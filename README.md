# url-to-html-api

A Puppeteer-based prerender/SSR service for CBD's Angular/React sites (`bch`, `absch`, `chm`, `ort` on `*.cbd.int`, plus `*.cbddev.xyz`). Bots and crawlers are routed here instead of the real single-page app so they get fully-rendered HTML back.

The same Docker image runs two independent processes:

- **Render service** — `GET /api/render-html?url=<target>`, backed by a shared headless Chrome instance. This is the default container command.
- **Stats service** — collects render events from every render replica and serves a monitoring dashboard.

## Running locally

Requires Node 20+ and a local Chrome/Chromium for Puppeteer to launch.

```bash
npm install
node src/index.js           # render service, default PORT=7100
node src/stats/server.js    # stats service, default STATS_PORT=7200
```

Smoke test:

```bash
curl "http://localhost:7100/api/render-html?url=https://absch.cbddev.xyz"
```

Useful env vars for local debugging:

| Var | Effect |
|---|---|
| `debug=true` | verbose console logging in the renderer |
| `showBrowser=true` | launch Chrome headful instead of headless |
| `showConsole=true` | forward the rendered page's browser console to the server log (needs `debug=true`) |
| `logHeaders=true` | log inbound request headers and CBD-domain response headers |
| `STATS_URL` | where the render service reports events (defaults to `http://stats:7200`; use `http://localhost:7200` against a locally-running stats service) |

There is no build step, linter, or automated test suite — changes are verified by running the service and hitting it manually.

## Deploying

Everything below assumes you're on the target server, inside the `stack/` directory.

### First-time setup

```bash
sudo docker swarm init
sudo docker network create --attachable --driver overlay proxy
sudo docker network create --attachable --driver overlay prerender
sudo docker stack deploy --compose-file ./docker-compose-prerender.yml prerender
sudo docker stack deploy --compose-file ./docker-compose.yml proxy
sudo ./init-letsencrypt.sh   # only needed once, to bootstrap TLS certs
```

This brings up two stacks:

- `prerender` (`docker-compose-prerender.yml`) — the `urlToHtml` render service (3 replicas), the `stats` service (1 replica, manager-only), and a Portainer instance for management.
- `proxy` (`docker-compose.yml`) — nginx (TLS termination, response caching, retry-on-503 to a less-busy replica) and certbot for cert renewal.

### Shipping a new image

```bash
./deploy.sh           # builds + pushes the image, then forces both services to pull and update
./deploy.sh false     # same, but skip updating the urlToHtml service (stats only)
```

### Updating the nginx config

```bash
./deploy-nginx.sh
```

Backs up the remote `app.conf`, copies the local version over, validates with `nginx -t`, reloads, and automatically rolls back if validation fails.

### Adding a worker node

```bash
sudo docker swarm join-token worker
# on the new node:
docker swarm join --token <token> <manager-ip>:2377
```

### Tearing down

```bash
sudo docker stack rm prerender
```
