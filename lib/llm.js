// ── LLM integration (Google Gemini) ──────────────────────────────────────────────
// Exported functions:
//   1. translateHeadlines  — translate Chinese → English (Phase 3 sources)
//   2. clusterHeadlines    — semantic clustering + per-cluster headline generation
//   3. editorialFilter     — bucket-aware KEEP / DISCARD filter
//   4. summarizeClusters   — 60-80 word summaries from articleExcerpts[]
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

// ── 1. Translate Chinese headlines ──────────────────────────────────────────

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

// ── 2. Cluster headlines + generate per-cluster headline ────────────────────
// Returns array of { indices: number[], headline: string|null }

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
                 'For each group, also generate a concise factual headline (10-15 words) that:\n' +
                 '- States the key fact clearly and specifically\n' +
                 '- Is declarative: not a question, not starting with Analysis:, Live:, Opinion:\n' +
                 '- Based only on the article titles provided; no outside knowledge\n' +
                 '- Includes names, places, or figures if present\n\n' +
                 'Return ONLY valid JSON, no markdown:\n' +
                 '{"groups":[{"indices":[0,3,7],"headline":"Generated headline"},{"indices":[1,4],"headline":"..."},...]}',
      },
      { role: 'user', content: list },
    ],
    max_tokens: Math.max(1024, items.length * 14),
  });

  const safe = sanitiseForJson(content);
  const json = extractJson(safe, '{', '}');
  if (!json) throw new Error(`No JSON in clusterHeadlines response: ${content.slice(0, 80)}`);
  const { groups } = JSON.parse(json);
  if (!Array.isArray(groups)) throw new Error('groups is not an array');

  // Tolerant validation: deduplicate indices and preserve Gemini headline per group.
  const seen = new Set();
  const cleaned = [];
  for (const g of groups) {
    const rawIndices = Array.isArray(g.indices) ? g.indices : (Array.isArray(g) ? g : []);
    const headline   = (typeof g.headline === 'string' && g.headline.trim()) || null;
    const deduped    = rawIndices.filter(idx =>
      typeof idx === 'number' && idx >= 0 && idx < items.length && !seen.has(idx)
    );
    deduped.forEach(idx => seen.add(idx));
    if (deduped.length > 0) cleaned.push({ indices: deduped, headline });
  }
  // Any articles Gemini omitted become their own singleton cluster (no headline)
  for (let i = 0; i < items.length; i++) {
    if (!seen.has(i)) cleaned.push({ indices: [i], headline: null });
  }

  return cleaned;
}

// ── 3. Editorial filter — bucket-aware ──────────────────────────────────────
// International: discard only HK stories.
// Local: keep only HK stories.

