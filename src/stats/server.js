const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const { classifyUserAgent } = require('./botDetect');
const { normalizeRoute } = require('./routePattern');
const slackReport = require('./slackReport');

const { DATA_DIR, DB_PATH } = require('./db');
const { runMigration } = require('./migrateToSqlite');

// One-off JSON->SQLite migration, gated on stats.db not existing yet. Must run before
// store.js is ever required — store.js opens DB_PATH as a module-load side effect and
// assumes it's already in its final (migrated-or-fresh) state.
if (!fs.existsSync(DB_PATH)) {
  runMigration({ dataDir: DATA_DIR, dbPath: DB_PATH });
}

const store = require('./store');

const PORT = Number(process.env.STATS_PORT) || 7200;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SLACK_REPORT_HOUR_UTC = 8;
const BACKUP_PATH = path.join(DATA_DIR, 'stats.backup.db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100kb' }));

app.post('/events', (req, res) => {
  const event = req.body || {};
  const client = classifyUserAgent(event.userAgent) || 'human';
  try {
    // One event fans out into several store calls — batched in a single transaction so
    // the update is atomic (no partial-apply if one call throws) and costs one WAL sync.
    store.withTransaction(() => {
      // Kept out of incrementCount — statusOf() on the dashboard buckets any unrecognized
      // type as "error", and a redirect/skipped-render is the opposite of a failure (it's
      // a render we avoided). Still appended to the raw event log below so the dashboard
      // can show a recent list for rollout monitoring.
      if (event.type !== 'legacy_url_redirect' && event.type !== 'malformed_url_404' && event.type !== 'security_probe_404') {
        store.incrementCount(event.type, event.domain, client);
        store.incrementHourlyCount(event.type, event.domain, client);
      }
      if (event.type !== 'render_success') {
        store.appendEvent(event);
      }
      if (event.type === 'soft_404' && event.url) {
        store.recordSoft404Url(event.url);
      }
      if (typeof event.durationMs === 'number') {
        store.recordDuration(event.domain, 'renderDurationMs', event.durationMs);
      }
      if (typeof event.queueWaitMs === 'number') {
        store.recordDuration(event.domain, 'queueWaitMs', event.queueWaitMs);
      }
      // Per-name breakdown (thesaurus/countries/jsdelivr — see CACHEABLE_ENTRIES in
      // renderer.js) rather than one pooled counter, so a jsdelivr URL's very different
      // hit-rate profile doesn't get blended into the API-lookup numbers.
      if (event.cacheCounts && typeof event.cacheCounts === 'object') {
        Object.entries(event.cacheCounts).forEach(([name, counts]) => {
          if (typeof counts.hit === 'number' && counts.hit) store.recordCacheCount(name, event.domain, 'hit', counts.hit);
          if (typeof counts.miss === 'number' && counts.miss) store.recordCacheCount(name, event.domain, 'miss', counts.miss);
        });
      }
      // Only ever a MISS/EXPIRED/STALE/BYPASS/REVALIDATED/UPDATING value — a true cache HIT
      // at the nginx edge never reaches this service in the first place, so "hit rate" isn't
      // derivable from this alone. This is "of the renders we did, why did each bypass cache."
      if (event.edgeCacheStatus) {
        store.recordCacheCount('nginx_edge', event.domain, event.edgeCacheStatus.toLowerCase(), 1);
      }
      // Scoped to successful renders only — a failed render didn't actually produce cached
      // output, so counting it as "duplicate work" or a "hot route" would overstate both.
      if (event.type === 'render_success' && event.url) {
        store.recordUrlSeen(event.domain, event.url);
        store.incrementRoutePattern(event.domain, normalizeRoute(event.url));
      }
    });
  } catch (e) {
    // Preserve the pre-SQLite contract: a stats-write problem never fails the caller
    // (statsReporter.js treats this endpoint as fire-and-forget).
    console.error('Failed to record stats event', e);
  }
  res.sendStatus(204);
});

