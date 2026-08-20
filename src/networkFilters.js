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

module.exports = { isCBDDomain, abortNetworkUrlRequest };