export async function editorialFilter(clusters, bucket = 'international') {
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
          content: bucket === 'international'
            ? 'You are an editorial AI for a Hong Kong news digest.\n\n' +
              'Given clusters for the INTERNATIONAL section, decide what to KEEP or DISCARD.\n\n' +
              'DISCARD only if the story is about Hong Kong — it takes place in Hong Kong, or is about ' +
              'HK subject matter (HK people, companies, government, institutions, geography, or events). ' +
              'A story filed by a HK outlet about a foreign event is NOT a HK story and should be KEPT.\n\n' +
              'KEEP everything else — politics, business, technology, science, sport, weather, finance ' +
              'or any other topic — as long as it is not primarily about Hong Kong.\n\n' +
              'Rules:\n- Every cluster id must appear in exactly one of: keep or discard.\n' +
              '- Return ONLY valid JSON, no markdown: { "keep": ["id",...], "discard": ["id",...] }'
            : 'You are an editorial AI for a Hong Kong news digest.\n\n' +
              'Given clusters for the LOCAL (Hong Kong) section, decide what to KEEP or DISCARD.\n\n' +
              'KEEP only if the story is genuinely about Hong Kong — takes place in HK, or is about HK ' +
              'subject matter (HK people, companies, government, institutions, geography, or events).\n\n' +
              'DISCARD if the story is not about Hong Kong, even if reported by a HK outlet. ' +
              'RTHK or TVB articles about foreign elections, natural disasters, or sports results ' +
              'should be discarded unless they have a direct HK angle.\n\n' +
              'Rules:\n- Every cluster id must appear in exactly one of: keep or discard.\n' +
              '- Return ONLY valid JSON, no markdown: { "keep": ["id",...], "discard": ["id",...] }',
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

// ── 4. Summarize clusters — 60-80 words from articleExcerpts[] ───────────────

function pickFallbackSummary(c) {
  const excerpts = c.articleExcerpts ?? (c.articleExcerpt ? [c.articleExcerpt] : []);
  if (excerpts.length > 0 && excerpts[0].length > 80) {
    const words = excerpts[0].trim().split(/\s+/);
    if (words.length <= 80) return excerpts[0].trim();
    const rough = words.slice(0, 80).join(' ');
    const end   = rough.search(/[.!?][^.!?]*$/);
    return end > 0 ? rough.slice(0, end + 1) : rough + '…';
  }
  const SKIP = [
    /\bmy\b/i, /\bme\b/i, /\bi [''']ve\b/i, /\bopinion[:\s]/i, /\bcomment[:\s]/i,
    /\banalysis[:\s]/i, /\binterview[:\s]/i, /\bexplainer[:\s]/i,
    /\blive updates?\b/i, /\blive blog\b/i, /^live:/i, /\blive:/i,
    /\bwatch:/i, /\bexclusive:/i, /\?$/, /^day \d+\b/i,
  ];
  const isBad = t => SKIP.some(p => p.test(t));
  const titles = (c.members ?? []).map(m => decodeEntities(m.title))
    .filter(t => t && t.length > 10 && !isBad(t));
  if (!titles.length) return decodeEntities(c.members?.[0]?.title ?? c.headline);
  return titles.reduce((best, t) => t.length > best.length ? t : best, titles[0]);
}

export async function summarizeClusters(clusters) {
  if (!clusters.length) return clusters;

  const prompt = clusters.map((c, i) => {
    const excerpts = (c.articleExcerpts?.length)
      ? c.articleExcerpts.slice(0, 5).map((a, j) => `   Article ${j + 1}: ${a}`).join('\n')
      : `   Source titles: ${[...new Set(c.members.map(m => decodeEntities(m.title)))].join(' / ')}`;
    return `${i + 1}. Headline: ${decodeEntities(c.headline)}\n${excerpts}`;
  }).join('\n\n');

  const summaryMap = new Map();

  try {
    const content = await gemini({
      model: MODEL_FAST,
      messages: [
        {
          role: 'system',
          content:
            'You write concise news summaries for a Hong Kong digest.\n\n' +
            'For each numbered story, write a 60-80 word factual summary in English.\n\n' +
            'Rules:\n' +
            '- CRITICAL: Base your summary ONLY on the article excerpts provided. ' +
            'Do NOT use any outside knowledge or information from your training data.\n' +
            '- If the provided articles do not contain enough information to reach 60 words, ' +
            'draw on as many of the provided articles as needed.\n' +
            '- Do NOT start by repeating the headline verbatim.\n' +
            '- Be specific: include names, locations, and figures exactly as they appear in the articles.\n' +
            '- Write in plain declarative sentences.\n\n' +
            'Reply with ONLY a numbered list — one summary per line:\n' +
            '1. [summary]\n2. [summary]\n...\n' +
            'No preamble, no extra text, no markdown.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: Math.max(2048, 200 * clusters.length),
    });

    const badSig = /\bprovided (?:article|content)\b[\s\S]{0,80}\b(?:does not|doesn.t)\b[\s\S]{0,60}\b(?:contain|include|mention)\b/i;

    for (const line of content.split('\n')) {
      const m = line.match(/^(\d+)\.\s+(.+)/);
      if (!m) continue;
      const idx  = parseInt(m[1], 10) - 1;
      const text = m[2].trim();
      if (idx < 0 || idx >= clusters.length) continue;
      if (text.split(/\s+/).length < 10) continue;
      if (badSig.test(text)) {
        summaryMap.set(clusters[idx].id, pickFallbackSummary(clusters[idx]));
        continue;
      }
      summaryMap.set(clusters[idx].id, text);
    }
  } catch (e) {
    console.warn('[llm] summarizeClusters error:', e.message);
  }

  return clusters.map(c => ({ ...c, summary: summaryMap.get(c.id) ?? pickFallbackSummary(c) }));
}

// ── 5. Translate digest to Traditional Chinese ───────────────────────────────

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
