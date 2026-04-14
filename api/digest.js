// ── api/digest.js ─────────────────────────────────────────────────────────────
// Function 2 of the two-function pipeline.
// The frontend calls this endpoint to fetch the digest.
//
// Flow:
//   1. Check Redis for a fresh `digest:{type}` cache → return immediately if found.
//   2. Fetch pre-scraped cluster data (`scraped:{type}`) written by api/scrape.js.
//   3. If no pre-scraped data: run the full scrape pipeline inline (fallback).
//   4. Run LLM editorial filter on all clusters (removes noise, merges false splits).
//   5. Run LLM summarization on each bucket in parallel (40-75 word summaries).
//   6. Format the frontend response and write it to the digest cache.
//   7. Return the formatted response.
//
// On error: return stale cached digest (if any) rather than a 500.
// Vercel config: maxDuration 120 s (Pro plan).

import { get as redisGet, set as redisSet, del as redisDel } from '../lib/redis.js';
import { Readability } from '@mozilla/readability';
import { parseHTML }   from 'linkedom';

/** Decode common HTML entities so raw &amp;, &#39; etc. never reach the UI. */
function decodeEntities(text) {
  if (!text) return text;
  return text
    .replace(/&amp;/g,   '&')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&quot;/g,  '"')
    .replace(/&#39;/g,   "'")
    .replace(/&#x27;/g,  "'")
    .replace(/&apos;/g,  "'")
    .replace(/&nbsp;/g,  ' ')
    .replace(/&#(\d+);/g,     (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

import { editorialFilter, summarizeClusters, translateHeadlines } from '../lib/llm.js';
import { buildSourceChips, pickStoryUrl, scoreClusters } from '../lib/scorer.js';
import { runAllAdapters } from '../lib/adapters/index.js';
import { enrichWithRss }  from '../lib/matcher.js';
import { buildClusters }  from '../lib/cluster.js';
import { pickBestHeadline } from '../lib/headlines.js';

function pickFallbackSummary(c) {
  const titles = (c.members ?? [])
    .map(m => m.title)
    .filter(t => t && t.length > 10);
  if (!titles.length) return c.members?.[0]?.title ?? c.headline;
  return titles.reduce((best, t) => t.length > best.length ? t : best, titles[0]);
}

/**
 * Compute `freeSourceCount` — number of free (non-paywalled) members per cluster.
 * Used by the UI for editorial prominence in the digest.
 */
function computeFreeSourceCount(cluster) {
  return cluster.members.filter(m => !m.isPaywalled).length;
}

/**
 * Build the external digest response. Called once per bucket.
 */
function buildDigestResponse(clusters, digestType) {
  return clusters.map(c => ({
    id:           c.id,
    headline:     c.headline,
    summary:      c.summary,
    sources:      buildSourceChips(c),
    url:          pickStoryUrl(c),
    freeSourceCount: computeFreeSourceCount(c),
  }));
}

/**
 * Main handler: fetch or compute digest, apply LLM steps, cache, and return.
 */
export default async function handler(req, res) {
  const digestType = req.query.type || 'morning';
  const cacheKey = `digest:${digestType}`;
  const scrapedKey = `scraped:${digestType}`;

  // ── 1. Check Redis cache ───────────────────────────────────────────────
  try {
    const cached = await redisGet(cacheKey);
    if (cached) {
      console.log(`[digest] ${digestType}: served from cache`);
      return res.status(200).json(JSON.parse(cached));
    }
  } catch (e) {
    console.warn('[digest] Redis get error:', e.message);
  }

  // ── 2. Fetch or compute clusters ───────────────────────────────────────
  let clusters;
  try {
    const scraped = await redisGet(scrapedKey);
    if (scraped) {
      clusters = JSON.parse(scraped);
      console.log(`[digest] ${digestType}: using pre-scraped clusters (${clusters.length})`);
    } else {
      // Fallback: run scrape pipeline inline
      console.log(`[digest] ${digestType}: running full scrape pipeline (fallback)`);
      const adapted = await runAllAdapters();
      const withRss = await enrichWithRss(adapted);
      clusters = buildClusters(withRss);
    }
  } catch (e) {
    console.error('[digest] Scrape/cluster error:', e.message);
    // Try to return stale cache
    try {
      const stale = await redisGet(cacheKey);
      if (stale) {
        console.log('[digest] Returning stale cache on error');
        return res.status(200).json(JSON.parse(stale));
      }
    } catch (e2) {
      console.warn('[digest] Stale cache also failed:', e2.message);
    }
    return res.status(500).json({ error: 'digest failed', details: e.message });
  }

  // ── 3. Separate by bucket ─────────────────────────────────────────────
  const international = clusters.filter(c => c.bucket === 'international');
  const local = clusters.filter(c => c.bucket === 'local');

  // ── 4. Apply editorial filter (combined, then split back) ──────────────
  let filtered;
  try {
    filtered = await editorialFilter([...international, ...local]);
    console.log(`[digest] After filter: ${filtered.length} clusters (was ${clusters.length})`);
  } catch (e) {
    console.warn('[digest] Editorial filter error:', e.message, '— continuing with unfiltered');
    filtered = clusters;
  }

  // Split back into buckets
  const filteredIntl = filtered.filter(c => c.bucket === 'international');
  const filteredLocal = filtered.filter(c => c.bucket === 'local');

  // ── 5. Score each bucket independently ──────────────────────────────────
  const scoredIntl = scoreClusters(filteredIntl, 'international', 6);
  const scoredLocal = scoreClusters(filteredLocal, 'local', 6);

  // ── 6. Pick headlines ──────────────────────────────────────────────────
  const withHeadlines = [
    ...scoredIntl.map(c => ({ ...c, headline: pickBestHeadline(c) })),
    ...scoredLocal.map(c => ({ ...c, headline: pickBestHeadline(c) })),
  ];

  // ── 7. Fetch article excerpts for summarization (parallel) ────────────────
  const withExcerpts = await Promise.all(
    withHeadlines.map(async (c) => {
      try {
        // Pick a free member's URL if possible; fall back to any member
        const freeUrl = c.members.find(m => !m.isPaywalled)?.articleUrl
          || c.members.find(m => m.articleUrl)?.articleUrl;
        if (!freeUrl) return c; // no URL — use title-only fallback

        const resp = await fetch(freeUrl, { signal: AbortSignal.timeout(8000) });
        if (!resp.ok) return c;

        const html = await resp.text();
        const doc = parseHTML(html).window.document;
        const reader = new Readability(doc);
        const article = reader.parse();
        if (!article?.content) return c;

        // Extract plain text from the parsed article
        const temp = parseHTML(article.content).window.document;
        const excerpt = temp.body.textContent.trim().slice(0, 400);
        return { ...c, articleExcerpt: excerpt };
      } catch (e) {
        // Suppress fetch/parse errors; return cluster without excerpt
        return c;
      }
    })
  );

  // ── 8. Summarize each bucket in parallel ───────────────────────────────
  let summarized = [];
  try {
    const [summIntl, summLocal] = await Promise.all([
      summarizeClusters(withExcerpts.filter(c => c.bucket === 'international')),
      summarizeClusters(withExcerpts.filter(c => c.bucket === 'local')),
    ]);
    summarized = [...summIntl, ...summLocal];
  } catch (e) {
    console.warn('[digest] Summarization error:', e.message);
    // Fall back to pickFallbackSummary for each cluster
    summarized = withExcerpts.map(c => ({
      ...c,
      summary: c.summary || pickFallbackSummary(c),
    }));
  }

  // ── 9. Format response ─────────────────────────────────────────────────
  const intlResponse = buildDigestResponse(
    summarized.filter(c => c.bucket === 'international'),
    digestType
  );
  const localResponse = buildDigestResponse(
    summarized.filter(c => c.bucket === 'local'),
    digestType
  );

  const response = {
    type: digestType,
    timestamp: new Date().toISOString(),
    international: intlResponse,
    local: localResponse,
  };

  // ── 10. Cache and return ───────────────────────────────────────────────
  try {
    await redisSet(cacheKey, JSON.stringify(response), 'EX', 3600);
  } catch (e) {
    console.warn('[digest] Redis set error:', e.message);
  }

  return res.status(200).json(response);
}
