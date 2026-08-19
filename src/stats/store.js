const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.STATS_DATA_DIR || path.join(__dirname, '../../data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const COUNTS_FILE = path.join(DATA_DIR, 'counts.json');
const DURATIONS_FILE = path.join(DATA_DIR, 'durations.json');
const RETENTION_DAYS = 30;

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadCounts() {
  if (!fs.existsSync(COUNTS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(COUNTS_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

const counts = loadCounts();

function saveCounts() {
  fs.writeFile(COUNTS_FILE, JSON.stringify(counts), (err) => {
    if (err) console.error('Failed to write stats counts', err);
  });
}

function incrementCount(type, domain, client) {
  const day = new Date().toISOString().slice(0, 10);
  const d = domain || 'unknown';
  counts[day] = counts[day] || {};
  counts[day][d] = counts[day][d] || {};
  const existing = counts[day][d][type];
  // Pre-migration data stored this bucket as a plain number; fold it in as human traffic.
  const bucket = typeof existing === 'object' ? existing : (existing ? { human: existing } : {});
  bucket[client] = (bucket[client] || 0) + 1;
  counts[day][d][type] = bucket;
  saveCounts();
}

function readCounts() {
  return counts;
}

function pruneOldCounts() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  Object.keys(counts).forEach((day) => {
    if (day < cutoff) delete counts[day];
  });
  saveCounts();
}

function loadDurations() {
  if (!fs.existsSync(DURATIONS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DURATIONS_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

const durations = loadDurations();

function saveDurations() {
  fs.writeFile(DURATIONS_FILE, JSON.stringify(durations), (err) => {
    if (err) console.error('Failed to write stats durations', err);
  });
}

// Tracks a running sum+count per day/domain/metric so an average can be computed later,
// without storing one record per render the way appendEvent's raw event log would.
function recordDuration(domain, metric, ms) {
  if (typeof ms !== 'number') return;
  const day = new Date().toISOString().slice(0, 10);
  const d = domain || 'unknown';
  durations[day] = durations[day] || {};
  durations[day][d] = durations[day][d] || {};
  const existing = durations[day][d][metric] || { sum: 0, count: 0 };
  durations[day][d][metric] = { sum: existing.sum + ms, count: existing.count + 1 };
  saveDurations();
}

function readDurations() {
  return durations;
}

function pruneOldDurations() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  Object.keys(durations).forEach((day) => {
    if (day < cutoff) delete durations[day];
  });
  saveDurations();
}

function appendEvent(event) {
  const record = { ...event, timestamp: new Date().toISOString() };
  fs.appendFile(EVENTS_FILE, JSON.stringify(record) + '\n', (err) => {
    if (err) console.error('Failed to write stats event', err);
  });
}

function readEvents() {
  if (!fs.existsSync(EVENTS_FILE)) return [];
  return fs.readFileSync(EVENTS_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
}

function pruneOldEvents() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const events = readEvents().filter((e) => new Date(e.timestamp).getTime() >= cutoff);
  fs.writeFileSync(EVENTS_FILE, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  return events.length;
}

module.exports = {
  appendEvent,
  readEvents,
  pruneOldEvents,
  incrementCount,
  readCounts,
  pruneOldCounts,
  recordDuration,
  readDurations,
  pruneOldDurations,
  RETENTION_DAYS,
};
