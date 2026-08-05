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

## Batch selection

Buffer accepts at most **100 ideas per push**, so a large scrape has to be narrowed down:

- **Stricter scoring on oversized CSVs** — when the upload has more than 100 rows, Claude grades on an explicit absolute curve (9–10 for industry-moving news, 4–6 for routine product blurbs and single-practice announcements) instead of its default bar.
- **Source-balanced picks** — auto-selection fills the batch breadth-first across source domains: every domain contributes its best item before any domain contributes a second, capped at 2 per domain. A prolific outlet can't take the top slots just because it published the most. Domains are normalized from the source column, falling back to the article link's hostname.
- **Adaptive threshold** — if items scoring 8+ can fill all 100 slots on their own, the 7s don't make the cut.
- **Hard 100 cap** — the selection UI won't let you go past 100 (already-pushed ideas count toward it), and the push itself is clamped to the same ceiling.

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
