// ── lib/enricher.js ───────────────────────────────────────────────────────────
// Shared article-enrichment module used by both Pipeline 1 (scraper) and
// Pipeline 2 (digest fallback).
//
// enrichWithArticleContent() now collects up to 5 substantive article bodies
// per cluster (one per source), sorted longest-first into c.articleExcerpts[].
//
// Phase 1 minimum word counts:
//   AP, RTHK, TVB Pearl, TVB News, Sky News, CBC News → 60 words
//   All others → 120 words
//
// Sky News: React SPA — Phase 2 (direct HTML fetch) is skipped entirely.
//   RSS description (Phase 1) is the only content source.
// CBC News: Next.js SSR — Phase 2 (direct HTML fetch) works cleanly.
//
// Guardian API (Phase 3): international only — produces false positives for HK.

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
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/-->/g, '')
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
    .replace(/\bApps?\s+A\s+A\s+A\b[^\n]*/gi, '')
    .replace(/\bskip\s+to\s+(?:main\s+)?(?:content|menu|navigation|more\s+\S+\s+sites?)[^.\n]*/gi, '')
    .replace(/^(?:in\s+focus|latest\s+audio|latest\s+videos?|live\s+tv|advertisement)[^.\n]*/gim, '')
    .replace(/\b\d+\s*[-\u2013]?\s*min\s+(?:read|listen)\b[^.\n]*/gi, '')
    .replace(/\blisten\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3}\s+published:/gi, 'Published:')
    .replace(/published:\s+\d+:\d+[ap]m,\s+\d+\s+\w+\s+\d{4}[^.\n]*/gi, '')
    .replace(/updated:\s+\d+:\d+[ap]m,\s+\d+\s+\w+\s+\d{4}[^.\n]*/gi, '')
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

// ── Source-priority ordering ──────────────────────────────────────────────────

const TIER1_SOURCE_PATTERNS = ['ap', 'apnews', 'reuters'];
const TIER2_SOURCE_PATTERNS = [
  'bbc', 'guardian', 'aljazeera', 'al-jazeera', 'nbcnews', 'nbc-news',
  'cbsnews', 'cbs-news', 'abcnews', 'abc-news', 'nytimes', 'nyt',
  'wsj', 'bloomberg', 'ft.com', 'financialtimes', 'financial-times',
];

function sourceTier(sourceId) {
  const id = (sourceId || '').toLowerCase();
  if (TIER1_SOURCE_PATTERNS.some(s => id.includes(s))) return 0;
  if (TIER2_SOURCE_PATTERNS.some(s => id.includes(s))) return 1;
  return 2;
}

function membersInPriorityOrder(members) {
  return [...(members || [])].sort((a, b) => sourceTier(a.sourceId) - sourceTier(b.sourceId));
}

function trimToWords(text, max = 600) {
  const words = text.trim().split(/\s+/);
  return words.length <= max ? text.trim() : words.slice(0, max).join(' ') + '…';
}

export async function pickSubstantiveExcerpt(cluster) {
  const headline = cluster.headline || '';
  const sorted   = membersInPriorityOrder(cluster.members);

  for (const m of sorted) {
    if (!m.description) continue;
    const cleaned = sanitiseExtract(m.description).replace(/\s+/g, ' ').trim();
    if (cleaned.trim().split(/\s+/).length >= 30) return trimToWords(cleaned);
  }
  for (const m of sorted) {
    if (!m.articleUrl || SKIP_URL_RE.test(m.articleUrl)) continue;
    if (isBotBlocked(m.articleUrl)) {
      const fc = await fetchWithFirecrawl(m.articleUrl);
      if (fc && fc.trim().split(/\s+/).length >= 30) return trimToWords(fc);
    } else {
      const result = await fetchDirect(m.articleUrl);
      if (result?.text && result.text.trim().split(/\s+/).length >= 30) return trimToWords(result.text);
    }
  }
  const ga = await searchGuardianForExcerpt(headline);
  if (ga && ga.trim().split(/\s+/).length >= 30) return trimToWords(ga);
  return null;
}

export async function enrichAndFilterClusters(clusters, { concurrency = 4 } = {}) {
  const excerptMap = new Map();
  for (let i = 0; i < clusters.length; i += concurrency) {
    await Promise.all(
      clusters.slice(i, i + concurrency).map(async c => {
        excerptMap.set(c.id, await pickSubstantiveExcerpt(c));
      })
    );
  }
  const kept = [];
  for (const c of clusters) {
    const excerpt = excerptMap.get(c.id);
    if (excerpt) {
      c.articleExcerpt = excerpt;
      kept.push(c);
    } else {
      console.log(`[enricher] Dropping story "${(c.headline || '').slice(0, 60)}" — no substantive content`);
    }
  }
  return kept;
}

// ── Main export ───────────────────────────────────────────────────────────────

const MIN_ARTICLE_WORDS = 120;
const wc = text => (text ? text.trim().split(/\s+/).length : 0);

