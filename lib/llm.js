// ── LLM integration (Google Gemini) ──────────────────────────────────────────
// Uses Gemini's OpenAI-compatible endpoint so the request shape is identical
// to the OpenAI SDK — only the base URL, model names, and API key differ.
//
// Paid tier (billing enabled):
//   gemini-2.5-flash — higher rate limits, better quality
//
// Three exported functions:
//   1. translateHeadlines  — translate Chinese → English (Phase 3 sources)
//   2. editorialFilter     — remove non-events, merge false cluster splits
//   3. summarizeClusters   — write neutral headline + 40-75 word summary per story

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
const MODEL_FAST  = 'gemini-2.5-flash';   // translate + summarise
const MODEL_SMART = 'gemini-2.5-flash';   // editorial filter

// Bracket-matching JSON extractor — handles nested structures and strings
// so URLs or text containing [] {} don't confuse lastIndexOf.
function extractJson(content, open, close) {
  const start = content.indexOf(open);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (esc)              { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true;  continue; }
    if (ch === '"')       { inStr = !inStr;  continue; }
    if (inStr)            continue;
    if (ch === open)      depth++;
    if (ch === close)     { depth--; if (depth === 0) return content.slice(start, i + 1); }
  }
  return null;
}

/**
 * Sanitise a raw LLM response so it is safe for JSON.parse.
 * Gemini occasionally emits literal newlines or control characters
 * inside string values (e.g. a summary split across two real lines),
 * which breaks JSON.parse. This walks the string character-by-character
 * and escapes control characters that appear inside a JSON string literal.
 */
function sanitiseForJson(s) {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc)                  { esc = false; out += ch; continue; }
    if (ch === '\\' && inStr) { esc = true;  out += ch; continue; }
    if (ch === '"')           { inStr = !inStr; out += ch; continue; }
    if (inStr) {
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      if (ch.charCodeAt(0) < 0x20) continue; // strip other control chars
    }
    out += ch;
  }
  return out;
}

/**
 * Decode common HTML entities to plain text before sending to the LLM.
 * RSS feeds frequently contain &amp;, &#39;, &quot; etc. that should be
 * rendered as plain characters so Gemini gets clean readable text.
 */
