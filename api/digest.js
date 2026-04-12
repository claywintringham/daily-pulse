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

import { get as redisGet, set as redisSet } from '../lib/redis.js';
import { editorialFilter, summarizeClusters } from '../lib/llm.js';
import { buildSourceChips, pickStoryUrl, scoreClusters } from '../lib/scorer.js';
import { runAllAdapters } from '../lib/adapters/index.js';
import { enrichWithRss }  from '../lib/matcher.js';
import { buildClusters }  from '../lib/cluster.js';
import { getById }        from '../lib/sourceRegistry.js';

export const config = { maxDuration: 120 };

// Cache TTL: keep short during testing; increase to 1800 (30 min) for production.
const DIGEST_TTL  = 3 * 60;   // 3 minutes
const SCRAPED_TTL = 60 * 60;  // 1 hour (mirrors api/scrape.js)

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectType(req) {
  const url   = new URL(req.url, `https://${req.headers.host}`);
  const param = url.searchParams.get('type');
  if (param === 'morning' || param === 'evening') return param;
  const hktHour = (new Date().getUTCHours() + 8) % 24;
  return hktHour < 13 ? 'morning' : 'evening';
}

/**
 * Inline scrape fallback: runs the full adapter → enrich → cluster → score
 * pipeline when no pre-warmed `scraped:{type}` data exists in Redis.
 * Result is also written to Redis so subsequent requests benefit from it.
 */
async function runInlineScrape(type) {
  console.log('[digest] Running inline scrape (no pre-warmed data)');

  const adapterResults = await runAllAdapters();

  const enriched = await Promise.all(
    adapterResults.map(async src => {
      const def          = getById(src.sourceId);
      const enrichedItems = await enrichWithRss(src.items ?? [], def?.rssUrl ?? null);
      return { ...src, items: enrichedItems };
    })
  );

  const clusters    = buildClusters(enriched);
  const intlScored  = scoreClusters(clusters, 'international');
  const localScored = scoreClusters(clusters, 'local');

  const payload = {
    type,
    scrapedAt:     new Date().toISOString(),
    international: intlScored,
    local:         localScored,
    adapterMeta:   adapterResults.map(r => ({
      sourceId:         r.sourceId,
      scrapeConfidence: r.scrapeConfidence,
      itemCount:        (r.items ?? []).length,
      warnings:         r.warnings ?? [],
    })),
  };

  // Cache so the next request skips the scrape
  await redisSet(`scraped:${type}`, payload, SCRAPED_TTL).catch(() => {});
  return payload;
}

/**
 * Format scored + summarized clusters into the shape consumed by daily-pulse.html.
 *
 * Each story card:
 * {
 *   id:       string,
 *   headline: string,
 *   summary:  string  (40-75 words),
 *   readUrl:  string | null   (highest-ranked free article URL),
 *   sources:  [{ name, position, url, paywalled }]
 *     url is set only for high-matchConfidence free sources (linked chips)
 *     url is null for medium-confidence or paywalled sources (unlinked chips)
 * }
 */
function formatStories(clusters) {
  return clusters.map(c => ({
    id:       c.id,
    headline: c.headline,
    summary:  c.summary ?? c.headline,
    readUrl:  pickStoryUrl(c),
    sources:  buildSourceChips(c),
    _meta: {
      qualificationRank: c.qualificationRank,
      baseScore:         c.baseScore,
      bonusScore:        c.bonusScore,
      clusterConfidence: c.clusterConfidence,
    },
  }));
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const type = detectType(req);
  const t0   = Date.now();
  console.log(`[digest] Request for type=${type}`);

  try {
    // ── 1. Digest cache hit ─────────────────────────────────────────────────
    const cached = await redisGet(`digest:${type}`);
    if (cached?.generatedAt) {
      const ageSeconds = (Date.now() - new Date(cached.generatedAt).getTime()) / 1000;
      if (ageSeconds < DIGEST_TTL) {
        console.log(`[digest] Cache HIT (age=${Math.round(ageSeconds)}s)`);
        res.setHeader('X-Cache', 'HIT');
        return res.status(200).json(cached);
      }
    }

    res.setHeader('X-Cache', 'MISS');

    // ── 2. Get pre-scraped cluster data ─────────────────────────────────────
    let scraped = await redisGet(`scraped:${type}`);

    // ── 3. Inline scrape if no pre-warmed data ──────────────────────────────
    if (!scraped) {
      scraped = await runInlineScrape(type);
    }

    const allClusters = [
      ...(scraped.international ?? []),
      ...(scraped.local ?? []),
    ];

    console.log(`[digest] ${allClusters.length} cluster(s) before editorial filter`);

    // ── 4. LLM editorial filter (combined buckets in one call) ──────────────
    const filtered = await editorialFilter(allClusters);
    console.log(`[digest] ${filtered.length} cluster(s) after editorial filter`);

    // Re-split by bucket (preserved on each cluster object)
    const filteredIntl  = filtered.filter(c => c.bucket === 'international');
    const filteredLocal = filtered.filter(c => c.bucket === 'local');

    // ── 5. Summarization (both buckets in parallel) ─────────────────────────
    const [summarisedIntl, summarisedLocal] = await Promise.all([
      summarizeClusters(filteredIntl),
      summarizeClusters(filteredLocal),
    ]);
    console.log(`[digest] Summarization done in ${Date.now() - t0} ms`);

    // ── 6. Format response ──────────────────────────────────────────────────
    const response = {
      type,
      generatedAt:   new Date().toISOString(),
      scrapedAt:     scraped.scrapedAt,
      international: formatStories(summarisedIntl),
      local:         formatStories(summarisedLocal),
      meta: {
        adapterMeta:        scraped.adapterMeta ?? [],
        clusterCountBefore: allClusters.length,
        clusterCountAfter:  filtered.length,
        elapsedMs:          Date.now() - t0,
      },
    };

    // ── 7. Cache and return ─────────────────────────────────────────────────
    await redisSet(`digest:${type}`, response, DIGEST_TTL).catch(e =>
      console.warn('[digest] Redis write failed (non-fatal):', e.message)
    );

    return res.status(200).json(response);

  } catch (err) {
    console.error('[digest] Fatal error:', err);

    // Serve stale cache rather than a hard error when possible
    const stale = await redisGet(`digest:${type}`).catch(() => null);
    if (stale) {
      console.warn('[digest] Returning stale cache after error');
      res.setHeader('X-Cache', 'STALE');
      return res.status(200).json({ ...stale, _stale: true, _error: err.message });
    }

    return res.status(500).json({
      error:  'Failed to generate digest',
      detail: err.message,
    });
  }
}
