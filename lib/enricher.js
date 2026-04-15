// ── lib/enricher.js ───────────────────────────────────────────────────────────
// Shared article-enrichment module used by both Pipeline 1 (scraper) and
// Pipeline 2 (digest fallback).
//
// Source-iteration strategy for picking articleExcerpt:
//
//   1. Sort the cluster's members by source priority (AP/Reuters first,
//      then major wires/papers, then everything else).
//   2. Pass 1 — descriptions: iterate the sorted list and take the first
//      member whose RSS description passes the quality gate.
//   3. Pass 2 — article bodies: if no description passes, fetch each
//      member's article URL (direct, with Firecrawl as last resort for
//      bot-blocked domains) and run the same gate on the body.
//   4. If every member fails both passes, leave articleExcerpt unset —
//      the caller (api/digest.js) drops these clusters before rendering.
//
// Quality gate (must pass ALL):
//   • ≥ 30 words
//   • ≥ 10 tokens not present in the cluster headline (case-insensitive,
//     punctuation stripped, common stopwords ignored)
//   • Not a stub/teaser (no "read more", "subscribe", paywall, captcha, etc.)
//   • Trim to 600 words if longer (don't reject — trim)

import { createRequire } from 'module';
const _require    = createRequire(import.meta.url);
const Readability = _require('@mozilla/readability');
const { parseHTML } = _require('linkedom');

// ── Source priority ───────────────────────────────────────────────────────────

// Tier 1 — wire services (most reliable factual reporting)
const PRIORITY_TIER_1 = ['ap', 'reuters'];
// Tier 2 — major wire/paper/broadcaster
const PRIORITY_TIER_2 = [
  'bbc', 'guardian', 'aljazeera',
  'nbcnews', 'cbsnews', 'abcnews',
  'nyt', 'wsj', 'bloomberg',
  'ft', 'financialtimes',
];

function sourceTier(sourceId) {
  const s = (sourceId || '').toLowerCase();
  if (PRIORITY_TIER_1.some(p => s.includes(p))) return 1;
  if (PRIORITY_TIER_2.some(p => s.includes(p))) return 2;
  return 3;
}

/**
 * Stable sort: tier ascending (lower tier = higher priority).
 * Within the same tier, preserve the original cluster member order
 * (rank-sorted from buildClusters).
 */
function prioritiseMembers(members) {
  return [...(members ?? [])]
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ta = sourceTier(a.m.sourceId);
      const tb = sourceTier(b.m.sourceId);
      if (ta !== tb) return ta - tb;
      return a.i - b.i;
    })
    .map(x => x.m);
}

// ── Learn-more URL ranking (used by digest/formatStories) ─────────────────────

const LEARN_MORE_PRIORITY = [
  'ap', 'reuters', 'bbc', 'guardian', 'rthk', 'hkfp', 'thestandard', 'scmp',
  'cnbc', 'cnn', 'aljazeera', 'dw', 'france24', 'nbcnews', 'cbsnews',
  'foxnews', 'foxbusiness',
];

const BOT_BLOCKED_DOMAINS = [
  'foxnews.com', 'nbcnews.com', 'cbsnews.com',
  'nbclosangeles.com', 'foxbusiness.com',
];

function isBotBlocked(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return BOT_BLOCKED_DOMAINS.some(d => h.includes(d));
  } catch { return false; }
}

