const url = require('url');

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
        country: req.headers['cloudfront-viewer-country'] || '',
        // nginx's $upstream_cache_status, forwarded per stack/data/nginx/app.conf. Only
        // ever MISS/EXPIRED/STALE/BYPASS/REVALIDATED/UPDATING — a true cache HIT is served
        // by nginx directly and never reaches this service.
        edgeCacheStatus: req.headers['x-proxy-cache'] || ''
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

module.exports = { clientIp, requesterInfo, safeHostname };