// Live render activity, per instance — in-memory only, never persisted. Unlike
// counts/durations/events this has no historical value once an instance goes quiet,
// so it's kept separate from the rest of the store rather than written to disk.
const LIVE_INSTANCE_STALE_MS = 60 * 1000;
const liveInstances = {};

app.post('/live-status', (req, res) => {
  const { instance, activeRenders, rendering, queued, rssMB, heapUsedMB, externalMB, openPages, networkResponseCacheEntries } = req.body || {};
  if (!instance) return res.sendStatus(400);
  liveInstances[instance] = { activeRenders, rendering, queued, rssMB, heapUsedMB, externalMB, openPages, networkResponseCacheEntries, updatedAt: Date.now() };
  res.sendStatus(204);
});

app.get('/api/live', (req, res) => {
  const now = Date.now();
  const instances = Object.entries(liveInstances)
    .filter(([, v]) => now - v.updatedAt < LIVE_INSTANCE_STALE_MS)
    .map(([instance, v]) => ({
      instance,
      activeRenders: v.activeRenders,
      rendering: v.rendering || [],
      queued: v.queued || [],
      // Undefined on instances running an older renderer build that doesn't report
      // diagnostics yet — left out entirely rather than coerced to 0/null so the
      // dashboard can tell "unknown" apart from "actually zero".
      rssMB: v.rssMB,
      heapUsedMB: v.heapUsedMB,
      externalMB: v.externalMB,
      openPages: v.openPages,
      networkResponseCacheEntries: v.networkResponseCacheEntries,
      ageMs: now - v.updatedAt,
    }));
  res.json({ instances });
});

// Lets renderer.js confirm a URL it only suspects is bogus (matches
// COUNTRIES_SUFFIX_RE) has actually rendered as a soft 404 before, so it only ever
// short-circuits a URL this service has independently confirmed is bad.
app.get('/api/known-soft-404', (req, res) => {
  res.json({ known: store.isKnownSoft404Url(req.query.url) });
});

// The only remaining client/bot-label shaping needed at read time — the two legacy
// data-shape shims (pre-per-client-tracking plain numbers, the generic 'bot' client
// key) are resolved once by migrateToSqlite.js, not handled here, since all data at
// rest is already clean after migration.
function toBotField(client) {
  return client === 'human' ? null : client;
}

// Soft 404s and other bot-driven event types are typically high-volume; capping each
// type to its own "last N" window (rather than one shared cap across all events) keeps
// a busy type from crowding the others out of the payload entirely. `asOf`/`asOfHour`
// additionally scope the window to one specific day/hour.
const ERROR_LIKE_EXCLUDE_TYPES = ['soft_404', 'legacy_url_redirect', 'malformed_url_404', 'security_probe_404'];