const JUNK_RE = /\bread\s+more\b|\bsubscribe\s+(to\s+continue|for\s+(full\s+)?access)\b|\bclick\s+here\b|\bsign\s+up\b|\bto\s+continue\s+reading\b|\bto\s+read\s+the\s+full\b|\baccess\s+this\s+article\b|\bcookie\s+(notice|consent)\b|\bcaptcha\b|\bpaywall\b|\brecurring\s+donors?\b|\bunlock\s+(?:\d+\s+)?(?:all\s+)?(?:member(?:ship)?\s+)?benefits?\b|\bmake\s+a\s+donation\b|\bdonate\s+to\s+(?:our|the)\s+newsroom\b|\bbecome\s+a\s+(?:member|supporter|donor)\b|\bannual(?:\/| )transparency\s+report\b/i;

function looksLikeProse(text) {
  const t = text.trim();
  if (!t) return false;
  if (/^\S*\.[a-z]{2,}\/\S*/i.test(t)) return false;
  if (/^[a-z]/.test(t)) return false;
  if (/^(By\s+[A-Z]|Published\s+On\b|Published:\s*\d|Updated\s*:|Advertisement\b|Sponsored\b)/i.test(t)) return false;
  return true;
}

export async function enrichWithArticleContent(clusters, { concurrency = 8, useFirecrawl = false } = {}) {
  for (let i = 0; i < clusters.length; i += concurrency) {
    const batch = clusters.slice(i, i + concurrency);
    await Promise.all(batch.map(async c => {
      if (c.articleExcerpts?.length) return;

      const urls = rankLearnMoreUrls(c);
      if (urls.length) c._learnMoreUrl = urls[0];

      const excerpts    = [];
      const seenSources = new Set();
      const sorted = membersInPriorityOrder(c.members ?? []);

      for (const m of sorted) {
        if (excerpts.length >= 5) break;
        if (seenSources.has(m.sourceId)) continue;
        if (m.isPaywalled) continue;

        let text = null;

        // Phase 1: RSS / API description field
        // Sources with concise but authoritative copy use a lower 60-word threshold.
        if (m.description) {
          const cleaned = sanitiseExtract(m.description).replace(/\s+/g, ' ').trim();
          const minWords = (
            m.sourceId === 'ap' || m.sourceId === 'rthk' ||
            m.sourceId === 'tvbpearl' || m.sourceId === 'tvb' ||
            m.sourceId === 'skynews' || m.sourceId === 'cbcnews'
          ) ? 60 : MIN_ARTICLE_WORDS;
          if (wc(cleaned) >= minWords && !JUNK_RE.test(cleaned)) text = trimToWords(cleaned);
        }

        // Phase 2: source-specific best method for article body
        if (!text && m.articleUrl && !SKIP_URL_RE.test(m.articleUrl)) {

          if (m.articleUrl.includes('news.tvb.com')) {
            // TVB Pearl / TVB News: use inews-api by article ID
            const idMatch = m.articleUrl.match(/\/(\d+)\//);
            if (idMatch) {
              const lang = m.articleUrl.includes('/pearlnews') ? 'en' : 'tc';
              try {
                const tvbRes = await fetch(
                  `https://inews-api.tvb.com/news/entry/by-id?id=${idMatch[1]}&lang=${lang}`,
                  { headers: { 'Origin': 'https://news.tvb.com', 'Referer': 'https://news.tvb.com', 'User-Agent': 'DailyPulse/2.0' },
                    signal: AbortSignal.timeout(6_000) }
                );
                if (tvbRes.ok) {
                  const tvbData = await tvbRes.json();
                  const body = tvbData?.content?.desc || tvbData?.desc || null;
                  if (body && wc(body) >= 60) text = trimToWords(sanitiseExtract(body));
                }
              } catch { /* non-fatal */ }
            }

          } else if (isBotBlocked(m.articleUrl)) {
            // NBC News, CBS News, Fox News, Fox Business: Firecrawl only
            if (useFirecrawl) {
              const fc = await fetchWithFirecrawl(m.articleUrl);
              if (fc && wc(fc) >= MIN_ARTICLE_WORDS) text = trimToWords(fc);
            }

          } else if (m.sourceId === 'skynews') {
            // Sky News: React SPA — direct HTML fetch produces social widget garbage.
            // Phase 1 (RSS description) is the only content source; if it failed,
            // Sky News contributes no excerpt for this cluster.

          } else {
            // All other sources: standard direct HTML fetch + Readability
            const result = await fetchDirect(m.articleUrl);
            if (result?.text && wc(result.text) >= MIN_ARTICLE_WORDS && !JUNK_RE.test(result.text)) text = trimToWords(result.text);
          }
        }

        if (text && looksLikeProse(text)) {
          excerpts.push(text);
          seenSources.add(m.sourceId);
        }
      }

      // Phase 3: Guardian API — international only
      if (excerpts.length < 2 && !seenSources.has('guardian') && c.bucket === 'international') {
        const ga = await searchGuardianForExcerpt(c.headline);
        if (ga && wc(ga) >= MIN_ARTICLE_WORDS) {
          excerpts.push(ga);
          seenSources.add('guardian');
        }
      }

      excerpts.sort((a, b) => wc(b) - wc(a));
      c.articleExcerpts = excerpts;
    }));
  }
}