function decodeEntities(text) {
  if (!text) return text;
  return text
    .replace(/&amp;/g,   '&')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&quot;/g,  '"')
    .replace(/&#39;/g,   "'")
    .replace(/&#x27;/g,  "'")
    .replace(/&apos;/g,  "'")
    .replace(/&nbsp;/g,  ' ')
    .replace(/&#(\d+);/g,     (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

async function gemini({ model = MODEL_SMART, messages, temperature = 0.3, max_tokens = 2048 }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY env var not set');

  const res = await fetch(`${GEMINI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body:   JSON.stringify({ model, messages, temperature, max_tokens }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices[0].message.content.trim();
}

// ── 1. Translate Chinese headlines ────────────────────────────────────────────
// Used for Phase 3 Chinese-language adapters (HKET, Ming Pao, ONCC).
// items:  [{ rank, title, ... }]  (Chinese titles)
// Returns same array with each `title` replaced by an English translation.

export async function translateHeadlines(items) {
  if (!items.length) return items;

  const lines = items.map((it, i) => `${i + 1}. ${it.title}`).join('\n');

  let content;
  try {
    content = await gemini({
      model: MODEL_FAST,
      messages: [
        {
          role:    'system',
          content: 'You are a Hong Kong news translator. Translate each numbered Chinese ' +
                   'headline into concise, natural English. Output ONLY the numbered list ' +
                   'in the same order. No explanations or extra text.',
        },
        { role: 'user', content: lines },
      ],
      max_tokens: 1024,
    });
  } catch (e) {
    // Gemini transient error (503, 429, timeout) — return originals untranslated.
    // The clustering pipeline handles mixed-language titles gracefully.
    console.warn('[llm] translateHeadlines error — returning originals:', e.message);
    return items;
  }

  const translated = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^(\d+)\.\s+(.+)/);
    if (m) translated[parseInt(m[1], 10) - 1] = m[2].trim();
  }

  return items.map((it, i) => ({ ...it, title: translated[i] ?? it.title }));
}

// ── 2. Cluster headlines using Gemini ─────────────────────────────────────────
// Replaces Jaccard similarity in lib/cluster.js with semantic grouping.
// Input:  items[] with { title, sourceId, bucket, ... }
// Output: number[][] — indices of items grouped by story

export async function clusterHeadlines(items) {
  if (!items.length) return [];

  const list = items.map((it, i) =>
    `[${i}] (${it.sourceId}, ${it.bucket}) ${it.title}`
  ).join('\n');

  const content = await gemini({
    messages: [
      {
        role:    'system',
        content: 'Group these news articles by story. Articles about the same real-world event ' +
                 'belong in the same group, even if they use different wording or angles.\n\n' +
                 'Rules:\n' +
                 '- Same core event = same group\n' +
                 '- Different events = different groups\n' +
                 '- Each article index appears in exactly one group\n' +
                 '- Single articles with no match are their own group\n\n' +
                 'Return ONLY valid JSON — no markdown:\n' +
                 '{"groups":[[0,3,7],[1,4],[2],...]}',
      },
      { role: 'user', content: list },
    ],
    max_tokens: Math.max(1024, items.length * 8),
  });

  const safe = sanitiseForJson(content);
  const json = extractJson(safe, '{', '}');
  if (!json) throw new Error(`No JSON in clusterHeadlines response: ${content.slice(0, 80)}`);
  const { groups } = JSON.parse(json);
  if (!Array.isArray(groups)) throw new Error('groups is not an array');

  const seen = new Set();
  for (const g of groups) for (const idx of g) seen.add(idx);
  if (seen.size !== items.length) throw new Error(`Index mismatch: ${seen.size} vs ${items.length}`);

  return groups;
}

// ── 3. Editorial filter (KEEP / DISCARD only) ─────────────────────────────────
// Gemini clustering already handles grouping, so MERGE is no longer needed.
// This step only judges quality: genuine news vs noise.

export async function editorialFilter(clusters) {
  if (!clusters.length) return clusters;

  const listing = clusters.map(c => ({
    id:       c.id,
    headline: decodeEntities(c.headline),
    sources:  c.members.length,
    bucket:   c.bucket,
    titles:   [...new Set(c.members.map(m => decodeEntities(m.title)))],
  }));

  let result;
  try {
    const content = await gemini({
      messages: [
        {
          role:    'system',
          content: 'You are an editorial AI for a Hong Kong news digest. ' +
                   'Given a JSON list of story clusters, decide what to keep or discard.\n\n' +
                   'DISCARD if: market/stock tickers, sports scores or match results, ' +
                   'sports league tables, weather, celebrity gossip, ' +
                   'listicles, newsletter/recap entries (e.g. "Morning Recap", "Daily Digest"), ' +
                   'advertisements, non-events, OR if the cluster\'s source titles ' +
                   'reveal the sources are covering DIFFERENT stories that share keywords.\n' +
                   'For clusters with bucket="local": DISCARD unless the story directly concerns ' +
                   'Hong Kong — its people, government, institutions, businesses, or territory. ' +
                   'A HK outlet (RTHK, TVB, SCMP, HKFP) covering a foreign story does NOT make ' +
                   'it a HK story. ' +
                   'Examples to DISCARD from local: school shootings in Turkey, ' +
                   'terrorist attacks in Europe, elections in South Korea, natural disasters in Japan, ' +
                   'Premier League results, US congressional news.\n' +
                   'KEEP if the cluster is a genuine news event with real-world impact.\n\n' +
                   'Note: story grouping is already done — do NOT try to merge clusters.\n\n' +
                   'Rules:\n' +
                   '- Every cluster id must appear in exactly one of: keep or discard.\n' +
                   '- Return ONLY valid JSON, no markdown fences:\n' +
                   '  { "keep": ["id",...], "discard": ["id",...] }',
        },
        { role: 'user', content: JSON.stringify(listing) },
      ],
      max_tokens: 2048,
    });

    const safe = sanitiseForJson(content);
    const json = extractJson(safe, '{', '}');
    if (!json) throw new Error(`No JSON in editorialFilter response: ${content.slice(0, 120)}`);
    result = JSON.parse(json);
  } catch (e) {
    console.warn('[llm] editorialFilter error — returning all clusters:', e.message);
    return clusters;
  }

  const { keep = [], discard: discard_ = [] } = result;
  const keepSet    = new Set(keep);
  const discardSet = new Set(discard_);
  return clusters.filter(c => keepSet.has(c.id) && !discardSet.has(c.id));
}

// ── 3. Summarize clusters ─────────────────────────────────────────────────────
// clusters: final filtered + scored clusters (one bucket).
// Returns clusters with `summary` added (40-75 words).
//
// Headline selection is handled algorithmically by pickBestHeadline in
// cluster.js (Jaccard centroid + subjectivity filter) — we do not ask the
// LLM to rewrite it, which avoids the per-cluster JSON-field mismatch that
// causes summary fallbacks.
//
// Summary rules:
//   - 40-75 words, factual, plain English
//   - Reflects what the MAJORITY of cited sources report
//   - Does NOT start by repeating the headline verbatim
//   - Does NOT include details only one source mentions
//
// HTML entities are decoded before sending to the LLM so Gemini receives
// clean readable text rather than &amp;, &#39;, etc.

export async function summarizeClusters(clusters) {
  if (!clusters.length) return clusters;

  // Build an ID-keyed prompt so Gemini can safely skip non-news clusters without
  // shifting the index of subsequent summaries. Each cluster is identified by its
  // unique id enclosed in brackets: [id] Headline: ... / Article: ...
  const prompt = clusters.map(c => {
    const content = c.articleExcerpt
      ? `Article: ${c.articleExcerpt}`
      : `Source titles: ${[...new Set(c.members.map(m => decodeEntities(m.title)))].join(' / ')}`;
    return `[${c.id}] Headline: ${decodeEntities(c.headline)}\n   ${content}`;
  }).join('\n\n');

  // Map from id → summary; clusters with no entry fall back to pickFallbackSummary.
  const summaryMap = new Map();

  try {
    const content = await gemini({
      model: MODEL_FAST,
      messages: [
        {
          role: 'system',
          content:
            'You write a morning and evening digest for Hong Kong readers.\n\n' +
            'For each story, write a 40–75 word factual summary in English.\n\n' +
            'Rules:\n' +
            '• Reflect what the MAJORITY of cited sources report.\n' +
            '• Do NOT start by repeating the headline verbatim.\n' +
            '• Do NOT include details mentioned by only one source.\n' +
            '• Be specific: names, locations, numbers when sources agree.\n' +
            '• CRITICAL: Base each summary ONLY on the Article or source titles ' +
            'provided — never draw on outside knowledge or training data.\n' +
            '• If the Article content is not relevant to the Headline (e.g. a ' +
            'different story that shares some keywords), ignore the Article and ' +
            'summarise from the Source titles only.\n' +
            '• If a story\'s content is clearly an advertisement, app promotion, ' +
            'or non-news content, skip it — output nothing for that ID.\n\n' +
            'Reply with ONLY lines in this exact format — one per story:\n' +
            '[id] summary text here\n' +
            'No preamble, no extra text, no markdown.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: Math.max(2048, 150 * clusters.length),
    });

    const badSig = /\bprovided (?:article|content)\b[\s\S]{0,80}\b(?:does not|doesn.t)\b[\s\S]{0,60}\b(?:contain|include|mention)\b/i;

    const parseLine = (id, text) => {
      if (text.split(/\s+/).length < 10) return; // reject only single-sentence echoes; accept short real summaries
      if (badSig.test(text)) {
        console.warn('[llm] id %s: article mismatch flagged by LLM, using title fallback', id);
        const cluster = clusters.find(c => c.id === id);
        if (cluster) summaryMap.set(id, pickFallbackSummary({ ...cluster, articleExcerpt: null }));
        return;
      }
      summaryMap.set(id, text);
    };

    // Primary: parse "[id] summary text" lines.
    // Allow optional period/colon/dash after the bracket in case Gemini adds punctuation.
    for (const line of content.split('\n')) {
      const m = line.match(/^\[([^\]]+)\]\s*[.:–-]?\s*(.+)/);
      if (m) parseLine(m[1].trim(), m[2].trim());
    }

    // Safety fallback: if Gemini ignored the [id] format and used numbered lines
    // instead (e.g. "1. summary"), map by position so nothing is silently lost.
    if (summaryMap.size === 0) {
      console.warn('[llm] No [id] lines parsed — falling back to positional parsing');
      for (const line of content.split('\n')) {
        const m = line.match(/^(\d+)\.\s+(.+)/);
        if (m) {
          const idx = parseInt(m[1], 10) - 1;
          if (idx >= 0 && idx < clusters.length) parseLine(clusters[idx].id, m[2].trim());
        }
      }
    }
  } catch (e) {
    console.warn('[llm] summarizeClusters error:', e.message);
    // summaryMap stays empty; pickFallbackSummary fills each cluster below
  }

  return clusters.map(c => ({
    ...c,
    summary: summaryMap.get(c.id) ?? pickFallbackSummary(c),
  }));
}

// ── 4. Translate digest to Traditional Chinese ────────────────────────────────
// items: [{ id, headline, summary }, ...]  (English)
// Returns same array with headline and summary replaced by Traditional Chinese.
// Single batched Gemini call — falls back to original English on any error.

export async function translateToZh(items) {
  if (!items.length) return items;

  const input = items.map((it, i) => ({
    i,
    headline: it.headline,
    summary:  it.summary || '',
  }));

  let translated;
  try {
    const content = await gemini({
      model: MODEL_FAST,
      messages: [
        {
          role:    'system',
          content:
            'You are a Hong Kong journalist. Translate each story\'s headline and summary into ' +
            'natural, newspaper-style Traditional Chinese (繁體中文).\n' +
            'Keep exactly the same factual content and similar length.\n' +
            'Return ONLY a JSON array in the same order — no markdown, no extra text:\n' +
            '[{"i":0,"headline":"...","summary":"..."},...]',
        },
        { role: 'user', content: JSON.stringify(input) },
      ],
      max_tokens: Math.max(4096, 200 * items.length),
    });

    const safe = sanitiseForJson(content);
    const json = extractJson(safe, '[', ']');
    if (!json) throw new Error(`No JSON array in translation response: ${content.slice(0, 120)}`);
    const parsed = JSON.parse(json);
    const byIdx  = Object.fromEntries(parsed.map(t => [t.i, t]));

    translated = items.map((it, i) => ({
      ...it,
      headline: byIdx[i]?.headline ?? it.headline,
      summary:  byIdx[i]?.summary  ?? it.summary,
    }));
  } catch (e) {
    console.warn('[llm] translateToZh error — returning English:', e.message);
    return items;
  }

  return translated;
}

/**
 * Fallback summary when the LLM doesn't produce one for a cluster.
 *
 * Priority:
 *   1. articleExcerpt — real article prose, truncated to ~75 words at a
 *      sentence boundary.  This is always preferred over titles because it
 *      contains actual reported facts rather than headline shorthand.
 *   2. Longest clean source title — used only when no excerpt is available
 *      (paywalled source, fetch timeout, bot-blocked, etc.).
 */
function pickFallbackSummary(c) {
  // ── 1. Article excerpt (real content) ──────────────────────────────────────
  if (c.articleExcerpt && c.articleExcerpt.length > 80) {
    const MAX_WORDS = 75;
    const words = c.articleExcerpt.trim().split(/\s+/);
    if (words.length <= MAX_WORDS) return c.articleExcerpt.trim();

    // Truncate at MAX_WORDS then extend to the next sentence boundary so we
    // don't cut mid-sentence.
    const rough = words.slice(0, MAX_WORDS).join(' ');
    const sentenceEnd = rough.search(/[.!?][^.!?]*$/);
    const cut = sentenceEnd > 0 ? rough.slice(0, sentenceEnd + 1) : rough + '…';
    return cut;
  }

  // ── 2. Title fallback (no excerpt available) ───────────────────────────────
  const SKIP = [
    /\bmy\b/i, /\bme\b/i, /\bi [''']ve\b/i,
    /\bopinion[:\s]/i, /\bcomment[:\s]/i, /\banalysis[:\s]/i, /\binterview[:\s]/i,
    /\bexplainer[:\s]/i,
    /\blive updates?\b/i, /\blive blog\b/i,
    /^live:/i,
    /\blive:/i,
    /\bwatch:/i, /\bexclusive:/i,
    /\?$/,
    /^day \d+\b/i,
  ];
  const isBad = t => SKIP.some(p => p.test(t));

  const titles = (c.members ?? [])
    .map(m => decodeEntities(m.title))
    .filter(t => t && t.length > 10 && !isBad(t));

  if (!titles.length) return decodeEntities(c.members?.[0]?.title ?? c.headline);
  return titles.reduce((best, t) => t.length > best.length ? t : best, titles[0]);
}
