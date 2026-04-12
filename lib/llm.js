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
//   3. summarizeClusters   — write 40-75 word summaries per story

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
//   MERGE   — pairs/groups that are the same story split by the clustering algorithm.
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
    // Include individual source titles so the filter can detect false clusters
    // where sources share keywords but are covering different events/angles.
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
                   'MERGE if two clusters clearly cover the same underlying event ' +
                   '(false split by the clustering algorithm).\n\n' +
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

    const json = extractJson(content, '{', '}');
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
    const headline   = parts.reduce((best, c) =>
      c.headline.length > best.headline.length ? c : best
    ).headline;

    mergedClusters.push({
      ...parts[0],
      id:              `${parts[0].id}-merged`,
      headline,
      members:         allMembers,
      freeSourceCount: allMembers.filter(m => !m.isPaywalled).length,
    });
  }

  return [
    ...clusters.filter(c => keepSet.has(c.id) && !mergedIds.has(c.id)),
    ...mergedClusters,
  ].filter(c => !discardSet.has(c.id));
}

// ── 3. Summarize clusters ─────────────────────────────────────────────────────
// clusters: final filtered + scored clusters (one bucket).
// Returns clusters with `headline` replaced by a synthesised common-ground
// headline and a new `summary` string added (40-75 words).
//
// Key requirement: BOTH the headline and summary must reflect the angle that
// ALL or MOST cited sources share — not a niche angle from a single source.
//
// HTML entities are decoded before sending to the LLM so Gemini receives
// clean readable text rather than &amp;, &#39;, etc.

export async function summarizeClusters(clusters) {
  if (!clusters.length) return clusters;

  const items = clusters.map(c => ({
    id:       c.id,
    // Raw headline from the best cluster member — used as context only
    rawHeadline: decodeEntities(c.headline),
    // All source titles so Gemini can identify the common thread
    titles:   [...new Set(c.members.map(m => decodeEntities(m.title)))],
  }));

  let results;
  try {
    const content = await gemini({
      model: MODEL_FAST,
      messages: [
        {
          role:    'system',
          content:
            'You write a morning and evening news digest for Hong Kong readers.\n\n' +
            'For each story cluster you will receive a rawHeadline (from one source) and ' +
            'a titles array (one title per cited source). Your task is to produce:\n\n' +
            '1. HEADLINE — synthesise the angle that ALL or MOST cited sources share. ' +
            'Use the broadest, most neutral factual top-line. ' +
            'Do NOT use an angle that only one source emphasises. ' +
            'Under 15 words.\n\n' +
            '2. SUMMARY — 40–75 words, factual, plain English. ' +
            'Reflect what the majority of cited sources report. ' +
            'Do NOT start by repeating the headline verbatim. ' +
            'Do NOT include details that only one source mentions. ' +
            'Be specific: locations, actors, numbers when most sources agree on them.\n\n' +
            'Output ONLY valid JSON — an array of ' +
            '{ "id": "...", "headline": "...", "summary": "..." } ' +
            'objects, one per input cluster, same ids. No markdown fences.',
        },
        {
          role:    'user',
          content: JSON.stringify(items),
        },
      ],
      max_tokens: Math.max(4096, 250 * clusters.length),
    });

    const arrJson = extractJson(content, '[', ']');
    const objJson = extractJson(content, '{', '}');
    const arrPos  = arrJson ? content.indexOf('[') : Infinity;
    const objPos  = objJson ? content.indexOf('{') : Infinity;
    if (arrJson && arrPos <= objPos) {
      results = JSON.parse(arrJson);
    } else if (objJson) {
      // Gemini returned a single object instead of array — wrap it
      results = [JSON.parse(objJson)];
    } else {
      throw new Error(`No JSON in Gemini response: ${content.slice(0, 120)}`);
    }
  } catch (e) {
    console.warn('[llm] summarizeClusters error — falling back to headlines:', e.message);
    return clusters.map(c => ({ ...c, summary: decodeEntities(c.headline) }));
  }

  const map = {};
  for (const r of (results ?? [])) map[r.id] = r;

  return clusters.map(c => {
    const r = map[c.id];
    return {
      ...c,
      // Replace the raw single-source headline with Gemini's synthesised one
      headline: r?.headline ?? decodeEntities(c.headline),
      summary:  r?.summary  ?? decodeEntities(c.headline),
    };
  });
}
