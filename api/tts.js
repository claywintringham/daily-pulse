// ── api/tts.js ────────────────────────────────────────────────────────────────
// Speechify TTS proxy for both English and Chinese Mandarin.
// Accepts POST { text, lang }, returns audio/mpeg binary.
//
// Caches responses in Redis (6-hour TTL) — repeat plays are instant.
// Stores base64 MP3 directly — no PCM conversion needed.
//
// Voice: "henry" (natural news-reading tone).
// Chinese: same voice via simba-multilingual model with language: zh-CN.

import { get as redisGet, set as redisSet } from '../lib/redis.js';

export const config = { maxDuration: 30 };

// ── Tiny DJB2 hash for stable cache keys ──────────────────────────────────────
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// ── One call to Speechify TTS. Returns base64 MP3 or throws. ─────────────────
async function callSpeechifyTts(apiKey, text, lang = 'en') {
  const isZh  = lang === 'zh';
  const model = isZh ? 'simba-multilingual' : 'simba-english';
  const body  = {
    input:        text,
    voice_id:     'henry',
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

  const apiKey = process.env.SPEECHIFY_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'SPEECHIFY_API_KEY not configured' });

  const { text, lang = 'en' } = req.body ?? {};
  if (!text?.trim()) return res.status(400).json({ error: '`text` is required' });

  const truncated = text.slice(0, 3000);
  // tts3: prefix avoids collisions with old Gemini PCM cache (tts2:)
  const cacheKey  = `tts3:${djb2(truncated + '|' + lang)}`;

  // ── Redis cache hit → instant playback ─────────────────────────────────────
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
      const b64 = await callSpeechifyTts(apiKey, truncated, lang);
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
