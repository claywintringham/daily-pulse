// ── api/tts.js ────────────────────────────────────────────────────────────────
// Gemini 2.5 Flash TTS proxy for both English and Chinese Mandarin.
// Accepts POST { text, lang }, returns audio/wav binary.
//
// Caches responses in Redis (6-hour TTL) — repeat plays are instant.
// Stores raw Gemini PCM base64 (not the wrapped WAV) to minimise Redis usage.
//
// Rate-limit handling: if Gemini returns 429, we wait 35 s then retry once.
// maxDuration is set to 65 s to accommodate that wait.

import { get as redisGet, set as redisSet } from '../lib/redis.js';

export const config = { maxDuration: 65 };

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
// Selects voice based on lang: Aoede for Mandarin Chinese, Kore for English.
async function callGeminiTts(apiKey, truncated, lang = 'en') {
  const voiceName = lang === 'zh' ? 'Aoede' : 'Kore';
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
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!upstream.ok) {
    const err = await upstream.text().catch(() => '');
    const e   = new Error(`Gemini TTS ${upstream.status}: ${err.slice(0, 200)}`);
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

  // ── Call Gemini TTS ──────────────────────────────────────────────────
  // Retry strategy:
  //   • 429 (rate limit): wait 35 s then retry once — stays within maxDuration.
  //   • 500 / 503 / noAudio / timeout: quick retries (1.5 s, 4 s).
  //   • Anything else (404, 400, …): fail immediately.
  let lastErr = null;
  let attempt = 0;

  while (attempt < 3) {
    try {
      const b64 = await callGeminiTts(apiKey, truncated, lang);
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
      attempt++;

      if (err.status === 429) {
        if (attempt === 1) {
          // First 429: wait out the rate-limit window then try exactly once more.
          console.log(`[tts] rate limited (429) — waiting 35 s before retry`);
          await new Promise(r => setTimeout(r, 35_000));
          continue;
        }
        // Second 429: give up.
        break;
      }

      const retryable =
        err.noAudio      ||
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
