const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.STATS_DATA_DIR || path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'stats.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

// Shared by store.js (the live runtime path) and migrateToSqlite.js (the one-off
// import), so the schema can never drift between the two. CREATE TABLE IF NOT EXISTS
// is idempotent — safe to run against both a brand-new file and an already-migrated one.
function openDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  // Lets an operator open the live db read-only (sqlite3 CLI, ad hoc debugging) without
  // an immediate SQLITE_BUSY — this is a single-writer service, so there's no real
  // contention to wait out, just a courtesy window for a concurrent reader.
  db.exec('PRAGMA busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      type TEXT,
      domain TEXT,
      url TEXT,
      ip TEXT,
      user_agent TEXT,
      referer TEXT,
      country TEXT,
      edge_cache_status TEXT,
      error TEXT,
      reason TEXT,
      redirect_to TEXT,
      queue_wait_ms INTEGER,
      timestamp TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

    CREATE TABLE IF NOT EXISTS counts (
      day TEXT, domain TEXT, type TEXT, client TEXT, n INTEGER,
      PRIMARY KEY (day, domain, type, client)
    );

    CREATE TABLE IF NOT EXISTS hourly_counts (
      hour TEXT, domain TEXT, type TEXT, client TEXT, n INTEGER,
      PRIMARY KEY (hour, domain, type, client)
    );

    CREATE TABLE IF NOT EXISTS url_seen (
      day TEXT, domain TEXT, url TEXT, n INTEGER,
      PRIMARY KEY (day, domain, url)
    );

    CREATE TABLE IF NOT EXISTS route_patterns (
      day TEXT, domain TEXT, pattern TEXT, n INTEGER,
      PRIMARY KEY (day, domain, pattern)
    );

    CREATE TABLE IF NOT EXISTS cache_stats (
      day TEXT, domain TEXT, cache_name TEXT, outcome TEXT, n INTEGER,
      PRIMARY KEY (day, domain, cache_name, outcome)
    );

    CREATE TABLE IF NOT EXISTS soft_404_urls (
      url TEXT PRIMARY KEY,
      last_seen_day TEXT
    );

    CREATE TABLE IF NOT EXISTS durations (
      day TEXT, domain TEXT, metric TEXT, sum INTEGER, count INTEGER,
      PRIMARY KEY (day, domain, metric)
    );

    -- Split out of durations so every field is a pure additive upsert (no
    -- select-then-mutate-then-write) — recordDuration fires on every render.
    CREATE TABLE IF NOT EXISTS duration_buckets (
      day TEXT, domain TEXT, metric TEXT, bucket_index INTEGER, n INTEGER,
      PRIMARY KEY (day, domain, metric, bucket_index)
    );
  `);

  return db;
}

module.exports = { openDatabase, DATA_DIR, DB_PATH };
