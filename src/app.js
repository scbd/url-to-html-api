const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const compression = require('compression');
const cors = require('cors');
const winston = require('./logger')(__filename);
const createRouter = require('./router');
const config = require('./config');

function createApp() {
  const app = express();
  app.use(morgan('common'));

  if(!config.URL_TO_HTML_URL){
    throw Error("URL_TO_HTML_URL is missing, exiting..")
  }

  if (config.NODE_ENV !== 'production') {
    app.use(morgan('dev'));
  }

  const corsOpts = {
    origin: config.CORS_ORIGIN,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'],
  };
  winston.info('Using CORS options:', corsOpts);
  app.use(cors(corsOpts));
  
  app.use(bodyParser.text({ limit: '100mb', type: 'text/html' }));
  app.use(bodyParser.json({ limit: '100mb' }));

  app.use(compression({threshold: 100,}));//100kb

  // Initialize routes
  const router = createRouter();
  app.use('/', router);

  return app;
}

module.exports = createApp;
