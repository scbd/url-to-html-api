const os = require('os');

// Swarm replicas share one log stream; this tags every log line from this process so
// activity from different replicas isn't confused with each other when reading logs.
const INSTANCE_ID = os.hostname();

module.exports = INSTANCE_ID;
