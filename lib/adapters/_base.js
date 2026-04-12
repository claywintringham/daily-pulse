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
 * Core DOM scraper.  Given cheerio-loaded HTML and a source config,
 * returns an ordered array of { rank, title, articleUrl } items.
 *
 * Strategy:
 *   1. Try each container selector in order; stop at first that yields ≥ 3 items.
 *   2. Within the container, apply itemSelectors (joined as OR) to find links.
 *   3. Remove excludeSelectors before scanning.
 */
export function scrapeEditorialRail($, source) {
  const items = [];
  const seen  = new Set();

  for (const containerSel of source.containers) {
    const $root = $(containerSel);
    if ($root.length === 0) continue;

    // Clone so we can destructively remove excluded elements
    const $clone = $root.clone();
    (source.excludeSelectors || []).forEach(sel => $clone.find(sel).remove());

    const combined = (source.itemSelectors || []).join(', ');
    $clone.find(combined).each((_i, el) => {
      const $el  = $(el);
      const title = $el.text().replace(/\s+/g, ' ').trim();
      const href  = $el.attr('href');

      if (!title || title.length < 12)  return;
      if (seen.has(title.toLowerCase())) return;

      let articleUrl = null;
      if (href) {
        articleUrl = href.startsWith('http')
          ? href
          : new URL(href, source.entryUrl).href;
      }

      seen.add(title.toLowerCase());
      items.push({ rank: items.length + 1, title, articleUrl });
    });

    if (items.length >= 3) break; // good enough; stop trying further containers
  }

  return items.slice(0, source.maxRank || 10);
}

/**
 * Full adapter run:
 *   fetch → load cheerio → scrapeEditorialRail → return standardised result.
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
    rawHtml:           html, // retained briefly for enrichment matching; not stored in Redis
  };
}
