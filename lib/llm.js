// ── LLM integration (Google Gemini) ──────────────────────────────────────────
// Exported functions:
//   1. translateHeadlines  — translate Chinese → English (Phase 3 sources)
//   2. clusterHeadlines    — semantic clustering (replaces Jaccard)
//   3. editorialFilter     — KEEP / DISCARD quality filter
//   4. summarizeClusters   — 40-75 word summaries per story (no placeholder fallback)
//   5. translateToZh       — EN → Traditional Chinese for UI toggle

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
const MODEL_FAST  = 'gemini-2.5-flash';
const MODEL_SMART = 'gemini-2.5-flash';

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
      if (ch.charCodeAt(0) < 0x20) continue;
    }
    out += ch;
  }
  return out;
}

function decodeEntities(text) {
  if (!text) return text;
  return text
    .replace(/&amp;/g,   '&').replace(/&lt;/g,  '<').replace(/&gt;/g,   '>')
    .replace(/&quot;/g,  '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&apos;/g,  "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g,     (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ').trim();
}

// Retry on 429 (rate limit) and 503 (overloaded) with exponential back-off.
async function gemini({ model = MODEL_SMART, messages, temperature = 0.3, max_tokens = 2048 }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY env var not set');

  const BACKOFFS_MS = [3000, 7000, 12000];
  for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
    const res = await fetch(`${GEMINI_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body:   JSON.stringify({ model, messages, temperature, max_tokens }),
      signal: AbortSignal.timeout(30_000),
    });

    if (res.ok) {
      const data = await res.json();
      return data.choices[0].message.content.trim();
    }

    if ((res.status === 429 || res.status === 503) && attempt < BACKOFFS_MS.length) {
      await new Promise(r => setTimeout(r, BACKOFFS_MS[attempt]));
      continue;
    }

    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err.slice(0, 200)}`);
  }
}

// ── 1. Translate Chinese headlines ────────────────────────────────────────────

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

  // Tolerant validation: deduplicate indices and fill any Gemini missed as singletons.
  // Gemini occasionally omits or duplicates indices with large article sets.
  const seen = new Set();
  const cleaned = [];
  for (const g of groups) {
    const deduped = g.filter(idx =>
      typeof idx === 'number' && idx >= 0 && idx < items.length && !seen.has(idx)
    );
    deduped.forEach(idx => seen.add(idx));
    if (deduped.length > 0) cleaned.push(deduped);
  }
  // Any articles Gemini omitted become their own singleton cluster
  for (let i = 0; i < items.length; i++) {
    if (!seen.has(i)) cleaned.push([i]);
  }

  return cleaned;
}

// ── 3. Editorial filter (KEEP / DISCARD only) ─────────────────────────────────
// Gemini clustering handles grouping; this step judges quality only.

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
                   'Note: story grouping is already done — do NOT merge clusters.\n\n' +
                   'Rules:\n' +
                   '- Every cluster id must appear in exactly one of: keep or discard.\n' +
                   '- Return ONLY valid JSON, no markdown:\n' +
                   '  { "keep": ["id",...], "discard": ["id",...] }',
        },
        { role: 'user', content: JSON.stringify(listing) },
      ],
      max_tokens: 2048,
    });
    const safe = sanitiseForJson(content);
    const json = extractJson(safe, '{', '}');
    if (!json) throw new Error(`No JSON in editorialFilter: ${content.slice(0, 120)}`);
    result = JSON.parse(json);
  } catch (e) {
    console.warn('[llm] editorialFilter error — returning all clusters:', e.message);
    return clusters;
  }

  const keepSet    = new Set(result.keep    ?? []);
  const discardSet = new Set(result.discard ?? []);
  return clusters.filter(c => keepSet.has(c.id) && !discardSet.has(c.id));
}

// ── 4. Summarize clusters ─────────────────────────────────────────────────────
//
// Design note: we no longer fall back to a "No additional details available…"
// placeholder, nor to a tautology-detector that rewrites the headline as the
// summary. Callers must pre-filter to clusters that carry a substantive
// articleExcerpt (see lib/enricher.js + api/digest.js). Any cluster that still
// comes back from Gemini without a usable summary is returned with
// `summary: undefined`, and the caller drops it before rendering.

export async function summarizeClusters(clusters) {
  if (!clusters.length) return clusters;

  const prompt = clusters.map((c, i) => {
    const body = c.articleExcerpt
      ? `Article: ${c.articleExcerpt}`
      : `Source titles: ${[...new Set(c.members.map(m => decodeEntities(m.title)))].join(' / ')}`;
    return `${i + 1}. Headline: ${decodeEntities(c.headline)}\n   ${body}`;
  }).join('\n\n');

  const summaryMap = new Map();

  try {
    const content = await gemini({
      model: MODEL_FAST,
      messages: [
        {
          role: 'system',
          content:
            'You write a morning and evening digest for Hong Kong readers.\n\n' +
            'For each numbered story, write a 40–75 word factual summary in English.\n\n' +
            'Rules:\n' +
            '• Reflect what the MAJORITY of cited sources report.\n' +
            '• Do NOT start by repeating the headline verbatim.\n' +
            '• Do NOT include details mentioned by only one source.\n' +
            '• Be specific: names, locations, numbers when sources agree.\n' +
            '• CRITICAL: Base each summary ONLY on the Article or source titles ' +
            'provided — never draw on outside knowledge or training data.\n' +
            '• If the Article content is not relevant to the Headline, ignore it ' +
            'and summarise from the Source titles only.\n\n' +
            'Reply with ONLY a numbered list — one summary per line:\n' +
            '1. [summary]\n2. [summary]\n...\n' +
            'No preamble, no extra text, no markdown.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: Math.max(2048, 150 * clusters.length),
    });

    for (const line of content.split('\n')) {
      const m = line.match(/^(\d+)\.\s+(.+)/);
      if (!m) continue;
      const idx  = parseInt(m[1], 10) - 1;
      const text = m[2].trim();
      if (idx < 0 || idx >= clusters.length) continue;
      if (text.split(/\s+/).length < 10) continue;
      summaryMap.set(clusters[idx].id, text);
    }
  } catch (e) {
    console.warn('[llm] summarizeClusters error:', e.message);
  }

  // Clusters that didn't receive a summary are returned with summary=undefined.
  // api/digest.js filters these out before rendering.
  return clusters.map(c => ({ ...c, summary: summaryMap.get(c.id) }));
}

// ── 5. Translate digest to Traditional Chinese ────────────────────────────────

export async function translateToZh(items) {
  if (!items.length) return items;
  const input = items.map((it, i) => ({ i, headline: it.headline, summary: it.summary || '' }));
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
    const safe   = sanitiseForJson(content);
    const json   = extractJson(safe, '[', ']');
    if (!json) throw new Error(`No JSON array in translation: ${content.slice(0, 120)}`);
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
