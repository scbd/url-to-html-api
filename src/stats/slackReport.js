const store = require('./store');
const screenshot = require('./screenshot');

function statusOf(type) {
  if (type === 'render_success') return 'success';
  if (type === 'browser_restart') return 'restart';
  if (type === 'soft_404') return 'soft_error';
  return 'error';
}

function yesterday() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// The hour that just completed, e.g. run at 14:00 UTC -> "2026-08-21T13".
function lastCompleteHour() {
  return new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 13);
}

// `rows` are flat {domain, type, client, n} counts — the legacy plain-number/generic-
// 'bot'-client data shapes are resolved once by migrateToSqlite.js, not handled here.
function summarizeCounts(rows) {
  const totals = { success: 0, error: 0, restart: 0, soft_error: 0 };
  const byDomain = {};
  let botTotal = 0;
  let grandTotal = 0;

  rows.forEach(({ domain, type, client, n }) => {
    const status = statusOf(type);
    totals[status] += n;
    grandTotal += n;
    byDomain[domain] = (byDomain[domain] || 0) + n;
    if (client !== 'human') botTotal += n;
  });

  const topDomains = Object.entries(byDomain).sort((a, b) => b[1] - a[1]).slice(0, 3);

  return { totals, topDomains, botTotal, grandTotal };
}

function summarizeDay(day) {
  const rows = store.readCounts().filter((r) => r.date === day);
  return { day, ...summarizeCounts(rows) };
}

function summarizeHour(hour) {
  return { hour, ...summarizeCounts(store.readHourlyCounts(hour)) };
}

function statsBodyText({ totals, topDomains, botTotal, grandTotal }) {
  const renderTotal = totals.success + totals.error;
  const errorRate = renderTotal ? ((totals.error / renderTotal) * 100).toFixed(1) : '0.0';
  const botPct = grandTotal ? ((botTotal / grandTotal) * 100).toFixed(1) : '0.0';
  const domainLines = topDomains.length
    ? topDomains.map(([domain, n]) => `• ${domain}: ${n.toLocaleString()}`).join('\n')
    : '• No traffic';

  return [
    `Successes: ${totals.success.toLocaleString()}  |  Errors: ${totals.error.toLocaleString()}  |  Soft errors: ${totals.soft_error.toLocaleString()}  |  Restarts: ${totals.restart.toLocaleString()}`,
    `Error rate: ${errorRate}%  |  Bot traffic: ${botPct}%`,
    'Top domains:',
    domainLines,
  ].join('\n');
}

function formatMessage(summary) {
  const text = [`*Prerender stats — ${summary.day}*`, statsBodyText(summary)].join('\n');
  return { text };
}

function hourLabel(hour) {
  const day = hour.slice(0, 10);
  const startHour = Number(hour.slice(11, 13));
  const endHour = (startHour + 1) % 24;
  return `${day} ${String(startHour).padStart(2, '0')}:00–${String(endHour).padStart(2, '0')}:00 UTC`;
}

function formatHourlyMessage(summary) {
  const text = [`*Prerender stats (hourly) — ${hourLabel(summary.hour)}*`, statsBodyText(summary)].join('\n');
  return { text };
}

async function slackApi(method, token, body, isJson) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': isJson ? 'application/json' : 'application/x-www-form-urlencoded',
    },
    body: isJson ? JSON.stringify(body) : new URLSearchParams(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method} failed: ${data.error}`);
  return data;
}

async function uploadFileBytes(uploadUrl, buffer, filename) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/png' }), filename);
  const res = await fetch(uploadUrl, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Upload to Slack failed: ${res.status}`);
}

// `tab` names the dashboard tab each section now lives behind — 'overview' is the
// default active tab so it needs no click, the other two do.
const SNAPSHOT_SECTIONS = [
  { tab: null, selector: '#snap-section-1' },
  { tab: 'traffic', selector: '#snap-section-2' },
  { tab: 'errors', selector: '#snap-section-3' },
];
const SECTION_TITLES = ['Overview & by domain', 'Crawlers by volume', 'Grouped failures & soft 404s'];

// The hourly Slack report screenshots the standalone hourly-snapshot block on the
// dashboard (see ASOF_HOUR_PARAM / #snap-hour-* in public/index.html) rather than the
// day-range sections above — no tab click needed since it lives outside the tabs.
const HOURLY_SNAPSHOT_SECTIONS = [
  { tab: null, selector: '#snap-hour-1' },
  { tab: null, selector: '#snap-hour-2' },
];
const HOURLY_SECTION_TITLES = ['Overview & top domains', 'Errors & soft 404s'];

async function uploadOneFile(token, buffer, filename) {
  const { upload_url: uploadUrl, file_id: fileId } = await slackApi(
    'files.getUploadURLExternal', token, { filename, length: String(buffer.length) }
  );
  await uploadFileBytes(uploadUrl, buffer, filename);
  return fileId;
}

async function postSnapshotToSlack({ pngs, day, caption, sectionTitles = SECTION_TITLES }) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;
  if (!token || !channelId) throw new Error('SLACK_BOT_TOKEN or SLACK_CHANNEL_ID not set');

  const fileIds = [];
  for (let i = 0; i < pngs.length; i++) {
    fileIds.push(await uploadOneFile(token, pngs[i], `prerender-stats-${day}-${i + 1}.png`));
  }

  await slackApi('files.completeUploadExternal', token, {
    files: fileIds.map((id, i) => ({ id, title: `Prerender stats — ${day} · ${sectionTitles[i] || i + 1}` })),
    channel_id: channelId,
    initial_comment: caption,
  }, true);
}

async function sendDailyReport(port) {
  const day = yesterday();
  const summary = summarizeDay(day);
  const caption = formatMessage(summary).text;
  const pngs = await screenshot.renderUrlSectionPngs(`http://localhost:${port}/?asOf=${day}`, SNAPSHOT_SECTIONS);
  await postSnapshotToSlack({ pngs, day, caption });
}

async function sendHourlyReport(port) {
  const hour = lastCompleteHour();
  const summary = summarizeHour(hour);
  const caption = formatHourlyMessage(summary).text;
  const pngs = await screenshot.renderUrlSectionPngs(`http://localhost:${port}/?asOfHour=${hour}`, HOURLY_SNAPSHOT_SECTIONS);
  await postSnapshotToSlack({ pngs, day: hour, caption, sectionTitles: HOURLY_SECTION_TITLES });
}

module.exports = {
  sendDailyReport, summarizeDay, formatMessage,
  sendHourlyReport, summarizeHour, formatHourlyMessage,
};
