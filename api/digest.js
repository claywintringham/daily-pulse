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
import { editorialFilter, summarizeClusters } from '../lib/llm.js';
import { buildSourceChips, pickStoryUrl, scoreClusters } from '../lib/scorer.js';
import { runAllAdapters } from '../lib/adapters/index.js';
import { enrichWithRss }  from '../lib/matcher.js';
import { buildClusters }  from '../lib/cluster.js';
import { getById }        from '../lib/sourceRegistry.js';

export const config = { maxDuration: 120 };

// Cache TTL: 20 minutes for both digest and scrape data.
// Breaking news surfaces within one 20-minute refresh cycle.
const DIGEST_TTL  = 20 * 60; // 20 minutes
const SCRAPED_TTL = 20 * 60; // 20 minutes

// Rolling digest: always show the top N stories within the staleness window.
const STORY_COUNTS = { intl: 5, local: 3 };

// Stories older than this are aged out of the digest.
const STALE_WINDOW_MS = 36 * 60 * 60 * 1000; // 36 hours

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Trusted source priority for "Learn more" links.
 * Ordered by editorial neutrality and comprehensiveness — we want the most
 * thorough, factual version of the story, not an opinion piece or niche outlet.
 */
const LEARN_MORE_PRIORITY = [
  'ap', 'reuters', 'bbc', 'guardian', 'rthk', 'hkfp', 'thestandard', 'scmp',
  'cnbc', 'aljazeera', 'dw', 'france24', 'nbcnews', 'cbsnews',
  'foxnews', 'foxbusiness',
];

/**
 * Return all free articleUrls for the cluster, sorted by source trust priority.
 * Used by enrichWithArticleContent to try each in turn until one succeeds.
 */
function rankLearnMoreUrls(c) {
  const freeWithUrl = (c.members ?? []).filter(m => !m.isPaywalled && m.articleUrl);
  if (!freeWithUrl.length) return [];

  return [...freeWithUrl]
    .sort((a, b) => {
      const ra = LEARN_MORE_PRIORITY.findIndex(s => a.sourceId?.toLowerCase().includes(s));
      const rb = LEARN_MORE_PRIORITY.findIndex(s => b.sourceId?.toLowerCase().includes(s));
      return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
    })
    .map(m => m.articleUrl);
}

/**
 * Return the top-ranked free articleUrl (used for the "Learn more" link).
 */
function pickLearnMoreUrl(c) {
  return rankLearnMoreUrls(c)[0] ?? null;
}

/**
 * Extract readable plain text from raw HTML.
 * Strips scripts, styles, and navigation blocks; joins <p> tag content.
 * Returns up to `maxChars` characters so the LLM prompt stays concise.
 */
