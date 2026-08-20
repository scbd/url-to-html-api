
const url       = require('url');
const os        = require('os');
const fs        = require('fs');
const path      = require('path');
// const chrome    = require("@sparticuz/chromium")
const puppeteer = require("puppeteer")
const { forEach, findKey }  = require('lodash');
const querySting = require('querystring');
const config = require('./config');

// Swarm replicas share one log stream; this tags every log line from this process so
// activity from different replicas isn't confused with each other when reading logs.
const INSTANCE_ID = os.hostname();

// Persists Chrome's own HTTP disk cache across restartChrome() calls within this
// container's lifetime (still wiped on a full container recreate/redeploy, since
// nothing mounts this path to a volume). Pages all share the default browser context
// (see browser.newPage() below, no incognito context), so this cache is already doing
// real work for repeat static assets — no reason to throw it away every time Chrome relaunches.
const CHROME_USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || path.join(__dirname, '../data/chrome-profile');
fs.mkdirSync(CHROME_USER_DATA_DIR, { recursive: true });

let browser;
const cacheControl = 7*24*60*60; //7days

// Slow-changing API calls made by rendered pages (e.g. thesaurus/countries lookups)
// and CDN-hosted libs are cached in-process, and persisted to disk (one file per
// `name`, see cacheStorageFilePath below), so repeated calls don't hit the origin/CDN
// on every render. Thesaurus/countries reference data hardly ever changes, so 7 days
// is safe; jsdelivr gets longer still since its URLs are npm-version-pinned and
// therefore effectively immutable at a given URL.
// `name` is also the dashboard-facing cache bucket (Caching tab) and the disk-file
// key — adding an entry here automatically gets its own persisted file and its own
// row on the dashboard, no other code changes needed.
const CACHEABLE_ENTRIES = [
    { name: 'thesaurus', prefix: 'https://api.cbd.int/api/v2013/thesaurus/', ttlMs: 7 * 24 * 60 * 60 * 1000 },
    { name: 'countries', prefix: 'https://api.cbd.int/api/v2013/countries/', ttlMs: 7 * 24 * 60 * 60 * 1000 },
    { name: 'jsdelivr', prefix: 'https://cdn.jsdelivr.net/', ttlMs: 30 * 24 * 60 * 60 * 1000 },
];
const networkResponseCache = new Map();

function matchCacheableEntry(requestUrl){
    return CACHEABLE_ENTRIES.find((e) => requestUrl.startsWith(e.prefix)) || null;
}

// One file per cache name rather than one shared file — a jsdelivr entry is large and
// rarely changes (30-day TTL), while thesaurus/countries entries are many, small, and
// churn daily; sharing a file would mean every thesaurus write also rewrites
// jsdelivr's bodies for no reason. Bodies persist as base64 since they're Buffers
// (could be binary, e.g. a jsdelivr asset) and JSON has no native byte-string type.
const NETWORK_RESPONSE_CACHE_DIR = process.env.NETWORK_RESPONSE_CACHE_DIR || path.join(__dirname, '../data');

function cacheStorageFilePath(name){
    return path.join(NETWORK_RESPONSE_CACHE_DIR, `network-response-cache-${name}.json`);
}

function loadNetworkResponseCache(){
    const now = Date.now();
    // De-duped in case a future CACHEABLE_ENTRIES addition ever reuses an existing name.
    const names = [...new Set(CACHEABLE_ENTRIES.map((e) => e.name))];
    names.forEach((name) => {
        const file = cacheStorageFilePath(name);
        try{
            if(!fs.existsSync(file)) return;
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            Object.entries(raw).forEach(([entryUrl, entry]) => {
                if(entry.expiresAt > now){
                    networkResponseCache.set(entryUrl, { ...entry, body: Buffer.from(entry.body, 'base64') });
                }
            });
        } catch(e){
            logError(`Failed to load persisted network response cache for "${name}"`, e);
        }
    });
    log(`Loaded ${networkResponseCache.size} cached network responses from disk`);
}

// Debounced, and scoped to only the cache name(s) that actually changed since the
// last flush — a burst of thesaurus lookups shouldn't also rewrite jsdelivr's file.
const dirtyCacheNames = new Set();
let saveNetworkResponseCacheTimer = null;
function saveNetworkResponseCache(name){
    dirtyCacheNames.add(name);
    if(saveNetworkResponseCacheTimer) return;
    saveNetworkResponseCacheTimer = setTimeout(() => {
        saveNetworkResponseCacheTimer = null;
        const namesToFlush = [...dirtyCacheNames];
        dirtyCacheNames.clear();

        namesToFlush.forEach((flushName) => {
            const serializable = {};
            networkResponseCache.forEach((entry, entryUrl) => {
                const matched = matchCacheableEntry(entryUrl);
                if(matched && matched.name === flushName){
                    serializable[entryUrl] = { ...entry, body: entry.body.toString('base64') };
                }
            });
            fs.writeFile(cacheStorageFilePath(flushName), JSON.stringify(serializable), (err) => {
                if(err) logError(`Failed to persist network response cache for "${flushName}"`, err);
            });
        });
    }, 2000);
}

