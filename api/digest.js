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

// Cache TTL: digest cached for 4 hours; scrape data for 1 hour.
const DIGEST_TTL  = 4 * 60 * 60; // 4 hours
const SCRAPED_TTL = 60 * 60;     // 1 hour (mirrors api/scrape.js)

// How many stories to surface per section per edition.
// "Never blank on first run" — slice after filtering, not before, so
// we always show up to N stories even if fewer pass the editorial filter.
const STORY_COUNTS = {
  morning: { intl: 5, local: 3 },
  evening: { intl: 3, local: 2 },
};

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
 * Return the articleUrl from the most trusted free source in the cluster.
 * Falls back to any free source with an articleUrl if none match the priority list.
 */
function pickLearnMoreUrl(c) {
  const freeWithUrl = (c.members ?? []).filter(m => !m.isPaywalled && m.articleUrl);
  if (!freeWithUrl.length) return null;

  const ranked = [...freeWithUrl].sort((a, b) => {
    const ra = LEARN_MORE_PRIORITY.findIndex(s =>
      a.sourceId?.toLowerCase().includes(s));
    const rb = LEARN_MORE_PRIORITY.findIndex(s =>
      b.sourceId?.toLowerCase().includes(s));
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
  });
  return ranked[0].articleUrl;
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
 * Headline-based fuzzy deduplication between editions.
 *
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
 * Filter `clusters` to those not already covered in the other edition's digest.
 *
 * Two signals are checked in OR:
 *   1. Headline token overlap ≥ 0.25 (lowered from 0.4 because the LLM can
 *      rephrase the same story very differently across editions).
 *   2. Source-label overlap ≥ 2 shared outlets — if the same news organisations
 *      appear in both the current cluster and a digest story, they are almost
 *      certainly reporting the same underlying event regardless of headline wording.
 */
function notInOtherDigest(clusters, digestStories) {
  if (!digestStories?.length) return clusters;
  return clusters.filter(c => {
    return !digestStories.some(ds => {
      // Signal 1: headline similarity
      if (headlineOverlap(c.headline, ds.headline) >= 0.25) return true;
      // Signal 2: 2+ shared outlet names
      const cLabels = new Set((c.members ?? []).map(m => (m.label ?? '').toLowerCase()));
      const dLabels = new Set((ds.sources ?? []).map(s => (s.name ?? '').toLowerCase()));
      let shared = 0;
      for (const l of cLabels) if (l && dLabels.has(l)) shared++;
      return shared >= 2;
    });
  });
}

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
      summary:      c.summary ?? decodeEntities(c.headline),
      readUrl:      pickStoryUrl(c),
      learnMoreUrl: pickLearnMoreUrl(c),
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
      redisDel('digest:morning').catch(() => {}),
      redisDel('digest:evening').catch(() => {}),
      redisDel('scraped:morning').catch(() => {}),
      redisDel('scraped:evening').catch(() => {}),
    ]);
    console.log('[digest] Cache reset via ?reset=true');
    return res.status(200).json({ ok: true, message: 'Cache cleared. Next request will run as morning edition.' });
  }

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
    const editFiltered = await editorialFilter(allClusters);

    // ── 4b. Staleness filter ─────────────────────────────────────────────────
    // Discard any cluster whose most recent member was published more than
    // 48 hours ago. RSS feeds can surface old entries; a 5-day-old article
    // should never appear in today's digest.
    const STALE_CUTOFF_MS = 48 * 60 * 60 * 1000; // 48 hours
    const nowMs = Date.now();
    const filtered = editFiltered.filter(c => {
      const withDates = (c.members ?? []).filter(
        m => m.publishedAt && !isNaN(new Date(m.publishedAt).getTime())
      );
      if (!withDates.length) return true; // no date info → keep (can't tell)
      const newestMs = Math.max(
        ...withDates.map(m => new Date(m.publishedAt).getTime())
      );
      return (nowMs - newestMs) <= STALE_CUTOFF_MS;
    });
    console.log(`[digest] ${filtered.length} cluster(s) after editorial + staleness filter (${editFiltered.length - filtered.length} stale removed)`);

    // Re-split by bucket (preserved on each cluster object)
    const filteredIntl  = filtered.filter(c => c.bucket === 'international');
    const filteredLocal = filtered.filter(c => c.bucket === 'local');

    // ── 5. Summarization (sequential to avoid Gemini rate-limit collisions) ───
    // After summarisation, deduplicate within each bucket: greedy clustering
    // can split a large story into two clusters that share a synthesised headline.
    // After dedup, re-sort by baseScore descending so importance order is
    // preserved even when the editorial filter or dedup reorders clusters.
    const byScore = arr => [...arr].sort((a, b) => (b.baseScore || 0) - (a.baseScore || 0));
    const summarisedIntl  = byScore(deduplicateByHeadline(await summarizeClusters(filteredIntl)));
    const summarisedLocal = byScore(deduplicateByHeadline(await summarizeClusters(filteredLocal)));
    console.log(`[digest] Summarization done in ${Date.now() - t0} ms`);

    // ── 6. Morning / evening differentiation ───────────────────────────────
    //
    // The two editions share the same underlying scraped data but serve
    // different stories depending on which ran first:
    //
    //   Evening after Morning:
    //     Show only stories NOT already in the morning digest, ranked by
    //     importance (scorer order is preserved). If nothing new → noUpdate.
    //
    //   Morning after Evening:
    //     Evening took the top stories; morning goes deeper in the ranked list
    //     and shows stories not yet covered. Never returns noUpdate — morning
    //     always has something to say even if the top headlines were in evening.
    //
    //   Either runs first (no other-edition cache):
    //     Show top-ranked stories normally.

    const counts = STORY_COUNTS[type] ?? STORY_COUNTS.morning;

    let finalIntl, finalLocal;
    let noUpdate      = false;
    let localNoUpdate = false; // evening only: intl has stories but local has none new
    let morningGeneratedAt = null;

    if (type === 'evening') {
      // ── Evening: only stories newer/more important than morning ────────────
      const morningDigest = await redisGet('digest:morning').catch(() => null);

      if (morningDigest?.generatedAt) {
        morningGeneratedAt = morningDigest.generatedAt;
        const morningStories = [
          ...(morningDigest.international ?? []),
          ...(morningDigest.local         ?? []),
        ];

        // Keep stories not already covered in morning (scorer order = importance)
        finalIntl  = notInOtherDigest(summarisedIntl,  morningStories).slice(0, counts.intl);
        finalLocal = notInOtherDigest(summarisedLocal, morningStories).slice(0, counts.local);

        if (finalIntl.length === 0 && finalLocal.length === 0) {
          noUpdate = true;
          console.log('[digest] Evening: no new stories vs morning — returning noUpdate');
        } else if (finalLocal.length === 0 && finalIntl.length > 0) {
          localNoUpdate = true;
          console.log('[digest] Evening: no new local stories vs morning');
        }
      } else {
        // Evening ran first: show top-ranked stories normally
        console.log('[digest] Evening ran first (no morning cache) — showing top-ranked stories');
        finalIntl  = summarisedIntl.slice(0, counts.intl);
        finalLocal = summarisedLocal.slice(0, counts.local);
      }

    } else {
      // ── Morning: skip stories already shown in evening, go deeper if needed ─
      const eveningDigest = await redisGet('digest:evening').catch(() => null);

      if (eveningDigest?.generatedAt) {
        const eveningStories = [
          ...(eveningDigest.international ?? []),
          ...(eveningDigest.local         ?? []),
        ];

        // Go as deep as needed through the ranked list to find non-evening stories
        finalIntl  = notInOtherDigest(summarisedIntl,  eveningStories).slice(0, counts.intl);
        finalLocal = notInOtherDigest(summarisedLocal, eveningStories).slice(0, counts.local);

        // Safety net: if somehow everything overlaps, fall back to top-ranked
        // (morning is never blank)
        if (finalIntl.length === 0 && finalLocal.length === 0) {
          console.warn('[digest] Morning: all stories already in evening — falling back to top-ranked');
          finalIntl  = summarisedIntl.slice(0, counts.intl);
          finalLocal = summarisedLocal.slice(0, counts.local);
        } else {
          console.log(`[digest] Morning after evening: ${finalIntl.length} intl, ${finalLocal.length} local (skipped ${eveningStories.length} evening stories)`);
        }
      } else {
        // Morning ran first: show top-ranked stories normally
        console.log('[digest] Morning ran first (no evening cache) — showing top-ranked stories');
        finalIntl  = summarisedIntl.slice(0, counts.intl);
        finalLocal = summarisedLocal.slice(0, counts.local);
      }
    }

    // ── 7. Build response ───────────────────────────────────────────────────
    const meta = {
      adapterMeta:        scraped.adapterMeta ?? [],
      clusterCountBefore: allClusters.length,
      clusterCountAfter:  filtered.length,
      elapsedMs:          Date.now() - t0,
    };

    if (noUpdate) {
      const response = {
        type,
        generatedAt:        new Date().toISOString(),
        scrapedAt:          scraped.scrapedAt,
        noUpdate:           true,
        morningGeneratedAt,
        international:      [],
        local:              [],
        meta,
      };
      await redisSet(`digest:${type}`, response, DIGEST_TTL).catch(e =>
        console.warn('[digest] Redis write failed (non-fatal):', e.message)
      );
      return res.status(200).json(response);
    }

    const response = {
      type,
      generatedAt:   new Date().toISOString(),
      scrapedAt:     scraped.scrapedAt,
      international: formatStories(finalIntl),
      local:         formatStories(finalLocal),
      localNoUpdate,
      meta,
    };

    // ── 8. Cache and return ─────────────────────────────────────────────────
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
