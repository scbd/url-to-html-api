const config = {
  PORT: Number(process.env.PORT) || 7100,
  NODE_ENV: process.env.NODE_ENV,
  LOG_LEVEL: process.env.LOG_LEVEL,
  PRERENDER_URL: process.env.PRERENDER_URL || 'http://localhost:3000/render',
  PAGE_LOAD_TIMEOUT: process.env.PAGE_LOAD_TIMEOUT || 10 * 1000,
  STATS_URL: process.env.STATS_URL || 'http://stats:7200',
  STATS_PORT: Number(process.env.STATS_PORT) || 7200,
  STATS_DATA_DIR: process.env.STATS_DATA_DIR,
  // renderer.js/stats read these flags directly off process.env, not through this config object
  debug: process.env.debug,
  showConsole: process.env.showConsole,
  showBrowser: process.env.showBrowser,
  logHeaders: process.env.logHeaders,
};

module.exports = config;
