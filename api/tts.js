// ── api/tts.js ────────────────────────────────────────────────────────────────
// TTS proxy. Routes by lang + heading flag:
//   • English stories + headings  → Speechify (Carly, simba-english, MP3)
//   • Chinese section headings    → Gemini TTS (Kore voice, WAV)
//   • Chinese stories             → Speechify (simba-multilingual, MP3)
//
// POST { text, lang, heading? } → audio binary
// Caches responses in Redis (6-hour TTL) — repeat plays are instant.

import { get as redisGet, set as redisSet } from '../lib/redis.js';

export const config = { maxDuration: 30 };

// ── Tiny DJB2 hash for stable cache keys ──────────────────────────────────────
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// ── PCM → WAV (Gemini returns raw 24 kHz 16-bit mono PCM; wrap for browsers) ──
function pcmToWav(pcmBuf, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const dataLen = pcmBuf.length;
  const hdr     = Buffer.alloc(44);
  hdr.write('RIFF',  0); hdr.writeUInt32LE(36 + dataLen, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16);          hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(channels, 22);
  hdr.writeUInt32LE(sampleRate, 24);
  hdr.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  hdr.writeUInt16LE(channels * bitsPerSample / 8, 32);
  hdr.writeUInt16LE(bitsPerSample, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(dataLen, 40);
  return Buffer.concat([hdr, pcmBuf]);
}

// ── Gemini TTS — Chinese section headings ────────────────────────────────────
async function callGeminiTts(apiKey, text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
        },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const e = new Error(`Gemini TTS ${res.status}: ${errText.slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  const b64  = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) throw new Error('No audio data in Gemini TTS response');
  return b64; // base64-encoded PCM (24 kHz, 16-bit, mono)
}

// ── Speechify TTS — stories (EN + ZH) and English headings ───────────────────
async function callSpeechifyTts(apiKey, text, lang = 'en') {
  const isZh  = lang === 'zh';
  const model = isZh ? 'simba-multilingual' : 'simba-english';
  const body  = {
    input:        text,
    voice_id:     'carly',
    model,
    audio_format: 'mp3',
    ...(isZh && { language: 'zh-CN' }),
  };

  const res = await fetch('https://api.speechify.ai/v1/audio/speech', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body:   JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const e       = new Error(`Speechify TTS ${res.status}: ${errText.slice(0, 200)}`);
    e.status      = res.status;
    throw e;
  }

  const data = await res.json();
  const b64  = data?.audio_data;
  if (!b64) {
    const e   = new Error('No audio_data in Speechify response');
    e.status  = 200;
    e.noAudio = true;
    throw e;
  }
  return b64;
}

// ── Handler ────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  const { text, lang = 'en', heading = false } = req.body ?? {};
  if (!text?.trim()) return res.status(400).json({ error: '`text` is required' });

  const truncated = text.slice(0, 3000);

  // ── Chinese section headings → Gemini TTS (WAV) ────────────────────────────
  if (lang === 'zh' && heading) {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

    const cacheKey = `tts3:zh-h:${djb2(truncated)}`;
    try {
      const cached = await redisGet(cacheKey);
      if (cached?.wav) {
        const buf = Buffer.from(cached.wav, 'base64');
        res.setHeader('Content-Type',   'audio/wav');
        res.setHeader('Content-Length', String(buf.length));
        res.setHeader('Cache-Control',  'private, max-age=21600');
        res.setHeader('X-Cache',        'HIT');
        return res.status(200).send(buf);
      }
    } catch (e) {
      console.log('[tts] Redis read miss (non-fatal):', e.message);
    }

    try {
      const pcmB64 = await callGeminiTts(geminiKey, truncated);
      const wavBuf = pcmToWav(Buffer.from(pcmB64, 'base64'));
      redisSet(cacheKey, { wav: wavBuf.toString('base64') }, 6 * 3600)
        .catch(e => console.log('[tts] Redis write miss (non-fatal):', e.message));
      res.setHeader('Content-Type',   'audio/wav');
      res.setHeader('Content-Length', String(wavBuf.length));
      res.setHeader('Cache-Control',  'private, max-age=21600');
      res.setHeader('X-Cache',        'MISS');
      return res.status(200).send(wavBuf);
    } catch (err) {
      console.log('[tts] Gemini TTS failed — client will fall back:', err.message);
      return res.status(502).json({ error: 'Gemini TTS unavailable', detail: err.message });
    }
  }

  // ── All other requests → Speechify (MP3) ──────────────────────────────────
  const speechifyKey = process.env.SPEECHIFY_API_KEY;
  if (!speechifyKey) return res.status(500).json({ error: 'SPEECHIFY_API_KEY not configured' });

  // tts3: prefix avoids collisions with old Gemini PCM cache (tts2:)
  const cacheKey = `tts3:${djb2(truncated + '|' + lang)}`;

  // ── Redis cache hit → instant playback ────────────────────────────────────
  try {
    const cached = await redisGet(cacheKey);
    if (cached?.mp3) {
      const buf = Buffer.from(cached.mp3, 'base64');
      res.setHeader('Content-Type',   'audio/mpeg');
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Cache-Control',  'private, max-age=21600');
      res.setHeader('X-Cache',        'HIT');
      return res.status(200).send(buf);
    }
  } catch (e) {
    console.log('[tts] Redis read miss (non-fatal):', e.message);
  }

  // ── Call Speechify TTS with retries ──────────────────────────────────────
  // Retries on transient errors (500/503/timeout).
  // No rate-limit wait needed — Speechify has no 2 RPM cap like Gemini preview.
  let lastErr = null;
  let attempt = 0;

  while (attempt < 3) {
    try {
      const b64 = await callSpeechifyTts(speechifyKey, truncated, lang);
      const buf = Buffer.from(b64, 'base64');

      redisSet(cacheKey, { mp3: b64 }, 6 * 3600)
        .catch(e => console.log('[tts] Redis write miss (non-fatal):', e.message));

      res.setHeader('Content-Type',   'audio/mpeg');
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Cache-Control',  'private, max-age=21600');
      res.setHeader('X-Cache',        'MISS');
      return res.status(200).send(buf);

    } catch (err) {
      lastErr = err;
      attempt++;

      const retryable =
        err.noAudio        ||
        err.status === 500 ||
        err.status === 503 ||
        /timeout|abort/i.test(err.message || '');

      if (!retryable || attempt >= 3) break;

      const waitMs = attempt === 1 ? 1500 : 4000;
      console.log(`[tts] attempt ${attempt} failed (${err.status ?? 'timeout'}): ${err.message} — retrying in ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  console.log('[tts] upstream unavailable — client will fall back:', lastErr?.message);
  return res.status(502).json({ error: 'TTS upstream unavailable', detail: lastErr?.message });
}
