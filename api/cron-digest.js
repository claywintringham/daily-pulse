// ── api/cron-digest.js ────────────────────────────────────────────────────────
// Vercel cron handler — warms the digest cache every 30 minutes.
// Skips execution during HKT quiet hours (midnight–7 am).
// Schedule (vercel.json): "*/30 * * * *"

export const config = { maxDuration: 130 };

export default async function handler(req, res) {
  // Vercel automatically adds this header for cron invocations
  if (!req.headers['x-vercel-cron'] && process.env.NODE_ENV === 'production') {
    return res.status(401).json({ error: 'Unauthorized — cron only' });
  }

  // HKT = UTC + 8.  Quiet window: 00:00–06:59 HKT (UTC 16:00–22:59).
  const hkHour = (new Date().getUTCHours() + 8) % 24;
  if (hkHour < 7) {
    console.log(`[cron-digest] Skipping — quiet hours (HKT ${hkHour}:xx)`);
    return res.status(200).json({ skipped: true, reason: 'quiet hours', hkHour });
  }

  // Derive the origin from the incoming request so this works on any
  // Vercel deployment (production, preview, branch).
  const proto  = req.headers['x-forwarded-proto'] || 'https';
  const host   = req.headers['x-forwarded-host']  || req.headers.host;
  const origin = `${proto}://${host}`;

  try {
    const digestRes = await fetch(`${origin}/api/digest`, {
      headers: {
        'x-digest-format': 'json',   // skip SSE streaming, return plain JSON
        'x-cron-warm':     '1',
      },
      signal: AbortSignal.timeout(120_000),
    });

    // Drain the body so the connection closes cleanly
    await digestRes.text();

    const xCache = digestRes.headers.get('x-cache') || 'unknown';
    console.log(`[cron-digest] Done — HTTP ${digestRes.status}, X-Cache: ${xCache}, HKT ${hkHour}:xx`);
    return res.status(200).json({ ok: true, digestStatus: digestRes.status, xCache, hkHour });

  } catch (err) {
    console.error('[cron-digest] Digest warm failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
