const path = require('path');
const express = require('express');
const cors = require('cors');
const store = require('./store');
const { classifyUserAgent } = require('./botDetect');
const { normalizeRoute } = require('./routePattern');
const slackReport = require('./slackReport');

const PORT = Number(process.env.STATS_PORT) || 7200;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SLACK_REPORT_HOUR_UTC = 8;

const app = express();
app.use(cors());
app.use(express.json({ limit: '100kb' }));

app.post('/events', (req, res) => {
  const event = req.body || {};
  const client = classifyUserAgent(event.userAgent) || 'human';
  // Kept out of incrementCount — statusOf() on the dashboard buckets any unrecognized
  // type as "error", and a redirect/skipped-render is the opposite of a failure (it's
  // a render we avoided). Still appended to the raw event log below so the dashboard
  // can show a recent list for rollout monitoring.
  if (event.type !== 'legacy_url_redirect' && event.type !== 'malformed_url_404' && event.type !== 'security_probe_404') {
    store.incrementCount(event.type, event.domain, client);
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

// Pre-migration data (before per-bot-name tracking) stored this bucket's bot traffic
// under the generic key 'bot' rather than a specific bot name.
const LEGACY_BOT_LABEL = 'Unclassified bot';

app.get('/api/stats', (req, res) => {
  const counts = store.readCounts();
  const rows = [];

  Object.entries(counts).forEach(([date, domains]) => {
    Object.entries(domains).forEach(([domain, types]) => {
      Object.entries(types).forEach(([type, byClient]) => {
        if (typeof byClient === 'number') {
          rows.push({ date, domain, type, bot: null, n: byClient });
          return;
        }
        Object.entries(byClient).forEach(([client, n]) => {
          let bot = null;
          if (client === 'bot') bot = LEGACY_BOT_LABEL;
          else if (client !== 'human') bot = client;
          rows.push({ date, domain, type, bot, n });
        });
      });
    });
  });

  // Soft 404s are typically high-volume bot traffic; capping errors/restarts and
  // soft 404s to one shared "last 200" window lets soft 404s crowd real errors out
  // of the payload entirely, so each type gets its own window instead.
  // asOf additionally scopes the window to one specific day — without it, a busier
  // later day can just as easily crowd an earlier day's errors out of a global cap.
  let allEvents = store.readEvents();
  if (req.query.asOf) {
    allEvents = allEvents.filter((e) => e.timestamp.slice(0, 10) === req.query.asOf);
  }
  const recentErrors = allEvents.filter((e) => e.type !== 'soft_404' && e.type !== 'legacy_url_redirect' && e.type !== 'malformed_url_404' && e.type !== 'security_probe_404').slice(-200).reverse();
  const recentSoftErrors = allEvents.filter((e) => e.type === 'soft_404').slice(-200).reverse();
  // Temporary rollout-monitoring list for the missing-/database/-segment redirect —
  // remove once that's confirmed clean. See MISSING_DATABASE_SEGMENT_RE in renderer.js.
  const recentRedirects = allEvents.filter((e) => e.type === 'legacy_url_redirect').slice(-200).reverse();
  // Bot-mangled URLs with a bot-appended /countries/<code> suffix (e.g.
  // .../register/countries/GM), short-circuited before rendering. See
  // COUNTRIES_SUFFIX_RE in renderer.js.
  const recentMalformedUrls = allEvents.filter((e) => e.type === 'malformed_url_404').slice(-200).reverse();

  const durationRows = [];
  Object.entries(store.readDurations()).forEach(([date, domains]) => {
    Object.entries(domains).forEach(([domain, metrics]) => {
      Object.entries(metrics).forEach(([metric, { sum, count, buckets }]) => {
        durationRows.push({ date, domain, metric, sum, count, buckets: buckets || null });
      });
    });
  });

  // Aggregated server-side rather than shipping the raw per-URL/per-domain maps to the
  // client — those can hold thousands of distinct URLs per day, far more than the
  // handful of numbers the dashboard actually needs from them.
  const duplicateRows = [];
  Object.entries(store.readUrlSeen()).forEach(([date, domains]) => {
    Object.entries(domains).forEach(([domain, urls]) => {
      let totalRenders = 0;
      let duplicateRenders = 0;
      Object.values(urls).forEach((n) => {
        totalRenders += n;
        if (n > 1) duplicateRenders += n - 1;
      });
      duplicateRows.push({ date, domain, totalRenders, duplicateRenders });
    });
  });

  const routePatternRows = [];
  Object.entries(store.readRoutePatterns()).forEach(([date, domains]) => {
    Object.entries(domains).forEach(([domain, patterns]) => {
      Object.entries(patterns).forEach(([pattern, n]) => {
        routePatternRows.push({ date, domain, pattern, n });
      });
    });
  });

  const cacheStatRows = [];
  Object.entries(store.readCacheStats()).forEach(([date, domains]) => {
    Object.entries(domains).forEach(([domain, caches]) => {
      Object.entries(caches).forEach(([cacheName, outcomes]) => {
        Object.entries(outcomes).forEach(([outcome, n]) => {
          cacheStatRows.push({ date, domain, cacheName, outcome, n });
        });
      });
    });
  });

  res.json({
    retentionDays: store.RETENTION_DAYS,
    counts: rows,
    durations: durationRows,
    durationBucketBoundaries: store.DURATION_BUCKETS_MS,
    duplicates: duplicateRows,
    routePatterns: routePatternRows,
    cacheStats: cacheStatRows,
    recentErrors,
    recentSoftErrors,
    recentRedirects,
    recentMalformedUrls,
    knownSoft404UrlCount: store.countSoft404Urls(),
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Stats server listening on ${PORT}`);
});

setInterval(() => {
  const remaining = store.pruneOldEvents();
  store.pruneOldCounts();
  store.pruneOldDurations();
  store.pruneOldUrlSeen();
  store.pruneOldRoutePatterns();
  store.pruneOldCacheStats();
  store.pruneOldSoft404Urls();
  console.log(`Pruned stats events, ${remaining} remaining`);
}, PRUNE_INTERVAL_MS);

function msUntilNextSlackReport() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SLACK_REPORT_HOUR_UTC, 0, 0, 0
  ));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

function runDailySlackReport() {
  slackReport.sendDailyReport(PORT).catch((err) => console.error('Failed to send Slack stats report', err));
}

if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID) {
  setTimeout(() => {
    runDailySlackReport();
    setInterval(runDailySlackReport, DAY_MS);
  }, msUntilNextSlackReport());

  if (process.env.SLACK_TEST_MODE === 'true') {
    const TEST_INTERVAL_MS = 60 * 60 * 1000;
    runDailySlackReport();
    setInterval(runDailySlackReport, TEST_INTERVAL_MS);
  }
}
