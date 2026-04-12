// TVB Pearl News adapter
// Uses the TVB internal content API (inews-api.tvb.com) which is publicly accessible
// without authentication. The API returns full English article text for the Pearl News
// category, with accurate publish timestamps and article IDs for URL construction.
//
// Discovery method: the __NEXT_DATA__ JSON embedded in the TVB website exposes the
// API domain and endpoint map; the category list endpoint revealed that "pearlnews"
// is the string category ID used by the entry/category endpoint.

const API_BASE    = 'https://inews-api.tvb.com/news';
const ARTICLE_BASE = 'https://news.tvb.com/tc/pearlnews';

/** Convert a title string to a URL-safe slug */
function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

export async function run(source) {
  try {
    const limit = source.maxRank || 20;
    const url = `${API_BASE}/entry/category?id=pearlnews&lang=en&limit=${limit}&page=1&country=HK`;

    const res = await fetch(url, {
      headers: {
        'Origin':  'https://news.tvb.com',
        'Referer': 'https://news.tvb.com/tc/pearlnews',
        'User-Agent': 'DailyPulse/2.0',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return stub(source, `HTTP ${res.status}`);
    }

    const data = await res.json();

    if (data?.meta?.status !== 'success' || !Array.isArray(data.content)) {
      return stub(source, data?.meta?.error_message || 'unexpected response');
    }

    const items = data.content
      .filter(a => a.title && a.id)
      .map((a, i) => {
        const articleUrl = `${ARTICLE_BASE}/${a.id}/${slugify(a.title)}`;
        return {
          rank:        i + 1,
          title:       a.title.trim(),
          description: a.desc || null,   // full article text — used by LLM for richer summaries
          articleUrl,
          publishedAt: a.publish_datetime || null,
        };
      });

    const presenceConfirmed = items.length > 0;
    const rankConfirmed     = items.length >= 3;

    return {
      sourceId:         source.id,
      presenceConfirmed,
      rankConfirmed,
      rankMethod:       'api',
      items,
      scrapeConfidence: rankConfirmed ? 'high' : presenceConfirmed ? 'medium' : 'low',
      error:            null,
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
    rankMethod:        'api',
    items:             [],
    scrapeConfidence:  'none',
    error,
  };
}
