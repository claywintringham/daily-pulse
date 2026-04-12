// ── The Standard adapter ──────────────────────────────────────────────────────
// thestandard.com.hk renders its homepage via JavaScript (Vue/React),
// so DOM scraping returns empty containers. Instead, we call their internal
// JSON API directly — the same endpoints the browser fetches at runtime.
//
// Endpoints used:
//   /api/homepage/?slug=hong-kong  → local HK stories (primary)
//   /api/homepage/?slug=focus      → featured/front-page stories (supplement)
//
// Response shape: { data: [{ title, url, ... }] }
// Article URLs are relative: "/news/article/329031/..." → prepend base URL.

const BASE_URL = 'https://www.thestandard.com.hk';

async function fetchSection(slug) {
  try {
    const res = await fetch(`${BASE_URL}/api/homepage/?slug=${slug}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'application/json',
        'Referer':    BASE_URL,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.data) ? data.data : [];
  } catch {
    return [];
  }
}

export async function run(source) {
  // Fetch local HK section; supplement with featured section for rank signal
  const [hkArticles, focusArticles] = await Promise.all([
    fetchSection('hong-kong'),
    fetchSection('focus'),
  ]);

  // Deduplicate by URL — HK section has rank priority
  const seen = new Set();
  const items = [];

  for (const article of [...hkArticles, ...focusArticles]) {
    if (!article.title || !article.url) continue;
    const articleUrl = article.url.startsWith('http')
      ? article.url
      : `${BASE_URL}${article.url}`;

    if (seen.has(articleUrl)) continue;
    seen.add(articleUrl);

    items.push({
      rank:       items.length + 1,
      title:      article.title.trim(),
      articleUrl,
    });

    if (items.length >= (source.maxRank || 10)) break;
  }

  const presenceConfirmed = items.length > 0;
  const rankConfirmed     = items.length >= 3;

  return {
    sourceId:          source.id,
    presenceConfirmed,
    rankConfirmed,
    rankMethod:        'json-api',
    items,
    scrapeConfidence:  rankConfirmed ? 'high' : presenceConfirmed ? 'medium' : 'low',
    error:             null,
  };
}
