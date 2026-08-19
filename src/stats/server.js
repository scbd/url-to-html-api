const path = require('path');
const express = require('express');
const cors = require('cors');
const store = require('./store');
const { classifyUserAgent } = require('./botDetect');
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
  store.incrementCount(event.type, event.domain, client);
  if (event.type !== 'render_success') {
    store.appendEvent(event);
  }
  res.sendStatus(204);
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
  const recentErrors = allEvents.filter((e) => e.type !== 'soft_404').slice(-200).reverse();
  const recentSoftErrors = allEvents.filter((e) => e.type === 'soft_404').slice(-200).reverse();

  res.json({
    retentionDays: store.RETENTION_DAYS,
    counts: rows,
    recentErrors,
    recentSoftErrors,
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Stats server listening on ${PORT}`);
});

setInterval(() => {
  const remaining = store.pruneOldEvents();
  store.pruneOldCounts();
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
