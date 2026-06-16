# dental-news-buffer

An internal tool for **USA Dental Report** that streamlines the workflow from raw news scraping to LinkedIn content publishing.

## What it does

1. **Upload** — drop in a CSV exported from your news scraper (any CSV with a title/headline column)
2. **Evaluate** — sends items in batches to Claude, which scores each one across three dimensions:
   - **Relevance** — dental industry fit for practicing dentists
   - **Recency** — how timely the news is
   - **Engagement** — LinkedIn potential based on headline and topic

   Claude also writes a suggested post title and a 2–3 sentence LinkedIn draft for each item.

3. **Push** — review the scored ideas, select the ones you want (high-scoring items are auto-selected), and push them directly to **Buffer** as LinkedIn Ideas via Buffer's GraphQL API.

## Architecture

- **Frontend** — dark-themed single-page React app (Vite), hosted on Vercel
- **`/api/claude`** — Vercel serverless function that proxies requests to the Claude API
- **`/api/buffer`** — Vercel serverless function that proxies requests to Buffer's GraphQL API

API keys stay server-side and never reach the browser.

## Setup

1. Clone the repo and run `npm install`
2. Set the following environment variables in your Vercel project:
   - `ANTHROPIC_API_KEY`
   - `BUFFER_ACCESS_TOKEN`
   - `BUFFER_ORG_ID`
3. Deploy to Vercel — the `api/` folder is picked up automatically as serverless functions

## Development

```bash
npm run dev      # start local dev server
npm run build    # production build
npm run preview  # preview production build locally
```
