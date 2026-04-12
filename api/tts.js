// ── api/tts.js ────────────────────────────────────────────────────────────────
// Gemini 2.5 Flash TTS proxy for both English and Chinese Mandarin.
// Accepts POST { text, lang }, returns audio/wav binary.
//
// Gemini auto-detects language from the input text, so the same model and
// voice handle both EN and ZH without any special routing.
// PCM output (24 kHz, mono, 16-bit) is wrapped in a WAV header server-side
// so the browser's <Audio> element can play it directly.

export const config = { maxDuration: 20 };

// ── PCM → WAV ──────────────────────────────────────────────────────────────
function pcmToWav(pcm, sampleRate = 24_000, channels = 1, bitDepth = 16) {
  const dataSize = pcm.length;
  const buf      = Buffer.alloc(44 + dataSize);

  buf.write('RIFF',                                        0);
  buf.writeUInt32LE(36 + dataSize,                         4);
  buf.write('WAVE',                                        8);
  buf.write('fmt ',                                       12);
  buf.writeUInt32LE(16,                                   16);  // fmt chunk size
  buf.writeUInt16LE(1,                                    20);  // PCM = 1
  buf.writeUInt16LE(channels,                             22);
  buf.writeUInt32LE(sampleRate,                           24);
  buf.writeUInt32LE(sampleRate * channels * bitDepth / 8, 28);
  buf.writeUInt16LE(channels * bitDepth / 8,              32);
  buf.writeUInt16LE(bitDepth,                             34);
  buf.write('data',                                       36);
  buf.writeUInt32LE(dataSize,                             40);
  pcm.copy(buf,                                           44);

  return buf;
}

// ── Handler ────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const { text } = req.body ?? {};
  if (!text?.trim()) return res.status(400).json({ error: '`text` is required' });

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
              `gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;

  try {
    const upstream = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: text.slice(0, 3000) }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
          },
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!upstream.ok) {
      const err = await upstream.text().catch(() => '');
      console.error('[tts] Gemini error:', upstream.status, err.slice(0, 200));
      return res.status(502).json({ error: `Gemini TTS ${upstream.status}` });
    }

    const data = await upstream.json();
    const b64  = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!b64) return res.status(500).json({ error: 'No audio data in Gemini response' });

    const wav = pcmToWav(Buffer.from(b64, 'base64'));
    res.setHeader('Content-Type',   'audio/wav');
    res.setHeader('Content-Length', String(wav.length));
    res.setHeader('Cache-Control',  'private, max-age=300');
    return res.status(200).send(wav);

  } catch (err) {
    console.error('[tts] error:', err.message);
    return res.status(500).json({ error: 'TTS request failed' });
  }
}
