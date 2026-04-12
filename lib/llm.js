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

  const content = await gemini({
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

  const translated = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^(\d+)\.\s+(.+)/);
    if (m) translated[parseInt(m[1], 10) - 1] = m[2].trim();
  }

  return items.map((it, i) => ({ ...it, title: translated[i] ?? it.title }));
}

// ── 2. Editorial filter ───────────────────────────────────────────────────────
// clusters: scored cluster array (mixed buckets OK; bucket field preserved)
//
// LLM decisions:
//   DISCARD — market/stock tickers, sports scores, weather, celebrity gossip,
//              listicles, ads, or non-events.
//   KEEP    — genuine news events with real-world impact.
//   MERGE   — two or more clusters covering THE SAME real-world event, even
//              if sources report different angles or emphasise different actors.
//
// Returns filtered + merged cluster array.
// On any LLM/parse failure, returns the input unchanged.

export async function editorialFilter(clusters) {
  if (!clusters.length) return clusters;

  const listing = clusters.map(c => ({
    id:       c.id,
    headline: decodeEntities(c.headline),
    sources:  c.members.length,
    bucket:   c.bucket,
    // All source titles so the filter can detect false clusters or same-story angles
    titles:   [...new Set(c.members.map(m => decodeEntities(m.title)))],
  }));

  let result;
  try {
    const content = await gemini({
      messages: [
        {
          role:    'system',
          content: 'You are an editorial AI for a Hong Kong news digest. ' +
                   'Given a JSON list of story clusters, decide what to keep, discard, or merge.\n\n' +
                   'DISCARD if: market/stock tickers, sports scores, weather, celebrity gossip, ' +
                   'listicles, advertisements, non-events, OR if the cluster\'s source titles ' +
                   'reveal the sources are actually covering DIFFERENT stories that merely share ' +
                   'keywords (false cluster from keyword overlap — e.g. two articles both mention ' +
                   '"Iran" and "prices" but one is about oil markets and one is about inflation).\n' +
                   'KEEP if the cluster is a genuine news event with real-world impact AND the ' +
                   'source titles confirm the sources are covering the same underlying event.\n' +
                   'MERGE if two or more clusters cover THE SAME real-world event — even when ' +
                   'sources report it from different angles or emphasise different actors or aspects. ' +
                   'For example: "US-Iran talks fail" + "Pakistan urges US-Iran deal" + ' +
                   '"Iran consumer prices rise amid talks" are all about the same diplomatic event ' +
                   'and should merge. Judge by whether the CORE EVENT is the same, not whether ' +
                   'the framing matches. When in doubt about whether two clusters are the same ' +
                   'story, MERGE rather than keep them separate.\n\n' +
                   'Rules:\n' +
                   '- Every cluster id must appear exactly once across keep/discard/merge.\n' +
                   '- Merged cluster ids must NOT also appear in keep or discard.\n' +
                   '- Return ONLY valid JSON, no markdown fences:\n' +
                   '  { "keep": ["id",...], "discard": ["id",...], "merge": [["id","id"],...] }',
        },
        {
          role:    'user',
          content: JSON.stringify(listing),
        },
      ],
      max_tokens: 4096,
    });

    const safe = sanitiseForJson(content);
    const json = extractJson(safe, '{', '}');
    if (!json) throw new Error(`No JSON object in Gemini response: ${content.slice(0, 120)}`);
    result = JSON.parse(json);
  } catch (e) {
    console.warn('[llm] editorialFilter error — returning all clusters:', e.message);
    return clusters;
  }

  const { keep = [], discard: discard_ = [], merge = [] } = result;
  const keepSet    = new Set(keep);
  const discardSet = new Set(discard_);

  const mergedClusters = [];
  const mergedIds      = new Set();

  for (const group of merge) {
    if (!Array.isArray(group) || group.length < 2) continue;
    const parts = clusters.filter(c => group.includes(c.id));
    if (parts.length < 2) continue;
    group.forEach(id => mergedIds.add(id));

    const allMembers = parts.flatMap(c => c.members);
    // Pick headline from the highest-scoring cluster, not the longest string.
    // e.g. "Trump blockades Strait of Hormuz" (baseScore 8.8) beats
    // "Vance says no deal reached" (baseScore 0.7) even if the latter is longer.
    const headline   = parts.reduce((best, c) =>
      (c.baseScore || 0) > (best.baseScore || 0) ? c : best
    ).headline;

    mergedClusters.push({
      ...parts[0],
      id:              `${parts[0].id}-merged`,
      headline,
      members:         allMembers,
      freeSourceCount: allMembers.filter(m => !m.isPaywalled).length,
      // Sum all baseScores so merged clusters rank above their constituent parts
      baseScore:       parts.reduce((s, c) => s + (c.baseScore || 0), 0),
    });
  }

  return [
    ...clusters.filter(c => keepSet.has(c.id) && !mergedIds.has(c.id)),
    ...mergedClusters,
  ].filter(c => !discardSet.has(c.id));
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

  // Build a numbered plain-text prompt — no JSON, no brittle field matching,
  // no ID normalisation issues. Gemini is highly reliable with numbered lists.
  // When an articleExcerpt was fetched by digest.js, use it as the primary
  // content source (real article text > just headlines). Fall back to source
  // titles if the fetch failed or wasn't available.
  const prompt = clusters.map((c, i) => {
    const content = c.articleExcerpt
      ? `Article: ${c.articleExcerpt}`
      : `Source titles: ${[...new Set(c.members.map(m => decodeEntities(m.title)))].join(' / ')}`;
    return `${i + 1}. Headline: ${decodeEntities(c.headline)}\n   ${content}`;
  }).join('\n\n');

  // Pre-fill with null; any entry that stays null after LLM parsing
  // is replaced by pickFallbackSummary(c) below — summaries are never null.
  const summaries = new Array(clusters.length).fill(null);

  try {
    const content = await gemini({
      model: MODEL_FAST,
      messages: [
        {
          role: 'system',
          content:
            'You write a morning and evening digest for Hong Kong readers.\n\n' +
            'For each numbered story, write a 40–75 word factual summary.\n\n' +
            'Rules:\n' +
            '• Reflect what the MAJORITY of cited sources report.\n' +
            '• Do NOT start by repeating the headline verbatim.\n' +
            '• Do NOT include details mentioned by only one source.\n' +
            '• Be specific: names, locations, numbers when sources agree.\n\n' +
            'Reply with ONLY a numbered list — one summary per line:\n' +
            '1. [40-75 word summary]\n' +
            '2. [40-75 word summary]\n' +
            '...\n' +
            'No preamble, no extra text, no markdown.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: Math.max(2048, 150 * clusters.length),
    });

    // Parse "N. summary text" lines — robust to any leading/trailing text
    // Gemini might add. Indices are 1-based in the response.
    for (const line of content.split('\n')) {
      const m = line.match(/^(\d+)\.\s+(.+)/);
      if (m) {
        const idx = parseInt(m[1], 10) - 1;
        const text = m[2].trim();
        // Reject if below the 40-word minimum we asked for (with a small buffer
        // for LLM word-count imprecision). A sub-35-word response is a title echo
        // or a refusal, not a real summary.
        if (idx >= 0 && idx < clusters.length && text.split(/\s+/).length >= 35) {
          summaries[idx] = text;
        }
      }
    }
  } catch (e) {
    console.warn('[llm] summarizeClusters error:', e.message);
    // summaries array stays all-null; pickFallbackSummary fills each below
  }

  return clusters.map((c, i) => ({
    ...c,
    summary: summaries[i] ?? pickFallbackSummary(c),
  }));
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
    /\bmy\b/i, /\bme\b/i, /\bi ['']ve\b/i,
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
