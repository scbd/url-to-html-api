const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.STATS_DATA_DIR || path.join(__dirname, '../../data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const COUNTS_FILE = path.join(DATA_DIR, 'counts.json');
const DURATIONS_FILE = path.join(DATA_DIR, 'durations.json');
const URL_SEEN_FILE = path.join(DATA_DIR, 'urlSeen.json');
const ROUTE_PATTERNS_FILE = path.join(DATA_DIR, 'routePatterns.json');
const CACHE_STATS_FILE = path.join(DATA_DIR, 'cacheStats.json');
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

// Upper bound (ms) of each latency bucket — a render/queue-wait falls in the first
// bucket whose boundary is >= its duration. Fixed, coarse-grained boundaries rather
// than exact samples: bounded storage per day/domain/metric regardless of render
// volume, at the cost of the percentile only being accurate to the nearest bucket edge.
const DURATION_BUCKETS_MS = [100, 250, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000, 120000, 300000, Infinity];

function durationBucketIndex(ms) {
  for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) {
    if (ms <= DURATION_BUCKETS_MS[i]) return i;
  }
  return DURATION_BUCKETS_MS.length - 1;
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
// without storing one record per render the way appendEvent's raw event log would. The
// bucket histogram alongside it is what lets a percentile be estimated later too —
// entries recorded before the histogram was added just have no `buckets` array, so
// their contribution to a percentile estimate is silently zero rather than wrong.
function recordDuration(domain, metric, ms) {
  if (typeof ms !== 'number') return;
  const day = new Date().toISOString().slice(0, 10);
  const d = domain || 'unknown';
  durations[day] = durations[day] || {};
  durations[day][d] = durations[day][d] || {};
  const existing = durations[day][d][metric] || { sum: 0, count: 0, buckets: new Array(DURATION_BUCKETS_MS.length).fill(0) };
  const buckets = existing.buckets || new Array(DURATION_BUCKETS_MS.length).fill(0);
  buckets[durationBucketIndex(ms)] += 1;
  durations[day][d][metric] = { sum: existing.sum + ms, count: existing.count + 1, buckets };
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

function loadUrlSeen() {
  if (!fs.existsSync(URL_SEEN_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(URL_SEEN_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

const urlSeen = loadUrlSeen();

function saveUrlSeen() {
  fs.writeFile(URL_SEEN_FILE, JSON.stringify(urlSeen), (err) => {
    if (err) console.error('Failed to write stats urlSeen', err);
  });
}

// How many times each URL has rendered successfully today, per domain — lets a
// "duplicate render" rate be derived (any render past the first for the same URL on
// the same day). Bounded by distinct URLs actually rendered per day rather than by
// domain/type/client cardinality like counts.json, so it can grow larger for
// high-traffic domains; pruned on the same 30-day cutoff as everything else.
function recordUrlSeen(domain, urlStr) {
  if (!urlStr) return 0;
  const day = new Date().toISOString().slice(0, 10);
  const d = domain || 'unknown';
  urlSeen[day] = urlSeen[day] || {};
  urlSeen[day][d] = urlSeen[day][d] || {};
  const n = (urlSeen[day][d][urlStr] || 0) + 1;
  urlSeen[day][d][urlStr] = n;
  saveUrlSeen();
  return n;
}

function readUrlSeen() {
  return urlSeen;
}

function pruneOldUrlSeen() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  Object.keys(urlSeen).forEach((day) => {
    if (day < cutoff) delete urlSeen[day];
  });
  saveUrlSeen();
}

function loadRoutePatterns() {
  if (!fs.existsSync(ROUTE_PATTERNS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(ROUTE_PATTERNS_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

const routePatterns = loadRoutePatterns();

function saveRoutePatterns() {
  fs.writeFile(ROUTE_PATTERNS_FILE, JSON.stringify(routePatterns), (err) => {
    if (err) console.error('Failed to write stats routePatterns', err);
  });
}

// Same shape as counts.json but keyed by a normalized route pattern instead of event
// type/client — normalization (see routePattern.js) collapses IDs out of the path so
// cardinality stays close to the number of distinct route *shapes*, not distinct URLs.
function incrementRoutePattern(domain, pattern) {
  if (!pattern) return;
  const day = new Date().toISOString().slice(0, 10);
  const d = domain || 'unknown';
  routePatterns[day] = routePatterns[day] || {};
  routePatterns[day][d] = routePatterns[day][d] || {};
  routePatterns[day][d][pattern] = (routePatterns[day][d][pattern] || 0) + 1;
  saveRoutePatterns();
}

function readRoutePatterns() {
  return routePatterns;
}

function pruneOldRoutePatterns() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  Object.keys(routePatterns).forEach((day) => {
    if (day < cutoff) delete routePatterns[day];
  });
  saveRoutePatterns();
}

function loadCacheStats() {
  if (!fs.existsSync(CACHE_STATS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_STATS_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

const cacheStats = loadCacheStats();

function saveCacheStats() {
  fs.writeFile(CACHE_STATS_FILE, JSON.stringify(cacheStats), (err) => {
    if (err) console.error('Failed to write stats cacheStats', err);
  });
}

// One bucket per day/domain/cache-name/outcome. cacheName distinguishes independent
// caches (e.g. "thesaurus" — renderer.js's in-process API response cache — vs
// "nginx_edge" — the X-Proxy-Cache status nginx forwards per request); outcome is
// cache-specific ("hit"/"miss" for thesaurus, the raw $upstream_cache_status value
// lowercased for nginx_edge).
function recordCacheCount(cacheName, domain, outcome, n = 1) {
  if (!n) return;
  const day = new Date().toISOString().slice(0, 10);
  const d = domain || 'unknown';
  cacheStats[day] = cacheStats[day] || {};
  cacheStats[day][d] = cacheStats[day][d] || {};
  cacheStats[day][d][cacheName] = cacheStats[day][d][cacheName] || {};
  cacheStats[day][d][cacheName][outcome] = (cacheStats[day][d][cacheName][outcome] || 0) + n;
  saveCacheStats();
}

function readCacheStats() {
  return cacheStats;
}

function pruneOldCacheStats() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  Object.keys(cacheStats).forEach((day) => {
    if (day < cutoff) delete cacheStats[day];
  });
  saveCacheStats();
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
  DURATION_BUCKETS_MS,
  recordUrlSeen,
  readUrlSeen,
  pruneOldUrlSeen,
  incrementRoutePattern,
  readRoutePatterns,
  pruneOldRoutePatterns,
  recordCacheCount,
  readCacheStats,
  pruneOldCacheStats,
  RETENTION_DAYS,
};
