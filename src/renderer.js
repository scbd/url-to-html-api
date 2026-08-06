
const url       = require('url');
// const chrome    = require("@sparticuz/chromium")
const puppeteer = require("puppeteer")
const AWS       = require('aws-sdk');
const { forEach, findKey, forIn}  = require('lodash');
const minify    = require('html-minifier').minify;
const querySting = require('querystring');

let browser;
const cacheControl = 7*24*60*60; //7days
const originHeaderName = 'x-origin';
// On top of your code
let restartBrowser = false;

const inflightRequests = {};

const sleep = (timeout)=>new Promise((resolve) => setTimeout(resolve, timeout));

async function initializeChrome(){
    if(!browser){
        let chromeFlags = [
			'--no-sandbox', '--disable-gpu', 
            '--hide-scrollbars', '--headless', 
            '--disable-setuid-sandbox', '--disable-dev-shm-usage'
		];
        let headless = true;

        if(process.env.showBrowser == 'true'){
            chromeFlags = chromeFlags.filter(e=>e!= '--headless')
            headless = false
        }

        // log(`executablePath`, puppeteer.executablePath())

        log('initializing chrome');

        const chromeOptions = {
            args: chromeFlags,            
            headless,
            // ignoreHTTPSErrors: true,
            // sloMo: config.DEBUG_MODE ? 250 : undefined,        
        }

        browser = await puppeteer.launch(chromeOptions)
        
        let numberOfOpenPages = (await browser.pages()).length
        if(numberOfOpenPages == 0){
            //fake page so that if the last tap is closed the instance stays in memory
            const fakePage = await browser.newPage();
        }

        log('Chrome new instance initialized')
    }
    else{
        log('Chrome instance is in memory, reusing...')
    }

    return browser;

}

// setInterval(() => {
//     restartBrowser = true;
// }, 15000);

