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
  'what','how','why','when','where','next','now','here',
  'hong','kong',
]);

export function normaliseTitle(title) {
  return new Set(
    title
      .toLowerCase()
      .replace(/[\u0027\u0027\u0022\u0022\u2013\u2014\-]/g, ' ')
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  );
}

export function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

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

export async function enrichWithRss(items, rssUrl) {
  if (!items.length) return items;

  const rssItems = await fetchRss(rssUrl);
  if (!rssItems.length) {
    return items.map(i => ({ ...i, publishedAt: null, matchConfidence: 'low' }));
  }

  const rssNorm = rssItems.map(r => ({ ...r, tokens: normaliseTitle(r.title) }));

  return items.map(item => {
    const domTokens = normaliseTitle(item.title);

    // 1. Exact URL match
    const exactUrl = rssItems.find(r => r.link === item.articleUrl);
    if (exactUrl) {
      return { ...item, articleUrl: exactUrl.link, publishedAt: exactUrl.pubDate, matchConfidence: 'high' };
    }

    // 2. Best title similarity match
    let best = null, bestScore = 0;
    for (const r of rssNorm) {
      const score = jaccard(domTokens, r.tokens);
      if (score > bestScore) { best = r; bestScore = score; }
    }

    if (bestScore >= 0.40) {
      return { ...item, articleUrl: best.link || item.articleUrl, publishedAt: best.pubDate, matchConfidence: 'high' };
    }

    if (bestScore >= 0.25) {
      // For JS-rendered sites (SCMP, etc.) the DOM URL is often just the section page.
      // Prefer the RSS article URL unless the DOM URL is already article-specific.
      const domIsArticle = item.articleUrl && /\/article\//i.test(item.articleUrl);
      return {
        ...item,
        articleUrl:     domIsArticle ? item.articleUrl : (best.link || item.articleUrl),
        publishedAt:    best.pubDate,
        matchConfidence:'medium',
      };
    }

    return { ...item, publishedAt: null, matchConfidence: 'low' };
  });
}
