// ── LLM integration (OpenAI) ──────────────────────────────────────────────────
// Three exported functions:
//   1. translateHeadlines  — gpt-4o-mini, Chinese → English (Phase 3 sources)
//   2. editorialFilter     — gpt-4o, removes non-events, merges false cluster splits
//   3. summarizeClusters   — gpt-4o, writes 40-75 word summaries per story
//
// All calls use a shared openai() helper with a 30 s timeout.
// On parse failures the functions degrade gracefully rather than throwing.

const OPENAI_API = 'https://api.openai.com/v1/chat/completions';

async function openai({ model, messages, temperature = 0.3, max_tokens = 2048 }) {
  const res = await fetch(OPENAI_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body:   JSON.stringify({ model, messages, temperature, max_tokens }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${res.status}: ${err.slice(0, 200)}`);
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

  const content = await openai({
    model: 'gpt-4o-mini',
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

  // Parse: "1. Translated headline\n2. ..."
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
// Asks the LLM to:
//   DISCARD — market data tickers, sports scores, weather, celebrity gossip,
//              listicles, PR/ads, or anything not a genuine news event.
//   KEEP    — genuine events with real-world impact (politics, policy, business,
//              society, international relations, disasters, crime, etc.)
//   MERGE   — pairs/groups that are clearly the same story but were split by the
//              clustering algorithm (e.g. same event, different phrasing).
//
// Returns filtered + merged cluster array.
// On any LLM/parse failure, returns the input unchanged.

export async function editorialFilter(clusters) {
  if (!clusters.length) return clusters;

  const listing = clusters.map(c => ({
    id:       c.id,
    headline: c.headline,
    sources:  c.members.length,
    bucket:   c.bucket,
  }));

  let result;
  try {
    const content = await openai({
      model: 'gpt-4o',
      messages: [
        {
          role:    'system',
          content: 'You are an editorial AI for a Hong Kong news digest. ' +
                   'Given a JSON list of story clusters, decide what to keep, discard, or merge.\n\n' +
                   'DISCARD if the cluster is: market/stock tickers, sports scores, weather, ' +
                   'celebrity gossip, listicles, advertisements, or any non-event.\n' +
                   'KEEP if the cluster is a genuine news event with real-world impact.\n' +
                   'MERGE if two clusters clearly cover the same underlying event ' +
                   '(false split by the clustering algorithm).\n\n' +
                   'Rules:\n' +
                   '- Every cluster id must appear exactly once across keep/discard/merge.\n' +
                   '- Merged cluster ids must NOT also appear in keep or discard.\n' +
                   '- Return ONLY valid JSON, no markdown:\n' +
                   '  { "keep": ["id",...], "discard": ["id",...], "merge": [["id","id"],...] }',
        },
        {
          role:    'user',
          content: JSON.stringify(listing),
        },
      ],
      max_tokens: 1024,
    });

    // Strip potential markdown code fences
    const json = content.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    result = JSON.parse(json);
  } catch (e) {
    console.warn('[llm] editorialFilter parse error — returning all clusters:', e.message);
    return clusters;
  }

  const { keep = [], discard: discard_ = [], merge = [] } = result;
  const keepSet    = new Set(keep);
  const discardSet = new Set(discard_);

  // Build merged clusters
  const mergedClusters = [];
  const mergedIds      = new Set();

  for (const group of merge) {
    if (!Array.isArray(group) || group.length < 2) continue;
    const parts = clusters.filter(c => group.includes(c.id));
    if (parts.length < 2) continue;
    group.forEach(id => mergedIds.add(id));

    const allMembers = parts.flatMap(c => c.members);
    // Pick the longest headline from the highest-confidence source
    const headline = parts.reduce((best, c) =>
      c.headline.length > best.headline.length ? c : best
    ).headline;

    mergedClusters.push({
      ...parts[0],
      id:             `${parts[0].id}-merged`,
      headline,
      members:        allMembers,
      freeSourceCount: allMembers.filter(m => !m.isPaywalled).length,
    });
  }

  // Return: kept originals (excluding those merged away) + merged clusters
  return [
    ...clusters.filter(c => keepSet.has(c.id) && !mergedIds.has(c.id)),
    ...mergedClusters,
  ].filter(c => !discardSet.has(c.id));
}

// ── 3. Summarize clusters ─────────────────────────────────────────────────────
// clusters: final filtered + scored clusters (one bucket).
// Returns same clusters with a `summary` string field added (40-75 words).
// All clusters summarized in a single batched call for efficiency.

export async function summarizeClusters(clusters) {
  if (!clusters.length) return clusters;

  const items = clusters.map(c => ({
    id:       c.id,
    headline: c.headline,
    titles:   [...new Set(c.members.map(m => m.title))], // deduplicated source titles
  }));

  let summaries;
  try {
    const content = await openai({
      model: 'gpt-4o',
      messages: [
        {
          role:    'system',
          content: 'You write a morning and evening news digest for Hong Kong readers. ' +
                   'For each story cluster, write a factual summary of 40–75 words. ' +
                   'Do NOT start with the headline repeated verbatim. ' +
                   'Be specific: mention locations, actors, numbers when available. ' +
                   'Write in plain, readable English suitable for a general audience.\n\n' +
                   'Output ONLY valid JSON — an array of { "id": "...", "summary": "..." } ' +
                   'objects, one per input cluster, preserving the same ids. No markdown.',
        },
        {
          role:    'user',
          content: JSON.stringify(items),
        },
      ],
      max_tokens: 300 * clusters.length, // ~300 tokens per story is generous
    });

    const json = content.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    summaries = JSON.parse(json);
  } catch (e) {
    console.warn('[llm] summarizeClusters parse error — falling back to headlines:', e.message);
    return clusters.map(c => ({ ...c, summary: c.headline }));
  }

  const map = {};
  for (const s of (summaries ?? [])) map[s.id] = s.summary;

  return clusters.map(c => ({ ...c, summary: map[c.id] ?? c.headline }));
}
