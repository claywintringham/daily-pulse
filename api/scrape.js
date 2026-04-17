// ── api/scrape.js ──────────────────────────────────────────────────────────
// Pre-warms both section caches (scraped:international + scraped:local).
// Runs international and local adapter fetching in parallel, then clusters
// each section separately (sequential to space out LLM calls).
//
// Invoked by Vercel Cron every 20 minutes.
// Also callable manually: GET /api/scrape

import { runAllAdapters }           from '../lib/adapters/index.js';
import { enrichWithRss }            from '../lib/matcher.js';
import { buildClusters }            from '../lib/cluster.js';
import { enrichWithArticleContent } from '../lib/enricher.js';
import { scoreClusters }            from '../lib/scorer.js';
import { getById }                  from '../lib/sourceRegistry.js';
import { set as redisSet }          from '../lib/redis.js';
import { translateHeadlines, clusterHeadlines } from '../lib/llm.js';

export const config = { maxDuration: 300 };

const SCRAPED_TTL  = 25 * 60; // 25 min — cron runs every 20 min, 5 min buffer
const ENRICH_COUNT = { intl: 6, local: 4 };

// ── RSS enrichment + translation helper ─────────────────────────────────
async function enrichAndTranslate(adapterResults) {
  const enriched = await Promise.all(
    adapterResults.map(async src => {
      const def = getById(src.sourceId);
      return { ...src, items: await enrichWithRss(src.items ?? [], def?.rssUrl ?? null) };
    })
  );
  return Promise.all(
    enriched.map(async src => {
      if (!getById(src.sourceId)?.needsTranslation || !src.items?.length) return src;
      return { ...src, items: await translateHeadlines(src.items) };
    })
  );
}

// ── Handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const t0 = Date.now();
  console.log('[scrape] Starting dual-bucket scrape');

  try {
    // ── Step 1: Fetch both buckets in parallel (HTTP only, no LLM) ────────
    const [intlAdapters, localAdapters] = await Promise.all([
      runAllAdapters('international'),
      runAllAdapters('local'),
    ]);
    console.log(`[scrape] Adapters done ${Date.now() - t0}ms — intl:${intlAdapters.length} local:${localAdapters.length}`);

    // ── Step 2: RSS enrichment + translation for both (parallel, no LLM) ────
    const [intlReady, localReady] = await Promise.all([
      enrichAndTranslate(intlAdapters),
      enrichAndTranslate(localAdapters),
    ]);
    console.log(`[scrape] Enrichment + translation done ${Date.now() - t0}ms`);

    // ── Step 3: Cluster each bucket (sequential — spaces out LLM calls) ─────
    const intlClusters = await buildClusters(intlReady, clusterHeadlines);
    console.log(`[scrape] Intl clustered: ${intlClusters.length} clusters ${Date.now() - t0}ms`);

    await new Promise(r => setTimeout(r, 2000));

    const localClusters = await buildClusters(localReady, clusterHeadlines);
    console.log(`[scrape] Local clustered: ${localClusters.length} clusters ${Date.now() - t0}ms`);

    // ── Step 4: Score per bucket ────────────────────────────────────────────
    const intlScored  = scoreClusters(intlClusters,  'international');
    const localScored = scoreClusters(localClusters, 'local');
    console.log(`[scrape] Scored: ${intlScored.length} intl, ${localScored.length} local`);

    // ── Step 5: Article enrichment for top N clusters (parallel, HTTP) ───────
    const topIntl  = intlScored.slice(0,  ENRICH_COUNT.intl);
    const topLocal = localScored.slice(0, ENRICH_COUNT.local);
    console.log(`[scrape] Enriching ${topIntl.length + topLocal.length} clusters…`);
    await Promise.all([
      enrichWithArticleContent(topIntl,  { useFirecrawl: true }),
      enrichWithArticleContent(topLocal, { useFirecrawl: true }),
    ]);
    console.log(`[scrape] Article enrichment done ${Date.now() - t0}ms`);

    // ── Step 6: Write to Redis ──────────────────────────────────────────────
    const scrapedAt = new Date().toISOString();
    const intlMeta  = intlAdapters.map(r => ({
      sourceId: r.sourceId, scrapeConfidence: r.scrapeConfidence,
      itemCount: (r.items ?? []).length, warnings: r.warnings ?? [],
    }));
    const localMeta = localAdapters.map(r => ({
      sourceId: r.sourceId, scrapeConfidence: r.scrapeConfidence,
      itemCount: (r.items ?? []).length, warnings: r.warnings ?? [],
    }));

    await Promise.all([
      redisSet('scraped:international', { scrapedAt, clusters: intlScored,  adapterMeta: intlMeta  }, SCRAPED_TTL),
      redisSet('scraped:local',         { scrapedAt, clusters: localScored, adapterMeta: localMeta }, SCRAPED_TTL),
    ]);
    console.log(`[scrape] Redis written. Total elapsed: ${Date.now() - t0}ms`);

    return res.status(200).json({
      ok: true,
      intlClusters:  intlScored.length,
      localClusters: localScored.length,
      elapsedMs:     Date.now() - t0,
      adapterMeta: [
        ...intlAdapters.map(r => ({
          sourceId: r.sourceId, scrapeConfidence: r.scrapeConfidence,
          itemCount: (r.items ?? []).length,
          sampleTitles: (r.items ?? []).slice(0, 3).map(i => i.title),
        })),
        ...localAdapters.map(r => ({
          sourceId: r.sourceId, scrapeConfidence: r.scrapeConfidence,
          itemCount: (r.items ?? []).length,
          sampleTitles: (r.items ?? []).slice(0, 3).map(i => i.title),
        })),
      ],
    });

  } catch (err) {
    console.error('[scrape] Fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
