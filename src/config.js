const config = {
  PORT: Number(process.env.PORT) || 7100,
  NODE_ENV: process.env.NODE_ENV,
  LOG_LEVEL: process.env.LOG_LEVEL,
  PRERENDER_URL: process.env.PRERENDER_URL || 'http://localhost:3000/render',
};

module.exports = config;