loadNetworkResponseCache();
// On top of your code
let restartBrowser = false;
const MAX_CONCURRENT_RENDERS = 4;
// Tracks renders dispatched but not yet finished, incremented synchronously the instant
// renderHtml is called. browser.pages().length lags behind (page creation is async), so
// using it as the concurrency gate let processInflightRequest's loop dispatch far more
// than MAX_CONCURRENT_RENDERS renders before the page count caught up.
let activeRenders = 0;

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

function reportLiveStatus(payload){
    fetch(`${STATS_URL}/live-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(2000)
    }).catch((e)=>{
        log(`Failed to report live status to ${STATS_URL}`, e ? e.toString() : 'unknown');
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
            userDataDir: CHROME_USER_DATA_DIR,
            // ignoreHTTPSErrors: true,
            // sloMo: config.DEBUG_MODE ? 250 : undefined,
        }

        browser = await puppeteer.launch(chromeOptions)

        // Fires on a real crash/OOM-kill, not on our own deliberate restartChrome() close
        // (that already sets browser = undefined before this listener would matter).
        // Reuses the existing browser_restart category so the dashboard needs no changes;
        // the reason text is what distinguishes a crash from a normal render-triggered restart.
        browser.on('disconnected', () => {
            logError(`[${INSTANCE_ID}] Browser disconnected unexpectedly`);
            reportEvent('browser_restart', { reason: 'Browser process disconnected unexpectedly (crash or external kill)' });
            restartBrowser = true;
        });

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

// Fails a still-queued (never started rendering) request fast instead of leaving it
// to the 5-minute MAX_INFLIGHT_WAIT_MS cap. Returning 503 here lets nginx's
// proxy_next_upstream retry the request against a different replica instead of the
// client riding out a backlog on this one — see stack/data/nginx/app.conf.
const MAX_QUEUE_WAIT_MS = 45 * 1000;

async function renderInflightRequest(url){

    const urlRequest = inflightRequests[url]
    if(urlRequest){

        if(['finished', 'error'].includes(urlRequest.status)){
            return urlRequest;
        }

        if(urlRequest.status === 'request' && Date.now() - urlRequest.requestDate.getTime() > MAX_QUEUE_WAIT_MS){
            log(`[${INSTANCE_ID}] Queue wait exceeded ${MAX_QUEUE_WAIT_MS}ms for ${url}, replica overloaded — failing fast with 503`);
            urlRequest.status = 'error';
            urlRequest.statusCode = 503;
            urlRequest.error = 'Render queue overloaded on this replica';
            urlRequest.renderErrorOn = new Date();
            reportEvent('queue_timeout', {
                url,
                domain: safeHostname(url),
                error: urlRequest.error,
                queueWaitMs: Date.now() - urlRequest.requestDate.getTime(),
                ip: urlRequest.ip,
                userAgent: urlRequest.userAgent,
                referer: urlRequest.referer,
                country: urlRequest.country
            });
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

    let waitedSeconds = 0
    if(activeRenders >= MAX_CONCURRENT_RENDERS){
        log(`number of concurrent renders have reached limit, ${activeRenders}.
            no of inflight request ${Object.keys(inflightRequests)?.length}.
            waitedSeconds : ${waitedSeconds}`);

        while(activeRenders >= MAX_CONCURRENT_RENDERS){
            await sleep(1000);
            waitedSeconds += 1000;
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

    activeRenders++;
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

                abortRequest = isImg;
                abortRequest = abortRequest || abortNetworkUrlRequest(requestUrl);
                // if(requestUrl.indexOf('bootstrap.min.css')>=0){
                //     log(`making request for ${cURL.hostname}, ${requestUrl}}`); 
                // }

                if(abortRequest){
                    return req.abort();
                }

                const cacheableEntry = req.method() === 'GET' ? matchCacheableEntry(requestUrl) : null;
                if(cacheableEntry){
                    const cached = networkResponseCache.get(requestUrl);
                    if(cached && cached.expiresAt > Date.now()){
                        bumpCacheCount(cacheableEntry.name, 'hit');
                        return req.respond(cached);
                    }
                    bumpCacheCount(cacheableEntry.name, 'miss');
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

                const responseCacheEntry = res.request().method() === 'GET' && res.status() === 200 ? matchCacheableEntry(res.url()) : null;
                if(responseCacheEntry){
                    try{
                        const body = await res.buffer();
                        const headers = {...res.headers()};
                        delete headers['content-encoding'];
                        delete headers['content-length'];
                        delete headers['transfer-encoding'];
                        networkResponseCache.set(res.url(), {
                            status: res.status(),
                            headers,
                            body,
                            expiresAt: Date.now() + responseCacheEntry.ttlMs
                        });
                        saveNetworkResponseCache(responseCacheEntry.name);
                    } catch(e){
                        // response body not available (e.g. redirect) — just skip caching it
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
                logError(`[${INSTANCE_ID}] Render for ${clientUrl} still waiting on network idle after ${(elapsedMs/1000).toFixed(0)}s, pending requests (${pending.length}):`, pending.slice(0, 20));
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

            reportEvent('render_success', {
                url: clientUrl,
                domain: htmlUrl.hostname,
                durationMs: (+new Date())-startTime,
                queueWaitMs: urlRequest.renderStartedOn.getTime() - urlRequest.requestDate.getTime(),
                userAgent: urlRequest.userAgent
            });

    } catch (err) {

        const errorMessage = err ? err.toString() : 'noerror';
        logError(`error in processing request, ${errorMessage}`, err, await captureDiagnostics())
        urlRequest.error = `Error when rendering page ${clientUrl}`;
        urlRequest.renderErrorOn = new Date();

        if(Object.keys(reqStatus)?.length)
            logError(`[${INSTANCE_ID}] Pending requests :`, reqStatus)

        urlRequest.status = 'error';

        // null when the failure happened before renderStartedOn was ever set (e.g. Chrome
        // itself failed to initialize) — there's no queue-wait to report in that case.
        const queueWaitMs = urlRequest.renderStartedOn
            ? urlRequest.renderStartedOn.getTime() - urlRequest.requestDate.getTime()
            : null;

        reportEvent('render_error', {
            url: clientUrl,
            domain: safeHostname(clientUrl),
            error: errorMessage,
            queueWaitMs,
            ip: urlRequest.ip,
            userAgent: urlRequest.userAgent,
            referer: urlRequest.referer,
            country: urlRequest.country
        });

        // The 'disconnected' listener above already handles genuine crashes/OOM-kills.
        // Most render_errors (navigation timeout, malformed page markup, etc.) leave
        // Chrome itself perfectly healthy — restarting anyway would throw away its warm
        // HTTP cache (see CHROME_USER_DATA_DIR) for no reason. Only restart here if
        // Chrome is actually gone.
        if(!browser || !browser.isConnected()){
            restartBrowser = true;
            log('Browser is disconnected, flagged for restart')
            reportEvent('browser_restart', {
                url: clientUrl,
                domain: safeHostname(clientUrl),
                reason: errorMessage,
                queueWaitMs,
                ip: urlRequest.ip,
                userAgent: urlRequest.userAgent,
                referer: urlRequest.referer,
                country: urlRequest.country
            });
        }
    }
    finally{
        activeRenders--;
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
           /www\.gstatic\.com/.test(url) ||
           /\/error-logs/.test(url) ||
           /un-geospatial\.github\.io/.test(url)
        //     ||
        //    /\app\/authorize\.html$/.test(url)

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
        instance: INSTANCE_ID,
        rssMB: Math.round(mem.rss / (1024*1024)),
        heapUsedMB: Math.round(mem.heapUsed / (1024*1024)),
        externalMB: Math.round(mem.external / (1024*1024)),
        inflightCount: getInflightCount(),
        activeRenders,
        openPages
    };
}

async function logInflightSnapshot(){
    const entries = Object.values(inflightRequests);
    const now = Date.now();
    const detail = entries.map(r => ({
        url: r.url,
        status: r.status,
        elapsedMs: now - r.requestDate.getTime(),
        userAgent: r.userAgent
    }));
    const rendering = detail.filter(e => e.status === 'inflight');
    const queued = detail.filter(e => e.status === 'request');

    // Was already computed on error paths (see catch blocks above) but only ever
    // logged locally; reused here so the dashboard's per-instance memory/openPages
    // reflects steady-state health too, not just the moment something broke.
    const { rssMB, heapUsedMB, externalMB, openPages } = await captureDiagnostics();

    // Reported unconditionally (even when empty) so the dashboard clears an instance's
    // display when it goes idle instead of showing its last-known busy state forever.
    reportLiveStatus({ instance: INSTANCE_ID, activeRenders, rendering, queued, rssMB, heapUsedMB, externalMB, openPages });
}

setInterval(() => {
    logInflightSnapshot().catch(e => logError('Error in logInflightSnapshot', e));
}, 15*1000);

module.exports = {
    renderUrl,
    processInflightRequest,
    getInflightCount
}