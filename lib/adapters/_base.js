// ── Base adapter utilities ───────────────────────────────────────────────────
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

/**
 * Decode common HTML entities to plain text.
 * Used for RSS titles which frequently contain &amp;, &#39;, &quot; etc.
 */
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

/**
 * Return true if the text looks like a JS/CSS snippet rather than a headline.
 * Catches the pattern where sites embed <script> onerror handlers whose text
 * content bleeds into cheerio's .text() output.
 */
function looksLikeCode(text) {
  if (/^function\s+\w+\s*\(/.test(text))           return true; // JS function def
  if (/\bconst\s+\w+\s*=/.test(text))              return true; // const declaration
  if (/[{}]{2,}/.test(text))                        return true; // multiple braces
  if (text.length > 250 && /[{}();]/.test(text))    return true; // long + code chars
  return false;
}

/**
 * Return true if the text looks like a photo caption rather than a headline.
 * Matches "• CNN Exclusive", "Photo: Reuters", "AP Photo/Name" etc.
 */
function looksLikeCaption(text) {
  if (/^[•·▶►»]\s/.test(text))                     return true; // bullet prefix
  if (/\b(Getty Images|Reuters|AP Photo|AFP)\b/.test(text)) return true;
  if (/\bFile\s*(photo|image)?\s*$/.test(text))     return true;
  return false;
}

/**
 * Fetch a URL and return its HTML text.
 * Returns null on timeout or HTTP error.
 */
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

/**
 * Try to parse __NEXT_DATA__ from a page's HTML.
 * Returns the parsed object or null.
 */
export function extractNextData(html) {
  try {
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>({[\s\S]*?})<\/script>/);
    if (match) return JSON.parse(match[1]);
  } catch { /* ignore */ }
  return null;
}

/**
 * Extract inline JSON-LD blocks from HTML.
 * Returns an array of parsed objects.
 */
export function extractJsonLd(html) {
  const results = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { results.push(JSON.parse(m[1])); } catch { /* ignore malformed */ }
  }
  return results;
}

/**
 * Parse an RSS <pubDate> string into an ISO 8601 string.
 * RSS pubDate is typically RFC 2822 (e.g. "Mon, 12 Apr 2026 08:30:00 +0800").
 * Returns null if the date is invalid or missing.
 */
