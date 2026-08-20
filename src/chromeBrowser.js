const path      = require('path');
const fs        = require('fs');
const puppeteer = require('puppeteer');
const INSTANCE_ID = require('./instanceId');
const sleep = require('./sleep');
const { log, logError } = require('./debugLog');
const { reportEvent } = require('./statsReporter');

// Persists Chrome's own HTTP disk cache across restartChrome() calls within this
// container's lifetime (still wiped on a full container recreate/redeploy, since
// nothing mounts this path to a volume). Pages all share the default browser context
// (see browser.newPage() below, no incognito context), so this cache is already doing
// real work for repeat static assets — no reason to throw it away every time Chrome relaunches.
const CHROME_USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || path.join(__dirname, '../data/chrome-profile');
fs.mkdirSync(CHROME_USER_DATA_DIR, { recursive: true });

let browser;
let restartBrowser = false;
const MAX_CONCURRENT_RENDERS = 4;
// Tracks renders dispatched but not yet finished, incremented synchronously the instant
// renderHtml is called. browser.pages().length lags behind (page creation is async), so
// using it as the concurrency gate let processInflightRequest's loop dispatch far more
// than MAX_CONCURRENT_RENDERS renders before the page count caught up.
let activeRenders = 0;

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

async function hasFreeTabs(inflightCount){
    if(!browser)
        await initializeChrome();

    let waitedSeconds = 0
    if(activeRenders >= MAX_CONCURRENT_RENDERS){
        log(`number of concurrent renders have reached limit, ${activeRenders}.
            no of inflight request ${inflightCount}.
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

module.exports = {
    CHROME_USER_DATA_DIR,
    MAX_CONCURRENT_RENDERS,
    initializeChrome,
    restartChrome,
    hasFreeTabs,
    waitForAllTabsToFinish,
    getBrowser: () => browser,
    shouldRestart: () => restartBrowser,
    requestRestart: () => { restartBrowser = true; },
    incrementActiveRenders: () => ++activeRenders,
    decrementActiveRenders: () => --activeRenders,
    getActiveRenders: () => activeRenders,
};
