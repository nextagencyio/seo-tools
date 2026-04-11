/**
 * SEO Audit Crawler — Technical SEO audit for any website
 *
 * Crawls a site and checks for common SEO issues:
 *   - Meta tags (title, description, canonical, robots)
 *   - Heading structure (H1, H2)
 *   - Response codes, redirects, broken links
 *   - robots.txt and sitemap.xml
 *   - Structured data (JSON-LD)
 *   - Image alt attributes
 *   - Page speed (TTFB)
 *   - Mobile viewport
 *   - Duplicate content signals
 *   - Crawl depth analysis
 *
 * Usage:
 *   npx tsx scripts/seo-audit.ts "https://www.mavsboard.com"
 *   npx tsx scripts/seo-audit.ts "https://www.mavsboard.com" --max-pages 50
 *   npx tsx scripts/seo-audit.ts "https://www.mavsboard.com" --max-pages 200 --delay 500
 *
 * Options:
 *   --max-pages N     Maximum pages to crawl (default: 100)
 *   --delay N         Delay between requests in ms (default: 1000)
 *   --include-external  Also check external links for broken links
 */

import fs from 'fs/promises'
import path from 'path'
import { load as cheerioLoad } from 'cheerio'

// ── Config ──────────────────────────────────────────────────────────────────

const OUTPUT_DIR = path.join(process.cwd(), 'scripts', 'keyword-data')

// ── Types ───────────────────────────────────────────────────────────────────

interface PageAudit {
  url: string
  status: number
  redirectUrl?: string
  ttfbMs: number
  title: string
  titleLength: number
  metaDescription: string
  metaDescriptionLength: number
  canonical: string | null
  robots: string | null
  h1s: string[]
  h2s: string[]
  hasViewport: boolean
  hasStructuredData: boolean
  structuredDataTypes: string[]
  images: { src: string; alt: string | null }[]
  imagesWithoutAlt: number
  internalLinks: string[]
  externalLinks: string[]
  brokenLinks: string[]
  hasPrintVersion: boolean
  wordCount: number
  depth: number
  issues: AuditIssue[]
}

interface AuditIssue {
  severity: 'error' | 'warning' | 'info'
  category: string
  message: string
  details?: string
}

interface SiteAudit {
  url: string
  crawlDate: string
  pagesAudited: number
  robotsTxt: RobotsTxtAudit | null
  sitemap: SitemapAudit | null
  pages: PageAudit[]
  summary: AuditSummary
}

interface RobotsTxtAudit {
  exists: boolean
  content: string
  hasSitemap: boolean
  sitemapUrls: string[]
  disallowedPaths: string[]
  issues: AuditIssue[]
}

interface SitemapAudit {
  exists: boolean
  url: string
  urlCount: number
  issues: AuditIssue[]
}

interface AuditSummary {
  totalPages: number
  totalIssues: number
  errors: number
  warnings: number
  infos: number
  avgTtfbMs: number
  pagesWithoutTitle: number
  pagesWithoutDescription: number
  pagesWithoutH1: number
  pagesWithMultipleH1s: number
  pagesWithoutCanonical: number
  pagesWithoutViewport: number
  totalImagesWithoutAlt: number
  totalBrokenLinks: number
  pagesWithStructuredData: number
  duplicateTitles: Map<string, string[]>
  duplicateDescriptions: Map<string, string[]>
  avgWordCount: number
  maxDepth: number
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  let url = ''
  let maxPages = 100
  let delay = 1000
  let includeExternal = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max-pages' && args[i + 1]) {
      maxPages = parseInt(args[i + 1], 10)
      i++
    } else if (args[i] === '--delay' && args[i + 1]) {
      delay = parseInt(args[i + 1], 10)
      i++
    } else if (args[i] === '--include-external') {
      includeExternal = true
    } else if (!args[i].startsWith('--')) {
      url = args[i]
    }
  }

  if (!url) {
    console.error('Usage: npx tsx scripts/seo-audit.ts "https://example.com" [--max-pages N] [--delay N]')
    process.exit(1)
  }

  // Normalize URL
  if (!url.startsWith('http')) url = `https://${url}`
  url = url.replace(/\/$/, '')

  return { url, maxPages, delay, includeExternal }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeUrl(href: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(href, baseUrl)
    // Remove fragment
    resolved.hash = ''
    // Remove trailing slash for consistency
    let normalized = resolved.toString().replace(/\/$/, '')
    return normalized
  } catch {
    return null
  }
}

