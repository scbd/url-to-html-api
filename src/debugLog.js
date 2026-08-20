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

module.exports = { log, logError };
