// ── Base adapter utilities ────────────────────────────────────────────────────
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
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(\{[\s\S]*?\})<\/script>/);
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
 * Fetch an RSS feed and return items as { rank, title, articleUrl }.
 * Used as a fallback when DOM scraping is blocked (e.g. Reuters).
 * HTML entities in titles are decoded to plain text.
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
      const linkM  = block.match(/<link>([^<]+)<\/link>/) ||
                     block.match(/<link[^>]+href="([^"]+)"/) ||
                     block.match(/<guid[^>]*isPermaLink="true">([^<]+)<\/guid>/);
      if (!titleM || !linkM) continue;
      const title = decodeEntities(titleM[1]);
      if (!title || title.length < 12) continue;
      items.push({
        rank:       items.length + 1,
        title,
        articleUrl: linkM[1].trim(),
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
 *   1. Try each container selector in order; stop at first that yields ≥ 3 items.
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
        // Selector matched an anchor directly
        title = $el.text().replace(/\s+/g, ' ').trim();
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
 * Full adapter run:
 *   fetch HTML → load cheerio → scrapeEditorialRail → return standardised result.
 *
 * If the DOM fetch fails (blocked, timeout, 4xx/5xx) and the source has an rssUrl,
 * automatically falls back to fetching the RSS feed and using item order as rank.
 * This handles sources like Reuters where the homepage blocks scrapers.
 *
 * Returns:
 * {
 *   sourceId, presenceConfirmed, rankConfirmed, rankMethod,
 *   items: [{ rank, title, articleUrl }],
 *   scrapeConfidence, error
 * }
 */
export async function runDomAdapter(source) {
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