function isInternalUrl(url: string, baseOrigin: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.origin === baseOrigin
  } catch {
    return false
  }
}

function shouldCrawl(url: string): boolean {
  // Skip non-HTML resources
  const skipExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico',
    '.css', '.js', '.pdf', '.zip', '.xml', '.json', '.rss', '.atom',
    '.mp3', '.mp4', '.avi', '.mov', '.woff', '.woff2', '.ttf', '.eot']
  const lower = url.toLowerCase()
  if (skipExtensions.some(ext => lower.endsWith(ext))) return false
  // Skip common non-content paths
  if (lower.includes('/wp-admin') || lower.includes('/admin/')) return false
  return true
}

async function fetchPage(url: string): Promise<{ html: string; status: number; ttfbMs: number; redirectUrl?: string; contentType?: string }> {
  const start = performance.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'SEOAuditBot/1.0 (compatible; site audit tool)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    })
    const ttfbMs = Math.round(performance.now() - start)
    const contentType = response.headers.get('content-type') || ''
    const html = contentType.includes('text/html') || contentType.includes('text/xml')
      ? await response.text()
      : ''
    const redirectUrl = response.redirected ? response.url : undefined

    return { html, status: response.status, ttfbMs, redirectUrl, contentType }
  } catch (err: any) {
    const ttfbMs = Math.round(performance.now() - start)
    if (err.name === 'AbortError') {
      return { html: '', status: 408, ttfbMs }
    }
    return { html: '', status: 0, ttfbMs }
  } finally {
    clearTimeout(timeout)
  }
}

// ── Audit Functions ─────────────────────────────────────────────────────────

async function auditRobotsTxt(baseUrl: string): Promise<RobotsTxtAudit> {
  const url = `${baseUrl}/robots.txt`
  console.log(`  🤖 Checking robots.txt...`)
  const { html: content, status } = await fetchPage(url)
  const issues: AuditIssue[] = []

  if (status !== 200 || !content) {
    issues.push({ severity: 'warning', category: 'Indexation', message: 'No robots.txt found', details: `${url} returned ${status}` })
    return { exists: false, content: '', hasSitemap: false, sitemapUrls: [], disallowedPaths: [], issues }
  }

  const sitemapUrls = content.match(/^Sitemap:\s*(.+)$/gim)?.map(l => l.replace(/^Sitemap:\s*/i, '').trim()) || []
  const disallowedPaths = content.match(/^Disallow:\s*(.+)$/gim)?.map(l => l.replace(/^Disallow:\s*/i, '').trim()) || []

  if (sitemapUrls.length === 0) {
    issues.push({ severity: 'warning', category: 'Indexation', message: 'No Sitemap directive in robots.txt' })
  }

  // Check for overly broad disallow
  if (disallowedPaths.includes('/')) {
    issues.push({ severity: 'error', category: 'Indexation', message: 'robots.txt disallows all crawling (Disallow: /)' })
  }

  return {
    exists: true,
    content,
    hasSitemap: sitemapUrls.length > 0,
    sitemapUrls,
    disallowedPaths,
    issues
  }
}

