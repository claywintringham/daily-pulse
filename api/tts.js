// ── api/tts.js ────────────────────────────────────────────────────────────────
// Proxy to Speechify TTS API.
// Accepts POST { text, lang, voiceId? }, returns audio/mpeg binary.
//
// lang: 'en' → simba-english model, 'zh' → simba-multilingual model
// voiceId is optional; if omitted Speechify uses its model default.

export const config = { maxDuration: 20 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.SPEECHIFY_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'SPEECHIFY_API_KEY not configured' });

  const { text, lang, voiceId } = req.body ?? {};
  if (!text?.trim()) return res.status(400).json({ error: '`text` is required' });

  const isZh  = String(lang ?? '').startsWith('zh');
  const model = isZh ? 'simba-multilingual' : 'simba-english';

  const body = {
    input:        text.slice(0, 3000),   // safety cap
    model,
    audio_format: 'mp3',
    language:     isZh ? 'zh-CN' : 'en-US',
  };
  if (voiceId) body.voice_id = voiceId;

  try {
    const upstream = await fetch('https://api.speechify.ai/v1/audio/speech', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      console.error('[tts] Speechify error:', upstream.status, errText.slice(0, 200));
      return res.status(502).json({ error: `Speechify API ${upstream.status}` });
    }

    const data = await upstream.json();
    const b64  = data.audio_data;
    if (!b64) return res.status(500).json({ error: 'No audio_data in Speechify response' });

    const buf = Buffer.from(b64, 'base64');
    res.setHeader('Content-Type',   'audio/mpeg');
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Cache-Control',  'private, max-age=300');
    return res.status(200).send(buf);

  } catch (err) {
    console.error('[tts] error:', err.message);
    return res.status(500).json({ error: 'TTS request failed' });
  }
}
