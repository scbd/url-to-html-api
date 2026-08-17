const path = require('path');
const express = require('express');
const cors = require('cors');
const store = require('./store');

const PORT = Number(process.env.STATS_PORT) || 7200;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const app = express();
app.use(cors());
app.use(express.json({ limit: '100kb' }));

app.post('/events', (req, res) => {
  const event = req.body || {};
  store.incrementCount(event.type, event.domain);
  if (event.type !== 'render_success') {
    store.appendEvent(event);
  }
  res.sendStatus(204);
});

app.get('/api/stats', (req, res) => {
  const counts = store.readCounts();
  const rows = [];

  Object.entries(counts).forEach(([date, domains]) => {
    Object.entries(domains).forEach(([domain, types]) => {
      Object.entries(types).forEach(([type, n]) => {
        rows.push({ date, domain, type, n });
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
