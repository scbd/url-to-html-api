const path = require('path');
const express = require('express');
const cors = require('cors');
const store = require('./store');
const { classifyUserAgent } = require('./botDetect');

const PORT = Number(process.env.STATS_PORT) || 7200;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

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

  res.json({
    retentionDays: store.RETENTION_DAYS,
    counts: rows,
    recent: store.readEvents().slice(-200).reverse(),
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
