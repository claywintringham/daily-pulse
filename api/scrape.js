// ── api/scrape.js ─────────────────────────────────────────────────────────────
// Function 1 of the two-function pipeline.
//
// Responsibilities:
//   1. Run all active source adapters in parallel (DOM scraping).
//   2. Enrich each adapter's item list with RSS metadata (URL, publishedAt,
//      description).
//   3. Build cross-source story clusters (Gemini semantic, Jaccard fallback).
//   4. Score and rank clusters per bucket (international / local).
//   5. Pre-fetch substantive article excerpts for the top clusters using the
//      source-iteration quality gate in lib/enricher.js.
//   6. Write raw scored clusters to Redis → key: `scraped:{type}`, TTL: 1 h.
//
// Invoked by:
//   • Vercel Cron (prewarm):  /api/scrape?type=morning&cron=1
//                             /api/scrape?type=evening&cron=1
//   • api/digest.js (fallback, inline) when no pre-warmed data exists.
//
// Vercel config: maxDuration 300 s (Pro plan).

import { runAllAdapters }          from '../lib/adapters/index.js';
import { enrichWithRss }           from '../lib/matcher.js';
import { buildClusters }           from '../lib/cluster.js';
import { enrichWithArticleContent } from '../lib/enricher.js';
import { scoreClusters }  from '../lib/scorer.js';
import { getById }        from '../lib/sourceRegistry.js';
import { set as redisSet } from '../lib/redis.js';
import { translateHeadlines, clusterHeadlines } from '../lib/llm.js';

export const config = { maxDuration: 300 };

const SCRAPED_TTL = 60 * 60; // 1 hour

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectType(req) {
  const url   = new URL(req.url, `https://${req.headers.host}`);
  const param = url.searchParams.get('type');
  if (param === 'morning' || param === 'evening') return param;
  // Auto-detect from HKT (UTC+8)
  const hktHour = (new Date().getUTCHours() + 8) % 24;
  return hktHour < 13 ? 'morning' : 'evening';
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url    = new URL(req.url, `https://${req.headers.host}`);
  const isCron = url.searchParams.get('cron') === '1';
  const type   = detectType(req);

  // Vercel sets the x-vercel-cron header on genuine cron invocations.
  // Reject spoofed cron requests from the public internet.
  if (isCron && req.headers['x-vercel-cron'] !== '1') {
    return res.status(401).json({ error: 'Unauthorized: cron header missing' });
  }

  const t0 = Date.now();
  console.log(`[scrape] Starting ${type} scrape (cron=${isCron})`);

  try {
    // ── Step 1: Run all active adapters ────────────────────────────────────
    const adapterResults = await runAllAdapters();
    console.log(
      `[scrape] ${adapterResults.length} adapter(s) completed in ${Date.now() - t0} ms`
    );

    // Log any low-confidence or failed adapters
    for (const r of adapterResults) {
      if (r.scrapeConfidence === 'low' || r.scrapeConfidence === 'none') {
        console.warn(`[scrape] Low confidence: ${r.sourceId} (${r.scrapeConfidence})`, r.warnings);
      }
    }

    // ── Step 2: RSS enrichment (parallel, one fetch per source) ────────────
    const enriched = await Promise.all(
      adapterResults.map(async src => {
        const def          = getById(src.sourceId);
        const rssUrl       = def?.rssUrl ?? null;
        const enrichedItems = await enrichWithRss(src.items ?? [], rssUrl);
        return { ...src, items: enrichedItems };
      })
    );
    console.log(`[scrape] RSS enrichment done in ${Date.now() - t0} ms`);

    // ── Step 2.5: Translate Chinese-language headlines ──────────────────────
    // Sources flagged needsTranslation:true have Chinese titles that must be
    // converted to English before clustering can match them against
    // English-language sources.
    const enrichedFinal = await Promise.all(
      enriched.map(async src => {
        if (!getById(src.sourceId)?.needsTranslation || !src.items?.length) return src;
        const translated = await translateHeadlines(src.items);
        return { ...src, items: translated };
      })
    );
    console.log(`[scrape] Translation done in ${Date.now() - t0} ms`);

    // ── Step 3: Cross-source clustering (Gemini semantic, Jaccard fallback) ──
    const clusters = await buildClusters(enrichedFinal, clusterHeadlines);
    console.log(`[scrape] Built ${clusters.length} cluster(s) in ${Date.now() - t0} ms`);

    // ── Step 4: Score per bucket ────────────────────────────────────────────
    const intlScored  = scoreClusters(clusters, 'international');
    const localScored = scoreClusters(clusters, 'local');
    console.log(`[scrape] Scored: ${intlScored.length} intl, ${localScored.length} local`);

    // ── Step 4.5: Article enrichment (Pipeline 1 — invisible to user) ───────
    // Pre-fetch article text for the top clusters so digest.js can skip this
    // step entirely, removing 5-10 s from the user-facing load time.
    // Firecrawl is used as a last resort for bot-blocked sites (Fox, NBC, CBS).
    //
    // We enrich with generous headroom: clusters that fail the substantive-
    // content quality gate are dropped at digest time, so the pre-warmed pool
    // must be large enough to still leave STORY_COUNTS candidates after drops.
    const ENRICH_INTL  = 8;
    const ENRICH_LOCAL = 6;
    const toEnrich = [
      ...intlScored.slice(0, ENRICH_INTL),
      ...localScored.slice(0, ENRICH_LOCAL),
    ];
    console.log(`[scrape] Enriching ${toEnrich.length} top clusters...`);
    await enrichWithArticleContent(toEnrich, { useFirecrawl: true });
    const enrichedCount = toEnrich.filter(c => c.articleExcerpt).length;
    console.log(`[scrape] Enrichment done in ${Date.now() - t0} ms — ${enrichedCount}/${toEnrich.length} passed quality gate`);

    // ── Step 5: Write to Redis ──────────────────────────────────────────────
    const adapterMeta = adapterResults.map(r => ({
      sourceId:         r.sourceId,
      scrapeConfidence: r.scrapeConfidence,
      itemCount:        (r.items ?? []).length,
      warnings:         r.warnings ?? [],
    }));

    const payload = {
      type,
      scrapedAt:     new Date().toISOString(),
      international: intlScored,
      local:         localScored,
      adapterMeta,
    };

    // Write to scraped:{type} (legacy) AND scraped:rolling (used by digest)
    await Promise.all([
      redisSet(`scraped:${type}`, payload, SCRAPED_TTL),
      redisSet('scraped:rolling',  payload, SCRAPED_TTL),
    ]);
    console.log(
      `[scrape] Written scraped:${type} to Redis. Total elapsed: ${Date.now() - t0} ms`
    );

    return res.status(200).json({
      ok:            true,
      type,
      intlClusters:  intlScored.length,
      localClusters: localScored.length,
      enrichedCount,
      elapsedMs:     Date.now() - t0,
      // Debug: per-source adapter results so we can diagnose selector mismatches
      adapterMeta: adapterResults.map(r => ({
        sourceId:         r.sourceId,
        scrapeConfidence: r.scrapeConfidence,
        itemCount:        (r.items ?? []).length,
        warnings:         r.warnings ?? [],
        // Show first 3 item titles so we can verify selectors are hitting real headlines
        sampleTitles:     (r.items ?? []).slice(0, 3).map(i => i.title),
      })),
    });
  } catch (err) {
    console.error('[scrape] Fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
