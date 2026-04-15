// ── api/tts.js ────────────────────────────────────────────────────────────────
// Gemini 2.5 Flash TTS proxy for both English and Chinese Mandarin.
// Accepts POST { text, lang }, returns audio/wav binary.
//
// Caches responses in Redis (6-hour TTL) — repeat plays are instant.
// Stores raw Gemini PCM base64 (not the wrapped WAV) to minimise Redis usage.

import { get as redisGet, set as redisSet } from '../lib/redis.js';

export const config = { maxDuration: 30 };

// ── Tiny DJB2 hash for stable cache keys ──────────────────────────────────────
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// ── PCM → WAV ─────────────────────────────────────────────────────────────────
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

// ── One attempt at calling Gemini TTS. Returns base64 PCM or throws. ─────────
async function callGeminiTts(apiKey, truncated) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
              `gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;

  const upstream = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: truncated }] }],
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
    const e   = new Error(`Gemini TTS ${upstream.status}: ${err.slice(0, 160)}`);
    e.status  = upstream.status;
    throw e;
  }

  const data = await upstream.json();
  const b64  = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) {
    const e   = new Error('No audio data in Gemini response');
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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const { text, lang = 'en' } = req.body ?? {};
  if (!text?.trim()) return res.status(400).json({ error: '`text` is required' });

  const truncated  = text.slice(0, 3000);
  const cacheKey   = `tts2:${djb2(truncated + '|' + lang)}`;

  // ── Redis cache hit → instant playback ─────────────────────────────────────
  try {
    const cached = await redisGet(cacheKey);
    if (cached?.pcm) {
      const wav = pcmToWav(Buffer.from(cached.pcm, 'base64'));
      res.setHeader('Content-Type',   'audio/wav');
      res.setHeader('Content-Length', String(wav.length));
      res.setHeader('Cache-Control',  'private, max-age=21600');
      res.setHeader('X-Cache',        'HIT');
      return res.status(200).send(wav);
    }
  } catch (e) {
    console.log('[tts] Redis read miss (non-fatal):', e.message);
  }

  // ── Call Gemini TTS with retry on transient failures ───────────────────────
  const BACKOFFS_MS = [1500, 4000];
  let lastErr = null;
  for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
    try {
      const b64 = await callGeminiTts(apiKey, truncated);
      const wav = pcmToWav(Buffer.from(b64, 'base64'));

      redisSet(cacheKey, { pcm: b64 }, 6 * 3600)
        .catch(e => console.log('[tts] Redis write miss (non-fatal):', e.message));

      res.setHeader('Content-Type',   'audio/wav');
      res.setHeader('Content-Length', String(wav.length));
      res.setHeader('Cache-Control',  'private, max-age=21600');
      res.setHeader('X-Cache',        'MISS');
      return res.status(200).send(wav);
    } catch (err) {
      lastErr = err;
      const retryable =
        err.noAudio ||
        err.status === 429 ||
        err.status === 503 ||
        /timeout|abort/i.test(err.message || '');
      if (!retryable || attempt === BACKOFFS_MS.length) break;
      await new Promise(r => setTimeout(r, BACKOFFS_MS[attempt]));
    }
  }

  console.log('[tts] upstream unavailable — client will fall back:', lastErr?.message);
  return res.status(502).json({ error: 'TTS upstream unavailable', detail: lastErr?.message });
}
