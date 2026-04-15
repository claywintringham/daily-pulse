// ── Within-source enrichment matcher ─────────────────────────────────────────
// Stage 1 of 2 in the matching pipeline.
// Takes DOM-ranked items from one source and enriches them with metadata
// (canonical URL, publishedAt, description) from that same source's RSS feed.
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

      // Extract <description> — provides article excerpt text for Phase 1 content fetching
      const descMatch = block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
      const rawDesc   = descMatch ? descMatch[1] : null;
      const description = rawDesc
        ? rawDesc
            .replace(/<[^>]+>/g, ' ')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ').trim() || null
        : null;

      items.push({
        title:   titleMatch[1].trim(),
        link:    linkMatch[1].trim(),
        pubDate: dateMatch ? new Date(dateMatch[1].trim()) : null,
        description,
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

    // 1. Exact URL match — unambiguous, propagate all three
    const exactUrl = rssItems.find(r => r.link === item.articleUrl);
    if (exactUrl) {
      return { ...item, articleUrl: exactUrl.link, publishedAt: exactUrl.pubDate, description: exactUrl.description || item.description || null, matchConfidence: 'high' };
    }

    // 2. Best title similarity match
    let best = null, bestScore = 0;
    for (const r of rssNorm) {
      const score = jaccard(domTokens, r.tokens);
      if (score > bestScore) { best = r; bestScore = score; }
    }

    // High confidence (≥0.40) — propagate all three (URL, date, description)
    if (bestScore >= 0.40) {
      return { ...item, articleUrl: best.link || item.articleUrl, publishedAt: best.pubDate, description: best.description || item.description || null, matchConfidence: 'high' };
    }

    // Medium confidence (0.25–0.40) — match is uncertain; URL, date, and description
    // all come from the same RSS item, so if the match is wrong all three are wrong.
    // Return the item unchanged with its original DOM data.
    if (bestScore >= 0.25) {
      return { ...item, matchConfidence: 'medium' };
    }

    return { ...item, publishedAt: null, matchConfidence: 'low' };
  });
}
