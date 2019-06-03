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
    'link',
    'attachment-name',
    'bucket'
];

async function renderHtml(req, res) {
    try{
        let content = await renderUrlHtml(req.query.url, {});
    
        res.status(200).send(content);
    }
    catch (err) {
        res.status(500).send('Error when rendering page');
    }

}

async function renderUrlToPdf(req, res) {
    try{
        var opts = {
            ignoreHttpsErrors : true
        }
        console.log('start html-to-pdf');
        let content = await renderUrlHtml(req.query.url, opts);
        
        console.log('content generated');
        var pdfPrams = req.query||{};

        if(!pdfPrams.baseurl){
            pdfPrams.baseurl = new url.URL(req.query.url).origin;
        }

        console.log('start pdf');
        let pdf = await convertHtmlToPdf(content, pdfPrams);
        
        console.log('pdf generated');
        if(pdf.status == 200){
            if(pdf.header['content-type'] == 'application/pdf'){
                res.set('content-type'    , pdf.header['content-type']);
                res.set('content-length'  , pdf.header['content-length']);
                res.set('date'            , pdf.header['date']);
                res.set('etag'            , pdf.header['etag']);
                res.send(pdf.body);
            }
            else if(pdf.body.url){
                return res.status(200).send(pdf.body);
            }
        }
        res.status(pdf.status);

        console.log('finish sending user pdf');
    }
    catch (err) {
        winston.error(`Error rendering url to pdf: ${err}`);
        
        res.status(400).send('Error rendering url to pdf');
    }

}

async function renderPdf(req, res) {

    try{

        let pdf = await convertHtmlToPdf(req.body);

        if(pdf.status == 200){
            if(pdf.header['content-type'] == 'application/pdf'){
                res.set('content-type'    , pdf.header['content-type']);
                res.set('content-length'  , pdf.header['content-length']);
                res.set('date'            , pdf.header['date']);
                res.set('etag'            , pdf.header['etag']);
                res.send(pdf.body);
            }
            else if(pdf.body.url){
                return res.redirect(302, pdf.body.url);
            }
        }
        res.status(pdf.status);

    }
    catch (err) {
        winston.error(`Error rendering html to pdf: ${err}`);
        
        res.status(500).send('Error rendering html to pdf');
    }
}

async function renderUrlHtml(url, opts){
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

async function convertHtmlToPdf(content, params) {
    try{

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
        
        let pdf;
        if(!params.link || params.link == 'false'){
            pdf = await request.post(config.PRINCE_PDF_URL)
                            .timeout({
                                response: 5*60*1000,    // Wait 5 minutes for the server to start sending,
                                deadline: 1*60*1000     // but allow 1 minute for the file to finish loading.
                            })
                            .query(queryString)
                            .set({'Content-Type': 'text/html; charset=UTF-8'})
                            .parse(binaryParser)
                            .buffer()
                            .send(content);
        }
        else{
            pdf = await request.post(config.PRINCE_PDF_URL)
                            .timeout({
                                response: 5*60*1000,    // Wait 5 minutes for the server to start sending,
                                deadline: 1*60*1000     // but allow 1 minute for the file to finish loading.
                            })
                            .query(queryString)
                            .set({'Content-Type': 'text/html; charset=UTF-8'})
                            .send(content);
        }
        winston.log('pdf generated...')

        return pdf;

    } 
    catch (err) {
        winston.error(`error in convertHtmlToPdf fn: ${err}`);
        
        throw err;
    } 

}

module.exports = {
    renderHtml,
    renderUrlToPdf,
    renderPdf,
}
