// ── api/voices.js ─────────────────────────────────────────────────────────────
// Returns the best Speechify voice ID for English and Mandarin Chinese.
// The frontend caches the result in localStorage for 24 hours.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.SPEECHIFY_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'SPEECHIFY_API_KEY not configured' });

  try {
    const upstream = await fetch('https://api.speechify.ai/v1/voices', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal:  AbortSignal.timeout(8_000),
    });
    if (!upstream.ok) throw new Error(`Speechify voices API ${upstream.status}`);

    const data   = await upstream.json();
    // Speechify may return { voices: [...] } or a bare array
    const voices = Array.isArray(data) ? data : (data.voices ?? data.items ?? []);

    const lang = v => (v.language ?? v.locale ?? v.lang ?? '').toLowerCase();
    const id   = v => v.id ?? v.voice_id ?? v.voiceId ?? null;

    // English: prefer en-US, then any en-* variant
    const enVoice = voices.find(v => lang(v).startsWith('en-us'))
                 ?? voices.find(v => lang(v).startsWith('en'));

    // Mandarin: prefer zh-CN / cmn, then any zh-* variant
    const zhVoice = voices.find(v => lang(v).startsWith('zh-cn') || lang(v).startsWith('cmn'))
                 ?? voices.find(v => lang(v).startsWith('zh'));

    return res.status(200).json({
      en: id(enVoice) ?? null,
      zh: id(zhVoice) ?? null,
    });

  } catch (err) {
    console.error('[voices] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
