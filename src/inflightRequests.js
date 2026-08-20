const INSTANCE_ID = require('./instanceId');
const sleep = require('./sleep');
const { log, logError } = require('./debugLog');
const { reportEvent } = require('./statsReporter');
const { safeHostname } = require('./requestContext');

const inflightRequests = {};

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

function diffInMinutes(dt2, dt1)
 {
  // Calculate the difference in milliseconds between the two provided dates and convert it to seconds
  var diff =(dt2.getTime() - dt1.getTime()) / 1000;
  // Convert the difference from seconds to minutes
  diff /= 60;
  // Return the absolute value of the rounded difference in minutes
  return Math.abs(Math.round(diff));
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

function getInflightCount(){
    return Object.keys(inflightRequests).length;
}

module.exports = {
    inflightRequests,
    renderInflightRequest,
    cleanUpInflightRequests,
    getInflightCount,
};
