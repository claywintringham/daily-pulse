// ── lib/adapters/thetimes.js ──────────────────────────────────────────────────
// Custom adapter for The Times (UK).
// The Times has no public RSS feed and is fully paywalled.
// Their homepage is Next.js SSR and embeds article headlines + publication
// times as JSON in the page source — extractable without JS execution.
// Items carry publishedAt directly; enrichWithRss is a no-op (rssUrl: null).
// Used for clustering signal only (isPaywalled: true — no article content fetched).

const USER_AGENT = 'Mozilla/5.0 (compatible; DailyPulse/1.0; +https://daily-pulse-theta.vercel.app)';

function unescapeJson(str) {
  return str
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, ' ').replace(/\\t/g, ' ').replace(/\\r/g, '')
    .replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

export async function run(source) {
  try {
    const res = await fetch('https://www.thetimes.com', {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return { sourceId: source.id, items: [], scrapeConfidence: 'none', error: `HTTP ${res.status}` };
    }
    const html = await res.text();

    // Extract headline + publishedTime pairs from Next.js SSR JSON.
    // The SSR payload embeds: "headline":"<text>", ..., "publishedTime":"<ISO>"
    const headlineRe = /"headline":"((?:[^"\\]|\\.)*)"/g;
    const seen = new Set();
    const raw = [];
    let hm;

    while ((hm = headlineRe.exec(html)) !== null) {
      const title = unescapeJson(hm[1]).trim();
      if (!title || seen.has(title) || title.length < 15) continue;

      // Look for publishedTime within 500 chars — same JSON object as the headline
      const nearby = html.slice(hm.index, hm.index + 500);
      const pubMatch = nearby.match(/"publishedTime":"([^"]+)"/);
      if (!pubMatch) continue;

      const pubDate = new Date(pubMatch[1]);
      if (isNaN(pubDate.getTime())) continue;

      seen.add(title);
      raw.push({ title, publishedAt: pubDate });
    }

    // Sort most-recent-first, take top maxRank
    raw.sort((a, b) => b.publishedAt - a.publishedAt);
    const items = raw.slice(0, source.maxRank ?? 10).map((r, i) => ({
      title:       r.title,
      articleUrl:  null,
      rank:        i + 1,
      publishedAt: r.publishedAt,
    }));

    const confidence = items.length >= 5 ? 'high' : items.length >= 2 ? 'medium' : 'none';
    console.log(`[thetimes] Extracted ${items.length} headlines from SSR JSON`);
    return { sourceId: source.id, items, scrapeConfidence: confidence };

  } catch (err) {
    console.error('[thetimes] adapter error:', err.message);
    return { sourceId: source.id, items: [], scrapeConfidence: 'none', error: err.message };
  }
}
