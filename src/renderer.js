
const url       = require('url');
// const chrome    = require("@sparticuz/chromium")
const puppeteer = require("puppeteer")
const { forEach, findKey }  = require('lodash');
const querySting = require('querystring');
const config = require('./config');

let browser;
const cacheControl = 7*24*60*60; //7days
// On top of your code
let restartBrowser = false;

// Soft-404s: SPAs that return HTTP 200 with a shell page but render a "not found"
// state client-side for routes with no matching data. Add signatures here as they're found.
const SOFT_404_PATTERNS = [
    /<span class="color-red bold" style="font-size:50px;">Page not found\.<\/span>/, // bch/absch/chm.cbd.int (shared AngularJS platform)
    /class="text-medium-emphasis float-start">The page you are looking for was not found\.<\/p>/ // ort.cbd.int (separate React app)
];

function detectSoftNotFound(content){
    return SOFT_404_PATTERNS.some(pattern => pattern.test(content));
}

const inflightRequests = {};

const sleep = (timeout)=>new Promise((resolve) => setTimeout(resolve, timeout));

const STATS_URL = process.env.STATS_URL || 'http://stats:7200';

function reportEvent(type, payload){
    fetch(`${STATS_URL}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, ...payload }),
        signal: AbortSignal.timeout(2000)
    }).catch((e)=>{
        log(`Failed to report stats event to ${STATS_URL}`, e ? e.toString() : 'unknown');
    });
}

function clientIp(req){
    const xff = req.headers['x-forwarded-for'];
    if(xff){
        // chain is [client-supplied..., realViewerIP (added by CloudFront), edgeIP (added by our nginx)]
        const ips = xff.split(',').map(ip => ip.trim()).filter(Boolean);
        if(ips.length >= 2) return ips[ips.length - 2];
        if(ips.length === 1) return ips[0];
    }
    return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

function requesterInfo(req){
    return {
        ip: clientIp(req),
        userAgent: req.headers['x-origin-user-agent'] || req.headers['user-agent'] || 'unknown',
        referer: req.headers['referer'] || req.headers['referrer'] || '',
        country: req.headers['cloudfront-viewer-country'] || ''
    };
}

function safeHostname(clientUrl){
    try{
        return new url.URL(clientUrl).hostname;
    }
    catch(e){
        return 'unknown';
    }
}

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
            handleSIGTERM: false,
            handleSIGINT: false,
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
    let requestEntry;
    try{

        cleanUpInflightRequests();

        const existing = inflightRequests[clientUrl];
        if(existing && !['finished', 'error'].includes(existing.status)){
            log('Joining existing inflight request for ', clientUrl);
            requestEntry = existing;
        }
        else {
            log('Adding inflight request for ', clientUrl);
            requestEntry = inflightRequests[clientUrl] = {
                url         : clientUrl,
                requestDate : new Date(),
                status : 'request',
                numberOfChecks : 0,
                ...requesterInfo(req)
            };
        }

        if(process.env.logHeaders == 'true'){
            log('origin request headers', req.headers);
        }

        const response = await renderInflightRequest(clientUrl);

        if(response.status === 'finished'){

            const statusCode = response.statusCode || 200;

            let cacheControlHeader = {'Cache-Control': `public, max-age=${cacheControl}` };
            if(search.cfCache == 'false' || statusCode !== 200)
                cacheControlHeader = {};
            return res.status(statusCode)
                        .set(cacheControlHeader)
                        .send(response.content);
        }
        else {

            return res.status(response.statusCode || 500)
                        .send(response.error || 'Internal server error');
        }

    }
    catch(e){
        logError(`Request error for ${clientUrl}`, inflightRequests[clientUrl], e, await captureDiagnostics())
        reportEvent('request_error', { url: clientUrl, domain: safeHostname(clientUrl), error: e ? e.toString() : 'unknown', ...requesterInfo(req) });
        return res.status(500).send('Internal server error');
    }
    finally{
        setTimeout(() => {
            if(inflightRequests[clientUrl] === requestEntry){
                delete inflightRequests[clientUrl];
            }
        }, 5000);
    }
}

const MAX_INFLIGHT_WAIT_MS = 5 * 60 * 1000;

async function renderInflightRequest(url){

    const urlRequest = inflightRequests[url]
    if(urlRequest){

        if(['finished', 'error'].includes(urlRequest.status)){
            return urlRequest;
        }

        // Wall-clock based: numberOfChecks is shared across every caller joined on this
        // same URL, so when multiple callers poll concurrently it climbs faster than
        // real time, making a poll-count threshold fire early and unpredictably.
        if(Date.now() - urlRequest.requestDate.getTime() > MAX_INFLIGHT_WAIT_MS){
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
    log('Request received to restart browser, waiting for all tabs to close')
    await waitForAllTabsToFinish(0);
    await sleep(1000);

    const browserToClose = browser;
    const childProcess = browserToClose.process();

    await Promise.race([browserToClose.close(), sleep(5000)])
        .catch(e => logError('Error closing browser gracefully', e));

    if(childProcess && childProcess.exitCode === null && !childProcess.killed){
        log('Browser did not close gracefully, force killing process');
        childProcess.kill('SIGKILL');
    }

    browser = undefined;
    log('Browser restarted!!!!!!')

    await initializeChrome();

    restartBrowser = false;
}

async function processInflightRequest(){
    try{
        await initializeChrome();

        while(true){
            if(Object.keys(inflightRequests)?.length> 0 ){

                log(`process inflight running, ${Object.keys(inflightRequests)?.length}`);

                if(restartBrowser){
                    try{
                        await restartChrome()
                    }
                    catch(e){
                        logError('Error restarting chrome', e);
                        reportEvent('restart_error', { error: e ? e.toString() : 'unknown' });
                    }
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
                    log(`Current browser has ${tabCount}`)
                }

                await sleep(200);
            }
            else {
                await sleep(2000);
            }
        }

    }
    catch(e){
        logError(`Error in processInflightRequest`, e)
        await sleep(1000)
        processInflightRequest();
    }


}

async function hasFreeTabs(){
    if(!browser)
        await initializeChrome();

    let numberOfOpenPages = (await browser.pages()).length
    let waitedSeconds = 0
    if(numberOfOpenPages > 4){
        log(`number of inflight request have reached limit, ${numberOfOpenPages}.
            no of inflight request ${Object.keys(inflightRequests)?.length}.
            waitedSeconds : ${waitedSeconds}`);

        while(numberOfOpenPages > 4){
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
            log(`Rendering url: ${clientUrl}`)

            let htmlUrl = new url.URL(clientUrl);
            let search  = querySting.parse((htmlUrl.search||'').replace(/^\?/, ''));

            if(!isCBDDomain(htmlUrl.hostname)){
                log(`Only CBD domain urls can be rendered ${htmlUrl.hostname}`)
                urlRequest.status = 'error';
                urlRequest.statusCode = 400;
                urlRequest.error = 'Only CBD domain urls can be rendered';
                urlRequest.renderErrorOn = new Date();
                return;
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
                        log(`url ${res.url()}, headers: ${JSON.stringify(res.request().headers())}`)
                    }
                }
                delete reqStatus[res.url()]
            })
            const stylesheetContents = {};
            let   importStyleSheets  = []
            

            const timeout = config.PAGE_LOAD_TIMEOUT
            let pdfOpts = {waitUntil : 'networkidle0', timeout} //timeout:0 (makes it infinite)
            
            //set X-Is-Prerender to avoid iscrawler check since headless userAgent is also consider crawler
            // await page.setExtraHTTPHeaders({
            //     'x-is-prerender': 'true'
            // });

            await page.setDefaultNavigationTimeout(timeout);

            // Logs what's still blocking networkidle0 once a render has been waiting a
            // while, so a stuck/slow resource is visible before the render eventually
            // times out rather than only after (reqStatus is already tracked above).
            const navStartedOn = Date.now();
            const stallLogger = setInterval(() => {
                const elapsedMs = Date.now() - navStartedOn;
                if(elapsedMs < 60*1000) return;
                const pending = Object.keys(reqStatus);
                logError(`Render for ${clientUrl} still waiting on network idle after ${(elapsedMs/1000).toFixed(0)}s, pending requests (${pending.length}):`, pending.slice(0, 20));
            }, 15*1000);

            try{
                await page.goto(clientUrl, pdfOpts);
            }
            finally{
                clearInterval(stallLogger);
            }
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

            log(`Total time taken to render ${clientUrl}: ${(((+new Date())-startTime)/1000).toFixed(5)} secs`);

            // return res.status(200)
            //         .set({
            //             ...cacheControlHeader
            //         })
            //         .send(pageContent);
            urlRequest.statusCode = detectSoftNotFound(pageContent) ? 404 : 200;
            if(urlRequest.statusCode === 404){
                log(`Soft 404 detected for ${clientUrl}`);
                reportEvent('soft_404', {
                    url: clientUrl,
                    domain: htmlUrl.hostname,
                    ip: urlRequest.ip,
                    userAgent: urlRequest.userAgent,
                    referer: urlRequest.referer,
                    country: urlRequest.country
                });
            }

            urlRequest.status = 'finished';
            urlRequest.content = pageContent;
            urlRequest.renderFinishedOn = new Date();

            reportEvent('render_success', { url: clientUrl, domain: htmlUrl.hostname, durationMs: (+new Date())-startTime, userAgent: urlRequest.userAgent });

    } catch (err) {

        const errorMessage = err ? err.toString() : 'noerror';
        logError(`error in processing request, ${errorMessage}`, err, await captureDiagnostics())
        urlRequest.error = `Error when rendering page ${clientUrl}`;
        urlRequest.renderErrorOn = new Date();

        if(Object.keys(reqStatus)?.length)
            logError(`Pending requests :`, reqStatus)

        urlRequest.status = 'error';

        reportEvent('render_error', {
            url: clientUrl,
            domain: safeHostname(clientUrl),
            error: errorMessage,
            ip: urlRequest.ip,
            userAgent: urlRequest.userAgent,
            referer: urlRequest.referer,
            country: urlRequest.country
        });

        restartBrowser = true;
        log('Request set to restart browser')
        reportEvent('browser_restart', {
            url: clientUrl,
            domain: safeHostname(clientUrl),
            reason: errorMessage,
            ip: urlRequest.ip,
            userAgent: urlRequest.userAgent,
            referer: urlRequest.referer,
            country: urlRequest.country
        });
    }
    finally{
        if(page){
            try{
                await page.close();            
            }
            catch(e){
                logError(`unable to close the page ${clientUrl}`);
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
                log(`cleaning url after 5 mins of processing ${url}`)
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

function log(message, ...params){

    if(process.env.debug == 'true'){
        // -lastCall
        console.log(new Date(), message, ...params, `${(((+new Date()))/1000).toFixed(5)} secs`);
        // lastCall = +new Date()
    }

}
function logError(message, ...params){
// -lastCall
    console.error(new Date(), message,params, `${(((+new Date()))/1000).toFixed(5)} secs`);
    // lastCall = +new Date()

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

function getInflightCount(){
    return Object.keys(inflightRequests).length;
}

async function captureDiagnostics(){
    const mem = process.memoryUsage();
    let openPages = null;
    try{
        if(browser) openPages = (await browser.pages()).length;
    }
    catch(e){
        openPages = 'unavailable';
    }
    return {
        rssMB: Math.round(mem.rss / (1024*1024)),
        heapUsedMB: Math.round(mem.heapUsed / (1024*1024)),
        externalMB: Math.round(mem.external / (1024*1024)),
        inflightCount: getInflightCount(),
        openPages
    };
}

module.exports = {
    renderUrl,
    processInflightRequest,
    getInflightCount
}