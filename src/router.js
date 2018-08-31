const _ = require('lodash');
const express = require('express');
const renderer = require('./renderer');

function createRouter() {

  const router = express.Router();

  router.get  ('/api/render-html',  validate,  renderer.renderHtml);
  router.get  ('/api/render-pdf',   validate,  renderer.renderHtmlandPdf);
  router.post ('/api/render-pdf',        validate,  renderer.renderPdf);

  return router;

  function validate(req, res, next){

    next();

  }
}

module.exports = createRouter;
