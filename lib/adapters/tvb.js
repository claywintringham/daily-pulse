// TVB News Chinese adapter
// Uses the TVB internal content API (inews-api.tvb.com) — same API as tvbpearl.js
// — to fetch Hong Kong/Macau local news from TVB's Chinese editorial (港澳, id=local).
//
// Because the content is in Traditional Chinese, titles are translated to English
// via translateHeadlines (lib/llm.js) before being returned so they can participate
// in English-language Jaccard clustering with RTHK, HKFP, and The Standard.
//
// API discovery: __NEXT_DATA__ JSON in the TVB website exposes the API domain and
// endpoint map; /news/category?country=HK&lang=tc confirms "local" is the string
// category ID for 港澳. See lib/adapters/tvbpearl.js for full discovery notes.

import { translateHeadlines } from '../llm.js';

const API_BASE     = 'https://inews-api.tvb.com/news';
const ARTICLE_BASE = 'https://news.tvb.com/tc/local';

/** URL-safe slug from a Chinese title — keeps Chinese chars and ASCII. */
function slugify(title) {
  return title
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

export async function run(source) {
  try {
    const limit = source.maxRank || 20;
    const url   = `${API_BASE}/entry/category?id=local&lang=tc&limit=${limit}&page=1&country=HK`;

    const res = await fetch(url, {
      headers: {
        'Origin':     'https://news.tvb.com',
        'Referer':    'https://news.tvb.com/tc/local',
        'User-Agent': 'DailyPulse/2.0',
      },
      redirect: 'follow',
      signal:   AbortSignal.timeout(8000),
    });

    if (!res.ok) return stub(source, `HTTP ${res.status}`);

    const data = await res.json();
    if (data?.meta?.status !== 'success' || !Array.isArray(data.content)) {
      return stub(source, data?.meta?.error_message || 'unexpected response');
    }

    const rawItems = data.content
      .filter(a => a.title && a.id)
      .map((a, i) => ({
        rank:           i + 1,
        title:          a.title.trim(),   // Traditional Chinese — translated below
        originalTitle:  a.title.trim(),   // preserved for reference / debugging
        description:    a.desc || null,   // full article text in Chinese
        articleUrl:     `${ARTICLE_BASE}/${a.id}/${slugify(a.title)}`,
        publishedAt:    a.publish_datetime || null,
      }));

    if (!rawItems.length) return stub(source, 'No items returned');

    // Translate Chinese titles → English so they can cluster with English sources.
    // translateHeadlines (lib/llm.js) calls Gemini in a single batch call and
    // returns the same array with each .title replaced by its English translation.
    const items = await translateHeadlines(rawItems);
    console.log('[tvb] translated titles:', items.slice(0, 5).map(i => i.title));

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
