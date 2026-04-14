// ── LLM integration (Google Gemini) ──────────────────────────────────────────
// Three exported functions:
//   1. translateHeadlines  — translate Chinese → English (Phase 3 sources)
//   2. editorialFilter     — remove non-events, merge false cluster splits
//   3. summarizeClusters   — write neutral headline + 40-75 word summary per story

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

// ── 2. Editorial filter ───────────────────────────────────────────────────────

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
                   'Given a JSON list of story clusters, decide what to keep, discard, or merge.\n\n' +
                   'DISCARD if: market/stock tickers, sports scores or match results (e.g. "Leeds end ' +
                   '45-year wait at Man United"), sports league tables, weather, celebrity gossip, ' +
                   'listicles, newsletter/recap entries (e.g. "Morning Recap", "Daily Digest"), ' +
                   'advertisements, non-events, OR if the cluster\'s source titles ' +
                   'reveal the sources are actually covering DIFFERENT stories that merely share ' +
                   'keywords (false cluster from keyword overlap — e.g. two articles both mention ' +
                   '"Iran" and "prices" but one is about oil markets and one is about inflation).\n' +
                   'For clusters with bucket="local": DISCARD unless the story directly concerns ' +
                   'Hong Kong — its people, government, institutions, businesses, or territory. ' +
                   'A HK outlet (RTHK, TVB, SCMP, HKFP) covering a foreign story does NOT make ' +
                   'it a HK story — discard it from local. ' +
                   'Examples that must be DISCARDED from local: school shootings in Turkey, ' +
                   'terrorist attacks in Europe, elections in South Korea, natural disasters in Japan, ' +
                   'Premier League results, US congressional news. ' +
                   'Only keep local stories where the event takes place in or directly affects Hong Kong.\n' +
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
    const headline   = parts.reduce((best, c) =>
      (c.baseScore || 0) > (best.baseScore || 0) ? c : best
    ).headline;

    mergedClusters.push({
      ...parts[0],
      id:              `${parts[0].id}-merged`,
      headline,
      members:         allMembers,
      freeSourceCount: allMembers.filter(m => !m.isPaywalled).length,
      baseScore:       parts.reduce((s, c) => s + (c.baseScore || 0), 0),
    });
  }

  return [
    ...clusters.filter(c => keepSet.has(c.id) && !mergedIds.has(c.id)),
    ...mergedClusters,
  ].filter(c => !discardSet.has(c.id));
}

// ── 3. Summarize clusters ─────────────────────────────────────────────────────

function pickFallbackSummary(c) {
  if (c.articleExcerpt && c.articleExcerpt.length > 80) {
    const MAX_WORDS = 75;
    const words = c.articleExcerpt.trim().split(/\s+/);
    if (words.length <= MAX_WORDS) return c.articleExcerpt.trim();
    const rough = words.slice(0, MAX_WORDS).join(' ');
    const sentenceEnd = rough.search(/[.!?][^.!?]*$/);
    const cut = sentenceEnd > 0 ? rough.slice(0, sentenceEnd + 1) : rough + '…';
    return cut;
  }

  const SKIP = [
    /\bmy\b/i, /\bme\b/i, /\bi [''']ve\b/i,
    /\bopinion[:\s]/i, /\bcomment[:\s]/i, /\banalysis[:\s]/i, /\binterview[:\s]/i,
    /\bexplainer[:\s]/i,
    /\blive updates?\b/i, /\blive blog\b/i,
    /^live:/i, /\blive:/i,
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

export async function summarizeClusters(clusters) {
  if (!clusters.length) return clusters;

  const prompt = clusters.map(c => {
    const content = c.articleExcerpt
      ? `Article: ${c.articleExcerpt}`
      : `Source titles: ${[...new Set(c.members.map(m => decodeEntities(m.title)))].join(' / ')}`;
    return `[${c.id}] Headline: ${decodeEntities(c.headline)}\n   ${content}`;
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
            'For each story, write a 40–75 word factual summary in English.\n\n' +
            'Rules:\n' +
            '• Reflect what the MAJORITY of cited sources report.\n' +
            '• Do NOT start by repeating the headline verbatim.\n' +
            '• Do NOT include details mentioned by only one source.\n' +
            '• Be specific: names, locations, numbers when sources agree.\n' +
            '• CRITICAL: Base each summary ONLY on the Article or source titles ' +
            'provided — never draw on outside knowledge or training data. ' +
            'If the provided content is insufficient, summarise what IS given ' +
            'without adding anything extra.\n' +
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
      // Only reject clearly empty/single-word responses; accept any real summary
      if (text.split(/\s+/).length < 10) return;
      if (badSig.test(text)) {
        console.warn('[llm] id %s: article mismatch flagged by LLM, using title fallback', id);
        const cluster = clusters.find(c => c.id === id);
        if (cluster) summaryMap.set(id, pickFallbackSummary({ ...cluster, articleExcerpt: null }));
        return;
      }
      summaryMap.set(id, text);
    };

    // Primary: parse "[id] summary" lines — allow optional punctuation after bracket
    for (const line of content.split('\n')) {
      const m = line.match(/^\[([^\]]+)\]\s*[.:–-]?\s*(.+)/);
      if (m) parseLine(m[1].trim(), m[2].trim());
    }

    // Safety fallback: positional parsing if Gemini ignored the [id] format
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
  }

  return clusters.map(c => ({
    ...c,
    summary: summaryMap.get(c.id) ?? pickFallbackSummary(c),
  }));
}

// ── 4. Translate digest to Traditional Chinese ────────────────────────────────

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
