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

### Per-source limit

One company flooding its blog with AI-generated posts shouldn't crowd out everything
else. Every item is grouped by publisher domain and ranked within that group by score;
anything past the **Max posts per source** limit (default 2) is left out of
auto-selection and flagged in the list. Adjust the limit on the results screen — it
re-ranks instantly without re-calling Claude — and use "Hide them" to drop the overflow
out of view entirely. A tally strip shows which domains are flooding the batch.

Domains come from the article URL where possible (`link`/`url`/`href`/`article_url`),
falling back to the `source`/`domain`/`outlet` column, so the limit works even on CSVs
that only export a link. `www.`, `blog.` and `news.` sub-domains are folded into the
parent domain. Items with no recognizable source are never capped.

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
   - `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` — gate the whole site behind HTTP Basic Auth (enforced by `middleware.js`)
3. Deploy to Vercel — the `api/` folder is picked up automatically as serverless functions

## Development

```bash
npm run dev      # start local dev server
npm run build    # production build
npm run preview  # preview production build locally
```
