#!/usr/bin/env tsx
/**
 * Google Search Console CLI.
 *
 * Subcommands:
 *   list-sites
 *   performance <site> [--days N] [--dim query|page|country|device] [--limit N] [--json]
 *   inspect <site> <url> [--json]
 *   sitemap-status <site> [--json]
 *   bulk-inspect <site> <file-or-stdin> [--json] [--out <file>]
 *
 * Site argument can be either the exact GSC siteUrl (e.g. "https://decoupled.io/",
 * "sc-domain:decoupled.io") or a fuzzy match — the script lists sites and picks
 * the one that contains the argument string.
 */

import dotenv from 'dotenv'
import { google } from 'googleapis'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

dotenv.config({ path: join(process.cwd(), '.env.local') })

const KEY_PATH = process.env.GSC_SERVICE_ACCOUNT_KEY_PATH
if (!KEY_PATH) {
  console.error('Missing GSC_SERVICE_ACCOUNT_KEY_PATH in .env.local')
  process.exit(1)
}

const auth = new google.auth.GoogleAuth({
  keyFile: resolve(KEY_PATH),
  // webmasters (not readonly) so we can submit/delete sitemaps.
  // URL inspection + search analytics also work under this scope.
  scopes: ['https://www.googleapis.com/auth/webmasters'],
})

const webmasters = google.webmasters({ version: 'v3', auth })
const searchconsole = google.searchconsole({ version: 'v1', auth })

// ---------- arg parsing ----------

type Args = {
  _: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        args.flags[key] = next
        i++
      } else {
        args.flags[key] = true
      }
    } else {
      args._.push(a)
    }
  }
  return args
}

// ---------- helpers ----------

async function listAllSites(): Promise<string[]> {
  const res = await webmasters.sites.list()
  const entries = res.data.siteEntry || []
  return entries
    .filter(e => e.permissionLevel !== 'siteUnverifiedUser')
    .map(e => e.siteUrl!)
    .filter(Boolean)
}

async function resolveSite(input: string): Promise<string> {
  const sites = await listAllSites()
  // Exact match first
  if (sites.includes(input)) return input
  // Fuzzy match by substring
  const match = sites.find(s => s.includes(input))
  if (match) return match
  throw new Error(
    `Site "${input}" not found. Available sites:\n  ${sites.join('\n  ')}`,
  )
}

function jsonOrPretty(data: unknown, args: Args): string {
  if (args.flags.json) return JSON.stringify(data, null, 2)
  return ''
}

// ---------- commands ----------

async function cmdListSites(args: Args) {
  const sites = await listAllSites()
  if (args.flags.json) {
    console.log(JSON.stringify(sites, null, 2))
    return
  }
  console.log(`\nVerified GSC sites (${sites.length}):\n`)
  for (const s of sites) console.log(`  ${s}`)
  console.log()
}

async function cmdPerformance(args: Args) {
  const siteArg = args._[1]
  if (!siteArg) throw new Error('Usage: performance <site> [--days N] [--dim query|page] [--limit N]')

  const site = await resolveSite(siteArg)
  const days = Number(args.flags.days || 28)
  const dim = String(args.flags.dim || 'query') as 'query' | 'page' | 'country' | 'device'
  const limit = Number(args.flags.limit || 25)

  const endDate = new Date().toISOString().slice(0, 10)
  const startDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

  const res = await webmasters.searchanalytics.query({
    siteUrl: site,
    requestBody: {
      startDate,
      endDate,
      dimensions: [dim],
      rowLimit: limit,
    },
  })

  const rows = res.data.rows || []

  if (args.flags.json) {
    console.log(JSON.stringify({ site, startDate, endDate, dim, rows }, null, 2))
    return
  }

  console.log(`\nPerformance: ${site}`)
  console.log(`Range: ${startDate} → ${endDate}  |  Dimension: ${dim}  |  Rows: ${rows.length}\n`)
  const w = dim === 'query' || dim === 'page' ? 60 : 20
  console.log(
    `${dim.toUpperCase().padEnd(w)}  ${'CLICKS'.padStart(8)}  ${'IMPR'.padStart(8)}  ${'CTR'.padStart(7)}  ${'POS'.padStart(6)}`,
  )
  console.log('-'.repeat(w + 36))
  for (const r of rows) {
    const key = (r.keys?.[0] || '').slice(0, w)
    console.log(
      `${key.padEnd(w)}  ${String(r.clicks ?? 0).padStart(8)}  ${String(r.impressions ?? 0).padStart(8)}  ${((r.ctr ?? 0) * 100).toFixed(1).padStart(6)}%  ${(r.position ?? 0).toFixed(1).padStart(6)}`,
    )
  }
  console.log()
}

