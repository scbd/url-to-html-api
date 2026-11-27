'use strict';

// Smoke tests for url-to-html-api.
//
// Starts the real server (express + embedded prerender/Chrome), serves a small
// local page whose DOM is modified by JavaScript, and checks that the rendered
// HTML contains the JS-generated content.
//
// The API only renders *.cbd.int / *.cbddev.xyz hosts, so the local page is
// served under SMOKE_PAGE_HOST (default url2html-smoke.cbddev.xyz), which must
// resolve to this machine. In Docker:
//
//   docker run --rm --add-host url2html-smoke.cbddev.xyz:127.0.0.1 <image> npm test
//
// Without that mapping the local render test is skipped.
// Set SMOKE_SKIP_PUBLIC=1 to skip the public page render (no internet).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const APP_PORT = Number(process.env.SMOKE_APP_PORT) || 17100;
const PAGE_HOST = process.env.SMOKE_PAGE_HOST || 'url2html-smoke.cbddev.xyz';
const PUBLIC_URL = process.env.SMOKE_PUBLIC_URL || 'https://www.cbd.int/';
const BASE = `http://127.0.0.1:${APP_PORT}`;
const JS_MARKER = 'JS_GENERATED_CONTENT_42';

const PAGE = `<!doctype html>
<html><head><title>url2html smoke</title></head>
<body>
  <div id="target">static content</div>
  <script>
    document.getElementById('target').textContent = 'changed by script';
    var p = document.createElement('p');
    p.id = 'js-added';
    p.textContent = '${JS_MARKER}';
    document.body.appendChild(p);
  </script>
</body></html>`;

let server;
let serverLog = '';
let pageServer;
let pagePort;

function renderUrl(target) {
  const qs = new URLSearchParams({ _escaped_fragment_: '', url: target });
  return `${BASE}/api/render-html?${qs}`;
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Ask for an invalid url: cheap, does not start a Chrome render.
      const res = await fetch(renderUrl('not-a-url'));
      await res.text();
      if (/Started Chrome/i.test(serverLog)) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not start in ${timeoutMs}ms\n${serverLog}`);
}

before(async () => {
  pageServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => pageServer.listen(0, '0.0.0.0', r));
  pagePort = pageServer.address().port;

  server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env, PORT: String(APP_PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  await waitForServer(60000);
});

after(async () => {
  if (server) {
    server.kill('SIGKILL');
    await new Promise((r) => server.once('exit', r));
  }
  if (pageServer) pageServer.close();
});

test('node version satisfies engines.node', () => {
  const { engines } = require('../package.json');
  assert.equal(engines.node, '^22.23.4 || ^24.22.1 || >=26.12.1');
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  const ok =
    (major === 22 && (minor > 23 || (minor === 23 && patch >= 4))) ||
    (major === 24 && (minor > 22 || (minor === 22 && patch >= 1))) ||
    (major === 26 && (minor > 12 || (minor === 12 && patch >= 1))) ||
    major > 26;
  assert.ok(ok, `node ${process.version} does not satisfy ${engines.node}`);
});

test('renders a local page and returns JS-generated DOM', async (t) => {
  const { address } = await dns.lookup(PAGE_HOST).catch(() => ({}));
  if (address !== '127.0.0.1' && address !== '::1') {
    t.skip(`${PAGE_HOST} does not resolve to loopback (use --add-host ${PAGE_HOST}:127.0.0.1)`);
    return;
  }

  const res = await fetch(renderUrl(`http://${PAGE_HOST}:${pagePort}/smoke.html`));
  const body = await res.text();
  assert.equal(res.status, 200, body.slice(0, 500));
  assert.match(body, new RegExp(`<p id="js-added">${JS_MARKER}</p>`));
  assert.match(body, /changed by script/);
  assert.doesNotMatch(body, /static content/);
  assert.doesNotMatch(body, /<script/i, 'script tags should be stripped');
});

test('renders a public CBD page', { skip: process.env.SMOKE_SKIP_PUBLIC === '1' }, async () => {
  const res = await fetch(renderUrl(PUBLIC_URL));
  const body = await res.text();
  assert.equal(res.status, 200, body.slice(0, 500));
  assert.match(body, /<html/i);
  assert.match(body, /<title>[^<]+<\/title>/i);
  assert.doesNotMatch(body, /<script(?![^>]*application\/ld\+json)/i, 'script tags should be stripped');
});

test('returns 500 for an invalid url', async () => {
  const res = await fetch(renderUrl('not-a-url'));
  const body = await res.text();
  assert.equal(res.status, 500);
  assert.match(body, /Error when rendering page not-a-url/);
});

test('server log has no warnings or errors', () => {
  // prerender polls Chrome's debugging port while Chrome boots and logs each
  // refused connection; that startup noise is expected.
  const log = serverLog.replace(
    /^.*Can't connect to Chrome, retrying Error: connect ECONNREFUSED[\s\S]*?^}\n/gm,
    ''
  );
  assert.doesNotMatch(log, /Warning|Error|ERR_|Unhandled/i, log);
});
