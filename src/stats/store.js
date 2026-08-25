const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.STATS_DATA_DIR || path.join(__dirname, '../../data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const COUNTS_FILE = path.join(DATA_DIR, 'counts.json');
const HOURLY_COUNTS_FILE = path.join(DATA_DIR, 'hourlyCounts.json');
const DURATIONS_FILE = path.join(DATA_DIR, 'durations.json');
const URL_SEEN_FILE = path.join(DATA_DIR, 'urlSeen.json');
const ROUTE_PATTERNS_FILE = path.join(DATA_DIR, 'routePatterns.json');
const CACHE_STATS_FILE = path.join(DATA_DIR, 'cacheStats.json');
const SOFT_404_URLS_FILE = path.join(DATA_DIR, 'soft404Urls.json');
const RETENTION_DAYS = 30;
// Only needed long enough for the hourly Slack report to summarize the hour that just
// ended — unlike counts.json, nothing else reads this, so it's pruned much sooner.
const HOURLY_RETENTION_HOURS = 48;

fs.mkdirSync(DATA_DIR, { recursive: true });

// A crash or restart mid-write (OOM kill, redeploy, host hiccup) could otherwise leave
// one of these JSON stores truncated. Two defenses: writes go through a temp file +
// atomic rename so a torn write can never reach the real path, and a read that still
// finds invalid JSON (e.g. from before this existed) moves the bad file aside instead
// of silently returning {} and letting the very next write overwrite it for good.
function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    const corruptPath = `${filePath}.corrupt`;
    try {
      fs.renameSync(filePath, corruptPath);
      console.error(`Corrupt stats file, moved aside to ${corruptPath}:`, e);
    } catch (renameErr) {
      console.error(`Corrupt stats file at ${filePath} (failed to move aside)`, e, renameErr);
    }
    return {};
  }
}

function writeJsonAtomic(filePath, data, label) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFile(tmpPath, JSON.stringify(data), (err) => {
    if (err) return console.error(`Failed to write stats ${label}`, err);
    fs.rename(tmpPath, filePath, (renameErr) => {
      if (renameErr) console.error(`Failed to finalize stats ${label}`, renameErr);
    });
  });
}

function loadCounts() {
  return readJsonSafe(COUNTS_FILE);
}

const counts = loadCounts();

function saveCounts() {
  writeJsonAtomic(COUNTS_FILE, counts, 'counts');
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

function loadHourlyCounts() {
  return readJsonSafe(HOURLY_COUNTS_FILE);
}

const hourlyCounts = loadHourlyCounts();

function saveHourlyCounts() {
  writeJsonAtomic(HOURLY_COUNTS_FILE, hourlyCounts, 'hourlyCounts');
}

// Same shape/logic as incrementCount, keyed by hour (YYYY-MM-DDTHH) instead of day —
// feeds the hourly Slack report only, so it doesn't need counts.json's 30-day retention.
function incrementHourlyCount(type, domain, client) {
  const hour = new Date().toISOString().slice(0, 13);
  const d = domain || 'unknown';
  hourlyCounts[hour] = hourlyCounts[hour] || {};
  hourlyCounts[hour][d] = hourlyCounts[hour][d] || {};
  const bucket = hourlyCounts[hour][d][type] || {};
  bucket[client] = (bucket[client] || 0) + 1;
  hourlyCounts[hour][d][type] = bucket;
  saveHourlyCounts();
}

function readHourlyCounts() {
  return hourlyCounts;
}

function pruneOldHourlyCounts() {
  const cutoff = new Date(Date.now() - HOURLY_RETENTION_HOURS * 60 * 60 * 1000).toISOString().slice(0, 13);
  Object.keys(hourlyCounts).forEach((hour) => {
    if (hour < cutoff) delete hourlyCounts[hour];
  });
  saveHourlyCounts();
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
  return readJsonSafe(DURATIONS_FILE);
}

const durations = loadDurations();

function saveDurations() {
  writeJsonAtomic(DURATIONS_FILE, durations, 'durations');
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
  // Same atomic-rename defense as writeJsonAtomic — this fully rewrites the file rather
  // than appending, so a crash mid-write must not be able to leave it truncated.
  const tmpPath = `${EVENTS_FILE}.tmp`;
  fs.writeFileSync(tmpPath, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  fs.renameSync(tmpPath, EVENTS_FILE);
  return events.length;
}

function loadUrlSeen() {
  return readJsonSafe(URL_SEEN_FILE);
}

const urlSeen = loadUrlSeen();

function saveUrlSeen() {
  writeJsonAtomic(URL_SEEN_FILE, urlSeen, 'urlSeen');
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
  return readJsonSafe(ROUTE_PATTERNS_FILE);
}

const routePatterns = loadRoutePatterns();

function saveRoutePatterns() {
  writeJsonAtomic(ROUTE_PATTERNS_FILE, routePatterns, 'routePatterns');
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
  return readJsonSafe(CACHE_STATS_FILE);
}

const cacheStats = loadCacheStats();

function saveCacheStats() {
  writeJsonAtomic(CACHE_STATS_FILE, cacheStats, 'cacheStats');
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

function loadSoft404Urls() {
  return readJsonSafe(SOFT_404_URLS_FILE);
}

const soft404Urls = loadSoft404Urls();

function saveSoft404Urls() {
  writeJsonAtomic(SOFT_404_URLS_FILE, soft404Urls, 'soft404Urls');
}

// URL -> last-seen day it was confirmed to render as a soft 404. Lets renderer.js
// short-circuit a URL it otherwise only suspects is bogus (e.g. matches
// COUNTRIES_SUFFIX_RE) once this service has actually seen it render a soft-404
// shell, without ever 404ing a URL that hasn't been confirmed bad first.
function recordSoft404Url(urlStr) {
  if (!urlStr) return;
  soft404Urls[urlStr] = new Date().toISOString().slice(0, 10);
  saveSoft404Urls();
}

function isKnownSoft404Url(urlStr) {
  return Boolean(urlStr && soft404Urls[urlStr]);
}

function pruneOldSoft404Urls() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  Object.keys(soft404Urls).forEach((urlStr) => {
    if (soft404Urls[urlStr] < cutoff) delete soft404Urls[urlStr];
  });
  saveSoft404Urls();
}

function countSoft404Urls() {
  return Object.keys(soft404Urls).length;
}

module.exports = {
  appendEvent,
  readEvents,
  pruneOldEvents,
  incrementCount,
  readCounts,
  pruneOldCounts,
  incrementHourlyCount,
  readHourlyCounts,
  pruneOldHourlyCounts,
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
  recordSoft404Url,
  isKnownSoft404Url,
  pruneOldSoft404Urls,
  countSoft404Urls,
  RETENTION_DAYS,
};
