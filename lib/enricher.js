// lib/enricher.js
// Shared article-enrichment module used by both Pipeline 1 (scraper) and
// Pipeline 2 (digest fallback).

import { createRequire } from 'module';
const _require    = createRequire(import.meta.url);
const Readability = _require('@mozilla/readability');
const { parseHTML } = _require('linkedom');

// Source priority
const PRIORITY_TIER_1 = ['ap', 'reuters'];
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

function prioritiseMembers(members) {
  return [...(members ?? [])
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ta = sourceTier(a.m.sourceId);
      const tb = sourceTier(b.m.sourceId);
      if (ta !== tb) return ta - tb;
      return a.i - b.i;
    })
    .map(x => x.m)];
}

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

const NAV_LABEL_RE =
  /\b(?:Menu|Homepage|Home Page|Latest News|News Archive|News Bulletins|Photo Gallery|Video Gallery|News Programmes|Send To|Live Video|Subscribe|Newsletter Sign|Cookie Policy|Privacy Policy|Terms of Service|Accessibility|Skip to content)\b/gi;

export function looksLikeNavJunk(text) {
  if (!text) return false;
  const arrowCount = (text.match(/-->/g) || []).length;
  if (arrowCount >= 3) return true;
  if (/\bA\s+A\s+A\b/.test(text)) return true;
  if (/繁\s*简\s*Eng/i.test(text)) return true;
  const navMatches = text.match(NAV_LABEL_RE) || [];
  const distinctNav = new Set(navMatches.map(s => s.toLowerCase()));
  if (distinctNav.size >= 3) return true;
  if (/(\b\d{1,4}\b[ \t]+){8,}\b\d{1,4}\b/.test(text)) return true;
  const words = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length >= 40) {
    const counts = new Map();
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
    for (const [w, n] of counts) {
      if (w.length >= 3 && n / words.length > 0.15) return true;
    }
  }
  return false;
}

function gateTokens(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !GATE_STOPWORDS.has(w));
}

export function passesQualityGate(text, headline) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (STUB_PATTERNS.some(p => p.test(trimmed))) return null;
  if (looksLikeNavJunk(trimmed)) return null;

  const words = trimmed.split(/\s+/);
  if (words.length < 30) return null;

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

  if (words.length > 600) return words.slice(0, 600).join(' ');
  return trimmed;
}

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
    console.warn('[enricher] Firecrawl skipped -- FIRECRAWL_API_KEY not set');
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

async function fetchArticleBody(url, { useFirecrawl = false } = {}) {
  if (!url || SKIP_URL_RE.test(url)) return null;
  const direct = await fetchDirect(url);
  if (direct?.text) return direct.text;
  if (useFirecrawl && isBotBlocked(url)) return fetchWithFirecrawl(url);
  return null;
}

export async function enrichWithArticleContent(clusters, { concurrency = 8, useFirecrawl = false } = {}) {
  if (useFirecrawl) {
    const hasKey = !!process.env.FIRECRAWL_API_KEY;
    console.log(`[enricher] Enriching ${clusters.length} clusters (Firecrawl ${hasKey ? 'ENABLED' : 'DISABLED'})`);
  }

  for (let i = 0; i < clusters.length; i += concurrency) {
    const batch = clusters.slice(i, i + concurrency);
    await Promise.all(batch.map(async c => {
      if (c.articleExcerpt || (Array.isArray(c.articleExcerpts) && c.articleExcerpts.length)) return;

      const learnUrls = rankLearnMoreUrls(c);
      if (learnUrls.length && !c._learnMoreUrl) c._learnMoreUrl = learnUrls[0];

      const sorted = prioritiseMembers(c.members ?? []);

      const excerpts = [];
      let firstPasserMember = null;
      for (const m of sorted) {
        if (!m.description) continue;
        const cleaned = sanitiseExtract(m.description);
        const gated   = passesQualityGate(cleaned, c.headline);
        if (!gated) continue;
        excerpts.push(gated);
        if (!firstPasserMember) firstPasserMember = m;
        if (excerpts.length >= 3) break;
      }

      if (excerpts.length) {
        c.articleExcerpts = excerpts;
        c.articleExcerpt  = excerpts[0];
        if (firstPasserMember?.articleUrl && !firstPasserMember.isPaywalled) {
          c._learnMoreUrl = firstPasserMember.articleUrl;
        }
        return;
      }

      const fetched = [];
      let firstFetchMember = null;
      for (const m of sorted) {
        if (!m.articleUrl || m.isPaywalled) continue;
        const body = await fetchArticleBody(m.articleUrl, { useFirecrawl });
        if (!body) continue;
        const cleaned = sanitiseExtract(body);
        const gated   = passesQualityGate(cleaned, c.headline);
        if (!gated) continue;
        fetched.push(gated);
        if (!firstFetchMember) firstFetchMember = m;
        if (fetched.length >= 3) break;
      }

      if (fetched.length) {
        c.articleExcerpts = fetched;
        c.articleExcerpt  = fetched[0];
        c._learnMoreUrl   = firstFetchMember.articleUrl;
        return;
      }

      console.log(`[enricher] no substantive content found for "${c.headline?.slice(0, 80)}"`);
    }));
  }
}