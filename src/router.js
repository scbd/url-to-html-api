const _ = require('lodash');
const express = require('express');
const renderer = require('./renderer');

function asyncwrap(fn) { return function (req, res, next) { fn(req, res, next).catch(next); } }

function createRouter() {

  const router = express.Router();
  initPrerenderServer();

  router.get  ('/api/render-html',  setTimeout, validate,  asyncwrap(renderer.renderHtml));

  return router;

  function setTimeout(req, res, next){
    req.setTimeout(15*60*1000);
    next();

  }

  function validate(req, res, next){
    next();
  }

  function initPrerenderServer(){

    const prerender = require('./libs/prerender');
    const server = prerender({
      port:3000,
      chromeFlags: ['--no-sandbox','--headless', '--disable-gpu', '--remote-debugging-port=9222', '--hide-scrollbars','--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      logRequests: process.env.PRERENDER_LOG_REQUESTS === 'true'
    });

    server.use(prerender.addMetaTags())
    // server.use(prerender.blockResources())
    server.use(prerender.browserForceRestart())
    server.use(prerender.httpHeaders())
    server.use(prerender.removeScriptTags())
    // server.use(prerender.sendPrerenderHeader())
    // server.use(require('./plugins/http-headers'))
    // server.use(require('./plugins/block-resources'))
    

    server.start();

  }
}

module.exports = createRouter;
