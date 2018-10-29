const puppeteer = require('puppeteer');
const _ = require('lodash');
const config = require('./config');
const winston = require('./logger')(__filename);
const request = require('superagent');
const url       = require('url');

const binaryParser = require('superagent-binary-parser');

const Whitelist_PDFParams = [
    'baseurl'     ,
    'page-margin' ,
    'pdf-title'   ,
    'pdf-subject' ,
    'pdf-author'  ,
    'pdf-keywords',
    'pdf-creator' ,
];

async function renderHtml(req, res) {
    try{
        let content = await getPageHtml(req.query.url, {});
    
        res.status(200).send(content);
    }
    catch (err) {
        res.status(500).send('Error when rendering page');
    }

}

async function renderHtmlandPdf(req, res) {
    try{
        var opts = {
            ignoreHttpsErrors : true
        }
        let content = await getPageHtml(req.query.url, opts);
        
        var pdfPrams = req.params||{};

        if(!pdfPrams.baseurl){
            pdfPrams.baseurl = new url.URL(req.query.url).origin;
        }
        let pdf = await getHtmlPdf(content, req.params);
        
        res.status(200);
        res.set('content-type'    , pdf.header['content-type']);
        res.set('content-length'  , pdf.header['content-length']);
        res.set('date'            , pdf.header['date']);
        res.set('etag'            , pdf.header['etag']);
        
        res.send(pdf.body);
    }
    catch (err) {
        winston.error(`Error rendering url to pdf: ${err}`);
        winston.error(err.stack);
        res.status(500).send('Error rendering url to pdf');
    }

}

async function renderPdf(req, res) {

    try{

        let pdf = await getHtmlPdf(req.body);

        res.status(200);
        res.set('content-type', 'application/pdf');
        res.send(pdf.body);
    }
    catch (err) {
        winston.error(`Error rendering html to pdf: ${err}`);
        winston.error(err.stack);
        res.status(500).send('Error rendering html to pdf');
    }
}

async function getPageHtml(url, opts){
    const browser = await puppeteer.launch({
        headless: !config.DEBUG_MODE,
        ignoreHTTPSErrors: opts.ignoreHttpsErrors,
        args: ['--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox'],
        sloMo: config.DEBUG_MODE ? 250 : undefined,
    });

    const page = await browser.newPage();

    page.on('console', (...args) => winston.info('PAGE LOG:', ...args));
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));

    await page.evaluate(() => console.log(`url is ${location.href}`));

    page.on('error', (err) => {
        winston.error(`Error event emitted: ${err}`);
        winston.error(err.stack);
        browser.close();
    });

    try {

        opts.viewport = {
        width: 1600,
        height: 1200,
        };
        
        winston.info('Set browser viewport..');
        await page.setViewport(opts.viewport);
        // await page.emulateMedia('screen');

        winston.info(`Goto url ${url} ..`);
        let pdfOpts = {waitUntil : 'networkidle0', timeout:0}
        await page.goto(url, pdfOpts);

        let pageContent = await page.content();

        winston.info('Content generated');

        return pageContent;

    } catch (err) {
        winston.error(`Error when rendering page: ${err}`);
        winston.error(err.stack);
        throw err;
    } finally {
        winston.info('Closing browser..');
        if (!config.DEBUG_MODE) {
            await browser.close();
        }
    }
}

async function getHtmlPdf(content, params) {
    let queryString = {};
    
    if(params){
        _.each(Whitelist_PDFParams, function(param){
            if(params[param])
                queryString[param] = params[param];
        });
    }

    let pdf = request.post(config.PRINCE_PDF_URL)
                           .query(queryString)
                           .set({'Content-Type': 'text/html'})
                           .parse(binaryParser)
                           .buffer()
                           .send(content);
    return pdf;
}

module.exports = {
    renderHtml,
    renderHtmlandPdf,
    renderPdf,
}
