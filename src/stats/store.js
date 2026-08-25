const { openDatabase, DB_PATH } = require('./db');

const RETENTION_DAYS = 30;
// Only needed long enough for the hourly Slack report to summarize the hour that just
// ended — unlike counts, nothing else reads this, so it's pruned much sooner.
const HOURLY_RETENTION_HOURS = 48;

// server.js runs the one-off JSON->SQLite migration (see migrateToSqlite.js) before
// ever requiring this module, gated on stats.db not existing yet — by the time this
// file is loaded, stats.db is guaranteed to already exist in a complete state.
const db = openDatabase(DB_PATH);

function close() {
  db.close();
}

// Wraps fn() in a single SQLite transaction — used by server.js's POST /events handler,
// which fans one incoming event out into several store calls (appendEvent, incrementCount,
// recordDuration, etc.). Batching them makes the whole update atomic instead of partially
// applied if one call throws partway through, and costs one WAL sync instead of several.
function withTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ─── events ──────────────────────────────────────────────────────────────────

const insertEvent = db.prepare(`
  INSERT INTO events (type, domain, url, ip, user_agent, referer, country, edge_cache_status, error, reason, redirect_to, queue_wait_ms, timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function appendEvent(event) {
  const timestamp = new Date().toISOString();
  insertEvent.run(
    event.type ?? null,
    event.domain ?? null,
    event.url ?? null,
    event.ip ?? null,
    event.userAgent ?? null,
    event.referer ?? null,
    event.country ?? null,
    event.edgeCacheStatus ?? null,
    event.error ?? null,
    event.reason ?? null,
    event.redirectTo ?? null,
    typeof event.queueWaitMs === 'number' ? event.queueWaitMs : null,
    timestamp
  );
}

function rowToEvent(row) {
  return {
    type: row.type,
    domain: row.domain,
    url: row.url,
    ip: row.ip,
    userAgent: row.user_agent,
    referer: row.referer,
    country: row.country,
    edgeCacheStatus: row.edge_cache_status,
    error: row.error,
    reason: row.reason,
    redirectTo: row.redirect_to,
    queueWaitMs: row.queue_wait_ms,
    timestamp: row.timestamp,
  };
}

// events scales with traffic volume (bot floods), not calendar days, so filtering
// happens in SQL rather than reading the whole table into JS first — the actual
// scaling risk this migration exists to fix. includeTypes/excludeTypes are mutually
// exclusive; prefix matches a day (YYYY-MM-DD) or hour (YYYY-MM-DDTHH) timestamp prefix.
function readRecentEvents({ includeTypes, excludeTypes, prefix, limit = 200 } = {}) {
  const clauses = [];
  const params = [];
  if (includeTypes) {
    clauses.push(`type IN (${includeTypes.map(() => '?').join(',')})`);
    params.push(...includeTypes);
  }
  if (excludeTypes) {
    clauses.push(`type NOT IN (${excludeTypes.map(() => '?').join(',')})`);
    params.push(...excludeTypes);
  }
  if (prefix) {
    clauses.push('timestamp LIKE ?');
    params.push(`${prefix}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  const rows = db.prepare(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT ?`).all(...params);
  return rows.map(rowToEvent);
}

function pruneOldEvents() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM events WHERE timestamp < ?').run(cutoff);
  return db.prepare('SELECT COUNT(*) AS c FROM events').get().c;
}

// ─── counts ──────────────────────────────────────────────────────────────────

const upsertCount = db.prepare(`
  INSERT INTO counts (day, domain, type, client, n) VALUES (?, ?, ?, ?, 1)
  ON CONFLICT(day, domain, type, client) DO UPDATE SET n = n + 1
`);

function incrementCount(type, domain, client) {
  const day = new Date().toISOString().slice(0, 10);
  upsertCount.run(day, domain || 'unknown', type, client);
}

function readCounts() {
  return db.prepare('SELECT day AS date, domain, type, client, n FROM counts').all();
}

function pruneOldCounts() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  db.prepare('DELETE FROM counts WHERE day < ?').run(cutoff);
}

// ─── hourly counts ───────────────────────────────────────────────────────────

const upsertHourlyCount = db.prepare(`
  INSERT INTO hourly_counts (hour, domain, type, client, n) VALUES (?, ?, ?, ?, 1)
  ON CONFLICT(hour, domain, type, client) DO UPDATE SET n = n + 1
`);

function incrementHourlyCount(type, domain, client) {
  const hour = new Date().toISOString().slice(0, 13);
  upsertHourlyCount.run(hour, domain || 'unknown', type, client);
}

// Scoped to a single hour (the only way this is ever read) — feeds the hourly Slack
// report / dashboard hourly-snapshot section only.
function readHourlyCounts(hour) {
  return db.prepare('SELECT domain, type, client, n FROM hourly_counts WHERE hour = ?').all(hour);
}

function pruneOldHourlyCounts() {
  const cutoff = new Date(Date.now() - HOURLY_RETENTION_HOURS * 60 * 60 * 1000).toISOString().slice(0, 13);
  db.prepare('DELETE FROM hourly_counts WHERE hour < ?').run(cutoff);
}

// ─── durations ───────────────────────────────────────────────────────────────

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

const upsertDuration = db.prepare(`
  INSERT INTO durations (day, domain, metric, sum, count) VALUES (?, ?, ?, ?, 1)
  ON CONFLICT(day, domain, metric) DO UPDATE SET sum = sum + excluded.sum, count = count + 1
`);
const upsertDurationBucket = db.prepare(`
  INSERT INTO duration_buckets (day, domain, metric, bucket_index, n) VALUES (?, ?, ?, ?, 1)
  ON CONFLICT(day, domain, metric, bucket_index) DO UPDATE SET n = n + 1
`);

// Tracks a running sum+count per day/domain/metric so an average can be computed later,
// without storing one record per render the way appendEvent's raw event log would. The
// bucket histogram alongside it is what lets a percentile be estimated later too —
// entries recorded before the histogram was added just have no `buckets` array, so
// their contribution to a percentile estimate is silently zero rather than wrong.
function recordDuration(domain, metric, ms) {
  if (typeof ms !== 'number') return;
  const day = new Date().toISOString().slice(0, 10);
  const d = domain || 'unknown';
  upsertDuration.run(day, d, metric, ms);
  upsertDurationBucket.run(day, d, metric, durationBucketIndex(ms));
}

function readDurations() {
  const base = db.prepare('SELECT day AS date, domain, metric, sum, count FROM durations').all();
  const bucketRows = db.prepare('SELECT day AS date, domain, metric, bucket_index, n FROM duration_buckets').all();
  const bucketsByKey = new Map();
  bucketRows.forEach((r) => {
    const key = `${r.date}|${r.domain}|${r.metric}`;
    const arr = bucketsByKey.get(key) || new Array(DURATION_BUCKETS_MS.length).fill(0);
    arr[r.bucket_index] = r.n;
    bucketsByKey.set(key, arr);
  });
  return base.map((r) => ({
    date: r.date,
    domain: r.domain,
    metric: r.metric,
    sum: r.sum,
    count: r.count,
    buckets: bucketsByKey.get(`${r.date}|${r.domain}|${r.metric}`) || null,
  }));
}

function pruneOldDurations() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  db.prepare('DELETE FROM durations WHERE day < ?').run(cutoff);
  db.prepare('DELETE FROM duration_buckets WHERE day < ?').run(cutoff);
}

// ─── url seen (duplicate-render tracking) ───────────────────────────────────

const upsertUrlSeen = db.prepare(`
  INSERT INTO url_seen (day, domain, url, n) VALUES (?, ?, ?, 1)
  ON CONFLICT(day, domain, url) DO UPDATE SET n = n + 1
  RETURNING n
`);

// How many times each URL has rendered successfully today, per domain — lets a
// "duplicate render" rate be derived (any render past the first for the same URL on
// the same day). Bounded by distinct URLs actually rendered per day rather than by
// domain/type/client cardinality like counts, so it can grow larger for high-traffic
// domains; pruned on the same 30-day cutoff as everything else.
function recordUrlSeen(domain, urlStr) {
  if (!urlStr) return 0;
  const day = new Date().toISOString().slice(0, 10);
  const row = upsertUrlSeen.get(day, domain || 'unknown', urlStr);
  return row ? row.n : 0;
}

// Aggregated in SQL rather than pulling every distinct URL into JS just to sum and
// discard them — url_seen can hold thousands of rows per day for a high-traffic domain.
function readUrlSeenSummary() {
  return db.prepare(`
    SELECT day AS date, domain,
           SUM(n) AS totalRenders,
           SUM(CASE WHEN n > 1 THEN n - 1 ELSE 0 END) AS duplicateRenders
    FROM url_seen
    GROUP BY day, domain
  `).all();
}

function pruneOldUrlSeen() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  db.prepare('DELETE FROM url_seen WHERE day < ?').run(cutoff);
}

// ─── route patterns ──────────────────────────────────────────────────────────

const upsertRoutePattern = db.prepare(`
  INSERT INTO route_patterns (day, domain, pattern, n) VALUES (?, ?, ?, 1)
  ON CONFLICT(day, domain, pattern) DO UPDATE SET n = n + 1
`);

// Same shape as counts but keyed by a normalized route pattern instead of event
// type/client — normalization (see routePattern.js) collapses IDs out of the path so
// cardinality stays close to the number of distinct route *shapes*, not distinct URLs.
function incrementRoutePattern(domain, pattern) {
  if (!pattern) return;
  const day = new Date().toISOString().slice(0, 10);
  upsertRoutePattern.run(day, domain || 'unknown', pattern);
}

function readRoutePatterns() {
  return db.prepare('SELECT day AS date, domain, pattern, n FROM route_patterns').all();
}

function pruneOldRoutePatterns() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  db.prepare('DELETE FROM route_patterns WHERE day < ?').run(cutoff);
}

// ─── cache stats ─────────────────────────────────────────────────────────────

const upsertCacheStat = db.prepare(`
  INSERT INTO cache_stats (day, domain, cache_name, outcome, n) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(day, domain, cache_name, outcome) DO UPDATE SET n = n + excluded.n
`);

// One bucket per day/domain/cache-name/outcome. cacheName distinguishes independent
// caches (e.g. "thesaurus" — renderer.js's in-process API response cache — vs
// "nginx_edge" — the X-Proxy-Cache status nginx forwards per request); outcome is
// cache-specific ("hit"/"miss" for thesaurus, the raw $upstream_cache_status value
// lowercased for nginx_edge). n can be >1 (batched hit/miss counts), unlike the other
// counters here, so this upserts n = n + excluded.n rather than a literal + 1.
function recordCacheCount(cacheName, domain, outcome, n = 1) {
  if (!n) return;
  const day = new Date().toISOString().slice(0, 10);
  upsertCacheStat.run(day, domain || 'unknown', cacheName, outcome, n);
}

function readCacheStats() {
  return db.prepare('SELECT day AS date, domain, cache_name AS cacheName, outcome, n FROM cache_stats').all();
}

function pruneOldCacheStats() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  db.prepare('DELETE FROM cache_stats WHERE day < ?').run(cutoff);
}

// ─── soft 404 urls ───────────────────────────────────────────────────────────

const upsertSoft404Url = db.prepare(`
  INSERT INTO soft_404_urls (url, last_seen_day) VALUES (?, ?)
  ON CONFLICT(url) DO UPDATE SET last_seen_day = excluded.last_seen_day
`);
const selectSoft404Url = db.prepare('SELECT 1 FROM soft_404_urls WHERE url = ?');

// URL -> last-seen day it was confirmed to render as a soft 404. Lets renderer.js
// short-circuit a URL it otherwise only suspects is bogus (e.g. matches
// COUNTRIES_SUFFIX_RE) once this service has actually seen it render a soft-404
// shell, without ever 404ing a URL that hasn't been confirmed bad first.
function recordSoft404Url(urlStr) {
  if (!urlStr) return;
  upsertSoft404Url.run(urlStr, new Date().toISOString().slice(0, 10));
}

function isKnownSoft404Url(urlStr) {
  return Boolean(urlStr && selectSoft404Url.get(urlStr));
}

function pruneOldSoft404Urls() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  db.prepare('DELETE FROM soft_404_urls WHERE last_seen_day < ?').run(cutoff);
}

function countSoft404Urls() {
  return db.prepare('SELECT COUNT(*) AS c FROM soft_404_urls').get().c;
}

// ─── backup ──────────────────────────────────────────────────────────────────

// Consistent point-in-time snapshot even while the live db is being written —
// piggybacked on the existing prune interval in server.js. No backup mechanism exists
// otherwise for this data (a single-node Docker volume, no replication).
function backupTo(backupPath) {
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
}

module.exports = {
  close,
  withTransaction,
  appendEvent,
  readRecentEvents,
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
  readUrlSeenSummary,
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
  backupTo,
  RETENTION_DAYS,
};
