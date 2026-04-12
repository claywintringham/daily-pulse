// ── Within-source enrichment matcher ─────────────────────────────────────────
// Stage 1 of 2 in the matching pipeline.
// Takes DOM-ranked items from one source and enriches them with metadata
// (canonical URL, publishedAt) from that same source's RSS feed.
// This is SEPARATE from cross-source clustering (cluster.js).

const STOP_WORDS = new Set([
  'a','an','the','and','but','or','for','nor','so','yet','at','by','in',
  'of','on','to','up','as','is','it','its','be','was','are','were','has',
  'had','have','do','did','does','will','would','could','should','may',
  'might','shall','can','that','this','these','those','with','from','into',
  'about','after','before','between','during','through','over','under',
  'again','then','than','too','very','just','not','no','nor','so','if',
  // Question / transition words — too generic to be meaningful cluster signals.
  // e.g. "What's next after Artemis II" and "What's next after Iran talks"
  // would otherwise share {what, next} and form a false cluster.
  'what','how','why','when','where','next','now','here',
  // HK-specific: 'hong' and 'kong' appear in almost every local story and
  // would create false-positive clusters if left as matching signals.
  'hong','kong',
]);

/**
 * Normalise a headline string for fuzzy matching.
 * Returns a Set of meaningful lower-cased tokens.
 */
export function normaliseTitle(title) {
  return new Set(
    title
      .toLowerCase()
      .replace(/[''""–—\-]/g, ' ')   // normalise dashes and quotes
      .replace(/[^\w\s]/g, '')        // strip remaining punctuation
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  );
}

/**
 * Jaccard similarity between two token sets.
 */
export function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

/**
 * Fetch and parse a simple RSS/Atom feed.
 * Returns an array of { title, link, pubDate } objects.
 */
async function fetchRss(rssUrl) {
  if (!rssUrl) return [];
  try {
    const res = await fetch(rssUrl, {
      headers: { 'User-Agent': 'DailyPulse/2.0' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    const xml = await res.text();

    const items = [];
    const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let m;
    while ((m = itemRe.exec(xml)) !== null) {
      const block = m[1];

      const titleMatch = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
      const linkMatch  = block.match(/<link>([^<]+)<\/link>/) ||
                         block.match(/<link[^>]+href="([^"]+)"/) ||
                         block.match(/<guid[^>]*isPermaLink="true">([^<]+)<\/guid>/);
      const dateMatch  = block.match(/<pubDate[^>]*>([^<]+)<\/pubDate>/) ||
                         block.match(/<published[^>]*>([^<]+)<\/published>/);

      if (!titleMatch || !linkMatch) continue;

      items.push({
        title:   titleMatch[1].trim(),
        link:    linkMatch[1].trim(),
        pubDate: dateMatch ? new Date(dateMatch[1].trim()) : null,
      });
    }
    return items;
  } catch {
    return [];
  }
}

/**
 * Enrich DOM-ranked items with RSS metadata (URL + publishedAt).
 *
 * For each DOM item, tries to find a matching RSS entry by:
 *   1. Exact URL match (if DOM already has an articleUrl)
 *   2. Normalised title Jaccard similarity ≥ 0.40  → matchConfidence: 'high'
 *   3. Jaccard 0.25–0.39                           → matchConfidence: 'medium'
 *   Below 0.25                                     → matchConfidence: 'low' (no enrichment)
 *
 * Returns the items array with `articleUrl`, `publishedAt`, and `matchConfidence` attached.
 */
export async function enrichWithRss(items, rssUrl) {
  if (!items.length) return items;

  const rssItems = await fetchRss(rssUrl);
  if (!rssItems.length) {
    // No RSS data — keep DOM URLs as-is, mark confidence as 'low'
    return items.map(i => ({ ...i, publishedAt: null, matchConfidence: 'low' }));
  }

  const rssNorm = rssItems.map(r => ({
    ...r,
    tokens: normaliseTitle(r.title),
  }));

  return items.map(item => {
    const domTokens = normaliseTitle(item.title);

    // 1. Exact URL match
    const exactUrl = rssItems.find(r => r.link === item.articleUrl);
    if (exactUrl) {
      return {
        ...item,
        articleUrl:     exactUrl.link,
        publishedAt:    exactUrl.pubDate,
        matchConfidence:'high',
      };
    }

    // 2. Best title similarity match
    let best = null, bestScore = 0;
    for (const r of rssNorm) {
      const score = jaccard(domTokens, r.tokens);
      if (score > bestScore) { best = r; bestScore = score; }
    }

    if (bestScore >= 0.40) {
      return {
        ...item,
        articleUrl:     best.link || item.articleUrl,
        publishedAt:    best.pubDate,
        matchConfidence:'high',
      };
    }
    if (bestScore >= 0.25) {
      return {
        ...item,
        articleUrl:     item.articleUrl, // keep DOM URL; don't override with uncertain RSS URL
        publishedAt:    best.pubDate,
        matchConfidence:'medium',
      };
    }

    return { ...item, publishedAt: null, matchConfidence: 'low' };
  });
}
