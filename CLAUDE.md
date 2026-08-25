# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Puppeteer-based SSR/prerender service for CBD's Angular/Vue sites (bch, absch, chm, ort `*.cbd.int` domains, plus `*.cbddev.xyz`). Bots and crawlers get pointed at this service (via cloudfront) instead of the real SPA so they receive fully-rendered HTML. One Docker image runs two independent processes, selected by the container command:

- **Render service** (`src/index.js`, default `CMD`) — Express API exposing `GET /api/render-html?url=<target>`, backed by a shared Puppeteer/Chrome instance.
- **Stats service** (`src/stats/server.js`, run via `command: ["node", "src/stats/server.js"]` in the prerender compose stack) — collects render events from every render replica, persists them to SQLite, and serves a dashboard.

## Commands

There is no build step, linter, or automated test suite (`npm test` is a stub that just exits 1) — changes are verified by running the service and hitting it manually.

```bash
npm install                      # install deps (needs a local Chrome/Chromium for puppeteer to launch)
node src/index.js                # run the render service, default PORT=7100
node src/stats/server.js          # run the stats service, default STATS_PORT=7200
```

Useful env vars when running locally (read directly off `process.env`, not all routed through `src/config.js`):

- `debug=true` — turns on verbose `log()`/console logging in the renderer (silent otherwise)
- `showBrowser=true` — launches Chrome headful instead of headless
- `showConsole=true` — forwards the rendered page's browser console output to the server log (requires `debug=true`)
- `logHeaders=true` — logs inbound request headers and CBD-domain response headers
- `STATS_URL` — where the render service reports events (defaults to `http://stats:7200`, the Swarm service name; set to `http://localhost:7200` for local dev against a locally-running stats service)
- `CHROME_USER_DATA_DIR`, `NETWORK_RESPONSE_CACHE_DIR`, `STATS_DATA_DIR` — override the on-disk paths under `data/` (Chrome profile, network response cache, stats store) used to persist state across restarts

Manual smoke test (this is what CI's `testImage` step and `deploy-nginx.sh`'s sanity check both do):
```bash
curl "http://localhost:7100/api/render-html?url=https://absch.cbddev.xyz"
```

### Docker / CI / deploy

- `Dockerfile` builds a single image (Node 24 + Google Chrome stable) that serves as both the render and stats service depending on the command it's started with. The Node base image tag is pinned to an exact patch version (not a floating `node:24`), since this image gets rebuilt on every push.
- `.circleci/config.yml` builds the image, runs it, curls `/api/render-html` as a smoke test, then pushes to Docker Hub (`scbd/url-to-html-api`) tagged by branch/release/tag depending on the workflow filter.
- `stack/docker-compose-prerender.yml` — the Swarm stack: `urlToHtml` (3 replicas, the render service), `stats` (1 replica, manager-only, has the persistent `stats-data` volume), `manage` (Portainer).
- `stack/docker-compose.yml` — the `proxy` stack: nginx (TLS termination + caching + proxy to `urlToHtml`) and certbot.
- `stack/data/nginx/app.conf` — the actual routing/caching rules in front of the render service; read this before changing anything about request/response shape, timeouts, or retry behavior, since nginx and `renderer.js` are tightly coupled (see below).
- `deploy.sh` — pushes a new image and forces the remote Swarm services to pull/update it.
- `deploy-nginx.sh` — pushes `stack/data/nginx/app.conf` to the remote host, validates with `nginx -t`, reloads, and rolls back automatically if validation fails.

## Architecture

### Render pipeline (`src/index.js` → `src/router.js` → `src/renderer.js`)

`router.js` wires `GET /api/render-html` to `renderer.renderUrl`, and kicks off `renderer.processInflightRequest()` once at startup — an infinite loop that pulls queued URLs and dispatches them to Chrome. Everything renderer-related used to live in one ~1000-line `renderer.js`; it's now split by concern, but the request flow crosses all of these:

1. **`renderer.js` `renderUrl`** — entry point. Before ever touching Chrome, it screens the URL for known-bad shapes (see "Legacy URL / bot traffic filtering" below) so obviously-doomed requests get redirected or 404'd without spinning up a render. If none of those match, it registers (or joins) an entry in the shared in-flight request map and waits on it.
2. **`inflightRequests.js`** — the dedupe/queue layer. Concurrent requests for the *same* URL join the same in-flight entry instead of triggering duplicate renders. `renderInflightRequest` polls that entry's status and enforces two timeouts: `MAX_QUEUE_WAIT_MS` (fails fast with 503 if a request has sat queued too long — see nginx's `proxy_next_upstream` retry-on-503 in `app.conf`, which is designed specifically around this) and `MAX_INFLIGHT_WAIT_MS` (hard cap on total wait).
3. **`renderer.js` `processInflightRequest`** — the dispatch loop. Restarts Chrome if flagged, waits for a free render slot (`chromeBrowser.hasFreeTabs`), then hands the next queued entry to `renderHtml`.
4. **`renderer.js` `renderHtml`** — does the actual Puppeteer work: opens a page, intercepts requests (blocks images, blocked-domain traffic via `networkFilters.js`, serves/populates the network response cache), navigates, inlines stylesheets, strips `<script>` tags and rewrites `/app/...` asset URLs (`htmlContent.js`), detects client-side soft-404s (`legacyUrlPatterns.js`), and reports the outcome via `statsReporter.js`.
5. Every step reports structured events (`reportEvent`) to the stats service — this is the only channel connecting the render replicas to the dashboard.