export function rankLearnMoreUrls(c) {
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

export function pickLearnMoreUrl(c) { return rankLearnMoreUrls(c)[0] ?? null; }

// ── Text sanitisation ─────────────────────────────────────────────────────────

const CLOSED_BLOG_RE = /^this (?:live )?blog (?:has now closed|is now closed|has closed|is closed)\b/i;

export function sanitiseExtract(text) {
  return text
    .replace(/^this (?:live )?blog (?:has now closed|is now closed|has closed|is closed)[^\n]*\n?/im, '')
    .replace(/^this page is no longer being updated[^\n]*\n?/im, '')
    .replace(/our (?:live )?coverage(?:[^\n.]{0,120})?continues here\.?\s*/im, '')
    .replace(/\[[a-zA-Z][a-zA-Z]*\]/g, '')
    .replace(/^Updated\b[^\n]*/im, '')
    .replace(/^[\s:,;]+/m, '')
    .replace(/^[A-Z][A-Za-z ,.]+\([A-Z]+\)\s*[—–\-]\s*/m, '')
    .replace(/\d+:\d+\s*[•·]\s*Source:[^\n]*/g, '')
    .replace(/(Exclusive:[^\n]{0,120}\n?){2,}/g, '$1')
    .replace(/^\d+\s+\w+\s+ago[\s\S]{0,600}?(?:Getty Images?|AFP|Reuters|EPA)[^\n.]{0,300}\.?\s*/i, '')
    .replace(/^\d+\s+(?:second|minute|hour|day|week)s?\s+ago\s*/im, '')
    .replace(/\bGetty Images?[^\n.]{0,250}\.?\s*/gi, '')
    .replace(/\s{2,}/g, ' ').trim();
}

// ── Quality gate ──────────────────────────────────────────────────────────────

const GATE_STOPWORDS = new Set([
  'the', 'a', 'of', 'to', 'in', 'and', 'for', 'is', 'on', 'with', 'by', 'at',
]);

const STUB_PATTERNS = [
  /read more/i,
  /subscribe to continue/i,
  /subscribe for full access/i,
  /click here/i,
  /sign up to read/i,
  /paywall/i,
  /please enable javascript/i,
  /accept cookies/i,
  /verify you are human/i,
  /captcha/i,
];

function gateTokens(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !GATE_STOPWORDS.has(w));
}

/**
 * Run the quality gate on a candidate excerpt relative to the cluster headline.
 * Returns the (possibly trimmed) text on pass, or null on fail.
 */
export function passesQualityGate(text, headline) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Stub/teaser check — reject outright
  if (STUB_PATTERNS.some(p => p.test(trimmed))) return null;

  // Word count — need ≥ 30
  const words = trimmed.split(/\s+/);
  if (words.length < 30) return null;

  // Headline-overlap check — need ≥ 10 unique tokens not in the headline
  const headlineSet = new Set(gateTokens(headline));
  const textTokens  = gateTokens(trimmed);
  let unique = 0;
  const seen = new Set();
  for (const t of textTokens) {
    if (seen.has(t)) continue;
    if (headlineSet.has(t)) continue;
    seen.add(t);
    unique++;
    if (unique >= 10) break;
  }
  if (unique < 10) return null;

  // Trim to 600 words if longer
  if (words.length > 600) return words.slice(0, 600).join(' ');
  return trimmed;
}

// ── HTML → text extraction ────────────────────────────────────────────────────

function extractTextFromHtml(html, maxChars = 6000) {
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document).parse();
    if (article?.textContent) {
      const raw = article.textContent
        .replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
      return sanitiseExtract(raw).replace(/\s+/g, ' ').trim().slice(0, maxChars);
    }
  } catch { /* fall through */ }

  const cleaned = html.replace(
    /<(script|style|noscript|nav|header|footer|aside|figure|figcaption|menu)[^>]*>[\s\S]*?<\/\1>/gi, ' '
  );
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  const paragraphs = [];
  let pm;
  while ((pm = pRe.exec(cleaned)) !== null) {
    const t = pm[1].replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ')
      .replace(/&#\d+;/g,' ').replace(/\s+/g,' ').trim();
    if (t.length > 40) paragraphs.push(t);
  }
  if (paragraphs.length) return sanitiseExtract(paragraphs.join(' ')).slice(0, maxChars);
  return sanitiseExtract(
    cleaned.replace(/<[^>]+>/g,' ')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ')
      .replace(/&#\d+;/g,' ').replace(/\s+/g,' ').trim()
  ).slice(0, maxChars);
}

// ── Fetchers ──────────────────────────────────────────────────────────────────

const SKIP_URL_RE = /\/(live[-\/]|live-updates|live-blog|liveblog)|\/video(s)?\/|\/(watch)\/|\/photo-gallery\//i;
const USER_AGENT  = 'Mozilla/5.0 (compatible; DailyPulse/1.0; +https://daily-pulse-theta.vercel.app)';

async function fetchDirect(url) {
  if (!url || SKIP_URL_RE.test(url)) return null;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return { status: res.status, text: null };
    const html = await res.text();
    const text = extractTextFromHtml(html);
    if (CLOSED_BLOG_RE.test(text)) return null;
    return { status: 200, text: text.length > 80 ? text : null };
  } catch { return null; }
}