function extractTextFromHtml(html, maxChars = 900) {
  return html
    // Remove non-content blocks entirely
    .replace(/<(script|style|noscript|nav|header|footer|aside|figure|figcaption)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    // Extract paragraph text (keep a space between tags)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

/**
 * Best-effort fetch of the article at `url`.
 * Returns plain-text excerpt or null on any failure (timeout, bot-block, etc.).
 * Used to give the LLM real article content to summarise rather than just titles.
 */
async function fetchArticleExcerpt(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DailyPulse/1.0; +https://daily-pulse-theta.vercel.app)',
        'Accept':     'text/html',
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const text = extractTextFromHtml(html);
    return text.length > 80 ? text : null; // discard near-empty pages
  } catch {
    return null; // timeout, network error, CORS — silently skip
  }
}

/**
 * Enrich each cluster with an `articleExcerpt` by fetching member article URLs
 * in priority order until one returns usable content.
 *
 * _learnMoreUrl is always set to the top-ranked URL (regardless of fetch
 * outcome) so the "Learn more" link is stable.  articleExcerpt may come from
 * a lower-ranked source if the top source times out or bot-blocks.
 */
async function enrichWithArticleContent(clusters, concurrency = 6) {
  for (let i = 0; i < clusters.length; i += concurrency) {
    const batch = clusters.slice(i, i + concurrency);
    await Promise.all(batch.map(async c => {
      const urls = rankLearnMoreUrls(c);
      if (!urls.length) return;
      c._learnMoreUrl = urls[0]; // best URL for the "Learn more" link
      for (const url of urls) {
        const excerpt = await fetchArticleExcerpt(url);
        if (excerpt) {
          c.articleExcerpt = excerpt;
          break; // got real content — stop trying
        }
      }
    }));
  }
}

/**
 * Return true when more than half of the cluster's members published
 * within the past 4 hours — indicating a breaking story.
 */
function computeIsBreaking(members) {
  if (!members?.length) return false;
  const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
  const recentCount  = members.filter(m => {
    if (!m.publishedAt) return false;
    const t = new Date(m.publishedAt).getTime();
    return !isNaN(t) && t >= fourHoursAgo;
  }).length;
  return recentCount > members.length / 2;
}

/**
 * Tokenise a headline into a set of meaningful words (length > 2, lowercased).
 * Returns Jaccard similarity in [0, 1].
 */
function headlineTokens(h) {
  return new Set(
    h.toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
  );
}

function headlineOverlap(h1, h2) {
  const a = headlineTokens(h1), b = headlineTokens(h2);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Remove duplicate clusters within a single bucket after summarisation.
 * Two clusters are duplicates when their synthesised headlines share ≥ 50 %
 * of tokens (Jaccard). Keeps whichever has more source members.
 * This catches cases where greedy single-link clustering splits a large story
 * into two clusters that only merge in the synthesised headline.
 */
function deduplicateByHeadline(clusters, threshold = 0.5) {
  const kept = [];
  for (const c of clusters) {
    const dupIdx = kept.findIndex(k => headlineOverlap(c.headline, k.headline) >= threshold);
    if (dupIdx === -1) {
      kept.push(c);
    } else {
      // Keep whichever cluster has more members (better source coverage)
      if (c.members.length > kept[dupIdx].members.length) kept[dupIdx] = c;
    }
  }
  return kept;
}


/**
 * Inline scrape fallback: runs the full adapter → enrich → cluster → score
 * pipeline when no pre-warmed `scraped:{type}` data exists in Redis.
 * Result is also written to Redis so subsequent requests benefit from it.
 */
async function runInlineScrape() {
  console.log('[digest] Running inline scrape (no pre-warmed data)');

  const adapterResults = await runAllAdapters();

  const enriched = await Promise.all(
    adapterResults.map(async src => {
      const def           = getById(src.sourceId);
      const enrichedItems = await enrichWithRss(src.items ?? [], def?.rssUrl ?? null);
      return { ...src, items: enrichedItems };
    })
  );

  const clusters    = buildClusters(enriched);
  const intlScored  = scoreClusters(clusters, 'international');
  const localScored = scoreClusters(clusters, 'local');

  const payload = {
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
  await redisSet('scraped:rolling', payload, SCRAPED_TTL).catch(() => {});
  return payload;
}

/**
 * Format scored + summarized clusters into the shape consumed by daily-pulse.html.
 *
 * Each story card:
 * {
 *   id:          string,
 *   headline:    string,
 *   summary:     string  (40-75 words),
 *   readUrl:     string | null   (highest-ranked free article URL),
 *   publishedAt: string | null   (ISO — earliest publishedAt across members),
 *   sources:     [{ name, position, url, paywalled }]
 *     url is set only for free sources with an articleUrl (linked chip)
 *     url is null for paywalled sources (unlinked chip with 🔒)
 * }
 */
function formatStories(clusters) {
  return clusters.map(c => {
    // Earliest publishedAt across all members that have a real date
    const dates = c.members
      .map(m => m.publishedAt)
      .filter(d => d && !isNaN(new Date(d).getTime()))
      .map(d => new Date(d).getTime());
    const publishedAt = dates.length ? new Date(Math.min(...dates)).toISOString() : null;

    return {
      id:           c.id,
      headline:     decodeEntities(c.headline),
      summary:      c.summary,
      readUrl:      pickStoryUrl(c),
      learnMoreUrl: c._learnMoreUrl ?? pickLearnMoreUrl(c), // reuse pre-fetched URL
      isBreaking:   computeIsBreaking(c.members),
      publishedAt,
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

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── 0. Cache reset (dev/debug) ─────────────────────────────────────────────
  const reqUrl = new URL(req.url, `https://${req.headers.host}`);
  if (reqUrl.searchParams.get('reset') === 'true') {
    await Promise.all([
      redisDel('digest:rolling').catch(() => {}),
      redisDel('scraped:rolling').catch(() => {}),
    ]);
    console.log('[digest] Cache reset via ?reset=true');
    return res.status(200).json({ ok: true, message: 'Cache cleared. Next request will regenerate the digest.' });
  }

  const t0 = Date.now();
  console.log('[digest] Request for rolling digest');

  try {
    // ── 1. Digest cache hit ─────────────────────────────────────────────────
    const cached = await redisGet('digest:rolling');
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
    let scraped = await redisGet('scraped:rolling');

    // ── 3. Inline scrape if no pre-warmed data ──────────────────────────────
    if (!scraped) {
      scraped = await runInlineScrape();
    }

    const allClusters = [
      ...(scraped.international ?? []),
      ...(scraped.local ?? []),
    ];

    console.log(`[digest] ${allClusters.length} cluster(s) before editorial filter`);

    // ── 4. LLM editorial filter (combined buckets in one call) ──────────────
    const editFiltered = await editorialFilter(allClusters);

    // ── 4b. Staleness filter ─────────────────────────────────────────────────
    // Discard any cluster whose most recent member was published outside the
    // 36-hour rolling window. RSS feeds can surface old entries; anything
    // older than the window should never appear in the digest.
    const nowMs = Date.now();
    const filtered = editFiltered.filter(c => {
      const withDates = (c.members ?? []).filter(
        m => m.publishedAt && !isNaN(new Date(m.publishedAt).getTime())
      );
      if (!withDates.length) return true; // no date info → keep (can't tell)
      const newestMs = Math.max(
        ...withDates.map(m => new Date(m.publishedAt).getTime())
      );
      return (nowMs - newestMs) <= STALE_WINDOW_MS;
    });
    console.log(`[digest] ${filtered.length} cluster(s) after editorial + staleness filter (${editFiltered.length - filtered.length} stale removed)`);

    // Re-split by bucket (preserved on each cluster object).
    //
    // Safety net: if the editorial filter merged every local cluster into an
    // international one (merged clusters inherit parts[0].bucket, which is
    // always 'international' because allClusters = [...intl, ...local]), the
    // local bucket ends up empty.  When that happens, fall back to the raw
    // scored local clusters from the scraper — staleness-filtered so we don't
    // surface old articles, but not editorially filtered (keeps genuine local
    // news that was accidentally absorbed into international merges).
    let filteredIntl  = filtered.filter(c => c.bucket === 'international');
    let filteredLocal = filtered.filter(c => c.bucket === 'local');

    if (filteredIntl.length === 0 && (scraped.international ?? []).length > 0) {
      console.warn('[digest] filteredIntl empty after editorial — using raw scraped international');
      filteredIntl = (scraped.international ?? []).filter(c => {
        const withDates = (c.members ?? []).filter(
          m => m.publishedAt && !isNaN(new Date(m.publishedAt).getTime())
        );
        if (!withDates.length) return true;
        return (nowMs - Math.max(...withDates.map(m => new Date(m.publishedAt).getTime()))) <= STALE_WINDOW_MS;
      });
    }
    if (filteredLocal.length === 0 && (scraped.local ?? []).length > 0) {
      console.warn('[digest] filteredLocal empty after editorial — using raw scraped local');
      filteredLocal = (scraped.local ?? []).filter(c => {
        const withDates = (c.members ?? []).filter(
          m => m.publishedAt && !isNaN(new Date(m.publishedAt).getTime())
        );
        if (!withDates.length) return true;
        return (nowMs - Math.max(...withDates.map(m => new Date(m.publishedAt).getTime()))) <= STALE_WINDOW_MS;
      });
    }

    // ── 5. Enrich clusters with article content ─────────────────────────────
    // Fetch the lead article for each cluster in parallel (best-effort: silent
    // fail on timeout / bot-block). The excerpt is passed to summarizeClusters
    // so Gemini can write summaries from real article text rather than titles.
    console.log('[digest] Fetching article excerpts…');
    await enrichWithArticleContent(filtered);
    console.log('[digest] Article enrichment done');

    // ── 6. Summarization (sequential to avoid Gemini rate-limit collisions) ───
    // After summarisation, deduplicate within each bucket: greedy clustering
    // can split a large story into two clusters that share a synthesised headline.
    // After dedup, re-sort by baseScore descending so importance order is
    // preserved even when the editorial filter or dedup reorders clusters.
    // Filter out stories with subjective or speculative headlines.
    // These slip through when every source in a cluster uses an analysis/opinion
    // framing, so pickBestHeadline has no factual title to fall back on.
    const HEADLINE_SKIP = [
      /\?$/,                                              // speculative question
      /^(analysis|opinion|comment|explainer|review|interview)[:\s]/i, // editorial label
      /^live:/i,                                          // live blog title
      /\blive:/i,                                         // "X crisis live: ..."
    ];
    const noQuestions = arr => arr.filter(
      c => !HEADLINE_SKIP.some(p => p.test(c.headline.trim()))
    );

    const byScore = arr => [...arr].sort((a, b) => (b.baseScore || 0) - (a.baseScore || 0));
    const summarisedIntl  = byScore(deduplicateByHeadline(noQuestions(await summarizeClusters(filteredIntl))));
    const summarisedLocal = byScore(deduplicateByHeadline(noQuestions(await summarizeClusters(filteredLocal))));
    console.log(`[digest] Summarization done in ${Date.now() - t0} ms`);

    // ── 6. Rolling top-N selection ──────────────────────────────────────────
    // Always return the highest-scored stories within the 36-hour window.
    // No morning/evening split — the frontend tracks which stories are new
    // via localStorage and shows a "New" badge on first view.
    const finalIntl  = summarisedIntl.slice(0, STORY_COUNTS.intl);
    const finalLocal = summarisedLocal.slice(0, STORY_COUNTS.local);
    console.log(`[digest] Rolling: ${finalIntl.length} intl, ${finalLocal.length} local`);

    // ── 7. Build response ───────────────────────────────────────────────────
    const meta = {
      adapterMeta:        scraped.adapterMeta ?? [],
      clusterCountBefore: allClusters.length,
      clusterCountAfter:  filtered.length,
      elapsedMs:          Date.now() - t0,
    };

    const response = {
      generatedAt:   new Date().toISOString(),
      scrapedAt:     scraped.scrapedAt,
      international: formatStories(finalIntl),
      local:         formatStories(finalLocal),
      meta,
    };

    // ── 8. Cache and return ─────────────────────────────────────────────────
    await redisSet('digest:rolling', response, DIGEST_TTL).catch(e =>
      console.warn('[digest] Redis write failed (non-fatal):', e.message)
    );

    return res.status(200).json(response);

  } catch (err) {
    console.error('[digest] Fatal error:', err);

    // Serve stale cache rather than a hard error when possible
    const stale = await redisGet('digest:rolling').catch(() => null);
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
