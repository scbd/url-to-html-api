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

  // Distinguishes "brand-new file, base schema below already has everything" from
  // "existing db that predates a schema change" — checked before the CREATE TABLE
  // block runs, since that block's IF NOT EXISTS would otherwise make both cases look
  // identical afterward. A fresh db gets stamped straight to the latest version (its
  // schema is already current); an existing older one runs the migrations that bring
  // it up to date. Without this, a fresh install would run migrations against a table
  // that already has their columns and error (ALTER TABLE ADD COLUMN has no IF NOT
  // EXISTS in SQLite).
  const isFreshDb = !db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").get();

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
      timestamp TEXT,
      instance TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

    -- Same upsert-counter shape as hourly_counts, keyed by instance instead of
    -- domain+client — feeds the Live Activity tab's per-instance restart count/error
    -- rate. Same 48h retention as hourly_counts (live-health signal, not long-term
    -- trend data — counts already covers that, scoped by domain).
    CREATE TABLE IF NOT EXISTS instance_counts (
      hour TEXT, instance TEXT, type TEXT, n INTEGER,
      PRIMARY KEY (hour, instance, type)
    );

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

    -- Same running sum+count shape as durations, keyed by instance instead of
    -- domain+metric — rendered-response byte size per instance, so a per-instance
    -- total (and average) can be derived without storing one row per render.
    CREATE TABLE IF NOT EXISTS instance_bytes (
      day TEXT, instance TEXT, sum INTEGER, count INTEGER,
      PRIMARY KEY (day, instance)
    );
  `);

  if (isFreshDb) {
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
  } else {
    runMigrations(db);
  }

  return db;
}

// The base CREATE TABLE block above is always the latest schema shape, so a fresh
// install never needs these — CREATE TABLE IF NOT EXISTS silently no-ops on a table
// that already exists (confirmed the hard way: this is exactly how the first schema
// change after the JSON->SQLite migration would have shipped with the new column
// simply never appearing on the already-migrated production db). Each entry here is
// the ALTER/CREATE needed to bring an *existing* older db up to the current shape.
// Runs automatically on every boot via PRAGMA user_version — a no-op loop once
// already current, so unlike the JSON migration this needs no separate boot-time gate.
const MIGRATIONS = [
  // v0 -> v1: events.instance (tags which replica produced each event) + instance_counts.
  (db) => {
    db.exec('ALTER TABLE events ADD COLUMN instance TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS instance_counts (
        hour TEXT, instance TEXT, type TEXT, n INTEGER,
        PRIMARY KEY (hour, instance, type)
      );
    `);
  },
  // v1 -> v2: instance_bytes (per-instance rendered-response-size tracking).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS instance_bytes (
        day TEXT, instance TEXT, sum INTEGER, count INTEGER,
        PRIMARY KEY (day, instance)
      );
    `);
  },
];

function runMigrations(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  if (current >= MIGRATIONS.length) return;
  db.exec('BEGIN');
  try {
    for (let v = current; v < MIGRATIONS.length; v++) MIGRATIONS[v](db);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { openDatabase, DATA_DIR, DB_PATH };
