// ── api/digest.js ───────────────────────────────────────────────────────
// Runs two parallel pipelines (international + local), each with its own
// source set, cluster, editorial-filter, enrichment, and summarisation steps.
import { get as redisGet, set as redisSet, del as redisDel } from '../lib/redis.js';
import { enrichWithArticleContent, rankLearnMoreUrls, pickLearnMoreUrl } from '../lib/enricher.js';
import { editorialFilter, summarizeClusters, translateHeadlines, clusterHeadlines } from '../lib/llm.js';
import { buildSourceChips, pickStoryUrl, scoreClusters } from '../lib/scorer.js';
import { runAllAdapters } from '../lib/adapters/index.js';
import { enrichWithRss }  from '../lib/matcher.js';
import { buildClusters }  from '../lib/cluster.js';
import { getById }        from '../lib/sourceRegistry.js';

export const config = { maxDuration: 120 };

const DIGEST_TTL      = 20 * 60;
const SCRAPED_TTL     = 20 * 60;
const STORY_COUNTS    = { intl: 3, local: 2 };
const STALE_WINDOW_MS = 36 * 60 * 60 * 1000;

function decodeEntities(text) {
  if (!text) return text;
  return text
    .replace(/&amp;/g,   '&').replace(/&lt;/g,  '<').replace(/&gt;/g,   '>')
    .replace(/&quot;/g,  '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&apos;/g,  "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g,     (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ').trim();
}

function computeIsBreaking(members) {
  if (!members?.length) return false;
  const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
  const dated = members.filter(m => m.publishedAt && !isNaN(new Date(m.publishedAt).getTime()));
  if (!dated.length) return false;
  const recent = dated.filter(m => new Date(m.publishedAt).getTime() >= fourHoursAgo).length;
  return recent > dated.length - recent;
}

