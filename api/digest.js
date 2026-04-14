// ── api/digest.js ─────────────────────────────────────────────────────────────
// Function 2 of the two-function pipeline.
import { get as redisGet, set as redisSet, del as redisDel } from '../lib/redis.js';
import { Readability } from '@mozilla/readability';
import { parseHTML }   from 'linkedom';

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
import { editorialFilter, summarizeClusters, translateHeadlines } from '../lib/llm.js';
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const LEARN_MORE_PRIORITY = [
  'ap', 'reuters', 'bbc', 'guardian', 'rthk', 'hkfp', 'thestandard', 'scmp',
  'cnbc', 'cnn', 'aljazeera', 'dw', 'france24', 'nbcnews', 'cbsnews',
  'foxnews', 'foxbusiness',
];

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

function pickLearnMoreUrl(c) { return rankLearnMoreUrls(c)[0] ?? null; }

const CLOSED_BLOG_RE = /^this (?:live )?blog (?:has now closed|is now closed|has closed|is closed)\b/i;

function sanitiseExtract(text) {
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

function extractTextFromHtml(html, url = '', maxChars = 1500) {
  try {
    const { document } = parseHTML(html);
    const reader  = new Readability(document);
    const article = reader.parse();
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
    const text = pm[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length > 40) paragraphs.push(text);
  }
  if (paragraphs.length > 0) return sanitiseExtract(paragraphs.join(' ')).slice(0, maxChars);
  return sanitiseExtract(
    cleaned.replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim()
  ).slice(0, maxChars);
}

const SKIP_URL_RE = /\/(live[-\/]|live-updates|live-blog|liveblog)|\/video(s)?\/|\/(watch)\/|\/photo-gallery\//i;

async function fetchArticleExcerpt(url) {
  if (!url) return null;
  if (SKIP_URL_RE.test(url)) return null;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DailyPulse/1.0; +https://daily-pulse-theta.vercel.app)',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const text = extractTextFromHtml(html, url);
    if (CLOSED_BLOG_RE.test(text)) return null;
    return text.length > 80 ? text : null;
  } catch { return null; }
}

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
  } catch { return null; }
}

