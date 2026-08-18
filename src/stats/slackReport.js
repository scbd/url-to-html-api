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

function summarizeDay(day) {
  const counts = store.readCounts()[day] || {};
  const totals = { success: 0, error: 0, restart: 0, soft_error: 0 };
  const byDomain = {};
  let botTotal = 0;
  let grandTotal = 0;

  Object.entries(counts).forEach(([domain, types]) => {
    Object.entries(types).forEach(([type, byClient]) => {
      const status = statusOf(type);
      // Pre-migration data stored this bucket as a plain number, all of it human traffic.
      const clients = typeof byClient === 'number' ? { human: byClient } : byClient;
      Object.entries(clients).forEach(([client, n]) => {
        totals[status] += n;
        grandTotal += n;
        byDomain[domain] = (byDomain[domain] || 0) + n;
        if (client !== 'human') botTotal += n;
      });
    });
  });

  const topDomains = Object.entries(byDomain).sort((a, b) => b[1] - a[1]).slice(0, 3);

  return { day, totals, topDomains, botTotal, grandTotal };
}

function formatMessage(summary) {
  const { day, totals, topDomains, botTotal, grandTotal } = summary;
  const renderTotal = totals.success + totals.error;
  const errorRate = renderTotal ? ((totals.error / renderTotal) * 100).toFixed(1) : '0.0';
  const botPct = grandTotal ? ((botTotal / grandTotal) * 100).toFixed(1) : '0.0';
  const domainLines = topDomains.length
    ? topDomains.map(([domain, n]) => `• ${domain}: ${n.toLocaleString()}`).join('\n')
    : '• No traffic';

  const text = [
    `*Prerender stats — ${day}*`,
    `Successes: ${totals.success.toLocaleString()}  |  Errors: ${totals.error.toLocaleString()}  |  Soft errors: ${totals.soft_error.toLocaleString()}  |  Restarts: ${totals.restart.toLocaleString()}`,
    `Error rate: ${errorRate}%  |  Bot traffic: ${botPct}%`,
    'Top domains:',
    domainLines,
  ].join('\n');

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

async function postSnapshotToSlack({ png, day, caption }) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;
  if (!token || !channelId) throw new Error('SLACK_BOT_TOKEN or SLACK_CHANNEL_ID not set');

  const filename = `prerender-stats-${day}.png`;
  const { upload_url: uploadUrl, file_id: fileId } = await slackApi(
    'files.getUploadURLExternal', token, { filename, length: String(png.length) }
  );
  await uploadFileBytes(uploadUrl, png, filename);
  await slackApi('files.completeUploadExternal', token, {
    files: [{ id: fileId, title: `Prerender stats — ${day}` }],
    channel_id: channelId,
    initial_comment: caption,
  }, true);
}

async function sendDailyReport(port) {
  const day = yesterday();
  const summary = summarizeDay(day);
  const caption = formatMessage(summary).text;
  const png = await screenshot.renderUrlPng(`http://localhost:${port}/?asOf=${day}`);
  await postSnapshotToSlack({ png, day, caption });
}

module.exports = { sendDailyReport, summarizeDay, formatMessage };
