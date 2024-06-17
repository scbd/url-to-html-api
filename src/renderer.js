
const url       = require('url');
// const chrome    = require("@sparticuz/chromium")
const puppeteer = require("puppeteer")
const AWS       = require('aws-sdk');
const { forEach, findKey}  = require('lodash');
const minify    = require('html-minifier').minify;
const querySting = require('querystring');

let startTime;
let lastCall;
let browser;
const cacheControl = 7*24*60*60; //7days
const originHeaderName = 'x-origin';
// On top of your code

async function initializeChrome(){
    if(!browser){
        let chromeFlags = [
			'--no-sandbox', '--disable-gpu', 
            '--hide-scrollbars',
            '--disable-setuid-sandbox', '--disable-dev-shm-usage'
		];

        console.log(puppeteer.executablePath())

        log('initializing chrome');

        browser = await puppeteer.launch({
            args: chromeFlags,
            ignoreHTTPSErrors: true,
            headless: true,
            // sloMo: config.DEBUG_MODE ? 250 : undefined,
        })
        
        //fake page so that if the last tap is closed the instance stays in memory
        const fakePage = await browser.newPage();
        log('Chrome new instance initialized')
    }
    else{
        log('Chrome instance is in memory, reusing...')
    }

    return browser;
}

async function renderHtml (req, res){

    let clientUrl = req.query.url.replace(/^\//, '');
    startTime = +new Date();
    lastCall = +new Date();
    let response;
    let page;
    try {        
            
            await initializeChrome();

            page = await browser.newPage();
            await page.setRequestInterception(true);
    
                        
            clientUrl = clientUrl.replace(/^\//, '');
            console.log(`Rendering url: ${clientUrl}`)

            let htmlUrl = new url.URL(clientUrl);
            let search  = querySting.parse((htmlUrl.search||'').replace(/^\?/, ''));

            if(!isCBDDomain(htmlUrl.hostname)){
                log(`Only CBD domain urls can be rendered ${htmlUrl.hostname}`)
                return {
                    'statusCode': 400,
                    'body': 'Only CBD domain urls can be rendered'
                };
            }
            log('Domain validation passed');

            page.on('console', async message =>{
                log(`${message.type().substr(0, 3).toUpperCase()} ${message.text()}`)
            });

            page.on('request', async req => {

                let abortRequest = false;
                const requestUrl   = req.url();
                const cURL         = new URL(requestUrl);
                const isImg        = req.resourceType() === 'image';
                
                abortRequest = isImg && ~cURL.pathname.indexOf('/api/v2013/documents/');
                abortRequest = abortRequest //|| !isCBDDomain(cURL.hostname);
                abortRequest = abortRequest || abortNetworkUrlRequest(requestUrl);
                if(requestUrl.indexOf('https://cdn.jsdelivr.net/npm/bootstrap-icons@1')>=0){
                    log(`making request for ${cURL.hostname}, ${requestUrl}}`);
                }
                
                let headers = {...req.headers() }                
                if(isCBDDomain(cURL.hostname)){
                    headers['x-is-prerender'] = 'true';
                    // deleteOriginRequestHeaders(headers);         
                }
                // if (cache[requestUrl] && cache[requestUrl].expires > Date.now()) {
                //     await req.respond(cache[requestUrl]);
                //     console.log(`served cached url response for ${requestUrl}`)
                //     return;
                // }

                if(process.env.logHeaders){
                    console.log('url', req.url(), `headers: `, headers)
                }
                if(abortRequest){
                    req.abort();
                }
                else
                    req.continue({headers});
                
            });
            const stylesheetContents = {};
            let   importStyleSheets  = []
            //copy local stylesheets to inline (to avoid multiple http calls for google index).
            // page.on('response', async resp => {
            //     try{
            //         var resStatus = resp.status();
            //         if(resStatus != 200)
            //             return;


            //         const headers = resp.headers();
            //         const cacheControl = headers['cache-control'] || '';
            //         const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
            //         const maxAge = maxAgeMatch && maxAgeMatch.length > 1 ? parseInt(maxAgeMatch[1], 10) : 0;

            //         const responseUrl   = resp.url();
            //         const cssURL        = new URL(responseUrl);
            //         const isStylesheet  = resp.request().resourceType() === 'stylesheet';

            //         let buffer;
            //             try {
            //                 buffer = await resp.buffer();
            //             } catch (error) {
            //                 // some responses do not contain buffer and do not need to be catched
            //                 // return;
            //             }

            //         // if (1==2 && isStylesheet) {
            //         //     stylesheetContents[responseUrl] = await resp.text();
    
            //         //     if(isCBDDomain(cssURL.origin)){
            //         //         let regex = /^@import url\((?:"|')(.*)(?:"|')\)(?:;)?$/igm
            //         //         let imports = stylesheetContents[responseUrl].match(regex);
            //         //         if(imports && imports.length>0){
            //         //             forEach(imports, (u)=>{
            //         //                 let urlMatches = u.match(/^@import url\((?:"|')(.*)(?:"|')\)(?:;)?$/);
            //         //                 let cssUrl = urlMatches[1].replace(/\.\.\//g, '');
            //         //                 let css = {
            //         //                     url: cssUrl,
            //         //                     originalString: u, baseCss:responseUrl
            //         //                 };
            //         //                 importStyleSheets.push(css);                   
            //         //             })
            //         //         }
            //         //     }
            //         // }

            //         if (maxAge &&  buffer) {
            //             if (cache[responseUrl] && cache[responseUrl].expires > Date.now()) return;

            //             cache[responseUrl] = {
            //                 status: resp.status(),
            //                 headers: resp.headers(),
            //                 body: buffer,
            //                 expires: Date.now() + (maxAge * 1000),
            //             };
            //         }
            //     }
            //     catch(err){
            //         // logError(err, resp)
            //     }
            // });

            //set X-Is-Prerender to avoid iscrawler check since headless userAgent is also consider crawler
            // await page.setExtraHTTPHeaders({
            //     'x-is-prerender': 'true'
            // })
            // await appendOriginRequestHeaders(page, (event||{}).headers);

            if(process.env.logHeaders){
                console.log('origin headers', req.headers);
            }

            let pdfOpts = {waitUntil : 'networkidle0', timeout:20*1000} //timeout:0 (makes it infinite)
            
            await page.goto(clientUrl, pdfOpts);
            log('finished goto');
            // await sleep(5000);

            // await page.setViewport({ width: 1920, height: 1001 });
            // log('viewport set');
           
            // Replace stylesheets in the page with their equivalent <style>.
            await page.$$eval('link[rel="stylesheet"]', (links, content) => {
                links.forEach(link => {
                const cssText = content[link.href];
                if (cssText) {
                    const style = document.createElement('style');
                    style.textContent = cssText;
                    link.replaceWith(style);
                }
                });
            }, stylesheetContents);
            log('Done combining stylesheets');

            let pageContent = await page.content();

            forEach(importStyleSheets, (style)=>{
                var newKey = findKey(stylesheetContents, (key, a)=>{
                                return ~a.indexOf(style.url)
                            });
                var css = stylesheetContents[newKey]
                pageContent = pageContent.replace(style.originalString, css);
 
            });
            log('Done combining import stylesheets');

            log(`page content received, length : ${pageContent.length}(${formatBytes(pageContent.length)})`)
            
            pageContent = removeScriptTags(pageContent);
            log('remove script end');

            pageContent = updateBaseUrl(pageContent, search.baseUrl||htmlUrl.origin||'');
            log('Base url updated');

            let cacheControlHeader = {'Cache-Control': `public, max-age=${cacheControl}` };

            log(`Total time taken: ${(((+new Date())-startTime)/1000).toFixed(5)} secs`);

            return res.status(200)
                    .set({
                        ...cacheControlHeader
                    })
                    .send(pageContent);

            // // special case for Sixth national report [Mexico|Costa Rica which are 10MB in size]
            // // since Google bot and other SEO bots do not respect 301/302 for the original request which we are doing here due to AWS Lambda limitation
            // // strip out all style elements since they are of no use to crawlers
            
            // if(pageContent.length > 5800000 && req.headers){
            //     try{
            //         log('page content is bigger than 5.8 mb' + pageContent.length)
                    
            //         const seoBotRegx = /(bot|crawl|archiver|transcoder|spider|uptime|validator|fetcher|cron|checker|reader|extractor|monitoring|analyzer|scraper)/i
            //         const userAgent = req.headers['X-Origin-User-Agent'];
            //         log('origin UA' + userAgent);
                    
            //         if(seoBotRegx.test(userAgent)){
            //             const cheerio = require('cheerio');
            //             let $ = cheerio.load(pageContent);
            //             $('.page-content').find('*[style]').removeAttr('style');
                        
            //             pageContent = $.html();
            //             log('Style attributes removed, length reduced to ' + pageContent.length)
            //         }
            //         else{
            //             log('User-agent is not bot...')
            //         }
            //     }
            //     catch(err){
            //         console.error('error executing special SEO condition', err);
            //     }
            // }
            
            // // if(pageContent.length <= 5800000){
            // //     pageContent = minimizeHtml(pageContent);
            // //     log('minimize end');
            // // }

            // let cacheControlHeader = {'Cache-Control': `public, max-age=${cacheControl}` };
            // if(search.cfCache == 'false')
            //     cacheControlHeader = {};
            // ////////////////////////////////
            // /// Since there is a Lambda response limit of 6MB upload content to S3 and 302 to the S3 file
            // ////////////////////////////////
            // if(pageContent.length < 5800000){ //5.8 MB
            //     log('Response is lower than 5.8 mb, returning normal request response.')
            //     response = {
            //         'statusCode': 200,
            //         'headers'   : {
            //             "Content-Type" : "text/html",
            //             ...cacheControlHeader
            //         },
            //         'body'      : pageContent
            //     }
            // }
            // else{
            //     log('response larger than 5.8 mb, saving to s3...')
            //     const S3_BUCKET = 'pdf-cache-prod';
            //     let key = 'html-files/' +guid() + '.html';
                
            //     let s3Options =  {
            //         Bucket      : S3_BUCKET, 
            //         Key         : key,
            //         ContentType : 'text/html', 
            //         Body        : pageContent, 
            //         ACL         : 'public-read'
            //     };
            //     const S3 = new AWS.S3();
            //     log('s3 initiated')

            //     let s3File = await S3.putObject(s3Options).promise();
            //     log('finish upload', s3File,)

                // log(`Total time taken: ${(((+new Date())-startTime)/1000).toFixed(5)} secs`)
            //     return {
            //         statusCode: 302,
            //         headers: {
            //             "Location": `https://s3.amazonaws.com/${S3_BUCKET}/${s3Options.Key}`,
            //             ...cacheControlHeader
            //         },
            //         body: null
            //     }
            // }
            
    } catch (err) {
        logError(`error in processing request, ${JSON.stringify(err||{msg:'noerror'})}`)
        logError('error catch', err);
        res.status(500).send(`Error when rendering page ${clientUrl}`);
    }
    finally{
        if(page)
            await page.close();            
    }

    return response;
}

function removeScriptTags(content){

    // code from https://github.com/prerender/prerender/blob/master/lib/plugins/removeScriptTags.js
    var matches = content.toString().match(/<script(?:.*?)>(?:[\S\s]*?)<\/script>/gi);
    for (let i = 0; matches && i < matches.length; i++) {
        if (matches[i].indexOf('application/ld+json') === -1) {
            content = content.toString().replace(matches[i], '');
        }
    }

    //<link rel="import" src=""> tags can contain script tags. Since they are already rendered, let's remove them
    matches = content.toString().match(/<link[^>]+?rel="import"[^>]*?>/i);
    for (let i = 0; matches && i < matches.length; i++) {
        content = content.toString().replace(matches[i], '');
    }

    //remove comments
    // content = content.replace(/(<!--.*?-->)|(<!--[\w\W\n\s]+?-->)/gm, '')
    
    return content;
}

function minimizeHtml(content){
    try{

        let options = {
            "caseSensitive": false,
            "collapseBooleanAttributes": true,
            "collapseInlineTagWhitespace": false,
            "collapseWhitespace": true,
            "conservativeCollapse": false,
            "decodeEntities": true,
            "html5": true,
            "includeAutoGeneratedTags": false,
            "keepClosingSlash": false,
            "minifyCSS": true,
            "minifyJS": true,
            "preserveLineBreaks": false,
            "preventAttributesEscaping": false,
            "processConditionalComments": true,
            "processScripts": ["text/html"],
            "removeAttributeQuotes": false,
            "removeComments": true,
            "removeEmptyAttributes": true,
            "removeEmptyElements": false,
            "removeOptionalTags": true,
            "removeRedundantAttributes": true,
            "removeScriptTypeAttributes": false,
            "removeStyleLinkTypeAttributes": false,
            "removeTagWhitespace": true,
            "sortAttributes": false,
            "sortClassName": false,
            "trimCustomFragments": true,
            "useShortDoctype": true
        };
        
        let orignalLength = content.length;
        content = minify(content, options);

        var diff = orignalLength - content.length;
        var savings = orignalLength ? (100 * diff / orignalLength).toFixed(2) : 0;
        
        log(`Original: ${formatBytes(orignalLength)}, minified: ${formatBytes(content.length)}, savings: ${savings}% (${formatBytes(diff)})`);
    }
    catch(e){}
    
    return content;

}
function log(message){

    if(process.env.debug){
        console.log(new Date(), message, `${(((+new Date())-lastCall)/1000).toFixed(5)} secs`);
        lastCall = +new Date()
    }

}
function logError(message){

    console.info(new Date(), message, `${(((+new Date())-lastCall)/1000).toFixed(5)} secs`);
    lastCall = +new Date()

}

function guid(sep) {
    function s4() {
        return Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    }

    if (sep === undefined)
        sep = '-';

    return s4() + s4() + sep + s4() + sep + s4() + sep + s4() + sep + s4() + s4() + s4();
}

function formatBytes(bytes, decimals, binaryUnits) {
    if(bytes == 0) {
        return '0 Bytes';
    }
    var unitMultiple = (binaryUnits) ? 1024 : 1000; 
    var unitNames = (unitMultiple === 1024) ? // 1000 bytes in 1 Kilobyte (KB) or 1024 bytes for the binary version (KiB)
        ['Bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB']: 
        ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    var unitChanges = Math.floor(Math.log(bytes) / Math.log(unitMultiple));
    return parseFloat((bytes / Math.pow(unitMultiple, unitChanges)).toFixed(decimals || 0)) + ' ' + unitNames[unitChanges];
}

function isCBDDomain(hostname){
   
    return /cbd\.int$/.test(hostname) || 
           /cbddev\.xyz$/.test(hostname)
}   

function abortNetworkUrlRequest(url){

    return /api\.cbddev\.xyz\/socket\.io/.test(url) ||
           /api\.cbd\.int\/socket\.io/.test(url) 
        //     ||
        //    /\app\/authorize\.html$/.test(url) || 
        //    /\/error-logs/.test(url)

}

async function appendOriginRequestHeaders(page, headers){

    const whitelistOriginHeaders = [
        'x-forwarded-for', 'user-agent', 'x-amzn-trace-id', 'x-amz-cf-id', 'from', 'host', 'via', 'cloudfront-viewer-country'
    ]
    try{
        if(headers){
            const extraHeaders = {};
            for (const header in headers) {
                if (Object.hasOwnProperty.call(headers, header) && 
                    !header.toLowerCase().startsWith(originHeaderName+'-')) {

                        if(whitelistOriginHeaders.includes(header.toLowerCase())){
                            const element = headers[header];
                            extraHeaders[`${originHeaderName}-${header}`] = element;
                        }
                }
            }
            if(process.env.logHeaders){
                console.log('new origin headers', extraHeaders, headers);
            }
            //currently setting extra header is breaking for unknown reasons. skip for now
            // await page.setExtraHTTPHeaders(extraHeaders);
            
        }
    }
    catch(e){
        logError('error adding request headers to prerender request', e);
    }

}

async function deleteOriginRequestHeaders(headers){

    try{
        if(headers){
           for (const header in headers) {
                if (Object.hasOwnProperty.call(headers, header) && 
                header.toLowerCase().startsWith(originHeaderName+'-')) {
                    delete headers[header];
                }
           }
        }
    }
    catch(e){
        logError('error removing request headers from external request', e);
    }

}

function updateBaseUrl(content, baseUrl){

    let matches = content.toString().match(/href="((\/?)app\/.*)"[^>]*?>/gi);
    for (let i = 0; matches && i < matches.length; i++) {
        
        content = content.toString().replace(matches[i], matches[i].replace('href="/app', `href="${baseUrl}/app`));
    }

    matches = content.toString().match(/<img[^>]+?src="(\/app\/.*)"[^>]*?>/gi);
    for (let i = 0; matches && i < matches.length; i++) {
        
        content = content.toString().replace(matches[i], matches[i].replace('src="/app', `src="${baseUrl}/app`));
    }

    return content;
}

module.exports = {
    renderHtml
}