async function fetchWithFirecrawl(url) {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) {
    console.warn('[enricher] Firecrawl skipped — FIRECRAWL_API_KEY not set');
    return null;
  }
  console.log(`[enricher] Firecrawl attempting: ${url}`);
  try {
    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`[enricher] Firecrawl HTTP ${res.status} for ${url}`);
      return null;
    }
    const data = await res.json();
    const md = data.data?.markdown ?? data.markdown ?? null;
    if (!md || md.length < 80) {
      console.warn(`[enricher] Firecrawl returned empty content for ${url}`);
      return null;
    }
    console.log(`[enricher] Firecrawl success: ${url} (${md.length} chars)`);
    return sanitiseExtract(md).slice(0, 6000);
  } catch (e) {
    console.warn(`[enricher] Firecrawl error for ${url}:`, e.message);
    return null;
  }
}

/**
 * Fetch article body for a single URL.
 * Tries direct fetch first; falls back to Firecrawl for bot-blocked domains
 * when `useFirecrawl` is true.
 */
async function fetchArticleBody(url, { useFirecrawl = false } = {}) {
  if (!url || SKIP_URL_RE.test(url)) return null;
  const direct = await fetchDirect(url);
  if (direct?.text) return direct.text;
  if (useFirecrawl && isBotBlocked(url)) return fetchWithFirecrawl(url);
  return null;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * For each cluster, attempt to populate `articleExcerpt` using the
 * source-iteration quality gate described at the top of this file.
 *
 * Mutates clusters in place:
 *   - On success: sets `articleExcerpt` and (if previously unset) `_learnMoreUrl`.
 *   - On total failure: leaves `articleExcerpt` undefined. The caller is
 *     expected to drop such clusters from the digest.
 */
export async function enrichWithArticleContent(clusters, { concurrency = 8, useFirecrawl = false } = {}) {
  if (useFirecrawl) {
    const hasKey = !!process.env.FIRECRAWL_API_KEY;
    console.log(`[enricher] Enriching ${clusters.length} clusters (Firecrawl ${hasKey ? 'ENABLED' : 'DISABLED — key missing'})`);
  }

  for (let i = 0; i < clusters.length; i += concurrency) {
    const batch = clusters.slice(i, i + concurrency);
    await Promise.all(batch.map(async c => {
      if (c.articleExcerpt) return;

      // Ensure _learnMoreUrl is set (UI needs this even if enrichment fails)
      const learnUrls = rankLearnMoreUrls(c);
      if (learnUrls.length && !c._learnMoreUrl) c._learnMoreUrl = learnUrls[0];

      const sorted = prioritiseMembers(c.members ?? []);

      // ── Pass 1: try each member's RSS description ───────────────────────
      for (const m of sorted) {
        if (!m.description) continue;
        const cleaned = sanitiseExtract(m.description);
        const gated   = passesQualityGate(cleaned, c.headline);
        if (gated) {
          c.articleExcerpt = gated;
          if (m.articleUrl && !m.isPaywalled) c._learnMoreUrl = m.articleUrl;
          return;
        }
      }

      // ── Pass 2: fetch article bodies in priority order ──────────────────
      for (const m of sorted) {
        if (!m.articleUrl || m.isPaywalled) continue;
        const body = await fetchArticleBody(m.articleUrl, { useFirecrawl });
        if (!body) continue;
        const cleaned = sanitiseExtract(body);
        const gated   = passesQualityGate(cleaned, c.headline);
        if (gated) {
          c.articleExcerpt = gated;
          c._learnMoreUrl  = m.articleUrl;
          return;
        }
      }

      // Both passes failed — articleExcerpt stays undefined; caller drops this cluster.
      console.log(`[enricher] no substantive content found for "${c.headline?.slice(0, 80)}"`);
    }));
  }
}
