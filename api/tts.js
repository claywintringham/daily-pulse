// ── api/tts.js ────────────────────────────────────────────────────────────────
// TTS proxy. Routes by lang:
//   • Chinese (headings + stories) → Qwen TTS (Cherry, qwen3-tts-flash, MP3)
//   • English (headings + stories) → Speechify (Carly, simba-english, MP3)
//
// POST { text, lang, heading? } → audio/mpeg binary
// Caches responses in Redis (6-hour TTL) — repeat plays are instant.

import { get as redisGet, set as redisSet } from '../lib/redis.js';

export const config = { maxDuration: 30 };

// ── Tiny DJB2 hash for stable cache keys ──────────────────────────────────────
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// ── Qwen TTS — all Chinese audio (Cherry voice, MP3) ─────────────────────────
// Response: JSON with output.audio.url → fetch that URL for audio bytes.
async function callQwenTts(apiKey, text) {
  const res = await fetch(
    'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'qwen3-tts-flash',
        input: {
          text,
          voice:         'Cherry',
          language_type: 'Chinese',
        },
        parameters: {
          response_format: 'mp3',
          sample_rate:     24000,
        },
      }),
      signal: AbortSignal.timeout(20_000),
    }
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const e = new Error(`Qwen TTS ${res.status}: ${errText.slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }

  const data     = await res.json();
  const audioUrl = data?.output?.audio?.url;
  if (!audioUrl) throw new Error(`No audio URL in Qwen TTS response: ${JSON.stringify(data).slice(0, 200)}`);

  // Fetch the actual audio from the signed URL Qwen returns
  const audioRes = await fetch(audioUrl, { signal: AbortSignal.timeout(15_000) });
  if (!audioRes.ok) throw new Error(`Qwen audio fetch ${audioRes.status}`);
  return Buffer.from(await audioRes.arrayBuffer()); // raw MP3 bytes
}

// ── Speechify TTS — English headings and stories ──────────────────────────────
async function callSpeechifyTts(apiKey, text) {
  const res = await fetch('https://api.speechify.ai/v1/audio/speech', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input:        text,
      voice_id:     'carly',
      model:        'simba-english',
      audio_format: 'mp3',
    }),
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
  return b64; // base64-encoded MP3
}

// ── Handler ────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  const { text, lang = 'en' } = req.body ?? {};
  if (!text?.trim()) return res.status(400).json({ error: '`text` is required' });

  const truncated = text.slice(0, 3000);

  // ── Chinese audio (headings + stories) → Qwen TTS Cherry ─────────────────
  if (lang === 'zh') {
    const qwenKey = process.env.QWEN_API_KEY;
    if (!qwenKey) {
      console.error('[tts] QWEN_API_KEY is not configured');
      return res.status(500).json({ error: 'QWEN_API_KEY not configured' });
    }

    // tts4: prefix isolates from old tts3: Gemini/Speechify Chinese cache entries
    const cacheKey = `tts4:zh:${djb2(truncated)}`;

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

    try {
      const audioBuf = await callQwenTts(qwenKey, truncated);
      redisSet(cacheKey, { mp3: audioBuf.toString('base64') }, 6 * 3600)
        .catch(e => console.log('[tts] Redis write miss (non-fatal):', e.message));
      res.setHeader('Content-Type',   'audio/mpeg');
      res.setHeader('Content-Length', String(audioBuf.length));
      res.setHeader('Cache-Control',  'private, max-age=21600');
      res.setHeader('X-Cache',        'MISS');
      return res.status(200).send(audioBuf);
    } catch (err) {
      console.log('[tts] Qwen TTS failed — client will fall back:', err.message);
      return res.status(502).json({ error: 'Qwen TTS unavailable', detail: err.message });
    }
  }

  // ── English audio → Speechify Carly ──────────────────────────────────────
  const speechifyKey = process.env.SPEECHIFY_API_KEY;
  if (!speechifyKey) return res.status(500).json({ error: 'SPEECHIFY_API_KEY not configured' });

  const cacheKey = `tts3:${djb2(truncated + '|en')}`;

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

  let lastErr = null;
  let attempt = 0;

  while (attempt < 3) {
    try {
      const b64 = await callSpeechifyTts(speechifyKey, truncated);
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
