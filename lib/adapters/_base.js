// ── Base adapter utilities ────────────────────────────────────────────────────────────────────
// Shared fetch + cheerio parse logic used by every source adapter.
// Individual adapters import from here and supply their source config.

import * as cheerio from 'cheerio';

const DEFAULT_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control':   'no-cache',
};

function decodeEntities(text) {
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

function looksLikeCode(text) {
  if (/^function\s+\w+\s*\(/.test(text))           return true;
  if (/\bconst\s+\w+\s*=/.test(text))              return true;
  if (/[{}]{2,}/.test(text))                        return true;
  if (text.length > 250 && /[{}();]/.test(text))    return true;
  return false;
}

function looksLikeCaption(text) {
  if (/^[•·▶►»]\s/.test(text))                     return true;
  if (/\b(Getty Images|Reuters|AP Photo|AFP)\b/.test(text)) return true;
  if (/\bFile\s*(photo|image)?\s*$/.test(text))     return true;
  return false;
}

export async function fetchHtml(url, timeoutMs = 8000) {
  try {
    const res = await fetch(url, {
      headers: DEFAULT_HEADERS,
      redirect: 'follow',
      signal:  AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`[adapter] HTTP ${res.status} for ${url}`);
      return null;
    }
    return res.text();
  } catch (err) {
    console.warn(`[adapter] fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

export function extractNextData(html) {
  try {
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>({[\s\S]*?})<\/script>/);
    if (match) return JSON.parse(match[1]);
  } catch { /* ignore */ }
  return null;
}

export function extractJsonLd(html) {
  const results = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { results.push(JSON.parse(m[1])); } catch { /* ignore malformed */ }
  }
  return results;
}

function parseRssPubDate(block) {
  const m = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function fetchRssItems(rssUrl, maxItems = 10) {
  if (!rssUrl) return [];
  try {
    const res = await fetch(rssUrl, {
      headers: { 'User-Agent': 'DailyPulse/2.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = [];
    const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let m;
    while ((m = itemRe.exec(xml)) !== null && items.length < maxItems) {
      const block = m[1];
      const titleM = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
      const linkM  = block.match(/<link[^>]*>(?:<!\[CDATA\[)?(https?:\/\/[^\]<]+?)(?:\]\]>)?<\/link>/i) ||
                     block.match(/<link[^>]+href="([^"]+)"/) ||
                     block.match(/<guid[^>]*isPermaLink="true">([^<]+)<\/guid>/);
      if (!titleM || !linkM) continue;
      const title = decodeEntities(titleM[1]);
      if (!title || title.length < 12) continue;
      items.push({
        rank:        items.length + 1,
        title,
        articleUrl:  linkM[1].trim(),
        publishedAt: parseRssPubDate(block),
      });
    }
    return items;
  } catch (err) {
    console.warn(`[adapter] RSS fetch failed for ${rssUrl}: ${err.message}`);
    return [];
  }
}

export function scrapeEditorialRail($, source) {
  const items = [];
  const seen  = new Set();

  for (const containerSel of source.containers) {
    const $root = $(containerSel);
    if ($root.length === 0) continue;

    const $clone = $root.clone();
    $clone.find('script, style, noscript').remove();
    (source.excludeSelectors || []).forEach(sel => $clone.find(sel).remove());

    const combined = (source.itemSelectors || []).join(', ');
    $clone.find(combined).each((_i, el) => {
      const $el  = $(el);

      let title, href;

      if (el.tagName?.toLowerCase() === 'a') {
        const textContent = $el.text().replace(/\s+/g, ' ').trim();
        const titleAttr   = ($el.attr('title') || '').replace(/\s+/g, ' ').trim();
        title = titleAttr.length > textContent.length ? titleAttr : textContent;
        href  = $el.attr('href');
      } else {
        title = $el.text().replace(/\s+/g, ' ').trim();
        const $anc = $el.closest('a');
        href  = $anc.length ? $anc.attr('href') : null;
      }

      if (!title || title.length < 12)          return;
      if (title.length > 250)                    return;
      if (looksLikeCode(title))                  return;
      if (looksLikeCaption(title))               return;
      if (seen.has(title.toLowerCase()))         return;

      let articleUrl = null;
      if (href) {
        articleUrl = href.startsWith('http')
          ? href
          : new URL(href, source.entryUrl).href;
      }

      seen.add(title.toLowerCase());
      items.push({ rank: items.length + 1, title, articleUrl });
    });

    if (items.length >= 3) break;
  }

  return items.slice(0, source.maxRank || 10);
}

async function fetchSitemapItems(sitemapUrl, options = {}) {
  const {
    includeUrlPatterns = [],
    excludeUrlPatterns = [],
    maxItems = 10,
  } = options;

  if (!sitemapUrl) return [];

  try {
    const res = await fetch(sitemapUrl, {
      headers: { 'User-Agent': 'DailyPulse/2.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const xml = await res.text();

    const raw = [];
    const urlRe = /<url[^>]*>([\s\S]*?)<\/url>/gi;
    let m;
    while ((m = urlRe.exec(xml)) !== null) {
      const block = m[1];

      const locM = block.match(/<loc[^>]*>([\s\S]*?)<\/loc>/i);
      if (!locM) continue;
      const articleUrl = locM[1].trim();

      if (includeUrlPatterns.length > 0) {
        if (!includeUrlPatterns.some(p => articleUrl.includes(p))) continue;
      }
      if (excludeUrlPatterns.some(p => articleUrl.includes(p))) continue;

      const titleM = block.match(/<news:title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/news:title>/i);
      if (!titleM) continue;
      const title = decodeEntities(titleM[1]);
      if (!title || title.length < 4) continue;

      const dateM = block.match(/<news:publication_date[^>]*>([\s\S]*?)<\/news:publication_date>/i);
      const publishedAt = dateM ? (() => {
        const d = new Date(dateM[1].trim());
        return isNaN(d.getTime()) ? null : d.toISOString();
      })() : null;

      raw.push({ title, articleUrl, publishedAt });
    }

    raw.sort((a, b) => {
      if (!a.publishedAt && !b.publishedAt) return 0;
      if (!a.publishedAt) return 1;
      if (!b.publishedAt) return -1;
      return b.publishedAt.localeCompare(a.publishedAt);
    });

    return raw.slice(0, maxItems).map((item, i) => ({
      rank: i + 1,
      ...item,
    }));
  } catch (err) {
    console.warn(`[adapter] sitemap fetch failed for ${sitemapUrl}: ${err.message}`);
    return [];
  }
}

export async function runSitemapAdapter(source) {
  const items = await fetchSitemapItems(source.sitemapUrl, {
    includeUrlPatterns: source.includeUrlPatterns || [],
    excludeUrlPatterns: source.excludeUrlPatterns || [],
    maxItems: source.maxRank || 10,
  });

  if (items.length > 0) {
    return {
      sourceId:          source.id,
      presenceConfirmed: true,
      rankConfirmed:     items.length >= 3,
      rankMethod:        'sitemap',
      items,
      scrapeConfidence:  items.length >= 3 ? 'high' : 'medium',
      error:             null,
    };
  }

  console.log(`[adapter] ${source.id}: sitemap returned 0 items, trying DOM fallback`);
  return runDomAdapter(source);
}

export async function runDomAdapter(source) {
  if (source.skipDom && source.rssUrl) {
    const rssItems = await fetchRssItems(source.rssUrl, source.maxRank || 10);
    if (rssItems.length > 0) {
      return {
        sourceId: source.id, presenceConfirmed: true,
        rankConfirmed: rssItems.length >= 3, rankMethod: 'rss',
        items: rssItems,
        scrapeConfidence: rssItems.length >= 3 ? 'high' : 'medium', error: null,
      };
    }
    return {
      sourceId: source.id, presenceConfirmed: false,
      rankConfirmed: false, rankMethod: 'rss',
      items: [], scrapeConfidence: 'none', error: 'rss-returned-empty',
    };
  }

  if (source.rssFirst && source.rssUrl) {
    const rssItems = await fetchRssItems(source.rssUrl, source.maxRank || 10);
    if (rssItems.length > 0) {
      return {
        sourceId:          source.id,
        presenceConfirmed: true,
        rankConfirmed:     rssItems.length >= 3,
        rankMethod:        'rss',
        items:             rssItems,
        scrapeConfidence:  rssItems.length >= 3 ? 'high' : 'medium',
        error:             null,
      };
    }
    console.log(`[adapter] ${source.id}: RSS returned 0 items, falling through to DOM`);
  }

  const html = await fetchHtml(source.entryUrl);

  if (!html) {
    if (source.rssUrl) {
      console.log(`[adapter] ${source.id}: DOM failed, trying RSS fallback`);
      const rssItems = await fetchRssItems(source.rssUrl, source.maxRank || 10);
      if (rssItems.length > 0) {
        return {
          sourceId:          source.id,
          presenceConfirmed: true,
          rankConfirmed:     rssItems.length >= 3,
          rankMethod:        'rss-fallback',
          items:             rssItems,
          scrapeConfidence:  rssItems.length >= 3 ? 'medium' : 'low',
          error:             'dom-blocked-rss-fallback',
        };
      }
    }
    return {
      sourceId:          source.id,
      presenceConfirmed: false,
      rankConfirmed:     false,
      rankMethod:        'dom-fetch-failed',
      items:             [],
      scrapeConfidence:  'none',
      error:             'fetch failed or timed out',
    };
  }

  const $ = cheerio.load(html);
  const items = scrapeEditorialRail($, source);

  if (items.length === 0 && source.rssUrl) {
    console.log(`[adapter] ${source.id}: DOM returned 0 items, trying RSS fallback`);
    const rssItems = await fetchRssItems(source.rssUrl, source.maxRank || 10);
    if (rssItems.length > 0) {
      return {
        sourceId:          source.id,
        presenceConfirmed: true,
        rankConfirmed:     rssItems.length >= 3,
        rankMethod:        'rss-fallback',
        items:             rssItems,
        scrapeConfidence:  rssItems.length >= 3 ? 'medium' : 'low',
        error:             'dom-selectors-matched-nothing',
        rawHtml:           html,
      };
    }
  }

  const presenceConfirmed = items.length > 0;
  const rankConfirmed     = items.length >= 3;

  return {
    sourceId:          source.id,
    presenceConfirmed,
    rankConfirmed,
    rankMethod:        'dom',
    items,
    scrapeConfidence:  rankConfirmed ? 'high' : presenceConfirmed ? 'medium' : 'low',
    error:             null,
    rawHtml:           html,
  };
}
