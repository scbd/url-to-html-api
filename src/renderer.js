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
        console.log('start html-to-pdf');
        let content = await getPageHtml(req.query.url, opts);
        
        console.log('content generated');
        var pdfPrams = req.params||{};

        if(!pdfPrams.baseurl){
            pdfPrams.baseurl = new url.URL(req.query.url).origin;
        }

        console.log('start pdf');
        let pdf = await getHtmlPdf(content, req.params);
        
        console.log('pdf generated, sending user pdf');
        if(pdf.status == 200){
            res.set('content-type'    , pdf.header['content-type']);
            res.set('content-length'  , pdf.header['content-length']);
            res.set('date'            , pdf.header['date']);
            res.set('etag'            , pdf.header['etag']);
        }
        res.status(pdf.status);
        res.send(pdf.body);
    }
    catch (err) {
        winston.error(`Error rendering url to pdf: ${err}`);
        
        res.status(500).send('Error rendering url to pdf');
    }

}

async function renderPdf(req, res) {

    try{

        let pdf = await getHtmlPdf(req.body);

        if(pdf.status == 200){
            res.set('content-type', 'application/pdf');
        }
        
        res.status(pdf.status);
        res.send(pdf.body);

    }
    catch (err) {
        winston.error(`Error rendering html to pdf: ${err}`);
        
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

    console.log('page object created');
    const page = await browser.newPage();

    page.on('console', (...args) => winston.log('info PAGE LOG:', ...args));
    // page.on('console', msg => console.log('PAGE LOG:', msg.text()));

    await page.evaluate(() => console.log(`url is ${location.href}`));

    page.on('error', (err) => {
        winston.error(`Error event emitted: ${err}`);
        
        browser.close();
    });

    try {

        opts.viewport = {
            width: 1600,
            height: 1200,
        };
        
        console.log('broswer view port set');
        winston.log('info Set browser viewport..');
        await page.setViewport(opts.viewport);

        winston.info(`Goto url ${url} ..`);

        
        console.log(`Goto url ${url} ..`)
        let pdfOpts = {waitUntil : 'networkidle0', timeout:0}
        await page.goto(url, pdfOpts);

        console.log('goto url done');
        winston.log(`goto done..`)
        let pageContent = await page.content();

        winston.log('Content generated');

        return pageContent;

    } 
    catch (err) {
        winston.error(`Error when rendering page: ${err}`);
        
        throw err;
    } 
    finally {
        winston.log('info Closing browser..');
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
    winston.log('generating pdf...')
    console.log('querystring', queryString);
    console.log(`prince url ${config.PRINCE_PDF_URL}`)
    console.log('inside pdf generation');
    
    let pdf = await request.post(config.PRINCE_PDF_URL).query(queryString)
                        .set({'Content-Type': 'text/html'})
                        .parse(binaryParser)
                        .buffer()
                        .send(content);

    winston.log('pdf generated...')

    return pdf;

}

module.exports = {
    renderHtml,
    renderHtmlandPdf,
    renderPdf,
}
