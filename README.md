# InstaGen

Internal tool that generates a daily 8-slide historical Instagram carousel using the MiniMax text and image APIs.

## Architecture

```
instagen/
├── package.json          # Express + cors + dotenv + serverless-http, ESM
├── .env                  # PORT, MINIMAX_API_KEY, MINIMAX_API_BASE
├── .gitignore
├── vercel.json           # Vercel routing (max 300s function duration)
├── server.js             # Express app: /api/generate-content pipeline
└── public/
    ├── index.html        # Mobile-first PWA-ready UI
    └── app.js            # Vanilla JS: fetch + localStorage cache + render
```

## Setup

```bash
npm install
cp .env .env.local       # then fill in your real MINIMAX_API_KEY
npm run dev              # http://localhost:3000
```

## Deployment

### Vercel
Push to a Git repo and import in Vercel. The included `vercel.json` routes `/api/*` to `server.js` (max 300s) and everything else to `public/`. Set `MINIMAX_API_KEY` in **Project Settings → Environment Variables**.

### Render
- **Build command:** `npm install`
- **Start command:** `npm start`
- **Environment:** add `MINIMAX_API_KEY` (and optionally `PORT`)

## API

### `POST /api/generate-content`

Resolves today's date server-side, generates 8 historical events via `MiniMax-M3`, fires 8 parallel `image-01` calls, and returns:

```json
{
  "date": "June 10",
  "generatedAt": "2026-06-10T12:34:56.000Z",
  "slides": [
    {
      "year": "1925",
      "title": "...",
      "description": "...",
      "imageUrl": "https://..."
    }
  ]
}
```

### `GET /api/health`

Liveness probe — returns `{ status, time, apiKeyConfigured }`.

## Safeguards

- **JSON parsing** — tries `JSON.parse`, then strips ```json fences, then regex-extracts the slice between the first `[` and last `]`.
- **Per-image fault isolation** — failed slices fall back to an inline-SVG placeholder, the rest of the carousel still ships.
- **LocalStorage cache** — payloads are keyed by `YYYY-MM-DD`; reopening the app the same day skips the backend entirely.
- **PWA-ready** — viewport-fit=cover, apple-mobile-web-app-capable, dark theme color, safe-area insets.
