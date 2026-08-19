# TODO

## Migrate stats storage from flat files to SQLite

Context: `data/events.jsonl` + `data/counts.json` work fine at current volume, but
`pruneOldEvents`/`saveCounts` do full read+rewrite of the whole file on every
prune cycle / every event — that's the actual scaling risk, not raw disk size.
Decided to fix it by moving to `node:sqlite` (built-in) rather than adding
`better-sqlite3`, since we're upgrading Node anyway.

- [ ] Bump `Dockerfile` base image from `node:20.0` to `node:24` (Puppeteer only requires Node >=18, no blocker)
- [ ] Add `"engines": { "node": ">=24" }` to `package.json`
- [ ] Design SQLite schema:
  - [ ] `events(id, type, domain, url, ip, user_agent, referer, country, error, timestamp)` — indexed on `timestamp` (and `type`/`domain`), replaces `events.jsonl`
  - [ ] `counts(day, domain, type, client, n, PRIMARY KEY(day, domain, type, client))` — replaces `counts.json`, written via upsert instead of full-object rewrite
- [ ] Rewrite `src/stats/store.js` against `node:sqlite` (`DatabaseSync`), keeping the same exported function names (`appendEvent`, `readEvents`, `incrementCount`, `readCounts`, `pruneOldEvents`, `pruneOldCounts`, `RETENTION_DAYS`) so `server.js` needs minimal changes
- [ ] Replace `pruneOldEvents`/`pruneOldCounts` full-file rewrite logic with indexed `DELETE WHERE timestamp/day < cutoff`
- [ ] Decide: keep `readCounts()` returning the old nested `{day:{domain:{type:{client:n}}}}` shape (minimal diff to `server.js`), or have SQL return flat rows directly and simplify the `/api/stats` flattening logic in `server.js`
- [ ] Decide: migrate existing `events.jsonl` / `counts.json` data into SQLite, or start the new store empty (current data is <24h old, 30-day retention anyway)
- [ ] If migrating: write one-off script to import old files into the new tables
- [ ] Verify SQLite file lives in the existing `stats-data` docker volume (`/usr/src/app/data`) — no docker-compose changes needed, `stats` already runs as a single replica so no multi-writer concerns
- [ ] Regression pass on the render path (`urlToHtml` service), not just the stats dashboard — same Docker image/Node bump ships to both services