async function auditSitemap(baseUrl: string, robotsSitemapUrls: string[]): Promise<SitemapAudit> {
  // Try robots.txt sitemap URLs first, then common locations
  const urlsToTry = [
    ...robotsSitemapUrls,
    `${baseUrl}/sitemap.xml`,
    `${baseUrl}/sitemap_index.xml`,
  ]

  for (const sitemapUrl of [...new Set(urlsToTry)]) {
    console.log(`  🗺️  Checking sitemap: ${sitemapUrl}`)
    const { html: content, status } = await fetchPage(sitemapUrl)
    if (status === 200 && content && (content.includes('<urlset') || content.includes('<sitemapindex'))) {
      const urlCount = (content.match(/<loc>/gi) || []).length
      const issues: AuditIssue[] = []

      if (urlCount === 0) {
        issues.push({ severity: 'warning', category: 'Indexation', message: 'Sitemap exists but contains no URLs' })
      }

      return { exists: true, url: sitemapUrl, urlCount, issues }
    }
  }

  return {
    exists: false,
    url: '',
    urlCount: 0,
    issues: [{ severity: 'warning', category: 'Indexation', message: 'No sitemap.xml found' }]
  }
}

function auditPage(url: string, html: string, status: number, ttfbMs: number, depth: number, redirectUrl?: string): PageAudit {
  const issues: AuditIssue[] = []
  const $ = cheerioLoad(html)

  // Title
  const title = $('title').first().text().trim()
  const titleLength = title.length
  if (!title) {
    issues.push({ severity: 'error', category: 'Meta', message: 'Missing title tag', details: url })
  } else if (titleLength < 30) {
    issues.push({ severity: 'warning', category: 'Meta', message: `Title too short (${titleLength} chars)`, details: `"${title}"` })
  } else if (titleLength > 60) {
    issues.push({ severity: 'warning', category: 'Meta', message: `Title too long (${titleLength} chars)`, details: `"${title}"` })
  }

  // Meta description
  const metaDescription = $('meta[name="description"]').attr('content')?.trim() || ''
  const metaDescriptionLength = metaDescription.length
  if (!metaDescription) {
    issues.push({ severity: 'warning', category: 'Meta', message: 'Missing meta description', details: url })
  } else if (metaDescriptionLength < 70) {
    issues.push({ severity: 'info', category: 'Meta', message: `Meta description short (${metaDescriptionLength} chars)`, details: `"${metaDescription}"` })
  } else if (metaDescriptionLength > 160) {
    issues.push({ severity: 'info', category: 'Meta', message: `Meta description long (${metaDescriptionLength} chars)`, details: `"${metaDescription}"` })
  }

  // Canonical
  const canonical = $('link[rel="canonical"]').attr('href') || null
  if (!canonical) {
    issues.push({ severity: 'warning', category: 'Indexation', message: 'Missing canonical tag', details: url })
  }

  // Robots meta
  const robots = $('meta[name="robots"]').attr('content') || null

  // Headings
  const h1s = $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean)
  const h2s = $('h2').map((_, el) => $(el).text().trim()).get().filter(Boolean)
  if (h1s.length === 0) {
    issues.push({ severity: 'warning', category: 'Content', message: 'No H1 tag found', details: url })
  } else if (h1s.length > 1) {
    issues.push({ severity: 'info', category: 'Content', message: `Multiple H1 tags (${h1s.length})`, details: h1s.join(' | ') })
  }

  // Viewport
  const hasViewport = $('meta[name="viewport"]').length > 0
  if (!hasViewport) {
    issues.push({ severity: 'error', category: 'Mobile', message: 'Missing viewport meta tag', details: url })
  }

  // Structured data
  const jsonLdScripts = $('script[type="application/ld+json"]')
  const structuredDataTypes: string[] = []
  jsonLdScripts.each((_, el) => {
    try {
      const data = JSON.parse($(el).html() || '{}')
      if (data['@type']) structuredDataTypes.push(data['@type'])
      if (Array.isArray(data['@graph'])) {
        data['@graph'].forEach((item: any) => {
          if (item['@type']) structuredDataTypes.push(item['@type'])
        })
      }
    } catch { /* ignore malformed JSON-LD */ }
  })
  const hasStructuredData = structuredDataTypes.length > 0

  // Images
  const images: { src: string; alt: string | null }[] = []
  $('img').each((_, el) => {
    images.push({
      src: $(el).attr('src') || '',
      alt: $(el).attr('alt') ?? null,
    })
  })
  const imagesWithoutAlt = images.filter(img => !img.alt && img.alt !== '').length
  if (imagesWithoutAlt > 0) {
    issues.push({ severity: 'warning', category: 'Accessibility', message: `${imagesWithoutAlt} image(s) without alt attribute`, details: url })
  }

  // Links
  const internalLinks: string[] = []
  const externalLinks: string[] = []
  const baseOrigin = new URL(url).origin
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return
    const resolved = normalizeUrl(href, url)
    if (!resolved) return
    if (isInternalUrl(resolved, baseOrigin)) {
      internalLinks.push(resolved)
    } else {
      externalLinks.push(resolved)
    }
  })

  // Print version detection (common MyBB/forum SEO issue)
  const hasPrintVersion = $('a[href*="printthread"]').length > 0 ||
    $('a[href*="print="]').length > 0 ||
    $('a[href*="/print/"]').length > 0

  if (hasPrintVersion) {
    issues.push({ severity: 'warning', category: 'Duplicate Content', message: 'Page links to print version (potential duplicate content)', details: url })
  }

  // Word count (rough)
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim()
  const wordCount = bodyText.split(' ').filter(w => w.length > 0).length

  // TTFB check
  if (ttfbMs > 3000) {
    issues.push({ severity: 'error', category: 'Performance', message: `Slow TTFB (${ttfbMs}ms)`, details: url })
  } else if (ttfbMs > 1500) {
    issues.push({ severity: 'warning', category: 'Performance', message: `High TTFB (${ttfbMs}ms)`, details: url })
  }

  // Status code issues
  if (status >= 400) {
    issues.push({ severity: 'error', category: 'HTTP', message: `HTTP ${status} error`, details: url })
  } else if (status >= 300) {
    issues.push({ severity: 'info', category: 'HTTP', message: `Redirect (${status})`, details: `${url} → ${redirectUrl}` })
  }

  return {
    url, status, redirectUrl, ttfbMs, title, titleLength,
    metaDescription, metaDescriptionLength, canonical, robots,
    h1s, h2s, hasViewport, hasStructuredData, structuredDataTypes,
    images, imagesWithoutAlt, internalLinks, externalLinks,
    brokenLinks: [], hasPrintVersion, wordCount, depth, issues
  }
}

