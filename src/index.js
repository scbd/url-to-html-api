const createApp = require('./app');
const winston = require('./logger')(__filename);
const config = require('./config');
const renderer = require('./renderer');


const app = createApp();
const server = app.listen(config.PORT, () => {
  winston.info(
    'Express server listening on http://localhost:%d/ in %s mode',
    config.PORT,
    app.get('env')
  );
});

const DRAIN_TIMEOUT_MS = 30 * 1000;

function closeServer(signal) {
  winston.info(`${signal} received`);
  server.close();

  const start = Date.now();
  const drainInterval = setInterval(() => {
    const remaining = renderer.getInflightCount();
    const timedOut = Date.now() - start >= DRAIN_TIMEOUT_MS;
    if (remaining === 0 || timedOut) {
      clearInterval(drainInterval);
      winston.info(`Exiting after drain, remaining inflight requests: ${remaining}`);
      process.exit(0);
    }
  }, 1000);
}

process.on('SIGTERM', closeServer.bind(this, 'SIGTERM'));
process.on('SIGINT', closeServer.bind(this, 'SIGINT(Ctrl-C)'));

