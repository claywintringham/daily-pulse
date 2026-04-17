// ── Cross-source story clustering ─────────────────────────────────────────────
// Stage 2 of 2 in the matching pipeline.
// Groups DOM-ranked items from DIFFERENT sources into story clusters.
// Produces a `clusterConfidence` score per cluster.
// This is SEPARATE from within-source enrichment matching (matcher.js).

import { normaliseTitle, jaccard } from './matcher.js';
// clusterHeadlines is passed as a parameter to avoid a diamond dependency:
// api/digest.js imports both lib/llm.js AND lib/cluster.js, and if
// cluster.js also imported llm.js, esbuild's module ordering would break.

const CLUSTER_THRESHOLD = 0.15; // Jaccard fallback threshold

/**
 * Build clusters from all source adapter results.
 *
 * clusterFn (clusterHeadlines from llm.js) now returns:
 *   { groups: [ { indices: number[], headline: string|null }, ... ] }
 *
 * The Gemini-generated headline per group is used directly as the cluster
 * headline when available; falls back to Jaccard centroid (pickBestHeadline)
 * if Gemini omits a headline or the LLM call fails entirely.
 */
export async function buildClusters(adapterResults, clusterFn = null) {
  // Flatten all items, tagging them with their source metadata
  const allItems = [];
  for (const src of adapterResults) {
    if (!src.items?.length) continue;
    for (const item of src.items) {
      allItems.push({
        ...item,
        sourceId:         src.sourceId,
        label:            src.label,
        bucket:           src.bucket,
        isPaywalled:      src.isPaywalled,
        scrapeConfidence: src.scrapeConfidence,
        tokens:           normaliseTitle(item.title),
      });
    }
  }

  // ── Gemini semantic clustering (with Jaccard fallback) ───────────────────
  let groups; // array of { indices, headline } objects

  try {
    if (!clusterFn) throw new Error('no clusterFn provided — using Jaccard');
    groups = await clusterFn(allItems);
    console.log(`[cluster] Gemini grouped ${allItems.length} items into ${groups.length} clusters`);
  } catch (e) {
    console.warn('[cluster] Gemini clustering failed, falling back to Jaccard:', e.message);
    // Jaccard returns plain arrays — normalise to {indices, headline} shape
    groups = jaccardCluster(allItems).map(indices => ({ indices, headline: null }));
  }

  // Convert groups to member arrays, enforcing one-item-per-source.
  // Groups are now { indices, headline } objects (Gemini) or the normalised Jaccard shape.
  const rawClusters = groups.map(g => {
    const indices        = Array.isArray(g.indices) ? g.indices : (Array.isArray(g) ? g : []);
    const geminiHeadline = (typeof g.headline === 'string' && g.headline.trim().length > 5)
      ? g.headline.trim() : null;

    const members = [];
    const seenSources = new Set();
    const sorted = indices.map(i => allItems[i]).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    for (const item of sorted) {
      if (seenSources.has(item.sourceId)) continue;
      seenSources.add(item.sourceId);
      members.push(item);
    }
    return { members, geminiHeadline };
  }).filter(({ members }) => members.length > 0);

  // Convert raw clusters to structured objects
  return rawClusters.map(({ members, geminiHeadline }, idx) => {
    // Use Gemini-generated headline if available; fall back to Jaccard centroid
    const headline = geminiHeadline || pickBestHeadline(members);
    const freeMembers = members.filter(m => !m.isPaywalled);
    const freeRankConfirmed = freeMembers.filter(
      m => m.scrapeConfidence === 'high' || m.scrapeConfidence === 'medium'
    );

    // clusterConfidence based on how many sources agree
    const clusterConfidence =
      freeRankConfirmed.length >= 3 ? 'high' :
      freeRankConfirmed.length >= 2 ? 'medium' : 'low';

    // Pick dominant bucket (all members should share one; take majority)
    const bucket = majorityBucket(members);

    return {
      id:               `cluster-${idx}`,
      bucket,
      headline,
      members:          members.map(({ tokens: _t, ...rest }) => rest), // strip tokens
      clusterConfidence,
      freeSourceCount:  freeRankConfirmed.length,
      baseScore:        0, // populated by scorer.js
      qualificationRank:null,
    };
  });
}

// ── Jaccard fallback clustering ───────────────────────────────────────────────
function jaccardCluster(allItems) {
  const assigned = new Set();
  const groups   = [];
  for (let i = 0; i < allItems.length; i++) {
    if (assigned.has(i)) continue;
    const group = [i];
    assigned.add(i);
    for (let j = i + 1; j < allItems.length; j++) {
      if (assigned.has(j)) continue;
      if (allItems[j].sourceId === allItems[i].sourceId) continue;
      if (jaccard(allItems[i].tokens, allItems[j].tokens) >= CLUSTER_THRESHOLD) {
        group.push(j);
        assigned.add(j);
      }
    }
    groups.push(group);
  }
  return groups;
}

