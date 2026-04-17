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
  'cnbc', 'cnn', 'aljazeera', 'dw', 'france24', 'nbcnews', 'cbsnews',
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
 * Extract readable plain text from raw HTML using Mozilla Readability
 * (the same engine that powers Firefox Reader Mode).
 *
 * Readability identifies the main article body and strips nav, ads,
 * sidebars, and related-article teasers — far more reliably than regex.
 *
 * Falls back to <p>-tag extraction when Readability decides the page
 * isn't article-like (e.g. homepages, search results).
 *
 * @param {string} html     - Raw HTML from the article page
 * @param {string} url      - Canonical URL (used as baseURI for Readability)
 * @param {number} maxChars - Max characters to return (default 1500)
 */
/**
 * Strip boilerplate patterns that survive Readability but pollute LLM input:
 *   • AP wire timestamp templates: [hour], [minute], [AMPM], etc.
 *   • "Updated HH:MM …" prefix lines that AP wires embed in hosted articles
 *   • Video chip text from CNN/NBC: "3:45 • Source: CNN"
 *   • Repeated "Exclusive:" video-embed labels from CNN player
 */
function sanitiseExtract(text) {
  return text
    // AP wire template placeholders like [hour], [monthFull], [timezone], etc.
    .replace(/\[[a-zA-Z][a-zA-Z]*\]/g, '')
    // "Updated …" AP/CBS CMS timestamp line — nuke the entire line unconditionally.
    // The previous pattern required an em-dash on the same line, which failed when
    // AP puts the dateline on a separate line, leaving "Updated : , ," behind.
    .replace(/^Updated\b[^\n]*/im, '')
    // Orphaned punctuation artifacts left after template-variable stripping,
    // e.g. ": , , " at the start of what is now the first content line.
    .replace(/^[\s:,;]+/m, '')
    // Bare AP dateline at paragraph start: "JERUSALEM (AP) — " or "BUDAPEST, Hungary (AP) — "
    // Also accepts a plain hyphen in case the em-dash didn't survive encoding.
        .replace(/^[A-Z][A-Za-z ,.]+\([A-Z]+\)\s*[—–\-]\s*/m, '')
    // Video duration chip: "3:45 • Source: CNN" or "3:45 · Source: ..."
    .replace(/\d+:\d+\s*[•·]\s*Source:[^\n]*/g, '')
    // Repeated "Exclusive:" video-embed labels left by CNN player
    .replace(/(Exclusive:[^\n]{0,120}\n?){2,}/g, '$1')
    // BBC / wire-agency article preamble at start of text:
    //   "N time-units ago" + optional byline + image credit + caption
    //   e.g. "4 hours agoLyse DoucetChief international correspondent,
    //         in IslamabadGetty ImagesFile photo of JD Vance … Hungary"
    .replace(/^\d+\s+\w+\s+ago[\s\S]{0,600}?(?:Getty Images?|AFP|Reuters|EPA)[^\n.]{0,300}\.?\s*/i, '')
    // Fallback: bare relative timestamp at start if no image credit followed above
    .replace(/^\d+\s+(?:second|minute|hour|day|week)s?\s+ago\s*/im, '')
    // BBC inline timestamp + byline injected mid-text (e.g. after a pull-quote
    // or question: "Will it work?2 hours agoPaul AdamsDiplomatic correspondentReuters…")
    // Strips: "Nunit ago" + up to 200 chars of byline junk (name, title, agency).
    .replace(/\d+\s+(?:second|minute|hour|day|week)s?\s+ago.{0,200}?(?=[A-Z][^A-Z])/g, '')
    // Orphaned Getty Images credit line anywhere in the extract
    .replace(/\bGetty Images?[^\n.]{0,250}\.?\s*/gi, '')
    // Dangling wire-agency byline fragments: "Paul AdamsDiplomatic correspondent"
    // pattern — a run of Title-Case words followed immediately (no space) by
    // another Title-Case run is a name+title glued together by missing whitespace.
    .replace(/(?<=[.?!])\s*[A-Z][a-z]+ [A-Z][a-z]+(?:[A-Z][a-z]+ ?){1,6}(?:correspondent|reporter|editor|analyst|bureau)[^\n.]{0,120}/g, '')
    // Collapse any resulting runs of whitespace
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractTextFromHtml(html, url = '', maxChars = 1500) {
  // ── Primary: Readability ────────────────────────────────────────────────────
  try {
    const { document } = parseHTML(html);
    const reader  = new Readability(document);
    const article = reader.parse();
    if (article?.textContent) {
      // Sanitise *before* collapsing whitespace so that \n boundaries are
      // available to the BBC preamble patterns in sanitiseExtract().
      // Without this, "Getty Images caption…" flows directly into the first
      // article sentence (no newline separator) and the [^\n.]{0,300} quantifier
      // eats article body text until it finds the next period.
      const raw = article.textContent
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')   // collapse blank runs but keep paragraph breaks
        .replace(/[ \t]+/g, ' ')       // normalise horizontal space only
        .trim();
      return sanitiseExtract(raw).replace(/\s+/g, ' ').trim().slice(0, maxChars);
    }
  } catch { /* Readability failed — fall through */ }

  // ── Fallback: <p>-tag extraction ────────────────────────────────────────────
  // Used when Readability decides the page has no article body (e.g. a homepage).
  const cleaned = html.replace(
    /<(script|style|noscript|nav|header|footer|aside|figure|figcaption|menu)[^>]*>[\s\S]*?<\/\1>/gi, ' '
  );
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  const paragraphs = [];
  let pm;
  while ((pm = pRe.exec(cleaned)) !== null) {
    const text = pm[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/&#\d+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 40) paragraphs.push(text);
  }
  if (paragraphs.length > 0) return sanitiseExtract(paragraphs.join(' ')).slice(0, maxChars);

  // Last resort: strip all tags
  return sanitiseExtract(
    cleaned
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/&#\d+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  ).slice(0, maxChars);
}

/**
 * Return true when the excerpt contains enough tokens from the cluster headline
 * to be considered on-topic.  Prevents a financial sidebar or related-article
 * teaser from being accepted as the summary source for a different story.
 *
 * Two-tier check:
 *
 * 1. ANCHOR GATE — any token longer than 6 characters is treated as a key
 *    subject word (e.g. "blockade", "concedes", "supermajority").  If the
 *    headline has at least one such word, the excerpt MUST contain at least
 *    one of them.  This rejects articles that only share short common words
 *    ("trump", "says", "will") but are clearly about a different topic
 *    (e.g. a 2004 Apprentice TV pilot won't contain "blockade").
 *
 * 2. OVERLAP GATE — ≥ 30 % of all meaningful tokens (length > 3) must
 *    appear in the excerpt, with a floor of 3 matches.
 */
function excerptIsRelevant(headline, excerpt) {
  if (!headline || !excerpt) return false;
  const tokens = headline
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3);
  if (!tokens.length) return true; // nothing meaningful to check
  const ex = excerpt.toLowerCase();

  // ── 1. Anchor gate ────────────────────────────────────────────────────────
  // Distinctive long words (>6 chars) are the story's key subjects.
  // At least one must appear in the excerpt, or it's clearly off-topic.
  const anchors = tokens.filter(w => w.length > 6);
  if (anchors.length > 0 && !anchors.some(a => ex.includes(a))) return false;

  // ── 2. Overlap gate ───────────────────────────────────────────────────────
  const hits = tokens.filter(t => ex.includes(t)).length;
  return hits >= Math.max(3, Math.floor(tokens.length * 0.30));
}

/**
 * URL patterns that produce unusable excerpts:
 *   - Live blogs: AP, CBS, BBC etc. use template placeholders like [hour]:[minute]
 *     that bleed into the extracted text and confuse the LLM.
 *   - Video pages: NBC /video/, CNN /video/, etc. return "Now Playing / Up Next"
 *     boilerplate rather than article prose.
 * These are skipped early so the fetch loop moves on to the next source URL.
 */
const SKIP_URL_RE = /\/(live[-\/]|live-updates|live-blog|liveblog)|\/video(s)?\/|\/(watch)\/|\/photo-gallery\//i;

/**
 * Best-effort fetch of the article at `url`.
 * Returns plain-text excerpt or null on any failure (timeout, bot-block, etc.).
 * Used to give the LLM real article content to summarise rather than just titles.
 */
async function fetchArticleExcerpt(url) {
  if (!url) return null;
  if (SKIP_URL_RE.test(url)) return null; // live blogs and video pages produce unusable text
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
    const text = extractTextFromHtml(html, url); // pass URL so Readability can set baseURI
    return text.length > 80 ? text : null; // discard near-empty pages
  } catch {
    return null; // timeout, network error, CORS — silently skip
  }
}

/**
 * Search The Guardian Open Platform for an article matching the cluster headline.
 * Returns plain-text article body (up to 1500 chars) or null.
 *
 * Requires GUARDIAN_API_KEY env var (free registration at open-platform.theguardian.com).
 * Silently skips if the key is absent — Guardian is a fallback, not required.
 */
async function searchGuardianForExcerpt(headline) {
  const key = process.env.GUARDIAN_API_KEY;
  if (!key) return null;
  try {
    const q   = encodeURIComponent(headline.replace(/['"]/g, '').slice(0, 120));
    const url = `https://content.guardianapis.com/search?q=${q}&show-fields=bodyText&page-size=1&api-key=${key}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const data = await res.json();
    const body = data.response?.results?.[0]?.fields?.bodyText;
    if (!body) return null;
    return body.replace(/\s+/g, ' ').trim().slice(0, 1500);
  } catch {
    return null;
  }
}

/**
 * Enrich each cluster with an `articleExcerpt` by fetching member article URLs
 * in priority order until one returns usable content.
 *
 * If every URL fails or returns off-topic content, falls back to searching
 * The Guardian API by headline (requires GUARDIAN_API_KEY env var).
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

      // Use pre-fetched description if available (e.g. TVB Pearl/TVB API items)
      // Avoids an outbound HTTP fetch when the adapter already returned article text.
      // Must pass a minimum word count AND excerptIsRelevant to filter out nav/ad
      // text that can appear in raw RSS description fields.
      // Also explicitly rejects BBC nav bars and ad-feedback injections: these embed
      // the actual article headline so they pass excerptIsRelevant(), but are still junk.
      const memberWithDesc = (c.members ?? []).find(m => m.description);
      if (memberWithDesc) {
        const sanitised = sanitiseExtract(memberWithDesc.description).slice(0, 1500);
        const wordCount = sanitised.split(/\s+/).filter(Boolean).length;
        const isNavJunk = /^Home\s+News\s+Sport\b/i.test(sanitised.trim()) ||
                          /\bAd\s+Feedback\b/i.test(sanitised);
        if (!isNavJunk && sanitised.length > 80 && wordCount >= 30 && excerptIsRelevant(c.headline, sanitised)) {
          c.articleExcerpt = sanitised;
          return; // skip URL fetching
        }
      }

      // Try each free member URL in priority order
      for (const url of urls) {
        const excerpt = await fetchArticleExcerpt(url);
        if (excerpt && excerptIsRelevant(c.headline, excerpt)) {
          c.articleExcerpt = excerpt;
          break; // got real, on-topic content — stop trying
        }
      }

      // Guardian API fallback — used when every URL times out, bot-blocks,
      // or returns off-topic content (e.g. a markets article for a Hormuz story)
      if (!c.articleExcerpt) {
        const guardianExcerpt = await searchGuardianForExcerpt(c.headline);
        if (guardianExcerpt && excerptIsRelevant(c.headline, guardianExcerpt)) {
          c.articleExcerpt = guardianExcerpt;
        }
      }
    }));
  }
}

/**
 * Return true when more sources published within the past 4 hours than
 * outside it — i.e. the majority of dated sources are fresh.
 *
 * Only members with a known publishedAt are used for the comparison.
 * Members where publishedAt is null (DOM-only scrape, no RSS match) are
 * excluded from both counts so they don't artificially depress the ratio.
 */
function computeIsBreaking(members) {
  if (!members?.length) return false;
  const fourHoursAgo  = Date.now() - 4 * 60 * 60 * 1000;
  const datedMembers  = members.filter(m => {
    if (!m.publishedAt) return false;
    const t = new Date(m.publishedAt).getTime();
    return !isNaN(t);
  });
  if (!datedMembers.length) return false; // no dates known — cannot determine
  const recentCount   = datedMembers.filter(
    m => new Date(m.publishedAt).getTime() >= fourHoursAgo
  ).length;
  const notRecentCount = datedMembers.length - recentCount;
  return recentCount > notRecentCount; // more fresh sources than stale ones
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
 * Count how many outlet labels appear in both clusters (source overlap).
 * Two clusters sharing 2+ outlets are almost certainly the same story even
 * if their synthesised headlines are worded very differently.
 */
function sourceOverlap(a, b) {
  const labelsA = new Set(a.members.map(m => m.label));
  let shared = 0;
  for (const m of b.members) if (labelsA.has(m.label)) shared++; 
  return shared;
}

/**
 * Remove duplicate clusters within a single bucket after summarisation.
 * Two clusters are considered duplicates when EITHER:
 *   (a) headline Jaccard similarity ≥ 0.5, OR
 *   (b) they share ≥ 2 outlet labels AND headline Jaccard ≥ 0.15
 *       (same story, differently worded headline)
 * Keeps whichever has more source members.
 */
function deduplicateByHeadline(clusters, threshold = 0.5) {
  const kept = [];
  for (const c of clusters) {
    const dupIdx = kept.findIndex(k => {
      const overlap = headlineOverlap(c.headline, k.headline);
      if (overlap >= threshold) return true;
      if (overlap >= 0.15 && sourceOverlap(c, k) >= 2) return true;
      return false;
    });
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
      const def    = getById(src.sourceId);
      const rssUrl = def?.rssUrl ?? null;
      // Skip RSS enrichment when items already carry publishedAt
      // (API adapters like TVB Pearl/News, sitemap, RSS-fallback items)
      if (!rssUrl || (src.items ?? []).some(item => item.publishedAt)) {
        return src;
      }
      const enrichedItems = await enrichWithRss(src.items ?? [], rssUrl);
      return { ...src, items: enrichedItems };
    })
  );

  // Translate Chinese-language headlines before clustering so Jaccard
  // similarity can match them against English-language sources.
  const enrichedFinal = await Promise.all(
    enriched.map(async src => {
      if (!getById(src.sourceId)?.needsTranslation || !src.items?.length) return src;
      const translated = await translateHeadlines(src.items);
      return { ...src, items: translated };
    })
  );

  const clusters    = buildClusters(enrichedFinal);
  const intlScored  = scoreClusters(clusters, 'international', STORY_COUNTS.intl);
  const localScored = scoreClusters(clusters, 'local',         STORY_COUNTS.local);

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

    // ── 4. LLM editorial filter + article prefetch (in parallel) ────────────
    // enrichWithArticleContent mutates cluster objects in-place, so prefetching
    // on allClusters is safe: excerpts for kept clusters are ready when
    // editorialFilter resolves; excerpts for dropped clusters are discarded.
    console.log('[digest] Running editorial filter + article prefetch in parallel…');
    const [editFiltered] = await Promise.all([
      editorialFilter(allClusters),
      enrichWithArticleContent(allClusters),
    ]);
    console.log('[digest] Editorial filter + article enrichment done');

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

    // ── 5 → 6. Summarization (article excerpts already fetched in step 4) (sequential to avoid Gemini rate-limit collisions) ───
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
    const [intlResults, localResults] = await Promise.all([
      summarizeClusters(filteredIntl),
      summarizeClusters(filteredLocal),
    ]);
    const summarisedIntl  = byScore(deduplicateByHeadline(noQuestions(intlResults)));
    const summarisedLocal = byScore(deduplicateByHeadline(noQuestions(localResults)));
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
