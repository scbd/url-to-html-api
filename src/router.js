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

    const prerender = require('prerender');
    const server = prerender({
      port:3000,
      pageLoadTimeout: 10 * 1000,
      chromeFlags: ['--no-sandbox','--headless', '--disable-gpu', '--remote-debugging-port=9222', '--hide-scrollbars','--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    server.use(prerender.addMetaTags())
    server.use(prerender.blockResources())
    server.use(prerender.browserForceRestart())
    server.use(prerender.httpHeaders())
    server.use(prerender.removeScriptTags())
    server.use(prerender.sendPrerenderHeader())
    server.use(require('./plugins/http-headers'))

    server.start();

  }
}

module.exports = createRouter;
