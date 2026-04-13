export const config = { maxDuration: 300 };

async function runStep(url, label) {
  const res = await fetch(url, {
    headers: {
      'x-vercel-cron': '1',
      'user-agent': 'DailyPulse-Prewarm/1.0',
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${label} failed (${res.status}): ${text.slice(0, 300)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${proto}://${host}`;

  const startedAt = Date.now();

  try {
    const scrape = await runStep(`${baseUrl}/api/scrape`, 'scrape');
    const digest = await runStep(`${baseUrl}/api/digest?prewarm=1`, 'digest');

    return res.status(200).json({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      scrape: {
        type: scrape.type,
        intlClusters: scrape.intlClusters,
        localClusters: scrape.localClusters,
        elapsedMs: scrape.elapsedMs,
      },
      digest: {
        generatedAt: digest.generatedAt,
        scrapedAt: digest.scrapedAt,
        intlStories: (digest.international || []).length,
        localStories: (digest.local || []).length,
        meta: digest.meta || null,
      },
    });
  } catch (err) {
    console.error('[prewarm] error:', err);
    return res.status(500).json({
      error: 'Prewarm failed',
      detail: err.message,
      elapsedMs: Date.now() - startedAt,
    });
  }
}
