// ── api/scrape.js ─────────────────────────────────────────────────────────────
// Function 1 of the two-function pipeline.
//
// Responsibilities:
//   1. Run all active source adapters in parallel (DOM scraping).
//   2. Enrich each adapter's item list with RSS metadata (URL, publishedAt).
//   3. Build cross-source story clusters (Jaccard similarity).
//   4. Score and rank clusters per bucket (international / local).
//   5. Write raw scored clusters to Redis → key: `scraped:{type}`, TTL: 1 h.
//
// Invoked by:
//   • Vercel Cron (prewarm):  /api/scrape?type=morning&cron=1
//                             /api/scrape?type=evening&cron=1
//   • api/digest.js (fallback, inline) when no pre-warmed data exists.
//
// Vercel config: maxDuration 300 s (Pro plan).

import { runAllAdapters } from '../lib/adapters/index.js';
import { enrichWithRss }  from '../lib/matcher.js';
import { buildClusters }  from '../lib/cluster.js';
import { scoreClusters }  from '../lib/scorer.js';
import { getById }        from '../lib/sourceRegistry.js';
import { set as redisSet } from '../lib/redis.js';

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

    // ── Step 3: Cross-source clustering ────────────────────────────────────
    const clusters = buildClusters(enriched);
    console.log(`[scrape] Built ${clusters.length} cluster(s)`);

    // ── Step 4: Score per bucket ────────────────────────────────────────────
    const intlScored  = scoreClusters(clusters, 'international');
    const localScored = scoreClusters(clusters, 'local');
    console.log(
      `[scrape] Scored: ${intlScored.length} international, ${localScored.length} local`
    );

    // ── Step 5: Write to Redis ──────────────────────────────────────────────
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

    await redisSet(`scraped:${type}`, payload, SCRAPED_TTL);
    console.log(
      `[scrape] Written scraped:${type} to Redis. Total elapsed: ${Date.now() - t0} ms`
    );

    return res.status(200).json({
      ok:           true,
      type,
      intlClusters: intlScored.length,
      localClusters: localScored.length,
      elapsedMs:    Date.now() - t0,
    });
  } catch (err) {
    console.error('[scrape] Fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
