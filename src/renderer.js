
const prerenderNode = require('prerender-node');
const url       = require('url');
const querySting = require('querystring');
const winston = require('./logger')(__filename);
const config = require('./config');

async function renderHtml(req, res) {
    
    let clientUrl = req.query.url.replace(/^\//, '');

    try{
        winston.log(`Rendering url: ${clientUrl}`)

        let htmlUrl = new url.URL(clientUrl);
        let search  = querySting.parse((htmlUrl.search||'').replace(/^\?/, ''));

        if(!isCBDDomain(htmlUrl.hostname)){
            winston.log(`Only CBD domain urls can be rendered ${htmlUrl.hostname}`)
            return {
                'statusCode': 400,
                'body': 'Only CBD domain urls can be rendered'
            };
        }
        winston.log('Domain validation passed');
        
        prerenderNode
            .set('prerenderServiceUrl', config.PRERENDER_URL)
            .set('afterRender', function(err, req, prerender_res) {
                if (err) {
                    return { cancelRender: true };
                }
                
                prerender_res.body = removeScriptTags(prerender_res.body);
                prerender_res.body = updateBaseUrl(prerender_res.body, search.baseUrl||htmlUrl.origin||'');
                
            });;

        return prerenderNode(req, res);                
    }
    catch (err) {
        res.status(500).send(`Error when rendering page ${clientUrl}`);
        console.log(err);
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

    //remove comments
    // content = content.replace(/(<!--.*?-->)|(<!--[\w\W\n\s]+?-->)/gm, '')
    
    return content;
}

function updateBaseUrl(content, baseUrl){

    let matches = content.toString().match(/href="(\/app\/.*)"[^>]*?>/gi);
    for (let i = 0; matches && i < matches.length; i++) {
        
        content = content.toString().replace(matches[i], matches[i].replace('href="/app', `href="${baseUrl}/app`));
    }

    matches = content.toString().match(/<img[^>]+?src="(\/app\/.*)"[^>]*?>/gi);
    for (let i = 0; matches && i < matches.length; i++) {
        
        content = content.toString().replace(matches[i], matches[i].replace('src="/app', `src="${baseUrl}/app`));
    }

    return content;
}

function isCBDDomain(hostname){
   
    return /cbd\.int$/.test(hostname) || 
           /cbddev\.xyz$/.test(hostname)
}   

function setPrerenderHeader(req, res, next){

		req.prerender.tab.Network.setExtraHTTPHeaders({
			headers: {
				'x-is-prerender': 'true'
			}
		});

		next();
}


module.exports = {
    renderHtml,
    setPrerenderHeader
}