app.get('/api/stats', (req, res) => {
  const rows = store.readCounts().map((r) => ({
    date: r.date, domain: r.domain, type: r.type, n: r.n, bot: toBotField(r.client),
  }));

  const dayPrefix = req.query.asOf;
  const recentErrors = store.readRecentEvents({ excludeTypes: ERROR_LIKE_EXCLUDE_TYPES, prefix: dayPrefix, limit: 200 });
  const recentSoftErrors = store.readRecentEvents({ includeTypes: ['soft_404'], prefix: dayPrefix, limit: 200 });
  // Temporary rollout-monitoring list for the missing-/database/-segment redirect —
  // remove once that's confirmed clean. See MISSING_DATABASE_SEGMENT_RE in renderer.js.
  const recentRedirects = store.readRecentEvents({ includeTypes: ['legacy_url_redirect'], prefix: dayPrefix, limit: 200 });
  // Bot-mangled URLs with a bot-appended /countries/<code> suffix (e.g.
  // .../register/countries/GM), short-circuited before rendering. See
  // COUNTRIES_SUFFIX_RE in renderer.js.
  const recentMalformedUrls = store.readRecentEvents({ includeTypes: ['malformed_url_404'], prefix: dayPrefix, limit: 200 });
  // Scanners probing for leaked credentials/secrets, short-circuited before
  // rendering. The claimed bot name (event.userAgent) is not to be trusted — this is
  // exactly the traffic that spoofs known-bot user agents. See SENSITIVE_PATH_RE in
  // renderer.js.
  const recentSecurityProbes = store.readRecentEvents({ includeTypes: ['security_probe_404'], prefix: dayPrefix, limit: 200 });

  // Feeds the standalone "Hourly snapshot" block the hourly Slack report screenshots
  // (see slackReport.js sendHourlyReport) — independent of the asOf/day filtering above.
  let hourly = null;
  if (req.query.asOfHour) {
    const hour = req.query.asOfHour;
    hourly = {
      hour,
      counts: store.readHourlyCounts(hour).map((r) => ({ domain: r.domain, type: r.type, n: r.n, bot: toBotField(r.client) })),
      recentErrors: store.readRecentEvents({ excludeTypes: ERROR_LIKE_EXCLUDE_TYPES, prefix: hour, limit: 50 }),
      recentSoftErrors: store.readRecentEvents({ includeTypes: ['soft_404'], prefix: hour, limit: 50 }),
    };
  }

  res.json({
    retentionDays: store.RETENTION_DAYS,
    counts: rows,
    durations: store.readDurations(),
    durationBucketBoundaries: store.DURATION_BUCKETS_MS,
    duplicates: store.readUrlSeenSummary(),
    routePatterns: store.readRoutePatterns(),
    cacheStats: store.readCacheStats(),
    recentErrors,
    recentSoftErrors,
    recentRedirects,
    recentMalformedUrls,
    recentSecurityProbes,
    knownSoft404UrlCount: store.countSoft404Urls(),
    hourly,
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Stats server listening on ${PORT}`);
});

// Swarm sends SIGTERM on every `docker service update --force` deploy — close cleanly
// so the WAL gets checkpointed back into stats.db rather than left to replay next boot.
process.on('SIGTERM', () => {
  store.close();
  process.exit(0);
});

setInterval(() => {
  const remaining = store.pruneOldEvents();
  store.pruneOldCounts();
  store.pruneOldHourlyCounts();
  store.pruneOldDurations();
  store.pruneOldUrlSeen();
  store.pruneOldRoutePatterns();
  store.pruneOldCacheStats();
  store.pruneOldSoft404Urls();
  console.log(`Pruned stats events, ${remaining} remaining`);

  // Consistent point-in-time snapshot even while the live db is being written — no
  // other backup mechanism exists for this data (a single-node Docker volume, no
  // replication). Written to a temp path and renamed into place, same atomicity
  // reasoning as everywhere else in this migration.
  try {
    const tmpBackupPath = `${BACKUP_PATH}.tmp`;
    if (fs.existsSync(tmpBackupPath)) fs.unlinkSync(tmpBackupPath);
    store.backupTo(tmpBackupPath);
    fs.renameSync(tmpBackupPath, BACKUP_PATH);
  } catch (e) {
    console.error('Failed to back up stats db', e);
  }
}, PRUNE_INTERVAL_MS);

function msUntilNextSlackReport() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SLACK_REPORT_HOUR_UTC, 0, 0, 0
  ));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

function msUntilNextHour() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next - now;
}

function runDailySlackReport() {
  slackReport.sendDailyReport(PORT).catch((err) => console.error('Failed to send Slack stats report', err));
}

function runHourlySlackReport() {
  slackReport.sendHourlyReport(PORT).catch((err) => console.error('Failed to send hourly Slack stats report', err));
}

if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID) {
  setTimeout(() => {
    runDailySlackReport();
    setInterval(runDailySlackReport, DAY_MS);
  }, msUntilNextSlackReport());

  setTimeout(() => {
    runHourlySlackReport();
    setInterval(runHourlySlackReport, HOUR_MS);
  }, msUntilNextHour());

  if (process.env.SLACK_TEST_MODE === 'true') {
    const TEST_INTERVAL_MS = 60 * 60 * 1000;
    runDailySlackReport();
    setInterval(runDailySlackReport, TEST_INTERVAL_MS);
    runHourlySlackReport();
  }
}
