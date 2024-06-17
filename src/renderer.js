
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

        log(`executablePath`, puppeteer.executablePath())

        log('initializing chrome');

        browser = await puppeteer.launch({
            args: chromeFlags,
            // ignoreHTTPSErrors: true,
            // headless: false,
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

    let reqStatus = {};
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

            if(process.env.debug){
                page.on('console', async message =>{
                    log(`${message.type().substr(0, 3).toUpperCase()} ${message.text()}`)
                });
            }

            page.on('request', async req => {

                let abortRequest = false;
                const requestUrl   = req.url();
                const cURL         = new URL(requestUrl);
                const isImg        = req.resourceType() === 'image';
                
                abortRequest = isImg && ~cURL.pathname.indexOf('/api/v2013/documents/');
                abortRequest = abortRequest //|| !isCBDDomain(cURL.hostname);
                abortRequest = abortRequest || abortNetworkUrlRequest(requestUrl);
                if(requestUrl.indexOf('bootstrap.min.css')>=0){
                    log(`making request for ${cURL.hostname}, ${requestUrl}}`); 
                }
                if(!abortRequest){
                    reqStatus[requestUrl] = 'request';
                }
                let headers = {...req.headers() }                
                // if(!isCBDDomain(cURL.hostname)){
                //     // delete headers['x-is-prerender'];// = 'true';
                //     // if(headers['access-control-request-headers'] == 'x-is-prerender')
                //     //     delete headers['access-control-request-headers']
                //     // deleteOriginRequestHeaders(headers);        
                    
                    // log(`making request for ${cURL.hostname}, ${requestUrl}}`); 
                // }

                let redirectFrom = '';
                const redirectChain = req.redirectChain();
                if(redirectChain?.length)
                    redirectFrom = redirectChain[0].url();

                if([requestUrl, redirectFrom].includes(clientUrl) || isCBDDomain(cURL.hostname)){
                    headers['x-is-prerender'] = 'true';
                }

                if(process.env.logHeaders){
                    console.log('url', req.url(), `headers: `, headers)
                }

                if(abortRequest){
                    req.abort();
                }
                else
                    req.continue({headers});
                
            });
            page.on('response', async res => {
                // console.log(res.url(), res.status())
                delete reqStatus[res.url()]
            })
            const stylesheetContents = {};
            let   importStyleSheets  = []
            

            if(process.env.logHeaders){
                console.log('origin headers', req.headers);
            }

            let pdfOpts = {waitUntil : 'networkidle0', timeout:20*1000} //timeout:0 (makes it infinite)
            
            //set X-Is-Prerender to avoid iscrawler check since headless userAgent is also consider crawler
            // await page.setExtraHTTPHeaders({
            //     'x-is-prerender': 'true'
            // })
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
            if(search.cfCache == 'false')
                cacheControlHeader = {};

            console.log(`Total time taken to render ${clientUrl}: ${(((+new Date())-startTime)/1000).toFixed(5)} secs`);

            return res.status(200)
                    .set({
                        ...cacheControlHeader
                    })
                    .send(pageContent);

            
    } catch (err) {
        logError(`error in processing request, ${JSON.stringify(err||{msg:'noerror'})}`)
        logError('error catch', err);
        res.status(500).send(`Error when rendering page ${clientUrl}`);

        if(Object.keys(reqStatus)?.length)
            console.log(`Pending requests :`, reqStatus)
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
function logError(message, ...params){

    console.info(new Date(), message,params, `${(((+new Date())-lastCall)/1000).toFixed(5)} secs`);
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
           /api\.cbd\.int\/socket\.io/.test(url) ||
           /www\.gstatic\.com/.test(url) 
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