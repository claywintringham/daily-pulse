// -- LLM integration (Google Gemini) --
// Three exported functions:
//   1. translateHeadlines  -- translate Chinese -> English (Phase 3 sources)
//   2. clusterHeadlines    -- semantic clustering (replaces Jaccard)
//   3. editorialFilter     -- KEEP / DISCARD quality filter
//   4. summarizeClusters   -- 40-75 word summaries per story
//   5. translateToZh       -- EN -> Traditional Chinese for UI toggle

import { looksLikeNavJunk } from './enricher.js';

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

// -- 1. Translate Chinese headlines ----

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
    console.warn('[llm] translateHeadlines error -- returning originals:', e.message);
    return items;
  }
  const translated = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^(\d+)\.\s+(.+)/);
    if (m) translated[parseInt(m[1], 10) - 1] = m[2].trim();
  }
  return items.map((it, i) => ({ ...it, title: translated[i] ?? it.title }));
}

// -- 2. Cluster headlines using Gemini --
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
                 'Return ONLY valid JSON -- no markdown:\n' +
                 '{"groups":[[0,3,7],[1,4],[2],...]}',
      },
      { role: 'user', content: list },
    ],
    max_tokens: Math.max(4096, items.length * 40),
  });

  const safe = sanitiseForJson(content);
  const json = extractJson(safe, '{', '}');
  if (!json) throw new Error(`No JSON in clusterHeadlines response: ${content.slice(0, 80)}`);
  const { groups } = JSON.parse(json);
  if (!Array.isArray(groups)) throw new Error('groups is not an array');

  // Tolerant validation: deduplicate indices and fill any Gemini missed as singletons.
  const seen = new Set();
  const cleaned = [];
  for (const g of groups) {
    const deduped = g.filter(idx =>
      typeof idx === 'number' && idx >= 0 && idx < items.length && !seen.has(idx)
    );
    deduped.forEach(idx => seen.add(idx));
    if (deduped.length > 0) cleaned.push(deduped);
  }
  for (let i = 0; i < items.length; i++) {
    if (!seen.has(i)) cleaned.push([i]);
  }

  return cleaned;
}

// -- 3. Editorial filter (KEEP / DISCARD only) --

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
                   'Hong Kong -- its people, government, institutions, businesses, or territory. ' +
                   'A HK outlet (RTHK, TVB, SCMP, HKFP) covering a foreign story does NOT make ' +
                   'it a HK story. ' +
                   'Examples to DISCARD from local: school shootings in Turkey, ' +
                   'terrorist attacks in Europe, elections in South Korea, natural disasters in Japan, ' +
                   'Premier League results, US congressional news.\n' +
                   'KEEP if the cluster is a genuine news event with real-world impact.\n\n' +
                   'Note: story grouping is already done -- do NOT merge clusters.\n\n' +
                   'Rules:\n' +
                   '- Every cluster id must appear in exactly one of: keep or discard.\n' +
                   '- Return ONLY valid JSON, no markdown:\n' +
                   '  { "keep": ["id",...], "discard": ["id",...] }',
        },
        { role: 'user', content: JSON.stringify(listing) },
      ],
      max_tokens: Math.max(4096, clusters.length * 80),
    });
    const safe = sanitiseForJson(content);
    const json = extractJson(safe, '{', '}');
    if (!json) throw new Error(`No JSON in editorialFilter: ${content.slice(0, 120)}`);
    result = JSON.parse(json);
  } catch (e) {
    console.warn('[llm] editorialFilter error -- returning all clusters:', e.message);
    return clusters;
  }

  const keepSet    = new Set(result.keep    ?? []);
  const discardSet = new Set(result.discard ?? []);
  return clusters.filter(c => keepSet.has(c.id) && !discardSet.has(c.id));
}

// -- 4. Summarize clusters --

/**
 * Strip web-page chrome that Readability occasionally includes in extracted
 * article text: social share buttons, topic/category tags, author bylines,
 * and nav prefixes. These appear at the START of excerpts before real prose
 * and show through verbatim when Gemini summarisation fails.
 *
 * Returns cleaned text, or the original if the result would be too short.
 */