async function renderUrl (req, res){
    const clientUrl = req.query.url.replace(/^\//, '');
    let htmlUrl = new url.URL(clientUrl);
    let search  = querySting.parse((htmlUrl.search||'').replace(/^\?/, ''));
    const startTime = +new Date();
    const lastCall = +new Date();
    try{

        cleanUpInflightRequests();
        // if(inflightRequests.find(clientUrl)){

        // }

        log('Adding inflight request for ', clientUrl);

        inflightRequests[clientUrl] = { 
            url         : clientUrl,
            requestDate : new Date(),
            status : 'request',
            numberOfChecks : 0
        };

        if(process.env.logHeaders == 'true'){
            console.log('origin request headers', req.headers);
        }

        const response = await renderInflightRequest(clientUrl);

        // const index = inflightRequests.findIndex(e=>e.url = clientUrl);
        
        if(response.status = 'finished'){

            let cacheControlHeader = {'Cache-Control': `public, max-age=${cacheControl}` };
            if(search.cfCache == 'false')
                cacheControlHeader = {};
            return res.status(200)
                        .set(cacheControlHeader)
                        .send(response.content);
        }
        else {

            return res.status(500)
                        .send(response.error || 'Internal server error');
        }

    }
    catch(e){
        console.log(`Request error for ${clientUrl}`, inflightRequests[clientUrl], e)
        res.status(500)
    }
    finally{
        setTimeout(() => {
            inflightRequests[clientUrl] = undefined;
            delete inflightRequests[clientUrl];
        }, 5000);
    }
}

async function renderInflightRequest(url){

    const urlRequest = inflightRequests[url]
    if(urlRequest){

        if(['finished', 'error'].includes(urlRequest.status)){
            return urlRequest;
        }

        if(urlRequest.numberOfChecks > 60*5){
            throw new Error('Too much wait time for request to process ', urlRequest)
        }

        urlRequest.numberOfChecks += 1;
        await sleep(1000);
        if(inflightRequests[url])
            return renderInflightRequest(url);
    }
    else{
        throw new Error('Request not found inflight', url)
    }
}

async function restartChrome(){
    console.log('Request received to restart browser, waiting for all tabs to close')
    await waitForAllTabsToFinish(0);
    await sleep(1000);
    await browser.close();
    browser = undefined;
    console.log('Browser restarted!!!!!!')

    await initializeChrome();

    restartBrowser = false;
}

async function processInflightRequest(){
    try{
        await initializeChrome();

        while(true){
            if(Object.keys(inflightRequests)?.length> 0 ){

                console.log(`process inflight running`, Object.keys(inflightRequests)?.length);
                
                if(restartBrowser){
                    await restartChrome()
                }

                const canProcessRequest = await hasFreeTabs();
                if(canProcessRequest){
                    const urlRequest = Object.values(inflightRequests)?.find(e=>e?.status == 'request');

                    if(urlRequest?.status == 'request'){
                        renderHtml(urlRequest)
                    }
                }
                else{
                    const tabCount = (await browser.pages()).length
                    console.log(`Current browser has ${tabCount}`)
                }

                await sleep(200);
            }
            else {
                console.log('no request in flight')
                await sleep(2000);
            }
        }

    }
    catch(e){
        console.error(`Error in processInflightRequest`, e)
        await sleep(1000)
        processInflightRequest();
    }


}

async function hasFreeTabs(){
    if(!browser)
        await initializeChrome();

    let numberOfOpenPages = (await browser.pages()).length
    let waitedSeconds = 0
    if(numberOfOpenPages > 10){
        log(`number of inflight request have reached limit, ${numberOfOpenPages}. 
            no of inflight request ${Object.keys(inflightRequests)?.length}.
            waitedSeconds : ${waitedSeconds}`);
       
        while(numberOfOpenPages > 10){
            await sleep(1000);
            waitedSeconds += 1000;
            numberOfOpenPages = (await browser.pages()).length
        }
    }

    return true;
}


async function waitForAllTabsToFinish(iteration = 0){
    if(!browser)
        return;

    let waitedSeconds     = 0;
    let numberOfOpenPages = (await browser.pages());
    for(index in numberOfOpenPages){
        const page = numberOfOpenPages[index];

        if(page.url() == 'about:blank'){
            await page.close();
        }
    }
    if(numberOfOpenPages?.length > 0){
        log(`number of inflight open request are ${numberOfOpenPages.length}.
            waitedSeconds : ${waitedSeconds}`);
       
        await sleep(1000);
       if(iteration > 30)
            return;

       return waitForAllTabsToFinish(iteration+1)
    }

}

async function renderHtml (urlRequest){

    let clientUrl = urlRequest.url.replace(/^\//, '');
    const startTime = +new Date();
    const lastCall = +new Date();
    let response;
    let page;

    let reqStatus = {};
    try {        
            
            urlRequest.status = 'inflight';
            
            await initializeChrome();

            urlRequest.renderStartedOn = new Date();

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

            if(process.env.debug == 'true'){
                page.on('console', async message =>{
                    if(process.env.showConsole == 'true')
                        log(`${message.type().substr(0, 3).toUpperCase()} ${message.text()} \n ${JSON.stringify(message.stackTrace())}`)
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
                // if(requestUrl.indexOf('bootstrap.min.css')>=0){
                //     log(`making request for ${cURL.hostname}, ${requestUrl}}`); 
                // }

                if(abortRequest){
                    return req.abort();
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
                    return req.continue({
                        headers
                    });
                }

                req.continue();
                
            });
            page.on('response', async res => {
                // console.log(res.url(), res.status())
                if(process.env.logHeaders == 'true'){
                    const requestUrl   = res.url();
                    const cURL         = new URL(requestUrl);
                    if( isCBDDomain(cURL.hostname)){
                        console.log(`url ${res.url()}, headers: ${JSON.stringify(res.request().headers())}`)
                    }
                }
                delete reqStatus[res.url()]
            })
            const stylesheetContents = {};
            let   importStyleSheets  = []
            

            const timeout = process.env.PAGE_LOAD_TIMEOUT || 120*1000
            let pdfOpts = {waitUntil : 'networkidle0', timeout} //timeout:0 (makes it infinite)
            
            //set X-Is-Prerender to avoid iscrawler check since headless userAgent is also consider crawler
            // await page.setExtraHTTPHeaders({
            //     'x-is-prerender': 'true'
            // });

            await page.setDefaultNavigationTimeout(timeout); 

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

            console.log(`Total time taken to render ${clientUrl}: ${(((+new Date())-startTime)/1000).toFixed(5)} secs`);

            // return res.status(200)
            //         .set({
            //             ...cacheControlHeader
            //         })
            //         .send(pageContent);
            urlRequest.status = 'finished';
            urlRequest.content = pageContent;
            urlRequest.renderFinishedOn = new Date();

            
    } catch (err) {
        
        const errorMessage = `${JSON.stringify(err||{msg:'noerror'})}`;
        logError(`error in processing request, ${errorMessage}`)
        logError('error catch', err);
        urlRequest.status = 500
        urlRequest.error = `Error when rendering page ${clientUrl}`;
        urlRequest.renderErrorOn = new Date();

        if(Object.keys(reqStatus)?.length)
            console.log(`Pending requests :`, reqStatus)

        urlRequest.status = 'error';

        if(errorMessage.indexOf('TimeoutError')>=0){
            restartBrowser = true;
            console.log('Request set to restart browser')
        }
    }
    finally{
        if(page){
            try{
                await page.close();            
            }
            catch(e){
                console.log(`unable to close the page ${clientUrl}`);
            }
        }
    }

    
}

function cleanUpInflightRequests(){

    Object.keys(inflightRequests)?.forEach(url=>{
        const urlRequest = inflightRequests[url];

        //should not exists more than 5 mins
        if(['finished', 'error'].includes(urlRequest?.status)){
            const timeSince = diffInMinutes(urlRequest.renderFinishedOn||urlRequest.renderErrorOn, new Date);

            if(timeSince > 5){
                console.log(`cleaning url after 5 mins of processing ${url}`)
                inflightRequests[url] = undefined;
                delete inflightRequests[url];
            }

        }
    });

}

function diffInMinutes(dt2, dt1) 
 {
  // Calculate the difference in milliseconds between the two provided dates and convert it to seconds
  var diff =(dt2.getTime() - dt1.getTime()) / 1000;
  // Convert the difference from seconds to minutes
  diff /= 60;
  // Return the absolute value of the rounded difference in minutes
  return Math.abs(Math.round(diff));
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

    if(process.env.debug == 'true'){
        // -lastCall
        console.log(new Date(), message, `${(((+new Date()))/1000).toFixed(5)} secs`);
        // lastCall = +new Date()
    }

}
function logError(message, ...params){
// -lastCall
    console.info(new Date(), message,params, `${(((+new Date()))/1000).toFixed(5)} secs`);
    // lastCall = +new Date()

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
           /cbddev\.xyz$/.test(hostname) || hostname == 'localhost'
}   

function abortNetworkUrlRequest(url){

    return /api\.cbddev\.xyz\/socket\.io/.test(url) ||
           /api\.cbd\.int\/socket\.io/.test(url) ||
        //    /socket\.io/.test(url) ||
           /cdn\.slaask\.com/.test(url) ||
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
            if(process.env.logHeaders == 'true'){
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
    renderUrl,
    processInflightRequest
}