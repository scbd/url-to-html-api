const fs = require('fs');
const path = require('path');
const { openDatabase } = require('./db');

// Historical data recorded before per-bot-name tracking existed used the generic
// client key 'bot' — same constant as server.js's LEGACY_BOT_LABEL, duplicated here
// since this script must never depend on runtime modules (see note on store.js below).
const LEGACY_BOT_LABEL = 'Unclassified bot';

function readJsonLegacy(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error(`migrateToSqlite: skipping unreadable ${filePath}: ${e.message}`);
    return null;
  }
}

function readEventsJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
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

// counts.json / hourlyCounts.json: {bucket: {domain: {type: byClient}}}, where byClient
// is either a plain number (pre-per-client-tracking data, implicitly all human) or
// {client: n} (with a generic 'bot' client key predating per-bot-name tracking).
// Resolves both legacy shapes into clean {client, n} rows so no runtime code needs to
// handle them after this migration.
function migrateCounts(db, tableName, bucketKeyName, legacyData) {
  if (!legacyData) return 0;
  const upsert = db.prepare(`
    INSERT INTO ${tableName} (${bucketKeyName}, domain, type, client, n) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(${bucketKeyName}, domain, type, client) DO UPDATE SET n = n + excluded.n
  `);
  let rows = 0;
  Object.entries(legacyData).forEach(([bucket, domains]) => {
    Object.entries(domains).forEach(([domain, types]) => {
      Object.entries(types).forEach(([type, byClient]) => {
        if (typeof byClient === 'number') {
          upsert.run(bucket, domain, type, 'human', byClient);
          rows++;
          return;
        }
        Object.entries(byClient).forEach(([client, n]) => {
          const resolvedClient = client === 'bot' ? LEGACY_BOT_LABEL : client;
          upsert.run(bucket, domain, type, resolvedClient, n);
          rows++;
        });
      });
    });
  });
  return rows;
}

// durations.json: {day: {domain: {metric: {sum, count, buckets}}}}.
function migrateDurations(db, legacyData) {
  if (!legacyData) return 0;
  const upsertDuration = db.prepare('INSERT INTO durations (day, domain, metric, sum, count) VALUES (?, ?, ?, ?, ?)');
  const upsertBucket = db.prepare('INSERT INTO duration_buckets (day, domain, metric, bucket_index, n) VALUES (?, ?, ?, ?, ?)');
  let rows = 0;
  Object.entries(legacyData).forEach(([day, domains]) => {
    Object.entries(domains).forEach(([domain, metrics]) => {
      Object.entries(metrics).forEach(([metric, { sum, count, buckets }]) => {
        upsertDuration.run(day, domain, metric, sum, count);
        rows++;
        (buckets || []).forEach((n, idx) => {
          if (n) upsertBucket.run(day, domain, metric, idx, n);
        });
      });
    });
  });
  return rows;
}

// urlSeen.json: {day: {domain: {url: n}}}.
function migrateUrlSeen(db, legacyData) {
  if (!legacyData) return 0;
  const upsert = db.prepare('INSERT INTO url_seen (day, domain, url, n) VALUES (?, ?, ?, ?)');
  let rows = 0;
  Object.entries(legacyData).forEach(([day, domains]) => {
    Object.entries(domains).forEach(([domain, urls]) => {
      Object.entries(urls).forEach(([url, n]) => {
        upsert.run(day, domain, url, n);
        rows++;
      });
    });
  });
  return rows;
}

// routePatterns.json: {day: {domain: {pattern: n}}}.
function migrateRoutePatterns(db, legacyData) {
  if (!legacyData) return 0;
  const upsert = db.prepare('INSERT INTO route_patterns (day, domain, pattern, n) VALUES (?, ?, ?, ?)');
  let rows = 0;
  Object.entries(legacyData).forEach(([day, domains]) => {
    Object.entries(domains).forEach(([domain, patterns]) => {
      Object.entries(patterns).forEach(([pattern, n]) => {
        upsert.run(day, domain, pattern, n);
        rows++;
      });
    });
  });
  return rows;
}