function cleanExcerpt(raw) {
  if (!raw) return raw;
  let t = raw
    // Social share buttons: "Facebook Tweet Email Link Threads Link Copied! Follow"
    .replace(/\b(?:Facebook|Tweet|Twitter|Email|Threads|WhatsApp|Pinterest|Reddit|LinkedIn)\b[\s,]*/g, '')
    .replace(/\bShare\b(?:\s+\bShare\b)?(?:\s+article)?\s*/gi, '')
    .replace(/\bLink\b(?:\s+\bLink\b)?\s*/g, '')
    .replace(/\bCopied!?\s*/gi, '')
    // "Follow" immediately before a proper noun (e.g. "Copied! Follow Former Virginia...")
    .replace(/\bFollow\s+(?=[A-Z])/g, '')
    // "See all topics" + trailing topic words before next sentence
    .replace(/\bSee\s+all\s+topics?\b[^.]*?(?=[A-Z]|\s*$)/gi, '')
    // "Topic: Unrest, Conflict and War" / "Topics: ..." lines
    .replace(/\bTopics?\s*:\s*[^.\n]+[.\n]?\s*/gi, '')
    // Navigation block "Menu World SECTIONS Iran war..." up to first real sentence
    .replace(/\bMenu\b[\s\S]{0,600}?(?=\b[A-Z][a-z]{3,}\b(?:\s[A-Z][a-z]{3,})?)/s, '')
    // "[Publication] News Home [headline]" prefix (ABC News pattern)
    .replace(/^[A-Z][\w\s]{2,30}\bHome\b\s+/m, '')
    // Author bylines: "By Matthew Doran , Sami Sockol and ABC staff in Gaza"
    .replace(/\bBy\s+[A-Z][a-zA-Z\s,]+?(?:correspondent|reporter|editor|staff|writer)[^\n.]*[.\n]?\s*/gi, '')
    // Collapse excess whitespace
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  // Only use cleaned version if it retains meaningful length
  return t.length >= Math.min(50, raw.length * 0.25) ? t : raw;
}