function parseRssPubDate(block) {
  const m = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Fetch an RSS feed and return items as { rank, title, articleUrl, publishedAt }.
 * Used as a fallback when DOM scraping is blocked (e.g. Reuters).
 * HTML entities in titles are decoded to plain text.
 * publishedAt is populated from <pubDate> when present (ISO 8601 string or null).
 */
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
      // Handle plain <link>URL</link> and CDATA-wrapped <link><![CDATA[URL]]></link>
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

/**
 * Core DOM scraper.  Given cheerio-loaded HTML and a source config,
 * returns an ordered array of { rank, title, articleUrl } items.
 *
 * Strategy:
 *   1. Try each container selector in order; stop at first that yields >= 3 items.
 *   2. Within the container, apply itemSelectors (joined as OR) to find elements.
 *   3. Remove excludeSelectors before scanning.
 *   4. Always strip <script>, <style>, <noscript> to prevent JS/CSS code from
 *      bleeding into .text() output (seen on CNN and similar JS-heavy pages).
 *
 * Handles both anchor and non-anchor selectors:
 *   - If the matched element IS an <a>: extract text + href directly.
 *   - If NOT an <a> (e.g. h2, h3): extract text from the element and
 *     traverse up to the nearest <a> ancestor for the href.
 *     This is needed for BBC which uses [data-testid="card-headline"] (H2)
 *     inside a wrapping <a data-testid="internal-link">.
 */
export function scrapeEditorialRail($, source) {
  const items = [];
  const seen  = new Set();

  for (const containerSel of source.containers) {
    const $root = $(containerSel);
    if ($root.length === 0) continue;

    const $clone = $root.clone();

    // Always remove script/style/noscript first — their text content is never
    // a headline and can corrupt title extraction on JS-heavy pages (e.g. CNN
    // embeds onerror handlers whose JS code bleeds into cheerio .text()).
    $clone.find('script, style, noscript').remove();

    (source.excludeSelectors || []).forEach(sel => $clone.find(sel).remove());

    const combined = (source.itemSelectors || []).join(', ');
    $clone.find(combined).each((_i, el) => {
      const $el  = $(el);

      let title, href;

      if (el.tagName?.toLowerCase() === 'a') {
        // Selector matched an anchor directly.
        // Prefer the title attribute when it's longer than the text content —
        // some Chinese sites (e.g. HKET) CSS-truncate the visible text but
        // put the full headline in the title attribute.
        const textContent = $el.text().replace(/\s+/g, ' ').trim();
        const titleAttr   = ($el.attr('title') || '').replace(/\s+/g, ' ').trim();
        title = titleAttr.length > textContent.length ? titleAttr : textContent;
        href  = $el.attr('href');
      } else {
        // Non-anchor element (e.g. h2, h3, div) — get clean text, find href from ancestor <a>
        title = $el.text().replace(/\s+/g, ' ').trim();
        const $anc = $el.closest('a');
        href  = $anc.length ? $anc.attr('href') : null;
      }

      if (!title || title.length < 12)          return; // too short
      if (title.length > 250)                    return; // too long (JS / meta text)
      if (looksLikeCode(title))                  return; // script content
      if (looksLikeCaption(title))               return; // photo caption
      if (seen.has(title.toLowerCase()))         return; // duplicate

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

/**
 * Fetch a Google News sitemap and return items as { rank, title, articleUrl, publishedAt }.
 *
 * Google News sitemaps use <news:title> and <news:publication_date> inside <url> blocks.
 * This parser:
 *   - Includes only URLs whose path matches at least one of includeUrlPatterns (if provided)
 *   - Excludes URLs whose path matches any of excludeUrlPatterns
 *   - Decodes HTML entities in titles
 *   - Sorts by publication_date descending (newest first) so rank = recency
 *
 * @param {string}   sitemapUrl
 * @param {object}   options
 * @param {string[]} options.includeUrlPatterns  - URL must contain at least one of these
 * @param {string[]} options.excludeUrlPatterns  - URL must not contain any of these
 * @param {number}   options.maxItems
 */
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

      // Extract <loc>
      const locM = block.match(/<loc[^>]*>([\s\S]*?)<\/loc>/i);
      if (!locM) continue;
      const articleUrl = locM[1].trim();

      // Apply include/exclude URL path filters
      if (includeUrlPatterns.length > 0) {
        if (!includeUrlPatterns.some(p => articleUrl.includes(p))) continue;
      }
      if (excludeUrlPatterns.some(p => articleUrl.includes(p))) continue;

      // Extract <news:title>
      const titleM = block.match(/<news:title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/news:title>/i);
      if (!titleM) continue;
      const title = decodeEntities(titleM[1]);
      if (!title || title.length < 4) continue;

      // Extract <news:publication_date> (ISO 8601 with offset, e.g. 2026-04-13T00:07:17+08:00)
      const dateM = block.match(/<news:publication_date[^>]*>([\s\S]*?)<\/news:publication_date>/i);
      const publishedAt = dateM ? (() => {
        const d = new Date(dateM[1].trim());
        return isNaN(d.getTime()) ? null : d.toISOString();
      })() : null;

      raw.push({ title, articleUrl, publishedAt });
    }

    // Sort newest-first (null dates go to the end)
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

/**
 * Adapter run for sources with a Google News sitemap instead of RSS or DOM.
 *
 * Uses source.sitemapUrl plus source.includeUrlPatterns / source.excludeUrlPatterns.
 * Falls back to DOM scraping if the sitemap yields nothing (e.g. temporary outage).
 */
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

  // Sitemap empty — try DOM fallback
  console.log(`[adapter] ${source.id}: sitemap returned 0 items, trying DOM fallback`);
  return runDomAdapter(source);
}

/**
 * Full adapter run:
 *   fetch HTML -> load cheerio -> scrapeEditorialRail -> return standardised result.
 *
 * Fetch order is controlled by two flags:
 *   skipDom:true  — skip DOM entirely, go straight to RSS (no DOM fallback).
 *   rssFirst:true — try RSS first; if RSS returns nothing, fall through to DOM.
 *                   Use this for sources where RSS is more reliable than DOM
 *                   but DOM is still worth trying as a fallback.
 *
 * If neither flag is set (default), DOM is tried first with RSS as fallback.
 *
 * Returns:
 * {
 *   sourceId, presenceConfirmed, rankConfirmed, rankMethod,
 *   items: [{ rank, title, articleUrl }],
 *   scrapeConfidence, error
 * }
 */
export async function runDomAdapter(source) {
  // Sources flagged skipDom:true always fail DOM scraping — go straight to RSS.
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

  // rssFirst: try RSS before DOM for sources where RSS is more reliable.
  // Unlike skipDom, this still falls back to DOM scraping if RSS returns nothing.
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
    // DOM failed — try RSS fallback
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

  // If DOM selectors matched nothing but page loaded OK, try RSS fallback.
  // This handles sites like RTHK where the page is server-side rendered but
  // our container selector is wrong or stale.
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