async function cmdInspect(args: Args) {
  const siteArg = args._[1]
  const urlArg = args._[2]
  if (!siteArg || !urlArg) throw new Error('Usage: inspect <site> <url>')

  const site = await resolveSite(siteArg)

  const res = await searchconsole.urlInspection.index.inspect({
    requestBody: {
      inspectionUrl: urlArg,
      siteUrl: site,
    },
  })

  if (args.flags.json) {
    console.log(JSON.stringify(res.data, null, 2))
    return
  }

  const r = res.data.inspectionResult
  if (!r) {
    console.log('No inspection result returned.')
    return
  }

  const index = r.indexStatusResult
  console.log(`\nURL Inspection: ${urlArg}`)
  console.log(`Site: ${site}\n`)
  console.log(`Verdict:              ${index?.verdict ?? 'N/A'}`)
  console.log(`Coverage state:       ${index?.coverageState ?? 'N/A'}`)
  console.log(`Indexing state:       ${index?.indexingState ?? 'N/A'}`)
  console.log(`Last crawl time:      ${index?.lastCrawlTime ?? 'N/A'}`)
  console.log(`Page fetch state:     ${index?.pageFetchState ?? 'N/A'}`)
  console.log(`Robots.txt state:     ${index?.robotsTxtState ?? 'N/A'}`)
  console.log(`User canonical:       ${index?.userCanonical ?? 'N/A'}`)
  console.log(`Google canonical:     ${index?.googleCanonical ?? 'N/A'}`)
  if (index?.referringUrls?.length) {
    console.log(`Referring URLs:`)
    for (const u of index.referringUrls) console.log(`  - ${u}`)
  }
  if (index?.sitemap?.length) {
    console.log(`Sitemaps referencing: ${index.sitemap.join(', ')}`)
  }

  const mobile = r.mobileUsabilityResult
  if (mobile) {
    console.log(`\nMobile verdict:       ${mobile.verdict ?? 'N/A'}`)
  }

  const rich = r.richResultsResult
  if (rich?.detectedItems?.length) {
    console.log(`\nStructured data items: ${rich.detectedItems.length}`)
    for (const item of rich.detectedItems) {
      console.log(`  - ${item.richResultType}: ${item.items?.length ?? 0} items`)
    }
  }
  console.log()
}

async function cmdSitemapStatus(args: Args) {
  const siteArg = args._[1]
  if (!siteArg) throw new Error('Usage: sitemap-status <site>')

  const site = await resolveSite(siteArg)
  const res = await webmasters.sitemaps.list({ siteUrl: site })
  const maps = res.data.sitemap || []

  if (args.flags.json) {
    console.log(JSON.stringify({ site, sitemaps: maps }, null, 2))
    return
  }

  console.log(`\nSitemaps for ${site}\n`)
  if (maps.length === 0) {
    console.log('  (no sitemaps submitted)\n')
    return
  }

  for (const m of maps) {
    console.log(`  ${m.path}`)
    console.log(`    Last submitted: ${m.lastSubmitted ?? 'N/A'}`)
    console.log(`    Last downloaded: ${m.lastDownloaded ?? 'N/A'}`)
    console.log(`    Is pending: ${m.isPending ?? false}`)
    console.log(`    Errors: ${m.errors ?? 0}  Warnings: ${m.warnings ?? 0}`)
    if (m.contents?.length) {
      for (const c of m.contents) {
        console.log(`    Type ${c.type}: ${c.submitted} submitted, ${c.indexed} indexed`)
      }
    }
    console.log()
  }
}

