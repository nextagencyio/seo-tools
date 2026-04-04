/**
 * Keyword Research Tool — Ubersuggest-style keyword discovery
 *
 * Uses free APIs (Google Autocomplete, Google Trends) plus optional
 * DataForSEO for search volume/difficulty data.
 *
 * Usage:
 *   npx tsx scripts/keyword-research.ts                    # Run with default seed keywords
 *   npx tsx scripts/keyword-research.ts "cms for lovable"  # Custom seed keyword
 *   npx tsx scripts/keyword-research.ts --seeds "decoupled drupal,headless cms,cms for lovable"
 *   npx tsx scripts/keyword-research.ts --mode trends      # Only Google Trends
 *   npx tsx scripts/keyword-research.ts --mode autocomplete # Only autocomplete expansion
 *   npx tsx scripts/keyword-research.ts --mode full         # Full pipeline (default)
 *   npx tsx scripts/keyword-research.ts --enrich            # Add DataForSEO volume data
 *   npx tsx scripts/keyword-research.ts --depth 2           # Recursive expansion depth (default 1)
 *
 * Environment variables (all optional):
 *   DATAFORSEO_LOGIN      — DataForSEO API login (for search volume + SERP analysis)
 *   DATAFORSEO_PASSWORD   — DataForSEO API password
 *
 * Setup for DataForSEO (pay-as-you-go, ~$0.05/1K keywords):
 *   1. Sign up at https://dataforseo.com
 *   2. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD in your .env.local
 */

import fs from 'fs/promises'
import path from 'path'
import dotenv from 'dotenv'
import googleTrends from 'google-trends-api'

// Load .env.local (script runs outside Next.js)
dotenv.config({ path: path.join(process.cwd(), '.env.local') })

// ── Config ──────────────────────────────────────────────────────────────────

// Default seeds — override with --seeds "keyword1,keyword2" or a bare argument
const DEFAULT_SEEDS = [
  'example keyword',
]

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('')
const QUESTION_PREFIXES = ['what', 'how', 'why', 'when', 'which', 'is', 'can', 'does', 'best', 'top']
const PREPOSITIONS = ['for', 'vs', 'with', 'without', 'or', 'and', 'to', 'like']

const DELAY_MS = 1200 // Delay between Google requests to avoid rate limiting
const OUTPUT_DIR = path.join(process.cwd(), 'scripts', 'keyword-data')

// ── Types ───────────────────────────────────────────────────────────────────

interface KeywordData {
  keyword: string
  source: string // 'autocomplete' | 'trends-related' | 'trends-rising' | 'seed'
  seedKeyword: string
  searchVolume?: number
  competition?: string
  competitionIndex?: number
  cpc?: number
  trendInterest?: number // 0-100 relative
  isRising?: boolean
}

interface TrendsResult {
  relatedQueries: string[]
  risingQueries: Array<{ query: string; value: string }>
  interestOverTime: Array<{ date: string; value: number }>
}

interface DataForSEOVolumeResult {
  keyword: string
  searchVolume: number
  competition: number
  cpc: number
  categories: number[]
  monthlySearches: Array<{ year: number; month: number; searchVolume: number }>
}

interface SERPAnalysis {
  keyword: string
  totalResults: number
  hasForumInTop5: boolean
  hasRedditInTop5: boolean
  avgDomainRank: number
  exactTitleMatches: number
  hasFeaturedSnippet: boolean
  hasPeopleAlsoAsk: boolean
  competitionScore: number // 0-100, lower = easier
  topResults: Array<{
    position: number
    title: string
    url: string
    domain: string
  }>
}

// ── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseArgs(): {
  seeds: string[]
  mode: 'full' | 'autocomplete' | 'trends'
  enrich: boolean
  depth: number
} {
  const args = process.argv.slice(2)
  let seeds = DEFAULT_SEEDS
  let mode: 'full' | 'autocomplete' | 'trends' = 'full'
  let enrich = false
  let depth = 1

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--seeds' && args[i + 1]) {
      seeds = args[i + 1].split(',').map(s => s.trim())
      i++
    } else if (args[i] === '--mode' && args[i + 1]) {
      mode = args[i + 1] as 'full' | 'autocomplete' | 'trends'
      i++
    } else if (args[i] === '--enrich') {
      enrich = true
    } else if (args[i] === '--depth' && args[i + 1]) {
      depth = parseInt(args[i + 1], 10)
      i++
    } else if (!args[i].startsWith('--')) {
      // Bare argument = single seed keyword
      seeds = [args[i]]
    }
  }

  return { seeds, mode, enrich, depth }
}

