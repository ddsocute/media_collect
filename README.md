# Media Collect

Media Collect is a small dashboard for tracking the latest updates from YouTube channels, podcasts, and RSS-compatible social feeds.

## Features

- Tracks updates from the last 7 days only.
- Filters out YouTube Shorts and common Reels-style links.
- Converts Chinese feed titles and summaries to Taiwan Traditional Chinese.
- Shows large 16:9 thumbnails for YouTube videos.
- Includes responsive layouts for desktop, tablet, and mobile screens.
- Stores followed sources in `data/sources.json`.

## Run Locally

```powershell
npm install
npm start
```

Open:

```text
http://localhost:5173
```

## Deploy To Vercel

Import this repository in Vercel and deploy it as a Node.js project. The included `vercel.json` routes `/api/*` to the Express function and lets Vercel serve the files in `public/`.

Use these settings:

```text
Install command: npm install
Build command: leave empty
Node version: 20 or newer
```

`data/state.json` is generated at runtime and is not committed. `data/sources.json` contains the followed channels and feeds.

On Vercel, runtime JSON writes are stored in `/tmp`, so changes made from the deployed UI can reset after a cold start or redeploy. Commit long-term source changes to `data/sources.json`, or connect a persistent database later.

## Shared Sync

For one shared source list across phone, desktop, and Vercel deployments, connect an Upstash Redis / Vercel KV database and set these environment variables in Vercel Project Settings:

```text
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

The app also supports the Vercel KV variable names:

```text
KV_REST_API_URL
KV_REST_API_TOKEN
```

Optional:

```text
MEDIA_COLLECT_NAMESPACE=media_collect
```

When Redis/KV is configured, sources and read state are stored there. Without it, Vercel falls back to `/tmp`, which is temporary and not shared across cold starts.

## Mobile

The site has a dedicated mobile layout:

- YouTube cards become full-width with large thumbnails.
- Filters and action buttons stack into touch-friendly rows.
- The sidebar and source form collapse into a single column.
