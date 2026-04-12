// TVB Pearl News adapter
// The TVB News site is client-side rendered — headlines are loaded by JavaScript
// from a private API (inews-api.tvb.com) that requires undisclosed internal IDs.
// Direct DOM scraping is not possible.
//
// Workaround: Google News indexes TVB Pearl articles in near-real-time and
// exposes them via its search RSS endpoint. We use a site:-scoped query so
// only news.tvb.com/tc/pearlnews articles are returned, then strip the
// " - news.tvb.com" suffix that Google News appends to every title.

const GOOGLE_NEWS_RSS =
  'https://news.google.com/rss/search?q=site:news.tvb.com/tc/pearlnews&hl=en-HK&gl=HK&ceid=HK:en';

function decodeEntities(text) {
  return text
    .replace(/&amp;/g,   '&')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&quot;/g,  '"')
    .replace(/&#39;/g,   "'")
    .replace(/&apos;/g,  "'")
    .replace(/&nbsp;/g,  ' ')
    .replace(/&#(\d+);/g,     (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove the source attribution suffix Google News appends: " - news.tvb.com" */
function stripSuffix(title) {
  return title.replace(/\s*[-–]\s*news\.tvb\.com\s*$/i, '').trim();
}

export async function run(source) {
  try {
    const res = await fetch(GOOGLE_NEWS_RSS, {
      headers: { 'User-Agent': 'DailyPulse/2.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return stub(source, `HTTP ${res.status}`);
    }

    const xml   = await res.text();
    const items = [];
    const re    = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let m;

    while ((m = re.exec(xml)) !== null && items.length < (source.maxRank || 10)) {
      const block  = m[1];
      const titleM = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
      const linkM  = block.match(/<link>([^<]+)<\/link>/) ||
                     block.match(/<link[^>]+href="([^"]+)"/) ||
                     block.match(/<guid[^>]*isPermaLink="true">([^<]+)<\/guid>/);
      const pubM   = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);

      if (!titleM || !linkM) continue;

      const title = stripSuffix(decodeEntities(titleM[1]));
      if (!title || title.length < 12) continue;

      let publishedAt = null;
      if (pubM) {
        try { publishedAt = new Date(pubM[1].trim()).toISOString(); } catch { /* ignore */ }
      }

      items.push({
        rank:       items.length + 1,
        title,
        articleUrl: linkM[1].trim(),
        publishedAt,
      });
    }

    const presenceConfirmed = items.length > 0;
    const rankConfirmed     = items.length >= 3;

    return {
      sourceId:          source.id,
      presenceConfirmed,
      rankConfirmed,
      rankMethod:        'rss-google-news',
      items,
      scrapeConfidence:  rankConfirmed ? 'high' : presenceConfirmed ? 'medium' : 'low',
      error:             null,
    };
  } catch (err) {
    return stub(source, err.message);
  }
}

function stub(source, error) {
  return {
    sourceId:          source.id,
    presenceConfirmed: false,
    rankConfirmed:     false,
    rankMethod:        'rss-google-news',
    items:             [],
    scrapeConfidence:  'none',
    error,
  };
}
