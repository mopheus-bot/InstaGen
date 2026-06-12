# InstaGen

Internal tool that generates a daily 8-slide carousel (historical or one of six other niche engines) using the MiniMax text and image APIs.

## Architecture

```
instagen/
├── package.json          # Express + cors + dotenv + express-rate-limit, ESM
├── .env                  # PORT, MINIMAX_API_KEY, PUBLIC_URL, ALLOWED_ORIGINS
├── .gitignore
├── server.js             # Express bootstrap — trust proxy, CORS, rate limit
├── api/
│   ├── _request.js               # Cloudflare-aware CORS + client-IP helpers
│   ├── generate-content.js       # POST /api/generate-content  (niche-aware)
│   ├── generate-daily-videos.js  # POST /api/generate-daily-videos
│   ├── video-callback.js         # POST /api/video-callback  (MiniMax webhook)
│   ├── video-status.js           # GET  /api/video-status
│   ├── video_task_store.js       # In-process task state
│   ├── niche_profiles.js         # Per-niche persona + image style factory
│   └── niche_queries.js          # Per-niche search directives
└── public/
    ├── index.html        # Theme Hub landing page (niche picker)
    ├── hub.js            # Hub controller (renders cards, handles click → store → route)
    ├── state.js          # Global niche store (vanilla, localStorage-backed)
    ├── generator.html    # Generator dashboard (served at /generator)
    ├── app.js            # Generator controller (reads niche, sends to API, renders grid)
    └── assets/
        └── placeholder-error.png
```

`server.js` is the entrypoint. It mounts every `api/*.js` handler under `/api/*` by converting each Express `req`/`res` into a Web `Request`/`Response` round-trip, so the handlers stay single-source. `api/_request.js` provides Cloudflare-aware client-IP resolution and a dynamic CORS policy driven by `PUBLIC_URL` and `ALLOWED_ORIGINS`.

## Pages

| Route       | File               | Purpose                                                |
| ----------- | ------------------ | ------------------------------------------------------ |
| `/`         | `index.html`       | Theme Hub: 7 niche cards, click → save & navigate      |
| `/generator`| `generator.html`   | The original dashboard, now niche-aware with a badge   |

The hub is the entry point. The dashboard is reached by picking a niche on the hub. `server.js` serves `/generator` and `/` as clean URLs (the static layer maps `/generator` → `generator.html`).

## Niches

The seven available engines (defined once in `public/state.js`, mirrored as system-prompt suffixes in `api/generate-content.js`):

- `history` — **On This Day in History** (the original engine, default)
- `true-crime` — **On This Day in True Crime**
- `conspiracy` — **On This Day in Conspiracy Theories**
- `womens-history` — **On This Day in Women's History**
- `vintage-tech` — **On This Day in Vintage Tech**
- `ancient-civ` — **On This Day in Ancient Civilizations**
- `philosophy` — **On This Day in Philosophy**

To add an 8th, append a row to `NICHES` in `public/state.js` and a matching entry to `NICHES` in `api/generate-content.js` with a `systemPromptSuffix` that scopes the topic. No other code needs to change.

## Global state (`active_niche`)

There is no framework, so the "global state" is a tiny vanilla module — `public/state.js` — that wraps `localStorage` and exposes a `subscribe` API shaped like a small store. From any page:

```js
import { getActiveNiche, setActiveNiche, subscribeActiveNiche, getNiche } from './state.js';

setActiveNiche('true-crime');              // write
const id = getActiveNiche();               // read
const niche = getNiche(id);                // resolve the full record (label, gradient, ...)
const unsubscribe = subscribeActiveNiche((id) => { /* re-render */ });
```

The subscription fires across tabs via the browser's native `storage` event, so opening `/generator` in one tab and switching the niche on `/` in another updates the badge live.

## Setup

```bash
npm install
cp .env .env.local       # then fill in your real MINIMAX_API_KEY
npm run dev              # http://localhost:3000
```

## Deployment

### Railway (or any long-lived Node host)

- **Build command:** `npm install`
- **Start command:** `npm start`
- **Environment:** add `MINIMAX_API_KEY`, `PUBLIC_URL`, and (optionally) `ALLOWED_ORIGINS`, `INTERNAL_KEY`

`server.js` binds to `process.env.PORT` (default 3000). The `app.set('trust proxy', true)` line is what makes `req.ip` resolve to the real end-user IP behind Cloudflare; do not remove it. The in-app rate limit (200 req / 15 min globally, 10 req / 15 min on generation endpoints) is the second line of defense; the first is the Cloudflare WAF rate-limit rule on `/api/*` (see `CLOUDFLARE_PROXY_SETUP.md`).

### Behind Cloudflare

Set the DNS records for `instagen.app` (and any subdomain) to orange-cloud the deployment host. See `CLOUDFLARE_PROXY_SETUP.md` for the full dashboard checklist (TLS mode, WAF rule, transform rules, etc.).

## API

### `POST /api/generate-content`

Body: `{ niche: 'history' | 'true-crime' | 'conspiracy' | 'womens-history' | 'vintage-tech' | 'ancient-civ' | 'philosophy' }`. Unknown / missing niche falls back to `history`.

Resolves today's date server-side, generates 8 niche-scoped events via `MiniMax-M3`, fires 8 parallel `image-01` calls, and returns:

```json
{
  "date": "June 10",
  "dateKey": "2026-06-10",
  "niche": "true-crime",
  "nicheLabel": "On This Day in True Crime",
  "generatedAt": "2026-06-10T12:34:56.000Z",
  "slides": [
    {
      "year": "1925",
      "title": "...",
      "description": "...",
      "imagePrompt": "...",
      "imageUrl": "https://..."
    }
  ]
}
```

### `POST /api/generate-daily-videos`

Same body shape (`{ niche }`). Five-step pipeline → `{ videos: [{url, title, year}] }`.

### `GET /api/video-status?ids=t1,t2,t3`

Polled by the frontend after submitting async text-to-video tasks. Returns `{ tasks: { t1: { status, url, fileId, error } } }`.

### `POST /api/video-callback`

Server-to-server webhook target for MiniMax's async video pipeline. Accepts the challenge handshake and status updates. See `api/video-callback.js` for the payload shape.

### `GET /api/health`

Liveness probe — returns `{ status, time, apiKeyConfigured }`.

## Safeguards

- **Trust proxy** — `app.set('trust proxy', true)` makes `req.ip` resolve to the real end-user IP (via `CF-Connecting-IP` / `X-Forwarded-For`).
- **Dynamic CORS** — `api/_request.js` resolves the allowlist from `PUBLIC_URL` + `ALLOWED_ORIGINS` on every request, with `Vary: Origin` and never a wildcard.
- **Two-tier rate limit** — global 200 req / 15 min, generation endpoints 10 req / 15 min, keyed on the real client IP, with an `INTERNAL_KEY` bypass for smoke tests.
- **JSON parsing** — tries `JSON.parse`, then strips ```json fences, then regex-extracts the slice between the first `[` and last `]`.
- **Per-image fault isolation** — failed slices fall back to an inline-SVG placeholder, the rest of the carousel still ships.
- **Niche-scoped localStorage cache** — payloads are keyed by `instagen:daily:v2:<niche>:<YYYY-MM-DD>`, so switching niches on the hub never shows another niche's stale carousel.
- **PWA-ready** — viewport-fit=cover, apple-mobile-web-app-capable, dark theme color, safe-area insets.