// cacheStats.json: {day: {domain: {cacheName: {outcome: n}}}}.
function migrateCacheStats(db, legacyData) {
  if (!legacyData) return 0;
  const upsert = db.prepare('INSERT INTO cache_stats (day, domain, cache_name, outcome, n) VALUES (?, ?, ?, ?, ?)');
  let rows = 0;
  Object.entries(legacyData).forEach(([day, domains]) => {
    Object.entries(domains).forEach(([domain, caches]) => {
      Object.entries(caches).forEach(([cacheName, outcomes]) => {
        Object.entries(outcomes).forEach(([outcome, n]) => {
          upsert.run(day, domain, cacheName, outcome, n);
          rows++;
        });
      });
    });
  });
  return rows;
}

// soft404Urls.json: {url: lastSeenDay}.
function migrateSoft404Urls(db, legacyData) {
  if (!legacyData) return 0;
  const upsert = db.prepare('INSERT INTO soft_404_urls (url, last_seen_day) VALUES (?, ?)');
  let rows = 0;
  Object.entries(legacyData).forEach(([url, lastSeenDay]) => {
    upsert.run(url, lastSeenDay);
    rows++;
  });
  return rows;
}

// events.jsonl: one flat camelCase event object per line. render_success is never
// expected here (appendEvent never wrote it), but skip defensively rather than assume.
function migrateEvents(db, events) {
  const upsert = db.prepare(`
    INSERT INTO events (type, domain, url, ip, user_agent, referer, country, edge_cache_status, error, reason, redirect_to, queue_wait_ms, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let rows = 0;
  events.forEach((event) => {
    if (event.type === 'render_success') return;
    upsert.run(
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
      event.timestamp ?? null
    );
    rows++;
  });
  return rows;
}

// Builds the new store into `${dbPath}.tmp` inside one transaction spanning every
// table, then atomically renames it into place — so a crash partway through this
// process leaves only the untouched temp file, never a half-populated stats.db. A
// missing or still-corrupt legacy file (from before the JSON stores got an atomic-write
// fix) is logged and skipped, not fatal — this must never depend on `store.js`/`server.js`
// (which assume stats.db already exists) to avoid a circular boot-order dependency.
function runMigration({ dataDir, dbPath }) {
  const tmpPath = `${dbPath}.tmp`;
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);

  const db = openDatabase(tmpPath);
  const counts = {};
  try {
    db.exec('BEGIN');
    counts.counts = migrateCounts(db, 'counts', 'day', readJsonLegacy(path.join(dataDir, 'counts.json')));
    counts.hourlyCounts = migrateCounts(db, 'hourly_counts', 'hour', readJsonLegacy(path.join(dataDir, 'hourlyCounts.json')));
    counts.durations = migrateDurations(db, readJsonLegacy(path.join(dataDir, 'durations.json')));
    counts.urlSeen = migrateUrlSeen(db, readJsonLegacy(path.join(dataDir, 'urlSeen.json')));
    counts.routePatterns = migrateRoutePatterns(db, readJsonLegacy(path.join(dataDir, 'routePatterns.json')));
    counts.cacheStats = migrateCacheStats(db, readJsonLegacy(path.join(dataDir, 'cacheStats.json')));
    counts.soft404Urls = migrateSoft404Urls(db, readJsonLegacy(path.join(dataDir, 'soft404Urls.json')));
    counts.events = migrateEvents(db, readEventsJsonl(path.join(dataDir, 'events.jsonl')));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    db.close();
    fs.unlinkSync(tmpPath);
    throw e;
  }
  db.close();

  fs.renameSync(tmpPath, dbPath);
  console.log('migrateToSqlite: migrated', JSON.stringify(counts));
  // Deliberately not deleting/renaming the original JSON/JSONL files — if this ships
  // with a bug and the image gets rolled back to the pre-migration store.js, it needs
  // those files intact to resume from, not silently start over from empty.
}

if (require.main === module) {
  const { DATA_DIR, DB_PATH } = require('./db');
  try {
    runMigration({ dataDir: DATA_DIR, dbPath: DB_PATH });
  } catch (e) {
    console.error('migrateToSqlite: migration failed', e);
    process.exit(1);
  }
}

module.exports = { runMigration };