// ── Google Autocomplete ─────────────────────────────────────────────────────

async function fetchAutocomplete(query: string): Promise<string[]> {
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}&hl=en&gl=us`

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })

    if (!response.ok) {
      console.warn(`  ⚠ Autocomplete returned ${response.status} for "${query}"`)
      return []
    }

    const data = await response.json() as [string, string[]]
    return data[1] || []
  } catch (err) {
    console.warn(`  ⚠ Autocomplete error for "${query}":`, (err as Error).message)
    return []
  }
}

async function expandKeywordAutocomplete(
  seed: string,
  depth: number = 1,
): Promise<KeywordData[]> {
  const allKeywords = new Map<string, KeywordData>()
  const processed = new Set<string>()

  async function expand(query: string, currentDepth: number) {
    if (currentDepth > depth || processed.has(query)) return
    processed.add(query)

    // Base suggestions
    console.log(`  🔍 Autocomplete: "${query}"`)
    const baseSuggestions = await fetchAutocomplete(query)
    await sleep(DELAY_MS)

    for (const kw of baseSuggestions) {
      if (!allKeywords.has(kw)) {
        allKeywords.set(kw, {
          keyword: kw,
          source: 'autocomplete',
          seedKeyword: seed,
        })
      }
    }

    // Alphabet expansion: "seed a", "seed b", ...
    for (const letter of ALPHABET) {
      const suggestions = await fetchAutocomplete(`${query} ${letter}`)
      await sleep(DELAY_MS)

      for (const kw of suggestions) {
        if (!allKeywords.has(kw)) {
          allKeywords.set(kw, {
            keyword: kw,
            source: 'autocomplete',
            seedKeyword: seed,
          })
        }
      }
    }

    // Question prefix expansion
    for (const prefix of QUESTION_PREFIXES) {
      const suggestions = await fetchAutocomplete(`${prefix} ${query}`)
      await sleep(DELAY_MS)

      for (const kw of suggestions) {
        if (!allKeywords.has(kw)) {
          allKeywords.set(kw, {
            keyword: kw,
            source: 'autocomplete',
            seedKeyword: seed,
          })
        }
      }
    }

    // Preposition expansion
    for (const prep of PREPOSITIONS) {
      const suggestions = await fetchAutocomplete(`${query} ${prep}`)
      await sleep(DELAY_MS)

      for (const kw of suggestions) {
        if (!allKeywords.has(kw)) {
          allKeywords.set(kw, {
            keyword: kw,
            source: 'autocomplete',
            seedKeyword: seed,
          })
        }
      }
    }

    // Recursive expansion on top results
    if (currentDepth < depth) {
      const topResults = baseSuggestions.slice(0, 3)
      for (const result of topResults) {
        await expand(result, currentDepth + 1)
      }
    }
  }

  await expand(seed, 1)
  return Array.from(allKeywords.values())
}

// ── Google Trends ───────────────────────────────────────────────────────────

async function fetchTrendsData(keyword: string): Promise<TrendsResult> {
  const result: TrendsResult = {
    relatedQueries: [],
    risingQueries: [],
    interestOverTime: [],
  }

  try {
    // Interest over time (last 12 months)
    console.log(`  📈 Trends interest: "${keyword}"`)
    const interestData = await googleTrends.interestOverTime({
      keyword,
      startTime: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      geo: 'US',
    })
    await sleep(DELAY_MS)

    const parsed = JSON.parse(interestData)
    if (parsed?.default?.timelineData) {
      result.interestOverTime = parsed.default.timelineData.map(
        (d: { formattedTime: string; value: number[] }) => ({
          date: d.formattedTime,
          value: d.value[0],
        }),
      )
    }
  } catch (err) {
    console.warn(`  ⚠ Trends interest error for "${keyword}":`, (err as Error).message)
  }

  try {
    // Related queries
    console.log(`  📈 Trends related queries: "${keyword}"`)
    const relatedData = await googleTrends.relatedQueries({
      keyword,
      startTime: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      geo: 'US',
    })
    await sleep(DELAY_MS)

    const parsed = JSON.parse(relatedData)
    const queryData = parsed?.default?.rankedList

    if (queryData?.[0]?.rankedKeyword) {
      result.relatedQueries = queryData[0].rankedKeyword.map(
        (item: { query: string }) => item.query,
      )
    }

    if (queryData?.[1]?.rankedKeyword) {
      result.risingQueries = queryData[1].rankedKeyword.map(
        (item: { query: string; formattedValue: string }) => ({
          query: item.query,
          value: item.formattedValue,
        }),
      )
    }
  } catch (err) {
    console.warn(`  ⚠ Trends related error for "${keyword}":`, (err as Error).message)
  }

  return result
}

// ── Heuristic Competition Estimator (free, no API needed) ───────────────────

function estimateCompetitionHeuristic(keyword: string): {
  score: number // 0-100, lower = easier
  signals: string[]
} {
  const words = keyword.toLowerCase().split(/\s+/)
  const wordCount = words.length
  let score = 50
  const signals: string[] = []

  // Long-tail keywords (4+ words) are typically less competitive
  if (wordCount >= 5) {
    score -= 20
    signals.push('very long-tail (5+ words)')
  } else if (wordCount >= 4) {
    score -= 15
    signals.push('long-tail (4 words)')
  } else if (wordCount === 3) {
    score -= 5
    signals.push('mid-tail (3 words)')
  } else if (wordCount <= 2) {
    score += 15
    signals.push('short-tail (1-2 words, high competition)')
  }

  // Question keywords tend to have lower competition
  const questionWords = ['what', 'how', 'why', 'when', 'where', 'which', 'is', 'can', 'does']
  if (questionWords.some(q => words[0] === q)) {
    score -= 10
    signals.push('question format')
  }

  // Comparison keywords ("vs", "alternative", "comparison")
  const comparisonTerms = ['vs', 'versus', 'alternative', 'alternatives', 'comparison', 'compared']
  if (comparisonTerms.some(t => words.includes(t))) {
    score -= 5
    signals.push('comparison/alternative keyword')
  }

  // Integration/tool-specific keywords (niche)
  const nicheTools = ['lovable', 'bolt.new', 'base44', 'v0.dev', 'mcp', 'graphql', 'nextjs', 'nuxt']
  if (nicheTools.some(t => keyword.toLowerCase().includes(t))) {
    score -= 15
    signals.push('niche tool-specific')
  }

  // Year-qualified searches
  if (/20\d{2}/.test(keyword)) {
    score -= 5
    signals.push('year-qualified')
  }

  // "Best" or "top" keywords tend to be more competitive
  if (words.includes('best') || words.includes('top')) {
    score += 10
    signals.push('"best/top" = higher competition')
  }

  // Very generic terms
  const genericTerms = ['cms', 'drupal', 'wordpress', 'headless']
  const genericCount = genericTerms.filter(t => words.includes(t)).length
  if (genericCount >= 2 && wordCount <= 2) {
    score += 10
    signals.push('generic short keyword')
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    signals,
  }
}

// ── DataForSEO Integration (optional) ───────────────────────────────────────

async function fetchDataForSEOVolume(
  keywords: string[],
): Promise<Map<string, DataForSEOVolumeResult>> {
  const login = process.env.DATAFORSEO_LOGIN
  const password = process.env.DATAFORSEO_PASSWORD
  const results = new Map<string, DataForSEOVolumeResult>()

  if (!login || !password) {
    console.log('\n⚠ DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set — skipping volume enrichment')
    console.log('  Sign up at https://dataforseo.com (pay-as-you-go, ~$0.05/1K keywords)\n')
    return results
  }

  const auth = Buffer.from(`${login}:${password}`).toString('base64')

  // DataForSEO rejects batches containing keywords with too many words (max ~10)
  const filtered = keywords.filter(kw => kw.split(/\s+/).length <= 10)
  if (filtered.length < keywords.length) {
    console.log(`  (Skipped ${keywords.length - filtered.length} keywords too long for DataForSEO)`)
  }

  // DataForSEO accepts up to 700 keywords per request
  const batches: string[][] = []
  for (let i = 0; i < filtered.length; i += 700) {
    batches.push(filtered.slice(i, i + 700))
  }

  for (const batch of batches) {
    console.log(`  💰 DataForSEO: fetching volume for ${batch.length} keywords...`)

    try {
      const response = await fetch(
        'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live',
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify([
            {
              keywords: batch,
              language_code: 'en',
              location_code: 2840, // United States
            },
          ]),
        },
      )

      if (!response.ok) {
        console.warn(`  ⚠ DataForSEO returned ${response.status}`)
        continue
      }

      const data = await response.json()
      const taskStatus = data?.tasks?.[0]?.status_code
      if (taskStatus !== 20000) {
        console.warn(`  ⚠ DataForSEO task status: ${taskStatus} — ${data?.tasks?.[0]?.status_message}`)
      }
      const tasks = data?.tasks?.[0]?.result

      if (tasks && Array.isArray(tasks)) {
        for (const item of tasks) {
          if (!item.keyword) continue
          const competitionRaw = item.competition_index ?? item.competition ?? 0
          results.set(item.keyword, {
            keyword: item.keyword,
            searchVolume: item.search_volume ?? 0,
            competition: typeof competitionRaw === 'number' ? competitionRaw / 100 : 0,
            cpc: item.cpc ?? 0,
            categories: item.categories ?? [],
            monthlySearches: Array.isArray(item.monthly_searches)
              ? item.monthly_searches.map(
                  (m: { year: number; month: number; search_volume: number }) => ({
                    year: m.year,
                    month: m.month,
                    searchVolume: m.search_volume,
                  }),
                )
              : [],
          })
        }
        console.log(`  ✓ Got volume data for ${results.size} keywords`)
      } else {
        console.warn(`  ⚠ DataForSEO returned no results`)
      }
    } catch (err) {
      console.warn(`  ⚠ DataForSEO error:`, (err as Error).message)
    }

    await sleep(500)
  }

  return results
}

// ── DataForSEO SERP Analysis (optional) ─────────────────────────────────────

async function fetchSERPAnalysis(keywords: string[]): Promise<Map<string, SERPAnalysis>> {
  const login = process.env.DATAFORSEO_LOGIN
  const password = process.env.DATAFORSEO_PASSWORD
  const results = new Map<string, SERPAnalysis>()

  if (!login || !password) return results

  const auth = Buffer.from(`${login}:${password}`).toString('base64')

  for (const keyword of keywords) {
    console.log(`  🔎 SERP analysis: "${keyword}"`)

    try {
      const response = await fetch(
        'https://api.dataforseo.com/v3/serp/google/organic/live/regular',
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify([
            {
              keyword,
              location_code: 2840,
              language_code: 'en',
              depth: 10,
            },
          ]),
        },
      )

      if (!response.ok) {
        console.warn(`  ⚠ SERP API returned ${response.status}`)
        continue
      }

      const data = await response.json()
      const task = data?.tasks?.[0]?.result?.[0]
      if (!task) continue

      const items = task.items || []
      const organicResults = items.filter((i: { type: string }) => i.type === 'organic')
      const top5Domains = organicResults.slice(0, 5).map((i: { domain: string }) => i.domain)

      const hasForumInTop5 = top5Domains.some(
        (d: string) =>
          d.includes('reddit.com') ||
          d.includes('quora.com') ||
          d.includes('stackoverflow.com') ||
          d.includes('forum'),
      )
      const hasRedditInTop5 = top5Domains.some((d: string) => d.includes('reddit.com'))

      const exactTitleMatches = organicResults.filter((i: { title: string }) =>
        i.title?.toLowerCase().includes(keyword.toLowerCase()),
      ).length

      const avgDomainRank =
        organicResults.length > 0
          ? organicResults.reduce(
              (sum: number, i: { domain_rank?: number }) => sum + (i.domain_rank || 0),
              0,
            ) / organicResults.length
          : 0

      const hasFeaturedSnippet = items.some((i: { type: string }) => i.type === 'featured_snippet')
      const hasPeopleAlsoAsk = items.some((i: { type: string }) => i.type === 'people_also_ask')

      let competitionScore = 50
      if (hasForumInTop5) competitionScore -= 20
      if (hasRedditInTop5) competitionScore -= 10
      if (avgDomainRank < 30) competitionScore -= 15
      else if (avgDomainRank > 70) competitionScore += 20
      if (exactTitleMatches <= 2) competitionScore -= 10
      else if (exactTitleMatches >= 7) competitionScore += 15
      if (hasFeaturedSnippet) competitionScore += 5
      competitionScore = Math.max(0, Math.min(100, competitionScore))

      results.set(keyword, {
        keyword,
        totalResults: task.se_results_count || 0,
        hasForumInTop5,
        hasRedditInTop5,
        avgDomainRank: Math.round(avgDomainRank),
        exactTitleMatches,
        hasFeaturedSnippet,
        hasPeopleAlsoAsk,
        competitionScore,
        topResults: organicResults.slice(0, 5).map(
          (i: { rank_absolute: number; title: string; url: string; domain: string }) => ({
            position: i.rank_absolute,
            title: i.title,
            url: i.url,
            domain: i.domain,
          }),
        ),
      })
    } catch (err) {
      console.warn(`  ⚠ SERP error for "${keyword}":`, (err as Error).message)
    }

    await sleep(1000)
  }

  return results
}

// ── Report Generation ───────────────────────────────────────────────────────

function generateReport(
  allKeywords: KeywordData[],
  trendsData: Map<string, TrendsResult>,
  volumeData: Map<string, DataForSEOVolumeResult>,
  serpData: Map<string, SERPAnalysis>,
  heuristics: Map<string, { score: number; signals: string[] }>,
): string {
  const lines: string[] = []
  const timestamp = new Date().toISOString().split('T')[0]

  lines.push(`# Keyword Research Report — ${timestamp}`)
  lines.push('')
  lines.push(`Total keywords discovered: **${allKeywords.length}**`)
  lines.push('')

  // ── Data Sources Used ──
  lines.push('## Data Sources')
  lines.push('')
  lines.push(`- Google Autocomplete: ${allKeywords.filter(k => k.source === 'autocomplete').length} keywords`)
  lines.push(`- Google Trends: ${allKeywords.filter(k => k.source.startsWith('trends')).length} keywords`)
  lines.push(`- DataForSEO volume: ${volumeData.size > 0 ? `${volumeData.size} enriched` : 'not configured (set DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD)'}`)
  lines.push(`- Heuristic scoring: ${heuristics.size} keywords scored`)
  lines.push('')

  // ── Trends Insights ──
  if (trendsData.size > 0) {
    lines.push('## 📈 Google Trends Insights')
    lines.push('')

    for (const [seed, trends] of trendsData) {
      lines.push(`### "${seed}"`)

      if (trends.interestOverTime.length > 0) {
        const recent = trends.interestOverTime.slice(-3)
        const avg = Math.round(recent.reduce((s, d) => s + d.value, 0) / recent.length)
        lines.push(`- Recent trend interest: **${avg}/100**`)
      }

      if (trends.risingQueries.length > 0) {
        lines.push('- **Rising queries** (opportunities):')
        for (const rq of trends.risingQueries.slice(0, 10)) {
          lines.push(`  - "${rq.query}" — ${rq.value}`)
        }
      }

      if (trends.relatedQueries.length > 0) {
        lines.push('- **Top related queries:**')
        for (const q of trends.relatedQueries.slice(0, 10)) {
          lines.push(`  - "${q}"`)
        }
      }

      lines.push('')
    }
  }

  // ── Top Keywords by Source ──
  lines.push('## 🔑 All Discovered Keywords')
  lines.push('')

  // Group by seed
  const bySeed = new Map<string, KeywordData[]>()
  for (const kw of allKeywords) {
    const existing = bySeed.get(kw.seedKeyword) || []
    existing.push(kw)
    bySeed.set(kw.seedKeyword, existing)
  }

  for (const [seed, keywords] of bySeed) {
    lines.push(`### Seed: "${seed}" (${keywords.length} keywords)`)
    lines.push('')

    if (volumeData.size > 0) {
      lines.push('| Keyword | Volume | Competition | CPC | Heuristic |')
      lines.push('|---------|--------|-------------|-----|-----------|')

      const sorted = [...keywords].sort((a, b) => {
        const volA = volumeData.get(a.keyword)?.searchVolume ?? 0
        const volB = volumeData.get(b.keyword)?.searchVolume ?? 0
        return volB - volA
      })

      for (const kw of sorted) {
        const vol = volumeData.get(kw.keyword)
        const heur = heuristics.get(kw.keyword)
        lines.push(
          `| ${kw.keyword} | ${vol?.searchVolume ?? '—'} | ${vol ? (vol.competition * 100).toFixed(0) : '—'} | $${vol?.cpc?.toFixed(2) ?? '—'} | ${heur?.score ?? '—'}/100 |`,
        )
      }
    } else {
      lines.push('| Keyword | Source | Heuristic Score | Signals |')
      lines.push('|---------|--------|----------------|---------|')

      const sorted = [...keywords].sort((a, b) => {
        const heurA = heuristics.get(a.keyword)?.score ?? 50
        const heurB = heuristics.get(b.keyword)?.score ?? 50
        return heurA - heurB // Lower = easier
      })

      for (const kw of sorted) {
        const heur = heuristics.get(kw.keyword)
        lines.push(
          `| ${kw.keyword} | ${kw.source} | ${heur?.score ?? '—'}/100 | ${heur?.signals.join(', ') ?? '—'} |`,
        )
      }
    }

    lines.push('')
  }

  // ── SERP Analysis ──
  if (serpData.size > 0) {
    lines.push('## 🔎 SERP Competition Analysis')
    lines.push('')
    lines.push('| Keyword | Score | Forums? | Reddit? | Exact Titles | Avg DR |')
    lines.push('|---------|-------|---------|---------|--------------|--------|')

    const sorted = [...serpData.values()].sort((a, b) => a.competitionScore - b.competitionScore)

    for (const s of sorted) {
      lines.push(
        `| ${s.keyword} | ${s.competitionScore}/100 | ${s.hasForumInTop5 ? 'Yes' : 'No'} | ${s.hasRedditInTop5 ? 'Yes' : 'No'} | ${s.exactTitleMatches}/10 | ${s.avgDomainRank} |`,
      )
    }
    lines.push('')

    const lowComp = sorted.filter(s => s.competitionScore < 40)
    if (lowComp.length > 0) {
      lines.push('### Low Competition Opportunities — SERP Details')
      lines.push('')
      for (const s of lowComp) {
        lines.push(`#### "${s.keyword}" (score: ${s.competitionScore}/100)`)
        lines.push('')
        for (const r of s.topResults) {
          lines.push(`${r.position}. [${r.title}](${r.url}) — ${r.domain}`)
        }
        lines.push('')
      }
    }
  }

  // ── Best Opportunities Summary ──
  lines.push('## 🎯 Best Keyword Opportunities')
  lines.push('')
  lines.push('Sorted by opportunity score (combines heuristic difficulty and volume data when available):')
  lines.push('')

  // Build an opportunity score combining available data
  const opportunities = allKeywords
    .map(kw => {
      const heur = heuristics.get(kw.keyword)
      const vol = volumeData.get(kw.keyword)
      const serp = serpData.get(kw.keyword)

      // Opportunity score: lower difficulty + higher volume = better
      let opportunityScore = 100 - (heur?.score ?? 50)

      // Boost for volume
      if (vol?.searchVolume) {
        if (vol.searchVolume > 1000) opportunityScore += 20
        else if (vol.searchVolume > 100) opportunityScore += 10
        else if (vol.searchVolume > 10) opportunityScore += 5
      }

      // Boost for low SERP competition
      if (serp) {
        if (serp.competitionScore < 30) opportunityScore += 20
        else if (serp.competitionScore < 50) opportunityScore += 10
      }

      // Boost for rising trends
      if (kw.isRising) opportunityScore += 15

      return {
        ...kw,
        heuristicScore: heur?.score ?? 50,
        heuristicSignals: heur?.signals ?? [],
        volume: vol?.searchVolume,
        serpScore: serp?.competitionScore,
        opportunityScore: Math.max(0, Math.min(200, opportunityScore)),
      }
    })
    .sort((a, b) => b.opportunityScore - a.opportunityScore)

  lines.push('| # | Keyword | Opp. Score | Difficulty | Volume | Rising? | Signals |')
  lines.push('|---|---------|-----------|------------|--------|---------|---------|')

  for (const [i, kw] of opportunities.slice(0, 50).entries()) {
    lines.push(
      `| ${i + 1} | ${kw.keyword} | ${kw.opportunityScore} | ${kw.heuristicScore}/100 | ${kw.volume ?? '—'} | ${kw.isRising ? 'YES' : ''} | ${kw.heuristicSignals.join(', ')} |`,
    )
  }

  lines.push('')
  lines.push('---')
  lines.push(`_Generated by keyword-research.ts on ${timestamp}_`)

  return lines.join('\n')
}