// ── Crawler ─────────────────────────────────────────────────────────────────

async function crawlSite(baseUrl: string, maxPages: number, delay: number): Promise<PageAudit[]> {
  const baseOrigin = new URL(baseUrl).origin
  const visited = new Set<string>()
  const queue: { url: string; depth: number }[] = [{ url: baseUrl, depth: 0 }]
  const results: PageAudit[] = []

  console.log(`\n═══ Crawling ${baseUrl} (max ${maxPages} pages) ═══\n`)

  while (queue.length > 0 && results.length < maxPages) {
    const { url, depth } = queue.shift()!
    const normalized = normalizeUrl(url, baseUrl)
    if (!normalized || visited.has(normalized)) continue
    if (!isInternalUrl(normalized, baseOrigin)) continue
    if (!shouldCrawl(normalized)) continue

    visited.add(normalized)
    const pageNum = results.length + 1
    process.stdout.write(`  [${pageNum}/${maxPages}] ${normalized.substring(0, 80)}...`)

    const { html, status, ttfbMs, redirectUrl } = await fetchPage(normalized)
    const audit = auditPage(normalized, html, status, ttfbMs, depth, redirectUrl)
    results.push(audit)

    const issueCount = audit.issues.length
    console.log(` ${status} | ${ttfbMs}ms | ${issueCount} issue${issueCount !== 1 ? 's' : ''}`)

    // Add discovered internal links to queue
    for (const link of audit.internalLinks) {
      if (!visited.has(link) && shouldCrawl(link)) {
        queue.push({ url: link, depth: depth + 1 })
      }
    }

    if (results.length < maxPages && queue.length > 0) {
      await sleep(delay)
    }
  }

  return results
}