function headlineTokens(h) {
  return new Set(h.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2));
}
function headlineOverlap(h1, h2) {
  const a = headlineTokens(h1), b = headlineTokens(h2);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
function deduplicateByHeadline(clusters, threshold = 0.5) {
  const kept = [];
  for (const c of clusters) {
    const idx = kept.findIndex(k => headlineOverlap(c.headline, k.headline) >= threshold);
    if (idx === -1) kept.push(c);
    else if (c.members.length > kept[idx].members.length) kept[idx] = c;
  }
  return kept;
}

// ── Per-bucket inline scrape ────────────────────────────────────────────────
async function runInlineScrape(bucket) {
  console.log(`[digest] Running inline scrape for bucket: ${bucket}`);
  const adapterResults = await runAllAdapters(bucket);

  const enriched = await Promise.all(
    adapterResults.map(async src => {
      const def = getById(src.sourceId);
      return { ...src, items: await enrichWithRss(src.items ?? [], def?.rssUrl ?? null) };
    })
  );
  const enrichedFinal = await Promise.all(
    enriched.map(async src => {
      if (!getById(src.sourceId)?.needsTranslation || !src.items?.length) return src;
      return { ...src, items: await translateHeadlines(src.items) };
    })
  );

  const clusters = await buildClusters(enrichedFinal, clusterHeadlines);
  const scored   = scoreClusters(clusters, bucket);

  const payload = {
    scrapedAt:   new Date().toISOString(),
    clusters:    scored,
    adapterMeta: adapterResults.map(r => ({
      sourceId: r.sourceId, scrapeConfidence: r.scrapeConfidence,
      itemCount: (r.items ?? []).length, warnings: r.warnings ?? [],
    })),
  };
  await redisSet(`scraped:${bucket}`, payload, SCRAPED_TTL).catch(() => {});
  return payload;
}

// ── formatStories ───────────────────────────────────────────────────────────
function formatStories(clusters) {
  return clusters.map(c => {
    const dates = c.members.map(m => m.publishedAt)
      .filter(d => d && !isNaN(new Date(d).getTime())).map(d => new Date(d).getTime());
    return {
      id:           c.id,
      headline:     decodeEntities(c.headline),
      summary:      c.summary,
      readUrl:      pickStoryUrl(c),
      learnMoreUrl: c._learnMoreUrl ?? pickLearnMoreUrl(c),
      isBreaking:   computeIsBreaking(c.members),
      publishedAt:  dates.length ? new Date(Math.min(...dates)).toISOString() : null,
      sources:      buildSourceChips(c),
      _meta: {
        qualificationRank: c.qualificationRank,
        baseScore:         c.baseScore,
        bonusScore:        c.bonusScore,
        clusterConfidence: c.clusterConfidence,
      },
    };
  });
}

// ── Handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const reqUrl = new URL(req.url, `https://${req.headers.host}`);
  if (reqUrl.searchParams.get('reset') === 'true') {
    await redisDel('digest:rolling').catch(() => {});
    if (reqUrl.searchParams.get('full') === 'true') {
      await Promise.all([
        redisDel('scraped:international').catch(() => {}),
        redisDel('scraped:local').catch(() => {}),
      ]);
    }
    return res.status(200).json({ ok: true, message: 'Cache cleared. Next request will regenerate the digest.' });
  }

  const t0 = Date.now();
  console.log('[digest] Request for rolling digest');

  try {
    // ── Digest cache ────────────────────────────────────────────────────
    const cached = await redisGet('digest:rolling');
    if (cached?.generatedAt) {
      const age = (Date.now() - new Date(cached.generatedAt).getTime()) / 1000;
      if (age < DIGEST_TTL) {
        res.setHeader('X-Cache', 'HIT');
        return res.status(200).json(cached);
      }
    }
    res.setHeader('X-Cache', 'MISS');

    const wantsJson = req.headers['x-digest-format'] === 'json';
    if (!wantsJson) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
    }
    const sse = (obj) => { try { if (!wantsJson) res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };

    // ── Get scrape data (check both caches in parallel, scrape if cold) ────
    const [cachedIntl, cachedLocal] = await Promise.all([
      redisGet('scraped:international'),
      redisGet('scraped:local'),
    ]);
    // Sequential inline scrapes if cold (spaces out LLM calls naturally)
    const intlScraped = cachedIntl || await runInlineScrape('international');
    const localScraped = cachedLocal || await runInlineScrape('local');

    // ── 90s guard ─────────────────────────────────────────────────────────
    if (Date.now() - t0 > 90_000) {
      sse({ type: 'error', message: 'Digest is regenerating — please try again in a moment.' });
      return res.end();
    }

    const intlClusters  = intlScraped.clusters  ?? [];
    const localClusters = localScraped.clusters ?? [];
    console.log(`[digest] ${intlClusters.length} intl clusters, ${localClusters.length} local clusters`);

    // ── Editorial filter (Gemini, bucket-aware, sequential) ─────────────────
    await new Promise(r => setTimeout(r, 1500));
    const editFilteredIntl  = await editorialFilter(intlClusters,  'international');
    await new Promise(r => setTimeout(r, 1500));
    const editFilteredLocal = await editorialFilter(localClusters, 'local');
    console.log(`[digest] After editorial filter: ${editFilteredIntl.length} intl, ${editFilteredLocal.length} local`);

    // ── Staleness filter (≤36 h) ────────────────────────────────────────────────
    const nowMs = Date.now();
    const isStale = c => {
      const dated = (c.members ?? []).filter(m => m.publishedAt && !isNaN(new Date(m.publishedAt).getTime()));
      if (!dated.length) return false;
      return (nowMs - Math.max(...dated.map(m => new Date(m.publishedAt).getTime()))) > STALE_WINDOW_MS;
    };
    let filteredIntl  = editFilteredIntl.filter(c  => !isStale(c));
    let filteredLocal = editFilteredLocal.filter(c => !isStale(c));

    // Fallback: if editorial filter removed everything, use scored clusters
    if (filteredIntl.length === 0 && intlClusters.length > 0) {
      console.warn('[digest] filteredIntl empty — using raw scraped clusters');
      filteredIntl = intlClusters.filter(c => !isStale(c));
    }
    if (filteredLocal.length === 0 && localClusters.length > 0) {
      console.warn('[digest] filteredLocal empty — using raw scraped clusters');
      filteredLocal = localClusters.filter(c => !isStale(c));
    }

    // ── Take top candidates (3× display count for headroom) ─────────────────
    const intlCandidates  = filteredIntl.slice(0,  STORY_COUNTS.intl  * 3);
    const localCandidates = filteredLocal.slice(0, STORY_COUNTS.local * 3);

    // ── Article enrichment (both sections in parallel, Firecrawl enabled) ───
    const needsEnrich = [...intlCandidates, ...localCandidates].filter(c => !c.articleExcerpts?.length);
    if (needsEnrich.length > 0) {
      console.log(`[digest] Enriching articles for ${needsEnrich.length} clusters…`);
      await Promise.all([
        enrichWithArticleContent(intlCandidates,  { useFirecrawl: true }),
        enrichWithArticleContent(localCandidates, { useFirecrawl: true }),
      ]);
    } else {
      console.log('[digest] All clusters pre-enriched — skipping fetch');
    }

    // ── Summarise international → stream section immediately ────────────────
    await new Promise(r => setTimeout(r, 1500));
    const intlSummarized = await summarizeClusters(intlCandidates);
    const finalIntl      = deduplicateByHeadline(intlSummarized).slice(0, STORY_COUNTS.intl);
    sse({ type: 'section', section: 'international', stories: formatStories(finalIntl) });

    // ── Summarise local → stream section ───────────────────────────────────
    await new Promise(r => setTimeout(r, 1500));
    const localSummarized = await summarizeClusters(localCandidates);
    const finalLocal      = deduplicateByHeadline(localSummarized).slice(0, STORY_COUNTS.local);
    sse({ type: 'section', section: 'local', stories: formatStories(finalLocal) });

    console.log(`[digest] Done ${Date.now() - t0}ms — ${finalIntl.length} intl, ${finalLocal.length} local`);

    const meta = {
      adapterMeta:       [...(intlScraped.adapterMeta ?? []), ...(localScraped.adapterMeta ?? [])],
      intlClusterCount:  intlClusters.length,
      localClusterCount: localClusters.length,
      elapsedMs:         Date.now() - t0,
    };
    const response = {
      generatedAt:   new Date().toISOString(),
      scrapedAt:     intlScraped.scrapedAt,
      international: formatStories(finalIntl),
      local:         formatStories(finalLocal),
      meta,
    };

    await redisSet('digest:rolling', response, DIGEST_TTL).catch(e =>
      console.warn('[digest] Redis write failed:', e.message)
    );

    if (wantsJson) return res.status(200).json(response);
    sse({ type: 'done', generatedAt: response.generatedAt, scrapedAt: response.scrapedAt, meta });
    return res.end();

  } catch (err) {
    console.error('[digest] Fatal error:', err);
    const stale = await redisGet('digest:rolling').catch(() => null);
    if (stale) {
      res.setHeader('X-Cache', 'STALE');
      return res.status(200).json({ ...stale, _stale: true, _error: err.message });
    }
    return res.status(500).json({ error: 'Failed to generate digest', detail: err.message });
  }
}