async function cmdBulkInspect(args: Args) {
  const siteArg = args._[1]
  const fileArg = args._[2]
  if (!siteArg) throw new Error('Usage: bulk-inspect <site> <file-with-urls-or-"-">')

  const site = await resolveSite(siteArg)

  let raw: string
  if (!fileArg || fileArg === '-') {
    raw = readFileSync(0, 'utf-8') // read stdin
  } else {
    raw = readFileSync(fileArg, 'utf-8')
  }

  const urls = raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))

  console.log(`Inspecting ${urls.length} URLs against ${site}...`)
  console.log('(Quota: 2000/day, 600/minute per project — pacing ~100ms between calls)\n')

  const results: {
    url: string
    verdict?: string
    coverageState?: string
    indexingState?: string
    lastCrawlTime?: string
    googleCanonical?: string
    userCanonical?: string
    error?: string
  }[] = []

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    try {
      const res = await searchconsole.urlInspection.index.inspect({
        requestBody: { inspectionUrl: url, siteUrl: site },
      })
      const idx = res.data.inspectionResult?.indexStatusResult
      results.push({
        url,
        verdict: idx?.verdict ?? undefined,
        coverageState: idx?.coverageState ?? undefined,
        indexingState: idx?.indexingState ?? undefined,
        lastCrawlTime: idx?.lastCrawlTime ?? undefined,
        googleCanonical: idx?.googleCanonical ?? undefined,
        userCanonical: idx?.userCanonical ?? undefined,
      })
      process.stdout.write(`  [${i + 1}/${urls.length}] ${idx?.verdict ?? '?'}  ${url}\n`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({ url, error: msg })
      process.stdout.write(`  [${i + 1}/${urls.length}] ERROR  ${url}  (${msg})\n`)
    }
    // Pace ourselves
    if (i < urls.length - 1) await new Promise(r => setTimeout(r, 120))
  }

  const outPath = args.flags.out as string | undefined
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(results, null, 2))
    console.log(`\nWrote ${results.length} results to ${outPath}`)
  } else if (args.flags.json) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    console.log(`\nSummary:`)
    const byVerdict: Record<string, number> = {}
    for (const r of results) {
      const k = r.verdict || (r.error ? 'ERROR' : 'UNKNOWN')
      byVerdict[k] = (byVerdict[k] || 0) + 1
    }
    for (const [k, v] of Object.entries(byVerdict).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(20)} ${v}`)
    }
  }
}

async function cmdSitemapSubmit(args: Args) {
  const siteArg = args._[1]
  const sitemapUrl = args._[2]
  if (!siteArg || !sitemapUrl) throw new Error('Usage: sitemap-submit <site> <sitemap-url>')

  const site = await resolveSite(siteArg)

  await webmasters.sitemaps.submit({
    siteUrl: site,
    feedpath: sitemapUrl,
  })

  console.log(`\nSubmitted ${sitemapUrl} to ${site}`)
  console.log(`(Google will fetch it on its own schedule — usually within hours.)\n`)
}

async function cmdSitemapDelete(args: Args) {
  const siteArg = args._[1]
  const sitemapUrl = args._[2]
  if (!siteArg || !sitemapUrl) throw new Error('Usage: sitemap-delete <site> <sitemap-url>')

  const site = await resolveSite(siteArg)

  await webmasters.sitemaps.delete({
    siteUrl: site,
    feedpath: sitemapUrl,
  })

  console.log(`\nDeleted ${sitemapUrl} from ${site}\n`)
}

// ---------- entry point ----------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]

  try {
    switch (cmd) {
      case 'list-sites':
        await cmdListSites(args)
        break
      case 'performance':
        await cmdPerformance(args)
        break
      case 'inspect':
        await cmdInspect(args)
        break
      case 'sitemap-status':
        await cmdSitemapStatus(args)
        break
      case 'sitemap-submit':
        await cmdSitemapSubmit(args)
        break
      case 'sitemap-delete':
        await cmdSitemapDelete(args)
        break
      case 'bulk-inspect':
        await cmdBulkInspect(args)
        break
      default:
        console.log(`\nGoogle Search Console CLI\n`)
        console.log(`Usage:`)
        console.log(`  tsx scripts/gsc-query.ts list-sites`)
        console.log(`  tsx scripts/gsc-query.ts performance <site> [--days N] [--dim query|page|country|device] [--limit N]`)
        console.log(`  tsx scripts/gsc-query.ts inspect <site> <url>`)
        console.log(`  tsx scripts/gsc-query.ts sitemap-status <site>`)
        console.log(`  tsx scripts/gsc-query.ts bulk-inspect <site> <urls-file> [--out results.json]`)
        console.log(`\nFlags:`)
        console.log(`  --json            Output raw JSON instead of formatted text`)
        console.log(`\nSite argument accepts fuzzy matching — e.g. "decoupled" matches "https://decoupled.io/"\n`)
        process.exit(cmd ? 1 : 0)
    }
  } catch (err) {
    console.error(`\nError: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}

main()