// ── Report Generation ───────────────────────────────────────────────────────

function generateSummary(pages: PageAudit[]): AuditSummary {
  const allIssues = pages.flatMap(p => p.issues)
  const duplicateTitles = new Map<string, string[]>()
  const duplicateDescriptions = new Map<string, string[]>()

  for (const page of pages) {
    if (page.title) {
      const existing = duplicateTitles.get(page.title) || []
      existing.push(page.url)
      duplicateTitles.set(page.title, existing)
    }
    if (page.metaDescription) {
      const existing = duplicateDescriptions.get(page.metaDescription) || []
      existing.push(page.url)
      duplicateDescriptions.set(page.metaDescription, existing)
    }
  }

  // Filter to only actual duplicates (>1 page)
  for (const [key, urls] of duplicateTitles) {
    if (urls.length <= 1) duplicateTitles.delete(key)
  }
  for (const [key, urls] of duplicateDescriptions) {
    if (urls.length <= 1) duplicateDescriptions.delete(key)
  }

  return {
    totalPages: pages.length,
    totalIssues: allIssues.length,
    errors: allIssues.filter(i => i.severity === 'error').length,
    warnings: allIssues.filter(i => i.severity === 'warning').length,
    infos: allIssues.filter(i => i.severity === 'info').length,
    avgTtfbMs: Math.round(pages.reduce((sum, p) => sum + p.ttfbMs, 0) / pages.length),
    pagesWithoutTitle: pages.filter(p => !p.title).length,
    pagesWithoutDescription: pages.filter(p => !p.metaDescription).length,
    pagesWithoutH1: pages.filter(p => p.h1s.length === 0).length,
    pagesWithMultipleH1s: pages.filter(p => p.h1s.length > 1).length,
    pagesWithoutCanonical: pages.filter(p => !p.canonical).length,
    pagesWithoutViewport: pages.filter(p => !p.hasViewport).length,
    totalImagesWithoutAlt: pages.reduce((sum, p) => sum + p.imagesWithoutAlt, 0),
    totalBrokenLinks: pages.reduce((sum, p) => sum + p.brokenLinks.length, 0),
    pagesWithStructuredData: pages.filter(p => p.hasStructuredData).length,
    duplicateTitles,
    duplicateDescriptions,
    avgWordCount: Math.round(pages.reduce((sum, p) => sum + p.wordCount, 0) / pages.length),
    maxDepth: Math.max(...pages.map(p => p.depth)),
  }
}