const SUBJECTIVE_PATTERNS = [
  /\bmy\b/i,
  /\bme\b/i,
  /\bi ['']ve\b/i,
  /\bopinion[:\s]/i,
  /\bcomment[:\s]/i,
  /\banalysis[:\s]/i,
  /\binterview[:\s]/i,
  /\blive updates?\b/i,
  /\blive blog\b/i,
  /^live:/i,
  /\bexclusive:/i,
  /\bwatch:/i,
  /\?$/, // question headlines speculate rather than report facts
];

function looksSubjective(title) {
  return SUBJECTIVE_PATTERNS.some(p => p.test(title));
}

/**
 * Fallback headline picker using Jaccard centroid.
 * Used when Gemini doesn't provide a headline for a group.
 */
function pickBestHeadline(members) {
  if (members.length === 1) return members[0].title;

  const noSubj = pool => {
    const f = pool.filter(m => !looksSubjective(m.title));
    return f.length ? f : pool;
  };

  const primary    = noSubj(members.filter(
    m => !m.isPaywalled &&
         (m.scrapeConfidence === 'high' || m.scrapeConfidence === 'medium')
  ));
  const free       = noSubj(members.filter(m => !m.isPaywalled));
  const anyNeutral = noSubj(members);

  const candidates = primary.length     ? primary :
                     free.length        ? free :
                     anyNeutral.length  ? anyNeutral : members;

  if (candidates.length === 1) return candidates[0].title;

  let bestIdx = 0, bestAvg = -1;
  for (let i = 0; i < candidates.length; i++) {
    let total = 0;
    for (let j = 0; j < candidates.length; j++) {
      if (i !== j) total += jaccard(candidates[i].tokens, candidates[j].tokens);
    }
    const avg = total / (candidates.length - 1);
    if (avg > bestAvg) { bestAvg = avg; bestIdx = i; }
  }
  return candidates[bestIdx].title;
}

// ── HK story detection (used for bucket tie-breaking) ────────────────────────
const HK_SIGNALS = [
  'hong kong', 'hongkong', 'kowloon', 'lantau', 'new territories',
  'wan chai', 'causeway bay', 'mong kok', 'yau ma tei', 'sha tin',
  'tuen mun', 'tai po', 'sai kung', 'tung chung', 'tsim sha tsui',
  'sheung wan', 'central hk', 'admiralty', 'north point', 'quarry bay',
  'kai tak', 'chek lap kok', 'tseung kwan o', 'west kowloon',
  'aberdeen hk', 'stanley hk', 'repulse bay', 'clear water bay',
  'victoria harbour', 'victoria peak', 'cross-harbour',
  ' hk ', ' hk,', ' hk.', '(hk)', 'hk$', 'hkd', 'hksar',
  'legco', 'basic law', 'national security law', 'article 23',
  'chief executive', 'financial secretary', 'security bureau',
  'immigration department', 'hong kong police', 'hk police',
  'hkma', 'sfc hk', 'hong kong monetary authority',
  'securities and futures commission',
  'cathay pacific', 'hk express', 'hong kong express',
  'greater bay airlines', 'hong kong airlines',
  'hong kong airport', 'hkia', 'airport authority hk',
  'mtrc', ' mtr ', 'octopus card', 'airport express',
  'kcr', 'light rail hk', 'citybus', 'kmb ', 'new world first bus',
  'hang seng', 'hkex', 'hang seng index', ' hsi ',
  'hsbc hk', 'bank of east asia', 'hang seng bank', 'bochk',
  'link reit', 'sun hung kai', 'henderson land', 'new world development',
  'swire pacific', 'swire properties', 'jardine matheson',
  'hutchison', 'cheung kong', 'citic pacific', 'wharf holdings',
  'clp holdings', 'hk electric', 'towngas', 'cwb',
  'tvb', 'now tv hk', 'cable tv hk', 'jockey club', 'hkjc',
  ' hku ', 'hkust', 'cuhk', 'polyu hk', 'cityu hk', 'hkbu',
  'hospital authority', 'queen mary hospital', 'prince of wales hospital',
  'princess margaret hospital',
];

function isHongKongStory(members) {
  const text = members.map(m => m.title).join(' ').toLowerCase();
  return HK_SIGNALS.some(s => text.includes(s));
}

function majorityBucket(members) {
  const counts = {};
  for (const m of members) counts[m.bucket] = (counts[m.bucket] || 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 1 || sorted[0][1] > sorted[1][1]) return sorted[0][0];
  return isHongKongStory(members) ? 'local' : 'international';
}