// ── CSV Export ───────────────────────────────────────────────────────────────

function generateCSV(
  allKeywords: KeywordData[],
  volumeData: Map<string, DataForSEOVolumeResult>,
  serpData: Map<string, SERPAnalysis>,
  heuristics: Map<string, { score: number; signals: string[] }>,
): string {
  const headers = [
    'keyword',
    'seed_keyword',
    'source',
    'search_volume',
    'competition',
    'cpc',
    'heuristic_score',
    'heuristic_signals',
    'serp_competition_score',
    'has_forum_top5',
    'has_reddit_top5',
    'is_rising',
  ]

  const rows = allKeywords.map(kw => {
    const vol = volumeData.get(kw.keyword)
    const serp = serpData.get(kw.keyword)
    const heur = heuristics.get(kw.keyword)

    return [
      `"${kw.keyword}"`,
      `"${kw.seedKeyword}"`,
      kw.source,
      vol?.searchVolume ?? '',
      vol ? (vol.competition * 100).toFixed(0) : '',
      vol?.cpc?.toFixed(2) ?? '',
      heur?.score ?? '',
      `"${heur?.signals.join('; ') ?? ''}"`,
      serp?.competitionScore ?? '',
      serp?.hasForumInTop5 ?? '',
      serp?.hasRedditInTop5 ?? '',
      kw.isRising ? 'true' : '',
    ].join(',')
  })

  return [headers.join(','), ...rows].join('\n')
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { seeds, mode, enrich, depth } = parseArgs()

  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║     Keyword Research Tool v1.0                          ║')
  console.log('║     Ubersuggest-style keyword discovery for SEO         ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log()
  console.log(`Seeds: ${seeds.join(', ')}`)
  console.log(`Mode: ${mode}`)
  console.log(`Depth: ${depth}`)
  console.log()

  // Check available APIs
  const hasDataForSEO = !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD)

  console.log('API availability:')
  console.log(`  Google Autocomplete:  ✅ (free, no key needed)`)
  console.log(`  Google Trends:        ✅ (free, no key needed)`)
  console.log(`  DataForSEO volume:    ${hasDataForSEO ? '✅' : '❌ Set DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD'}`)
  console.log(`  Heuristic scoring:    ✅ (built-in, always available)`)
  console.log()

  if (!hasDataForSEO) {
    console.log('Tip: Add API keys for richer data. See script header for setup instructions.')
    console.log()
  }

  const allKeywords: KeywordData[] = []
  const trendsData = new Map<string, TrendsResult>()
  const uniqueKeywords = new Set<string>()

  // Add seeds as keywords
  for (const seed of seeds) {
    allKeywords.push({ keyword: seed, source: 'seed', seedKeyword: seed })
    uniqueKeywords.add(seed)
  }

  // ── Step 1: Autocomplete Expansion ──
  if (mode === 'full' || mode === 'autocomplete') {
    console.log('═══ Phase 1: Google Autocomplete Expansion ═══')
    console.log()

    for (const seed of seeds) {
      console.log(`\n▶ Expanding: "${seed}"`)
      const keywords = await expandKeywordAutocomplete(seed, depth)

      for (const kw of keywords) {
        if (!uniqueKeywords.has(kw.keyword)) {
          uniqueKeywords.add(kw.keyword)
          allKeywords.push(kw)
        }
      }

      console.log(`  ✓ Found ${keywords.length} suggestions for "${seed}"`)
    }

    console.log(`\n✓ Total unique keywords after autocomplete: ${allKeywords.length}`)
  }

  // ── Step 2: Google Trends ──
  if (mode === 'full' || mode === 'trends') {
    console.log('\n═══ Phase 2: Google Trends Analysis ═══')
    console.log()

    for (const seed of seeds) {
      console.log(`\n▶ Trends: "${seed}"`)
      const trends = await fetchTrendsData(seed)
      trendsData.set(seed, trends)

      for (const rq of trends.risingQueries) {
        if (!uniqueKeywords.has(rq.query)) {
          uniqueKeywords.add(rq.query)
          allKeywords.push({
            keyword: rq.query,
            source: 'trends-rising',
            seedKeyword: seed,
            isRising: true,
          })
        }
      }

      for (const q of trends.relatedQueries) {
        if (!uniqueKeywords.has(q)) {
          uniqueKeywords.add(q)
          allKeywords.push({
            keyword: q,
            source: 'trends-related',
            seedKeyword: seed,
          })
        }
      }

      console.log(
        `  ✓ ${trends.relatedQueries.length} related + ${trends.risingQueries.length} rising queries`,
      )
    }

    console.log(`\n✓ Total unique keywords after trends: ${allKeywords.length}`)
  }

  // ── Step 3: Heuristic Competition Scoring ──
  console.log('\n═══ Phase 3: Heuristic Competition Scoring ═══')
  console.log()

  const heuristics = new Map<string, { score: number; signals: string[] }>()
  for (const kw of allKeywords) {
    heuristics.set(kw.keyword, estimateCompetitionHeuristic(kw.keyword))
  }
  console.log(`✓ Scored ${heuristics.size} keywords with heuristic competition estimator`)

  // ── Step 4: DataForSEO Enrichment (optional) ──
  let volumeData = new Map<string, DataForSEOVolumeResult>()
  let serpData = new Map<string, SERPAnalysis>()

  if (enrich || hasDataForSEO) {
    console.log('\n═══ Phase 5: DataForSEO Volume & SERP Enrichment ═══')
    console.log()

    const keywordStrings = allKeywords.map(kw => kw.keyword)
    volumeData = await fetchDataForSEOVolume(keywordStrings)

    // SERP analysis for top candidates (to manage costs)
    if (volumeData.size > 0) {
      const topCandidates = allKeywords
        .filter(kw => {
          const vol = volumeData.get(kw.keyword)
          return vol && vol.searchVolume > 0
        })
        .sort((a, b) => {
          const volA = volumeData.get(a.keyword)?.searchVolume ?? 0
          const volB = volumeData.get(b.keyword)?.searchVolume ?? 0
          return volB - volA
        })
        .slice(0, 30)
        .map(kw => kw.keyword)

      if (topCandidates.length > 0) {
        console.log(`\nRunning SERP analysis for top ${topCandidates.length} keywords...`)
        serpData = await fetchSERPAnalysis(topCandidates)
      }
    }
  }

  // ── Step 6: Generate Reports ──
  console.log('\n═══ Generating Reports ═══')
  console.log()

  await fs.mkdir(OUTPUT_DIR, { recursive: true })

  const report = generateReport(allKeywords, trendsData, volumeData, serpData, heuristics)
  const csv = generateCSV(allKeywords, volumeData, serpData, heuristics)

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const reportPath = path.join(OUTPUT_DIR, `report-${timestamp}.md`)
  const csvPath = path.join(OUTPUT_DIR, `keywords-${timestamp}.csv`)
  const jsonPath = path.join(OUTPUT_DIR, `raw-${timestamp}.json`)

  await fs.writeFile(reportPath, report)
  await fs.writeFile(csvPath, csv)
  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      {
        metadata: {
          seeds,
          mode,
          depth,
          enriched: enrich || hasDataForSEO,
          hasDataForSEO,
          generatedAt: new Date().toISOString(),
          totalKeywords: allKeywords.length,
        },
        keywords: allKeywords,
        trends: Object.fromEntries(trendsData),
        volumeData: Object.fromEntries(volumeData),
        serpData: Object.fromEntries(serpData),
        heuristics: Object.fromEntries(heuristics),
      },
      null,
      2,
    ),
  )

  console.log(`✅ Report: ${reportPath}`)
  console.log(`✅ CSV:    ${csvPath}`)
  console.log(`✅ JSON:   ${jsonPath}`)

  // ── Summary ──
  console.log('\n╔══════════════════════════════════════════════════════════╗')
  console.log('║                       Summary                           ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log()
  console.log(`Total keywords discovered: ${allKeywords.length}`)
  console.log(`  From autocomplete:     ${allKeywords.filter(k => k.source === 'autocomplete').length}`)
  console.log(`  From trends (rising):  ${allKeywords.filter(k => k.source === 'trends-rising').length}`)
  console.log(`  From trends (related): ${allKeywords.filter(k => k.source === 'trends-related').length}`)
  console.log(`  Seed keywords:         ${seeds.length}`)

  if (volumeData.size > 0) {
    const withVolume = allKeywords.filter(k => (volumeData.get(k.keyword)?.searchVolume ?? 0) > 0)
    console.log(`  With search volume:    ${withVolume.length}`)
  }
  // Show top opportunities
  const topOps = allKeywords
    .map(kw => ({
      keyword: kw.keyword,
      score: heuristics.get(kw.keyword)?.score ?? 50,
      volume: volumeData.get(kw.keyword)?.searchVolume,
      rising: kw.isRising,
    }))
    .sort((a, b) => {
      // Sort by: low heuristic + has volume + rising
      let scoreA = a.score
      let scoreB = b.score
      if (a.volume && a.volume > 100) scoreA -= 20
      if (b.volume && b.volume > 100) scoreB -= 20
      if (a.rising) scoreA -= 10
      if (b.rising) scoreB -= 10
      return scoreA - scoreB
    })
    .slice(0, 20)

  console.log('\n🎯 Top 20 Keyword Opportunities:')
  console.log()
  for (const [i, op] of topOps.entries()) {
    const parts = [
      `${(i + 1).toString().padStart(2)}. "${op.keyword}"`,
      `difficulty: ${op.score}/100`,
    ]
    if (op.volume) parts.push(`vol: ${op.volume}`)
    if (op.rising) parts.push('📈 RISING')
    console.log(`  ${parts.join(' | ')}`)
  }

  console.log('\n💡 Tips:')
  if (!hasDataForSEO) {
    console.log('  - Set DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD for search volume (pay-as-you-go, ~$0.05/1K)')
  }
  console.log('  - Open the CSV in a spreadsheet for sorting/filtering')
  console.log('  - Use --depth 2 for deeper keyword expansion (slower but more thorough)')
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
