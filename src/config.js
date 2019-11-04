const config = {
  PORT: Number(process.env.PORT) || 7100,
  NODE_ENV: process.env.NODE_ENV,
  LOG_LEVEL: process.env.LOG_LEVEL,
  PRINCE_PDF_URL: process.env.PRINCE_PDF_URL || 'http://localhost:7070/api/render',
  URL_TO_HTML_URL: process.env.URL_TO_HTML_URL
};

module.exports = config;
