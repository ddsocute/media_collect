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

## Deploy

The server reads `process.env.PORT`, so it can run on common Node hosts such as Render, Railway, Fly.io, or a VPS.

Use these settings:

```text
Build command: npm install
Start command: npm start
Node version: 20 or newer
```

`data/state.json` is generated at runtime and is not committed. `data/sources.json` contains the followed channels and feeds.

## Mobile

The site has a dedicated mobile layout:

- YouTube cards become full-width with large thumbnails.
- Filters and action buttons stack into touch-friendly rows.
- The sidebar and source form collapse into a single column.
