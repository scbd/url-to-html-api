const _ = require('lodash');
const express = require('express');
const renderer = require('./renderer');

function asyncwrap(fn) { return function (req, res, next) { fn(req, res, next).catch(next); } }

function createRouter() {

  const router = express.Router();

  router.get  ('/api/render-html',  setTimeout, validate,  asyncwrap(renderer.renderHtml));
  router.get  ('/api/render-pdf',   setTimeout, validate,  asyncwrap(renderer.renderUrlToPdf));
  router.post ('/api/render-pdf',   setTimeout, validate,  asyncwrap(renderer.renderPdf));

  return router;

  function setTimeout(req, res, next){
    req.setTimeout(15*60*1000);
    next();

  }

  function validate(req, res, next){
    next();
  }
}

module.exports = createRouter;
