# InstaGen

Internal tool that generates a daily 8-slide carousel (historical or one of six other niche engines) using the MiniMax text and image APIs.

## Architecture

```
instagen/
├── package.json          # Express + cors + dotenv + serverless-http, ESM
├── .env                  # PORT, MINIMAX_API_KEY, MINIMAX_API_BASE
├── .gitignore
├── vercel.json           # Vercel routing (rewrites + function timeouts)
├── api/
│   ├── generate-content.js       # POST /api/generate-content  (niche-aware)
│   └── generate-daily-videos.js  # POST /api/generate-daily-videos
└── public/
    ├── index.html        # Theme Hub landing page (niche picker)
    ├── hub.js            # Hub controller (renders cards, handles click → store → route)
    ├── state.js          # Global niche store (vanilla, localStorage-backed)
    ├── generator.html    # Generator dashboard (served at /generator)
    ├── app.js            # Generator controller (reads niche, sends to API, renders grid)
    └── assets/
        └── placeholder-error.png
```

## Pages

| Route       | File               | Purpose                                                |
| ----------- | ------------------ | ------------------------------------------------------ |
| `/`         | `index.html`       | Theme Hub: 7 niche cards, click → save & navigate      |
| `/generator`| `generator.html`   | The original dashboard, now niche-aware with a badge   |

The hub is the entry point. The dashboard is reached by picking a niche on the hub. A `vercel.json` rewrite maps `/generator` → `/generator.html` for a clean URL.

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

### Vercel
Push to a Git repo and import in Vercel. The included `vercel.json`:
- rewrites `/generator` → `/generator.html`
- pins `/api/*` timeouts (60s for content, 300s for video)
- forwards `request.signal` to upstream fetches (set `supportsCancellation: true`)

Set `MINIMAX_API_KEY` in **Project Settings → Environment Variables**.

### Render
- **Build command:** `npm install`
- **Start command:** `npm start`
- **Environment:** add `MINIMAX_API_KEY` (and optionally `PORT`)

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

### `GET /api/health`

Liveness probe — returns `{ status, time, apiKeyConfigured }`.

## Safeguards

- **JSON parsing** — tries `JSON.parse`, then strips ```json fences, then regex-extracts the slice between the first `[` and last `]`.
- **Per-image fault isolation** — failed slices fall back to an inline-SVG placeholder, the rest of the carousel still ships.
- **Niche-scoped localStorage cache** — payloads are keyed by `instagen:daily:v2:<niche>:<YYYY-MM-DD>`, so switching niches on the hub never shows another niche's stale carousel.
- **PWA-ready** — viewport-fit=cover, apple-mobile-web-app-capable, dark theme color, safe-area insets.
