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

// events.jsonl can be tens of MB (one line per non-render_success event, no retention
// cap applied until pruneOldEvents runs) — readFileSync + split + map would hold the
// raw text, the split line array, AND a fully-parsed object array in memory all at
// once, easily multiplying a modest file size into a container-OOM-killing spike (this
// is exactly what happened in production: a 48MB events.jsonl OOM-killed the 1024M-
// limited stats container three times before this file ever got read to see why).
// Reads in fixed-size byte chunks and only ever decodes one COMPLETE line at a time —
// splitting on the raw newline byte before decoding UTF-8 avoids corrupting a multi-byte
// character that happens to straddle a chunk boundary.
function forEachJsonlLine(filePath, onLine) {
  if (!fs.existsSync(filePath)) return;
  const CHUNK_SIZE = 1024 * 1024;
  const readBuf = Buffer.alloc(CHUNK_SIZE);
  let pending = Buffer.alloc(0);
  const fd = fs.openSync(filePath, 'r');
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, readBuf, 0, CHUNK_SIZE, null)) > 0) {
      pending = Buffer.concat([pending, readBuf.subarray(0, bytesRead)]);
      let newlineIdx;
      while ((newlineIdx = pending.indexOf(0x0a)) !== -1) {
        const line = pending.subarray(0, newlineIdx).toString('utf8');
        pending = pending.subarray(newlineIdx + 1);
        if (line) onLine(line);
      }
    }
    if (pending.length) onLine(pending.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
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
// Streamed via forEachJsonlLine (see above) rather than reading the whole file — this
// is by far the largest legacy file in practice and the one that OOM-killed the
// migration in production before this fix.
function migrateEvents(db, filePath) {
  const upsert = db.prepare(`
    INSERT INTO events (type, domain, url, ip, user_agent, referer, country, edge_cache_status, error, reason, redirect_to, queue_wait_ms, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let rows = 0;
  let malformed = 0;
  forEachJsonlLine(filePath, (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch (e) {
      malformed++;
      return;
    }
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
    if (rows % 50000 === 0) console.log(`migrateToSqlite: events.jsonl — ${rows} rows so far`);
  });
  if (malformed) console.log(`migrateToSqlite: skipped ${malformed} malformed line(s) in events.jsonl`);
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

  console.log(`migrateToSqlite: starting, dataDir=${dataDir}`);
  const db = openDatabase(tmpPath);
  const counts = {};
  try {
    db.exec('BEGIN');
    counts.counts = migrateCounts(db, 'counts', 'day', readJsonLegacy(path.join(dataDir, 'counts.json')));
    console.log(`migrateToSqlite: counts done (${counts.counts} rows)`);
    counts.hourlyCounts = migrateCounts(db, 'hourly_counts', 'hour', readJsonLegacy(path.join(dataDir, 'hourlyCounts.json')));
    console.log(`migrateToSqlite: hourlyCounts done (${counts.hourlyCounts} rows)`);
    counts.durations = migrateDurations(db, readJsonLegacy(path.join(dataDir, 'durations.json')));
    console.log(`migrateToSqlite: durations done (${counts.durations} rows)`);
    counts.urlSeen = migrateUrlSeen(db, readJsonLegacy(path.join(dataDir, 'urlSeen.json')));
    console.log(`migrateToSqlite: urlSeen done (${counts.urlSeen} rows)`);
    counts.routePatterns = migrateRoutePatterns(db, readJsonLegacy(path.join(dataDir, 'routePatterns.json')));
    console.log(`migrateToSqlite: routePatterns done (${counts.routePatterns} rows)`);
    counts.cacheStats = migrateCacheStats(db, readJsonLegacy(path.join(dataDir, 'cacheStats.json')));
    console.log(`migrateToSqlite: cacheStats done (${counts.cacheStats} rows)`);
    counts.soft404Urls = migrateSoft404Urls(db, readJsonLegacy(path.join(dataDir, 'soft404Urls.json')));
    console.log(`migrateToSqlite: soft404Urls done (${counts.soft404Urls} rows)`);
    counts.events = migrateEvents(db, path.join(dataDir, 'events.jsonl'));
    console.log(`migrateToSqlite: events done (${counts.events} rows)`);
    console.log('migrateToSqlite: committing transaction');
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