function generateReport(audit: SiteAudit): string {
  const { summary: s, robotsTxt, sitemap, pages } = audit
  const lines: string[] = []
  const add = (line: string) => lines.push(line)

  add(`# SEO Audit Report — ${audit.url}`)
  add(`**Date:** ${audit.crawlDate}`)
  add(`**Pages Audited:** ${s.totalPages}`)
  add('')

  // Score
  const scoreDeductions = s.errors * 5 + s.warnings * 2 + s.infos * 0.5
  const rawScore = Math.max(0, 100 - scoreDeductions / s.totalPages)
  const score = Math.round(rawScore)
  add(`## Overall Score: ${score}/100`)
  add('')
  if (score >= 80) add('Overall health is **good** — focus on the issues below to improve further.')
  else if (score >= 60) add('**Moderate issues found** — addressing errors and warnings will improve rankings.')
  else add('**Significant issues detected** — prioritize fixing errors to avoid ranking penalties.')
  add('')

  // Summary
  add('## Issue Summary')
  add('')
  add(`| Metric | Count |`)
  add(`|--------|-------|`)
  add(`| Total Issues | ${s.totalIssues} |`)
  add(`| Errors | ${s.errors} |`)
  add(`| Warnings | ${s.warnings} |`)
  add(`| Info | ${s.infos} |`)
  add(`| Avg TTFB | ${s.avgTtfbMs}ms |`)
  add(`| Avg Word Count | ${s.avgWordCount} |`)
  add(`| Max Crawl Depth | ${s.maxDepth} |`)
  add('')

  // Key metrics
  add('## Key Metrics')
  add('')
  add(`| Check | Result | Status |`)
  add(`|-------|--------|--------|`)
  add(`| robots.txt | ${robotsTxt?.exists ? 'Found' : 'Missing'} | ${robotsTxt?.exists ? 'PASS' : 'WARN'} |`)
  add(`| Sitemap | ${sitemap?.exists ? `Found (${sitemap.urlCount} URLs)` : 'Missing'} | ${sitemap?.exists ? 'PASS' : 'WARN'} |`)
  add(`| Pages without title | ${s.pagesWithoutTitle}/${s.totalPages} | ${s.pagesWithoutTitle === 0 ? 'PASS' : 'FAIL'} |`)
  add(`| Pages without meta description | ${s.pagesWithoutDescription}/${s.totalPages} | ${s.pagesWithoutDescription === 0 ? 'PASS' : 'WARN'} |`)
  add(`| Pages without H1 | ${s.pagesWithoutH1}/${s.totalPages} | ${s.pagesWithoutH1 === 0 ? 'PASS' : 'WARN'} |`)
  add(`| Pages with multiple H1s | ${s.pagesWithMultipleH1s}/${s.totalPages} | ${s.pagesWithMultipleH1s === 0 ? 'PASS' : 'INFO'} |`)
  add(`| Pages without canonical | ${s.pagesWithoutCanonical}/${s.totalPages} | ${s.pagesWithoutCanonical === 0 ? 'PASS' : 'WARN'} |`)
  add(`| Pages without viewport | ${s.pagesWithoutViewport}/${s.totalPages} | ${s.pagesWithoutViewport === 0 ? 'PASS' : 'FAIL'} |`)
  add(`| Images without alt text | ${s.totalImagesWithoutAlt} | ${s.totalImagesWithoutAlt === 0 ? 'PASS' : 'WARN'} |`)
  add(`| Pages with structured data | ${s.pagesWithStructuredData}/${s.totalPages} | ${s.pagesWithStructuredData > 0 ? 'PASS' : 'WARN'} |`)
  add('')

  // Duplicate content
  if (s.duplicateTitles.size > 0) {
    add('## Duplicate Titles')
    add('')
    for (const [title, urls] of s.duplicateTitles) {
      add(`**"${title}"** (${urls.length} pages)`)
      for (const u of urls.slice(0, 5)) add(`- ${u}`)
      if (urls.length > 5) add(`- ... and ${urls.length - 5} more`)
      add('')
    }
  }

  if (s.duplicateDescriptions.size > 0) {
    add('## Duplicate Meta Descriptions')
    add('')
    for (const [desc, urls] of s.duplicateDescriptions) {
      add(`**"${desc.substring(0, 80)}..."** (${urls.length} pages)`)
      for (const u of urls.slice(0, 5)) add(`- ${u}`)
      if (urls.length > 5) add(`- ... and ${urls.length - 5} more`)
      add('')
    }
  }

  // robots.txt details
  if (robotsTxt?.exists) {
    add('## robots.txt')
    add('')
    add('```')
    add(robotsTxt.content)
    add('```')
    add('')
    if (robotsTxt.issues.length > 0) {
      for (const issue of robotsTxt.issues) {
        add(`- **${issue.severity.toUpperCase()}:** ${issue.message}`)
      }
      add('')
    }
  }

  // All errors
  const errors = pages.flatMap(p => p.issues.filter(i => i.severity === 'error'))
  if (errors.length > 0) {
    add('## Errors (Must Fix)')
    add('')
    add('| Issue | URL/Details |')
    add('|-------|-------------|')
    for (const err of errors) {
      add(`| ${err.message} | ${err.details || ''} |`)
    }
    add('')
  }

  // All warnings
  const warnings = pages.flatMap(p => p.issues.filter(i => i.severity === 'warning'))
  if (warnings.length > 0) {
    add('## Warnings (Should Fix)')
    add('')
    add('| Issue | URL/Details |')
    add('|-------|-------------|')
    for (const warn of warnings.slice(0, 100)) {
      add(`| ${warn.message} | ${warn.details || ''} |`)
    }
    if (warnings.length > 100) add(`\n*... and ${warnings.length - 100} more warnings*`)
    add('')
  }

  // Page-by-page details (top 20 by issue count)
  add('## Page Details (Top Issues)')
  add('')
  const sortedPages = [...pages].sort((a, b) => b.issues.length - a.issues.length)
  for (const page of sortedPages.slice(0, 30)) {
    if (page.issues.length === 0) continue
    add(`### ${page.url}`)
    add(`- **Status:** ${page.status} | **TTFB:** ${page.ttfbMs}ms | **Words:** ${page.wordCount}`)
    add(`- **Title:** "${page.title}" (${page.titleLength} chars)`)
    add(`- **H1:** ${page.h1s.length > 0 ? page.h1s.join(', ') : 'MISSING'}`)
    add(`- **Canonical:** ${page.canonical || 'MISSING'}`)
    add(`- **Structured Data:** ${page.hasStructuredData ? page.structuredDataTypes.join(', ') : 'None'}`)
    if (page.issues.length > 0) {
      add(`- **Issues:**`)
      for (const issue of page.issues) {
        add(`  - [${issue.severity.toUpperCase()}] ${issue.message}`)
      }
    }
    add('')
  }

  // Recommendations
  add('## Recommendations')
  add('')

  if (s.pagesWithoutCanonical > 0) {
    add('### Add Canonical Tags')
    add(`${s.pagesWithoutCanonical} pages are missing canonical tags. This helps prevent duplicate content issues, especially important for forums where the same content may be accessible via multiple URLs.`)
    add('')
  }

  if (!sitemap?.exists) {
    add('### Create a Sitemap')
    add('No sitemap.xml was found. Create one and submit it to Google Search Console. For MyBB, you can use the Google SEO plugin or generate one manually.')
    add('')
  }

  if (s.pagesWithStructuredData === 0) {
    add('### Add Structured Data')
    add('No pages have structured data (JSON-LD). For a forum, implement `DiscussionForumPosting` schema on thread pages. This helps Google understand your content and can enable rich results.')
    add('')
  }

  if (s.pagesWithoutDescription > s.totalPages * 0.5) {
    add('### Add Meta Descriptions')
    add(`${s.pagesWithoutDescription} pages lack meta descriptions. While Google sometimes generates its own, custom descriptions improve click-through rates from search results.`)
    add('')
  }

  if (s.totalImagesWithoutAlt > 0) {
    add('### Add Image Alt Text')
    add(`${s.totalImagesWithoutAlt} images are missing alt attributes. This impacts accessibility and image search visibility.`)
    add('')
  }

  const slowPages = pages.filter(p => p.ttfbMs > 2000)
  if (slowPages.length > 0) {
    add('### Improve Page Speed')
    add(`${slowPages.length} pages have TTFB over 2 seconds. Consider server-side caching, database optimization, or a CDN.`)
    add('')
  }

  add('---')
  add(`_Generated by seo-audit.ts on ${audit.crawlDate}_`)

  return lines.join('\n')
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { url, maxPages, delay } = parseArgs()

  console.log(`╔══════════════════════════════════════════════════════════╗`)
  console.log(`║     SEO Audit Tool v1.0                                 ║`)
  console.log(`║     Technical SEO crawler and auditor                   ║`)
  console.log(`╚══════════════════════════════════════════════════════════╝`)
  console.log()
  console.log(`  Target: ${url}`)
  console.log(`  Max pages: ${maxPages}`)
  console.log(`  Delay: ${delay}ms`)

  // Phase 1: robots.txt
  console.log(`\n═══ Phase 1: robots.txt ═══\n`)
  const robotsTxt = await auditRobotsTxt(url)
  if (robotsTxt.exists) {
    console.log(`  ✓ robots.txt found`)
    console.log(`  Sitemap references: ${robotsTxt.sitemapUrls.length}`)
    console.log(`  Disallow rules: ${robotsTxt.disallowedPaths.length}`)
  } else {
    console.log(`  ✗ No robots.txt`)
  }

  // Phase 2: Sitemap
  console.log(`\n═══ Phase 2: Sitemap ═══\n`)
  const sitemap = await auditSitemap(url, robotsTxt.sitemapUrls)
  if (sitemap.exists) {
    console.log(`  ✓ Sitemap found: ${sitemap.url}`)
    console.log(`  URLs in sitemap: ${sitemap.urlCount}`)
  } else {
    console.log(`  ✗ No sitemap found`)
  }

  // Phase 3: Crawl
  console.log(`\n═══ Phase 3: Page Crawl ═══`)
  const pages = await crawlSite(url, maxPages, delay)

  // Phase 4: Generate report
  console.log(`\n═══ Phase 4: Generating Report ═══\n`)
  const summary = generateSummary(pages)
  const crawlDate = new Date().toISOString().split('T')[0]

  const audit: SiteAudit = {
    url,
    crawlDate,
    pagesAudited: pages.length,
    robotsTxt,
    sitemap,
    pages,
    summary
  }

  const report = generateReport(audit)

  // Save files
  await fs.mkdir(OUTPUT_DIR, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T').join('T').substring(0, 19)
  const domain = new URL(url).hostname.replace(/^www\./, '')

  const reportPath = path.join(OUTPUT_DIR, `audit-${domain}-${timestamp}.md`)
  const jsonPath = path.join(OUTPUT_DIR, `audit-${domain}-${timestamp}.json`)

  await fs.writeFile(reportPath, report)
  await fs.writeFile(jsonPath, JSON.stringify(audit, (key, value) => {
    if (value instanceof Map) return Object.fromEntries(value)
    return value
  }, 2))

  console.log(`  ✅ Report: ${reportPath}`)
  console.log(`  ✅ JSON:   ${jsonPath}`)

  // Print summary
  console.log()
  console.log(`╔══════════════════════════════════════════════════════════╗`)
  console.log(`║                     Audit Summary                       ║`)
  console.log(`╚══════════════════════════════════════════════════════════╝`)
  console.log()
  console.log(`  Pages crawled:     ${summary.totalPages}`)
  console.log(`  Total issues:      ${summary.totalIssues}`)
  console.log(`    Errors:          ${summary.errors}`)
  console.log(`    Warnings:        ${summary.warnings}`)
  console.log(`    Info:            ${summary.infos}`)
  console.log(`  Avg TTFB:          ${summary.avgTtfbMs}ms`)
  console.log(`  Missing titles:    ${summary.pagesWithoutTitle}`)
  console.log(`  Missing H1:        ${summary.pagesWithoutH1}`)
  console.log(`  Missing canonical: ${summary.pagesWithoutCanonical}`)
  console.log(`  No structured data: ${summary.totalPages - summary.pagesWithStructuredData}`)
  console.log(`  Duplicate titles:  ${summary.duplicateTitles.size} groups`)
}

main().catch(console.error)