Module map:
| Module | Responsibility |
|---|---|
| `chromeBrowser.js` | Chrome process lifecycle: launch/reuse, restart-on-disconnect, tab cleanup, the `activeRenders`/`MAX_CONCURRENT_RENDERS` concurrency gate |
| `inflightRequests.js` | Request dedupe/queue map, queue/inflight timeouts |
| `legacyUrlPatterns.js` | Regexes + correction logic for known-bad legacy/bot URL shapes, and soft-404 HTML signatures |
| `networkResponseCache.js` | In-memory + disk-persisted cache for slow-changing third-party API calls (thesaurus/countries lookups, jsdelivr CDN assets) made *by* rendered pages |
| `networkFilters.js` | CBD-domain allowlist check + blocklist of third-party request patterns to abort during render |
| `htmlContent.js` | Post-render HTML transforms (script stripping, base-URL rewriting) + byte formatting |
| `requestContext.js` | Extracting client IP / UA / referer / country from inbound request headers (CloudFront + nginx aware) |
| `statsReporter.js` | Fire-and-forget event/live-status reporting to the stats service, plus the soft-404 lookup used to gate malformed-URL short-circuiting |
| `diagnostics.js` | Per-instance memory/inflight/open-page snapshot, pushed to the stats service every 15s for the dashboard's live view |
| `debugLog.js`, `sleep.js`, `instanceId.js` | Small shared utilities (env-gated console logging, promise sleep, hostname-based instance tag for correlating replica logs) |

### Chrome lifecycle & concurrency

A single Chrome instance is shared across all renders in a replica (`chromeBrowser.js`), reusing the default browser context (no incognito) so its HTTP cache persists across `restartChrome()` calls via `CHROME_USER_DATA_DIR`. Concurrency is capped by `MAX_CONCURRENT_RENDERS` using a synchronous `activeRenders` counter incremented the instant a render is dispatched — `browser.pages().length` was tried and rejected because page creation is async and lags behind, letting the dispatch loop overshoot the cap. Chrome restarts happen either on a genuine crash/disconnect (flagged from the `browser.on('disconnected')` listener) or when a render error leaves the browser actually disconnected; ordinary render errors (navigation timeout, bad markup) deliberately do *not* trigger a restart, to avoid throwing away the warm HTTP cache for no reason.

### Legacy URL / bot traffic filtering

`legacyUrlPatterns.js` encodes several known-bad URL shapes seen in production crawler traffic against the pre-migration/legacy BCH URL structure, each redirected or rejected *before* a render is attempted (rendering them always fails or times out, so this is purely a cost-avoidance + noise-reduction layer, not a correctness fix):
- Missing `/database/{TYPE}/` segment (two sub-shapes, with and without the type directory present)
- `/database/{TYPE}\}/...` — stray brace from a buggy link generator
- `/database/record.shtml?documentid=<id>` — old query-string record lookup, redirected straight to the type-less `/database/<id>` shape (confirmed against the origin's own redirect chain)
- Sensitive/dotfile path probes (`.env`, `id_rsa`, etc.) — 404'd outright as credential-scanning traffic, never rendered
- Bot-appended `/countries/<code>` or doubled path segments — only short-circuited once the stats service confirms (`isKnownSoftNotFoundUrl`) that exact URL has actually rendered as a soft 404 before, so a shape-only match never wrongly 404s a real route

Soft-404 detection (`detectSoftNotFound`) matches known "not found" markup signatures rendered client-side by the SPA (which itself returns HTTP 200), one pattern per platform (bch/absch/chm's shared AngularJS app vs. ort's separate React app).

### Stats service (`src/stats/`)

A separate Express app, single Swarm replica, backed by a SQLite database (`stats.db` under `data/` or `STATS_DATA_DIR`, via the built-in `node:sqlite` module) — counts, hourly counts, durations, per-URL "seen" tracking, route-pattern histograms, cache hit/miss stats, and soft-404 URLs, all bucketed by day (or hour) and pruned after `RETENTION_DAYS` (30). `db.js` owns the schema (shared by `store.js` and `migrateToSqlite.js` so they can't drift); `store.js` exposes one prepared-statement function per read/write plus `withTransaction()` for batching a single incoming event's several store calls atomically. `server.js` exposes `/events` (ingest, called by every render replica — wraps its whole handler body in one `store.withTransaction()` call), `/live-status` + `/api/live` (near-real-time per-instance render activity, in-memory only), `/api/known-soft-404` (the lookup gating the countries/repeated-segment redirect above), and `/api/stats` (the aggregated payload for the dashboard at `src/stats/public/`, including a `hourly` block when `?asOfHour=` is passed). `slackReport.js` posts a daily summary and an hourly summary to Slack when `SLACK_BOT_TOKEN`/`SLACK_CHANNEL_ID` are set.

**Migration from the old flat-JSON store**: `migrateToSqlite.js` runs automatically on boot (`server.js`, gated on `stats.db` not existing yet) to import any pre-existing `counts.json`/`events.jsonl`/etc. from before this migration — it builds the whole import in one transaction against a temp file, then atomically renames it into place, so a crash partway through never leaves a half-migrated `stats.db`. The original JSON/JSONL files are deliberately never deleted (cheap insurance against a rollback to the pre-SQLite `store.js`). Can also be run manually via `npm run migrate:stats`.

### Dead code

`src/plugins/block-resources.js` and `src/plugins/http-headers.js` are leftovers from an older implementation built on the `prerender` npm package (they reference `req.prerender.tab.Network`, an API this codebase no longer uses) — nothing in the current request path requires them, don't assume they're wired in. Note also that `src/renderer.js` and friends do their own env-gated console logging via `debugLog.js` rather than the winston-based `src/logger.js` used by `index.js`/`app.js` — two independent logging setups coexist in this codebase.
