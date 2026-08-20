const url        = require('url');
const querySting  = require('querystring');
const { forEach, findKey } = require('lodash');
const config = require('./config');

const INSTANCE_ID = require('./instanceId');
const sleep = require('./sleep');
const { log, logError } = require('./debugLog');
const { removeScriptTags, updateBaseUrl, formatBytes } = require('./htmlContent');
const { isCBDDomain, abortNetworkUrlRequest } = require('./networkFilters');
const {
    SENSITIVE_PATH_RE,
    MISSING_DATABASE_SEGMENT_RE,
    STRAY_BRACE_TYPE_SEGMENT_RE,
    COUNTRIES_SUFFIX_RE,
    REPEATED_PATH_SEGMENT_RE,
    detectSoftNotFound,
    matchLegacyQueryRecord,
} = require('./legacyUrlPatterns');
const { networkResponseCache, matchCacheableEntry, saveNetworkResponseCache } = require('./networkResponseCache');
const { reportEvent, isKnownSoftNotFoundUrl } = require('./statsReporter');
const { requesterInfo, safeHostname } = require('./requestContext');
const chromeBrowser = require('./chromeBrowser');
const { inflightRequests, renderInflightRequest, cleanUpInflightRequests, getInflightCount } = require('./inflightRequests');
const { captureDiagnostics, logInflightSnapshot } = require('./diagnostics');

const cacheControl = 7*24*60*60; //7days

async function renderUrl (req, res){
    const clientUrl = req.query.url.replace(/^\//, '');
    let htmlUrl = new url.URL(clientUrl);
    let search  = querySting.parse((htmlUrl.search||'').replace(/^\?/, ''));
    const startTime = +new Date();
    const lastCall = +new Date();
    let requestEntry;
    try{

        if(SENSITIVE_PATH_RE.test(htmlUrl.pathname)){
            log(`Blocked probe for sensitive path, skipping render for ${clientUrl}`);
            reportEvent('security_probe_404', { url: clientUrl, domain: htmlUrl.hostname, ...requesterInfo(req) });
            return res.status(404).send('Not found');
        }

        for(const { re, correct } of MISSING_DATABASE_SEGMENT_RE){
            const match = htmlUrl.pathname.match(re);
            if(!match) continue;
            const correctedPath = correct(...match.slice(1));
            const redirectUrl = `${htmlUrl.origin}${correctedPath}${htmlUrl.search}`;
            log(`Legacy URL missing /database/{TYPE}/ segment, redirecting ${clientUrl} -> ${redirectUrl}`);
            reportEvent('legacy_url_redirect', { url: clientUrl, domain: htmlUrl.hostname, redirectTo: redirectUrl, ...requesterInfo(req) });
            return res.redirect(301, redirectUrl);
        }

        if(STRAY_BRACE_TYPE_SEGMENT_RE.test(htmlUrl.pathname)){
            const correctedPath = htmlUrl.pathname.replace(STRAY_BRACE_TYPE_SEGMENT_RE, '$1$2$3');
            const redirectUrl = `${htmlUrl.origin}${correctedPath}${htmlUrl.search}`;
            log(`Legacy URL with stray "}" after type segment, redirecting ${clientUrl} -> ${redirectUrl}`);
            reportEvent('legacy_url_redirect', { url: clientUrl, domain: htmlUrl.hostname, redirectTo: redirectUrl, ...requesterInfo(req) });
            return res.redirect(301, redirectUrl);
        }

        const legacyQueryRecordPath = matchLegacyQueryRecord(htmlUrl.pathname, htmlUrl.searchParams);
        if(legacyQueryRecordPath){
            const redirectUrl = `${htmlUrl.origin}${legacyQueryRecordPath}`;
            log(`Legacy query-string record lookup, redirecting ${clientUrl} -> ${redirectUrl}`);
            reportEvent('legacy_url_redirect', { url: clientUrl, domain: htmlUrl.hostname, redirectTo: redirectUrl, ...requesterInfo(req) });
            return res.redirect(301, redirectUrl);
        }

        if((COUNTRIES_SUFFIX_RE.test(htmlUrl.pathname) || REPEATED_PATH_SEGMENT_RE.test(htmlUrl.pathname)) && await isKnownSoftNotFoundUrl(clientUrl)){
            log(`Malformed URL previously confirmed soft 404, skipping render for ${clientUrl}`);
            reportEvent('malformed_url_404', { url: clientUrl, domain: htmlUrl.hostname, ...requesterInfo(req) });
            return res.status(404).send('Not found');
        }

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

async function processInflightRequest(){
    try{
        await chromeBrowser.initializeChrome();

        while(true){
            if(Object.keys(inflightRequests)?.length> 0 ){

                log(`process inflight running, ${Object.keys(inflightRequests)?.length}`);

                if(chromeBrowser.shouldRestart()){
                    try{
                        await chromeBrowser.restartChrome()
                    }
                    catch(e){
                        logError('Error restarting chrome', e);
                        reportEvent('restart_error', { error: e ? e.toString() : 'unknown' });
                    }
                }

                const canProcessRequest = await chromeBrowser.hasFreeTabs(Object.keys(inflightRequests)?.length);
                if(canProcessRequest){
                    const urlRequest = Object.values(inflightRequests)?.find(e=>e?.status == 'request');

                    if(urlRequest?.status == 'request'){
                        renderHtml(urlRequest)
                    }
                }
                else{
                    const tabCount = (await chromeBrowser.getBrowser().pages()).length
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

async function renderHtml (urlRequest){

    let clientUrl = urlRequest.url.replace(/^\//, '');
    const startTime = +new Date();
    const lastCall = +new Date();
    let response;
    let page;

    chromeBrowser.incrementActiveRenders();
    let reqStatus = {};
    // name (thesaurus/countries/jsdelivr) -> { hit, miss } — see CACHEABLE_ENTRIES.
    const cacheCounts = {};
    function bumpCacheCount(name, outcome){
        cacheCounts[name] = cacheCounts[name] || { hit: 0, miss: 0 };
        cacheCounts[name][outcome]++;
    }
    try {

            urlRequest.status = 'inflight';

            const browser = await chromeBrowser.initializeChrome();

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
                userAgent: urlRequest.userAgent,
                cacheCounts,
                edgeCacheStatus: urlRequest.edgeCacheStatus
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
        const browser = chromeBrowser.getBrowser();
        if(!browser || !browser.isConnected()){
            chromeBrowser.requestRestart();
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
        chromeBrowser.decrementActiveRenders();
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

setInterval(() => {
    logInflightSnapshot().catch(e => logError('Error in logInflightSnapshot', e));
}, 15*1000);

module.exports = {
    renderUrl,
    processInflightRequest,
    getInflightCount
}