async function enrichWithArticleContent(clusters, concurrency = 8) {
  for (let i = 0; i < clusters.length; i += concurrency) {
    const batch = clusters.slice(i, i + concurrency);
    await Promise.all(batch.map(async c => {
      const urls = rankLearnMoreUrls(c);
      if (!urls.length) return;
      c._learnMoreUrl = urls[0];

      // Use pre-fetched description if available (TVB Pearl / TVB API items)
      const memberWithDesc = (c.members ?? []).find(m => m.description);
      if (memberWithDesc) {
        const sanitised = sanitiseExtract(memberWithDesc.description).slice(0, 1500);
        if (sanitised.length > 80) { c.articleExcerpt = sanitised; return; }
      }

      // Try each free member URL in priority order — accept any non-empty text.
      // Gemini judges relevance in summarizeClusters so no regex gate needed here.
      for (const url of urls) {
        const excerpt = await fetchArticleExcerpt(url);
        if (excerpt) { c.articleExcerpt = excerpt; break; }
      }

      // Guardian API fallback when all direct URLs time out or bot-block.
      if (!c.articleExcerpt) {
        const guardianExcerpt = await searchGuardianForExcerpt(c.headline);
        if (guardianExcerpt) c.articleExcerpt = guardianExcerpt;
      }
    }));
  }
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

async function runInlineScrape() {
  console.log('[digest] Running inline scrape (no pre-warmed data)');
  const adapterResults = await runAllAdapters();
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
  const clusters   = buildClusters(enrichedFinal);
  const payload = {
    scrapedAt:     new Date().toISOString(),
    international: scoreClusters(clusters, 'international'),
    local:         scoreClusters(clusters, 'local'),
    adapterMeta:   adapterResults.map(r => ({
      sourceId: r.sourceId, scrapeConfidence: r.scrapeConfidence,
      itemCount: (r.items ?? []).length, warnings: r.warnings ?? [],
    })),
  };
  await redisSet('scraped:rolling', payload, SCRAPED_TTL).catch(() => {});
  return payload;
}

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

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const reqUrl = new URL(req.url, `https://${req.headers.host}`);
  if (reqUrl.searchParams.get('reset') === 'true') {
    await Promise.all([
      redisDel('digest:rolling').catch(() => {}),
      redisDel('scraped:rolling').catch(() => {}),
    ]);
    return res.status(200).json({ ok: true, message: 'Cache cleared. Next request will regenerate the digest.' });
  }

  const t0 = Date.now();
  console.log('[digest] Request for rolling digest');

  try {
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

    let scraped = await redisGet('scraped:rolling');
    if (!scraped) scraped = await runInlineScrape();

    const allClusters = [...(scraped.international ?? []), ...(scraped.local ?? [])];
    console.log(`[digest] ${allClusters.length} cluster(s) before editorial filter`);

    const editFiltered = await editorialFilter(allClusters);

    const nowMs = Date.now();
    const filtered = editFiltered.filter(c => {
      const dated = (c.members ?? []).filter(m => m.publishedAt && !isNaN(new Date(m.publishedAt).getTime()));
      if (!dated.length) return true;
      return (nowMs - Math.max(...dated.map(m => new Date(m.publishedAt).getTime()))) <= STALE_WINDOW_MS;
    });
    console.log(`[digest] ${filtered.length} cluster(s) after editorial + staleness filter`);

    let filteredIntl  = filtered.filter(c => c.bucket === 'international');
    let filteredLocal = filtered.filter(c => c.bucket === 'local');

    const staleFilter = arr => arr.filter(c => {
      const dated = (c.members ?? []).filter(m => m.publishedAt && !isNaN(new Date(m.publishedAt).getTime()));
      return !dated.length || (nowMs - Math.max(...dated.map(m => new Date(m.publishedAt).getTime()))) <= STALE_WINDOW_MS;
    });

    if (filteredIntl.length === 0 && (scraped.international ?? []).length > 0) {
      console.warn('[digest] filteredIntl empty — using raw scraped international');
      filteredIntl = staleFilter(scraped.international ?? []);
    }
    if (filteredLocal.length === 0 && (scraped.local ?? []).length > 0) {
      console.warn('[digest] filteredLocal empty — using raw scraped local');
      filteredLocal = staleFilter(scraped.local ?? []);
    }

    const toEnrich = [...new Map([...filteredIntl, ...filteredLocal].map(c => [c.id, c])).values()];
    console.log('[digest] Fetching article excerpts…');
    await enrichWithArticleContent(toEnrich);

    const HEADLINE_SKIP = [
      /\?$/, /^(analysis|opinion|comment|explainer|review|interview)[:\s]/i,
      /^live:/i, /\blive:/i,
      /^(morning|evening|daily|weekly)\s+(recap|digest|briefing|roundup|update|summary)/i,
      /^recap\b/i, /^(your|the)\s+(daily|morning|evening)\s+(news|digest|briefing|summary)/i,
      /^the latest news from\b/i,
    ];
    const NON_HK_SPORTS_LOCAL = [
      /\b(Premier League|FA Cup|Champions League|UEFA|Europa League|La Liga|Serie A|Bundesliga|Ligue 1)\b/i,
      /\b(NFL|NBA|MLB|NHL|MLS|ATP|WTA|Grand Slam|Wimbledon|Roland Garros|US Open|Australian Open)\b/i,
      /\b(Man\s*United|Man\s*City|Arsenal|Chelsea|Liverpool|Tottenham|Leicester|Everton|Aston\s*Villa)\b/i,
      /\bFox Business\b/i, /\b(Wall Street|Main Street)\b.*\bon\s+\w/i,
    ];
    const noQuestions      = arr => arr.filter(c => !HEADLINE_SKIP.some(p => p.test(c.headline.trim())));
    const noQuestionsLocal = arr => arr.filter(c => {
      const h = c.headline.trim();
      return !HEADLINE_SKIP.some(p => p.test(h)) && !NON_HK_SPORTS_LOCAL.some(p => p.test(h));
    });

    const byScore = arr => [...arr].sort((a, b) => (b.baseScore || 0) - (a.baseScore || 0));

    const intlResults    = await summarizeClusters(filteredIntl);
    const summarisedIntl = byScore(deduplicateByHeadline(noQuestions(intlResults)));
    const finalIntl      = summarisedIntl.slice(0, STORY_COUNTS.intl);
    sse({ type: 'section', section: 'international', stories: formatStories(finalIntl) });

    const localResults    = await summarizeClusters(filteredLocal);
    const summarisedLocal = byScore(deduplicateByHeadline(noQuestionsLocal(localResults)));
    const finalLocal      = summarisedLocal.slice(0, STORY_COUNTS.local);
    sse({ type: 'section', section: 'local', stories: formatStories(finalLocal) });
    console.log(`[digest] Done in ${Date.now() - t0}ms — ${finalIntl.length} intl, ${finalLocal.length} local`);

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
