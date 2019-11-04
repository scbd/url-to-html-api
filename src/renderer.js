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
        let url = req.query.url.replace(/^\//, '')
        let content = await renderUrlHtml(url, {});
                
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
        winston.info('start html-to-pdf');
        let content = await renderUrlHtml(req.query.url, opts);
        
        winston.info('content generated');
        var pdfPrams = req.query||{};

        if(!pdfPrams.baseurl){
            pdfPrams.baseurl = new url.URL(req.query.url).origin;
        }

        winston.info('start pdf');
        let pdf = await convertHtmlToPdf(content, pdfPrams);
        
        winston.info('pdf generated');
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

        winston.info('finish sending user pdf');
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
    
    try {
       
        let pageContent = await request.get(config.URL_TO_HTML_URL)
                                        .query({url:(url)})
                                        .accept('text/html; charset=UTF-8')
                                        .buffer(true)
                                        .parse(request.parse.text)
                                        .then(page=>{
                                            return page.text;
                                        });
        return pageContent;

    } 
    catch (err) {
        winston.error(`Error when getting page html: ${err}`);
        throw err;
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

        winston.info('generating pdf...')
        winston.info('querystring', queryString);
        winston.info(`prince url ${config.PRINCE_PDF_URL}`)
        winston.info('inside pdf generation');
        
        let pdf;
        if(!params.link || params.link == 'false'){
            pdf = await request.post(config.PRINCE_PDF_URL)
                            .query(queryString)
                            .set({'Content-Type': 'text/html; charset=UTF-8'})
                            .parse(binaryParser)
                            .buffer()
                            .send(content);
        }
        else{
            pdf = await request.post(config.PRINCE_PDF_URL)
                            .query(queryString)
                            .set({'Content-Type': 'text/html; charset=UTF-8'})
                            .send(content);
        }
        winston.info('pdf generated...')

        return pdf;

    } 
    catch (err) {
        winston.error(`error in convertHtmlToPdf fn: ${err}`);
        
        throw err;
    } 

}

function removeScriptTags(content){

    // code from https://github.com/prerender/prerender/blob/master/lib/plugins/removeScriptTags.js
    var matches = content.toString().match(/<script(?:.*?)>(?:[\S\s]*?)<\/script>/gi);
    for (let i = 0; matches && i < matches.length; i++) {
        if (matches[i].indexOf('application/ld+json') === -1) {
            content = content.toString().replace(matches[i], '');
        }
    }

    //<link rel="import" src=""> tags can contain script tags. Since they are already rendered, let's remove them
    matches = content.toString().match(/<link[^>]+?rel="import"[^>]*?>/i);
    for (let i = 0; matches && i < matches.length; i++) {
        content = content.toString().replace(matches[i], '');
    }

    return content;
}
module.exports = {
    renderHtml,
    renderUrlToPdf,
    renderPdf,
}
