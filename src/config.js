const config = {
  PORT: Number(process.env.PORT) || 7100,
  NODE_ENV: process.env.NODE_ENV,
  LOG_LEVEL: process.env.LOG_LEVEL,
  PRERENDER_URL: process.env.PRERENDER_URL || 'http://localhost:3000/render',
  PAGE_LOAD_TIMEOUT: process.env.PAGE_LOAD_TIMEOUT || 10 * 1000,
};

module.exports = config;