function pickFallbackSummary(c) {
  const excerpts = Array.isArray(c.articleExcerpts) && c.articleExcerpts.length > 0
    ? c.articleExcerpts
    : (c.articleExcerpt ? [c.articleExcerpt] : []);

  // Concatenate ALL pooled excerpts so we don't lose content when source #1
  // is short. Then take roughly the first 65 words of the combined text,
  // trimmed to a sentence boundary where possible.
  const usable = excerpts
    .filter(e => e && !looksLikeNavJunk(e))
    .map(cleanExcerpt)
    .filter(e => e && e.length > 50);
  if (usable.length > 0) {
    const combined = usable.map(e => e.trim()).join(' ').replace(/\s+/g, ' ').trim();
    if (combined.length > 80) {
      const words = combined.split(/\s+/);
      if (words.length <= 75) return combined;
      const rough = words.slice(0, 65).join(' ');
      const end   = rough.search(/[.!?][^.!?]*$/);
      return end > 0 ? rough.slice(0, end + 1) : rough + '...';
    }
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
    const excerpts = Array.isArray(c.articleExcerpts) && c.articleExcerpts.length
      ? c.articleExcerpts
      : (c.articleExcerpt ? [c.articleExcerpt] : []);

    let body;
    if (excerpts.length >= 2) {
      const labelled = excerpts
        .map((x, j) => `--- Source ${j + 1} ---\n${x}`)
        .join('\n');
      body = `Independent accounts of the same event:\n${labelled}`;
    } else if (excerpts.length === 1) {
      body = `Article: ${excerpts[0]}`;
    } else {
      body = `Source titles: ${[...new Set(c.members.map(m => decodeEntities(m.title)))].join(' / ')}`;
    }
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
            'For each numbered story, synthesise across the provided source descriptions ' +
            '(which are independent accounts of the same event) and write a 40-75 word ' +
            'factual summary in English.\n\n' +
            'Rules:\n' +
            'CRITICAL: Your summary MUST describe the specific event or claim in the headline. ' +
            'If the pooled source descriptions primarily cover related-but-distinct angles ' +
            '(e.g., a blockade when the headline is about diplomatic talks), focus on source ' +
            'content that addresses the headline. If NO source content covers the headline\'s ' +
            'topic, summarise from the source titles only.\n' +
            '* Every summary MUST include at least TWO concrete new facts that are NOT ' +
            'already stated in the headline. A "concrete new fact" means one of: ' +
            'a specific number, date, or statistic; a named third party (person, ' +
            'organisation, country, location) not already in the headline; a direct ' +
            'cause or consequence; a quoted statement or official response; ' +
            'a measurable outcome.\n' +
            '* The following patterns add ZERO new facts and are REJECTED:\n' +
            '    - "X spoke at / attended / opened Y" when both X and Y appear in the headline.\n' +
            '    - "X emphasised / stressed / said that Y is important / ongoing / a priority."\n' +
            '    - Any sentence that merely rephrases the headline with synonyms.\n' +
            '    - Vague modifiers ("significant", "important", "ongoing") without specifics.\n' +
            '* Do NOT paraphrase the headline. Do NOT start by repeating it.\n' +
            '* Prefer facts reported by multiple sources for verification, but include ' +
            'single-source facts if they directly address the headline\'s specific event or claim.\n' +
            '* Be specific: prefer names, locations, numbers when sources agree.\n' +
            '* CRITICAL: base each summary ONLY on the Article(s) or source titles ' +
            'provided -- never draw on outside knowledge or training data.\n' +
            '* If the content looks like navigation/boilerplate junk or is unrelated to ' +
            'the headline, summarise from the source titles only.\n' +
            '* If the provided content gives you NO additional facts beyond what the headline ' +
            'already states, write exactly and only: INSUFFICIENT_CONTENT\n\n' +
            'Reply with ONLY a numbered list -- one entry per line:\n' +
            '1. [summary or INSUFFICIENT_CONTENT]\n2. [summary or INSUFFICIENT_CONTENT]\n...\n' +
            'No preamble, no extra text, no markdown.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: Math.max(2048, 150 * clusters.length),
    });

    const badSig = /\bprovided (?:article|content)\b[\s\S]{0,80}\b(?:does not|doesn.t)\b[\s\S]{0,60}\b(?:contain|include|mention)\b/i;
    const insufficientSig = /^INSUFFICIENT_CONTENT\b/i;

    const THIN_COVERAGE = 'No additional details are available beyond the headline at time of publishing. Follow the source link for the full story.';

    function isTautological(summary, headline) {
      const STOP = new Set(['the','a','an','and','but','or','for','in','of','on','to',
        'at','is','was','are','were','has','had','it','its','this','that','with',
        'from','by','not','no','be','do','did','will','can','have','he','she','they',
        'who','his','her','its','their','says','said']);
      const tok = s => new Set(
        s.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/)
          .filter(w => w.length > 2 && !STOP.has(w))
      );
      const hs = tok(headline);
      const ss = tok(summary);
      if (!hs.size || !ss.size) return false;
      let inter = 0;
      for (const t of ss) if (hs.has(t)) inter++;
      return inter / Math.min(hs.size, ss.size) > 0.65;
    }

    for (const line of content.split('\n')) {
      const m = line.match(/^(\d+)\.\s+(.+)/);
      if (!m) continue;
      const idx  = parseInt(m[1], 10) - 1;
      const text = m[2].trim();
      if (idx < 0 || idx >= clusters.length) continue;
      if (insufficientSig.test(text)) {
        console.log(`[llm] cluster ${clusters[idx].id}: Gemini flagged INSUFFICIENT_CONTENT`);
        summaryMap.set(clusters[idx].id, THIN_COVERAGE);
        continue;
      }
      if (text.split(/\s+/).length < 10) continue;
      if (badSig.test(text)) {
        summaryMap.set(clusters[idx].id, pickFallbackSummary(clusters[idx]));
        continue;
      }
      if (isTautological(text, decodeEntities(clusters[idx].headline))) {
        console.log(`[llm] cluster ${clusters[idx].id}: tautological summary detected, using fallback`);
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

// -- 5. Translate digest to Traditional Chinese --

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
            'natural, newspaper-style Traditional Chinese (\u7e41\u9ad4\u4e2d\u6587).\n' +
            'Keep exactly the same factual content and similar length.\n' +
            'Return ONLY a JSON array in the same order -- no markdown, no extra text:\n' +
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
    console.warn('[llm] translateToZh error -- returning English:', e.message);
    return items;
  }
  return translated;
}
