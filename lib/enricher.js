// ── lib/enricher.js ───────────────────────────────────────────────────────────
// Shared article-enrichment module used by both Pipeline 1 (scraper) and
// Pipeline 2 (digest fallback).
//
// Uses createRequire to load CJS packages (@mozilla/readability, linkedom)
// to avoid esbuild bundling issues when this shared lib is imported by
// multiple API functions simultaneously.

import { createRequire } from 'module';
const _require    = createRequire(import.meta.url);
const Readability = _require('@mozilla/readability');
const { parseHTML } = _require('linkedom');

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function extractTextFromHtml(html, maxChars = 1500) {
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
    return sanitiseExtract(md).slice(0, 1500);
  } catch (e) {
    console.warn(`[enricher] Firecrawl error for ${url}:`, e.message);
    return null;
  }
}

async function fetchArticleExcerpt(url, useFirecrawl = false) {
  if (!url || SKIP_URL_RE.test(url)) return null;
  const result = await fetchDirect(url);
  if (result?.text) return result.text;
  if (useFirecrawl && isBotBlocked(url)) return fetchWithFirecrawl(url);
  return null;
}

async function searchGuardianForExcerpt(headline) {
  const key = process.env.GUARDIAN_API_KEY;
  if (!key) return null;
  try {
    const q = encodeURIComponent(headline.replace(/['"]/g, '').slice(0, 120));
    const res = await fetch(
      `https://content.guardianapis.com/search?q=${q}&show-fields=bodyText&page-size=1&api-key=${key}`,
      { signal: AbortSignal.timeout(5_000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const body = data.response?.results?.[0]?.fields?.bodyText;
    if (!body) return null;
    return body.replace(/\s+/g, ' ').trim().slice(0, 1500);
  } catch { return null; }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function enrichWithArticleContent(clusters, { concurrency = 8, useFirecrawl = false } = {}) {
  if (useFirecrawl) {
    const hasKey = !!process.env.FIRECRAWL_API_KEY;
    console.log(`[enricher] Enriching ${clusters.length} clusters (Firecrawl ${hasKey ? 'ENABLED' : 'DISABLED — key missing'})`);
  }

  for (let i = 0; i < clusters.length; i += concurrency) {
    const batch = clusters.slice(i, i + concurrency);
    await Promise.all(batch.map(async c => {
      if (c.articleExcerpt) return;

      const urls = rankLearnMoreUrls(c);
      if (!urls.length) return;
      c._learnMoreUrl = urls[0];

      const memberWithDesc = (c.members ?? []).find(m => m.description);
      if (memberWithDesc) {
        const s = sanitiseExtract(memberWithDesc.description).slice(0, 1500);
        if (s.length > 80) { c.articleExcerpt = s; return; }
      }

      const normalUrls  = urls.filter(u => !isBotBlocked(u));
      const blockedUrls = urls.filter(u => isBotBlocked(u));

      for (const url of normalUrls) {
        const excerpt = await fetchArticleExcerpt(url, false);
        if (excerpt) { c.articleExcerpt = excerpt; return; }
      }

      const guardianExcerpt = await searchGuardianForExcerpt(c.headline);
      if (guardianExcerpt) { c.articleExcerpt = guardianExcerpt; return; }

      if (useFirecrawl && blockedUrls.length > 0) {
        for (const url of blockedUrls) {
          const excerpt = await fetchWithFirecrawl(url);
          if (excerpt) { c.articleExcerpt = excerpt; return; }
        }
      }
    }));
  }
}
