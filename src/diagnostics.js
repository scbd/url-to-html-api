const INSTANCE_ID = require('./instanceId');
const { getBrowser, getActiveRenders } = require('./chromeBrowser');
const { inflightRequests, getInflightCount } = require('./inflightRequests');
const { networkResponseCache } = require('./networkResponseCache');
const { reportLiveStatus } = require('./statsReporter');

async function captureDiagnostics(){
    const mem = process.memoryUsage();
    let openPages = null;
    try{
        const browser = getBrowser();
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
        activeRenders: getActiveRenders(),
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
    // Entry count in the disk-persisted network response cache (thesaurus/countries/
    // jsdelivr) — has no TTL-driven eviction of its own, so this is the visibility
    // that catches unbounded growth before it's a problem, not just a hit-rate number.
    reportLiveStatus({ instance: INSTANCE_ID, activeRenders: getActiveRenders(), rendering, queued, rssMB, heapUsedMB, externalMB, openPages, networkResponseCacheEntries: networkResponseCache.size });
}

module.exports = { captureDiagnostics, logInflightSnapshot };
