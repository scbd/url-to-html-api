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
      // chromeLocation: '/usr/bin/google-chrome-stable',
      chromeFlags: ['--no-sandbox','--headless', '--disable-gpu', '--remote-debugging-port=9222', '--hide-scrollbars','--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    server.start();
  }
}

module.exports = createRouter;
