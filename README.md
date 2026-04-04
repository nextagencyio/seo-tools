# SEO Tools

Keyword research and competition analysis CLI tools. Ubersuggest-style keyword discovery using free APIs with optional paid enrichment.

## Setup

```bash
npm install
```

Copy `.env.local.example` to `.env.local` and add your API keys (all optional — the tool works without them).

## Usage

```bash
# Single keyword
npx tsx scripts/keyword-research.ts "your keyword"

# Multiple seeds
npx tsx scripts/keyword-research.ts --seeds "keyword one,keyword two,keyword three"

# Full pipeline (autocomplete + trends + heuristic scoring)
npm run keywords -- --seeds "your keyword"

# Trends only (fast, ~30s per seed)
npm run keywords:trends -- --seeds "your keyword"

# Autocomplete expansion only
npm run keywords:autocomplete -- --seeds "your keyword"

# Deeper recursive expansion (slower but more thorough)
npx tsx scripts/keyword-research.ts --depth 2 "your keyword"

# Explicit DataForSEO enrichment
npx tsx scripts/keyword-research.ts --enrich --seeds "your keyword"
```

## What It Does (5 Phases)

| Phase | Source | Cost | What You Get |
|-------|--------|------|-------------|
| 1. Autocomplete | Google Suggest API | Free | 200-300 keyword suggestions per seed (alphabet + question + preposition expansion) |
| 2. Trends | Google Trends | Free | Rising queries, related queries, interest over time |
| 3. Heuristic | Built-in | Free | Competition difficulty score based on keyword characteristics |
| 4. Volume/SERP | DataForSEO | ~$0.05/1K keywords | Search volume, CPC, SERP competition analysis |

## Output

Reports are saved to `scripts/keyword-data/` in three formats:
- **Markdown report** — human-readable with ranked opportunities
- **CSV** — for spreadsheet sorting/filtering
- **JSON** — raw data for further processing

## API Setup (all optional)

### DataForSEO (pay-as-you-go)

Provides exact monthly search volume, CPC, keyword difficulty, and SERP analysis. Costs ~$0.05 per 1,000 keywords.

1. Sign up at [dataforseo.com](https://dataforseo.com)
2. Add to `.env.local`:
   ```
   DATAFORSEO_LOGIN=your_email
   DATAFORSEO_PASSWORD=your_password
   ```

## How to Interpret Results

- **Heuristic score** (0-100): Lower = easier. Based on word count, question format, niche specificity. Rough estimate when you don't have SERP data.
- **SERP score** (0-100, DataForSEO): Lower = easier. Based on actual search results — Reddit/forums in top 5, title match count, domain authority.
- **Rising queries**: Keywords gaining traction fast — often the best opportunities.
