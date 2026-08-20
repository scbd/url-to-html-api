const fs   = require('fs');
const path = require('path');
const { log, logError } = require('./debugLog');

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
    // No trailing slash: the site's actual call is `$http.get("/api/v2013/countries",
    // {params:{s:sortBy}})` (commonjs.getCountries, used by the shared header
    // directive on nearly every page) — the real request URL is
    // ".../countries?s%5B...%5D=1" with no "/" before the query string, so a
    // trailing-slash prefix here never matched it and this traffic was silently
    // never cached (and never counted on the dashboard).
    { name: 'countries', prefix: 'https://api.cbd.int/api/v2013/countries', ttlMs: 7 * 24 * 60 * 60 * 1000 },
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

module.exports = {
    networkResponseCache,
    matchCacheableEntry,
    saveNetworkResponseCache,
};
