const { log } = require('./debugLog');

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

// Confirms a URL that only *looks* bogus (matches COUNTRIES_SUFFIX_RE) has actually
// rendered as a soft 404 before reporting for it — defaults to false (render as
// normal) on any lookup failure, so a stats-service hiccup never causes a false 404.
async function isKnownSoftNotFoundUrl(clientUrl){
    try{
        const res = await fetch(`${STATS_URL}/api/known-soft-404?url=${encodeURIComponent(clientUrl)}`, {
            signal: AbortSignal.timeout(2000)
        });
        if(!res.ok) return false;
        const data = await res.json();
        return Boolean(data.known);
    }
    catch(e){
        log(`Failed to check known soft-404 status for ${clientUrl}`, e ? e.toString() : 'unknown');
        return false;
    }
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

module.exports = { STATS_URL, reportEvent, isKnownSoftNotFoundUrl, reportLiveStatus };
