# Claude Code — SEO Tools

## Project Overview

Standalone SEO keyword research and competition analysis CLI tools. Designed to be used across multiple projects — not tied to any specific site.

- **Language**: TypeScript, run via `tsx`
- **No build step** — scripts run directly with `npx tsx`
- **Output**: Reports saved to `scripts/keyword-data/` (gitignored)

## How It Works

The main script (`scripts/keyword-research.ts`) runs a multi-phase pipeline:

1. **Google Autocomplete** — expands seed keywords using alphabet soup, question prefixes, and prepositions. Free, no API key needed.
2. **Google Trends** — finds rising and related queries via `google-trends-api` npm package. Free, no key needed.
3. **Heuristic Scoring** — built-in competition estimator based on keyword characteristics (word count, question format, niche specificity).
4. **Google Custom Search API** — `allintitle:` result counts for competition analysis. Free tier: 100 queries/day. Requires `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_CX`.
5. **DataForSEO** — exact monthly search volume, CPC, keyword difficulty, and live SERP analysis. Pay-as-you-go (~$0.05/1K keywords). Requires `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD`.

## Usage

```bash
# Single keyword
npx tsx scripts/keyword-research.ts "your keyword"

# Multiple seeds
npx tsx scripts/keyword-research.ts --seeds "keyword one,keyword two"

# npm shortcuts
npm run keywords -- --seeds "your keyword"
npm run keywords:trends -- --seeds "your keyword"
npm run keywords:autocomplete -- --seeds "your keyword"

# Options
--mode full|trends|autocomplete   # Which phases to run (default: full)
--depth 1|2|3                     # Recursive autocomplete expansion depth (default: 1)
--enrich                          # Force DataForSEO enrichment
--seeds "kw1,kw2,kw3"            # Comma-separated seed keywords
```

## Key Files

| File | Purpose |
|------|---------|
| `scripts/keyword-research.ts` | Main keyword research script |
| `scripts/google-trends-api.d.ts` | Type declarations for google-trends-api |
| `.env.local` | API keys (DataForSEO, Google CSE) |
| `scripts/keyword-data/` | Output directory for reports (gitignored) |

## Environment Variables

All optional — the tool works without any API keys (autocomplete + trends + heuristic scoring).

| Variable | Service | Purpose |
|----------|---------|---------|
| `DATAFORSEO_LOGIN` | DataForSEO | Search volume, CPC, SERP analysis |
| `DATAFORSEO_PASSWORD` | DataForSEO | API password |
| `GOOGLE_CSE_API_KEY` | Google Cloud | allintitle competition checks |
| `GOOGLE_CSE_CX` | Google CSE | Custom Search Engine ID |

## Interpreting Results

- **Heuristic score** (0-100): Lower = easier to rank. Rough estimate based on keyword structure.
- **SERP score** (0-100): Lower = easier. Based on actual Google results — Reddit/forums ranking, title matches, domain authority.
- **allintitle count**: Pages with the exact keyword in their title. Under 200 = very low competition.
- **Rising queries** from Google Trends: Keywords gaining traction — often the best opportunities.
- **CPC**: High CPC = commercial intent. Advertisers pay for these keywords, which signals value.

## Adding New Features

When adding new data sources or analysis phases:
1. Add the fetch function with proper error handling and rate limiting
2. Wire it into the `main()` function's pipeline
3. Add results to the report generator and CSV export
4. Update the JSON output structure
5. Add any new env vars to `.env.local.example`
