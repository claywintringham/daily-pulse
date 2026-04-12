// ── Cross-source story clustering ─────────────────────────────────────────────
// Stage 2 of 2 in the matching pipeline.
// Groups DOM-ranked items from DIFFERENT sources into story clusters.
// Produces a `clusterConfidence` score per cluster.
// This is SEPARATE from within-source enrichment matching (matcher.js).

import { normaliseTitle, jaccard } from './matcher.js';

const CLUSTER_THRESHOLD = 0.15; // Jaccard ≥ this → same story (lowered to catch HK local stories with few shared tokens)

/**
 * Build clusters from all source adapter results.
 *
 * Input:  adapterResults[] — each has { sourceId, label, bucket, isPaywalled,
 *                                        items[{ rank, title, articleUrl,
 *                                                publishedAt, matchConfidence }] }
 *
 * Output: clusters[] — each cluster:
 * {
 *   id:                string (uuid-style),
 *   bucket:            'international' | 'local',
 *   headline:          string  (most frequent / longest title among members),
 *   members: [{
 *     sourceId, label, isPaywalled, rank, title, articleUrl,
 *     publishedAt, matchConfidence, scrapeConfidence
 *   }],
 *   clusterConfidence: 'high' | 'medium' | 'low',
 *   qualificationRank: number (3, 4, 5, or 6 — which expansion level qualified it),
 *   freeSourceCount:   number,
 *   baseScore:         number,
 * }
 */
export function buildClusters(adapterResults) {
  // Flatten all items, tagging them with their source metadata
  const allItems = [];
  for (const src of adapterResults) {
    if (!src.items?.length) continue;
    for (const item of src.items) {
      allItems.push({
        ...item,
        sourceId:        src.sourceId,
        label:           src.label,
        bucket:          src.bucket,
        isPaywalled:     src.isPaywalled,
        scrapeConfidence:src.scrapeConfidence,
        tokens:          normaliseTitle(item.title),
      });
    }
  }

  // Greedy single-link clustering
  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < allItems.length; i++) {
    if (assigned.has(i)) continue;

    const cluster = [allItems[i]];
    assigned.add(i);

    for (let j = i + 1; j < allItems.length; j++) {
      if (assigned.has(j)) continue;
      // Don't cluster two items from the same source
      if (allItems[j].sourceId === allItems[i].sourceId) continue;

      const sim = jaccard(allItems[i].tokens, allItems[j].tokens);
      if (sim >= CLUSTER_THRESHOLD) {
        cluster.push(allItems[j]);
        assigned.add(j);
      }
    }

    clusters.push(cluster);
  }

  // Convert raw clusters to structured objects
  return clusters.map((members, idx) => {
    const headline    = pickBestHeadline(members);
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

/**
 * Pick the representative headline for a cluster using Jaccard centroid.
 *
 * Strategy:
 *   1. Restrict candidates to non-paywalled, high/medium confidence sources.
 *   2. Among those candidates, pick the title with the highest average
 *      Jaccard similarity to all other candidate titles — i.e. the title
 *      that best represents the "common thread" of the story rather than
 *      a niche angle from one source.
 *   3. Falls back to the single candidate / full member pool if needed.
 *
 * Each member still has its `tokens` set attached at this point (stripped
 * later in buildClusters before the cluster object is returned).
 */
function pickBestHeadline(members) {
  if (members.length === 1) return members[0].title;

  // Prefer non-paywalled + high/medium confidence sources
  const primary = members.filter(
    m => !m.isPaywalled &&
         (m.scrapeConfidence === 'high' || m.scrapeConfidence === 'medium')
  );
  const free       = members.filter(m => !m.isPaywalled);
  const candidates = primary.length ? primary : free.length ? free : members;

  if (candidates.length === 1) return candidates[0].title;

  // Jaccard centroid: highest average pairwise similarity
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

// ── HK story detection ────────────────────────────────────────────────────────
// A story is local when its SUBJECT MATTER is Hong Kong — regardless of which
// outlet covers it. Signals therefore cover geography AND entities: if the
// story is about a HK company, HK institution, HK infrastructure, or a HK
// person/event, it belongs in the local digest even when an international
// outlet (CNBC, BBC, AP) files the article.
const HK_SIGNALS = [
  // ── Place names ──────────────────────────────────────────────────────────
  'hong kong', 'hongkong', 'kowloon', 'lantau', 'new territories',
  'wan chai', 'causeway bay', 'mong kok', 'yau ma tei', 'sha tin',
  'tuen mun', 'tai po', 'sai kung', 'tung chung', 'tsim sha tsui',
  'sheung wan', 'central hk', 'admiralty', 'north point', 'quarry bay',
  'kai tak', 'chek lap kok', 'tseung kwan o', 'west kowloon',
  'aberdeen hk', 'stanley hk', 'repulse bay', 'clear water bay',
  'victoria harbour', 'victoria peak', 'cross-harbour',

  // ── Abbreviations (padded to avoid false matches e.g. "think") ───────────
  ' hk ', ' hk,', ' hk.', '(hk)', 'hk$', 'hkd', 'hksar',

  // ── Government & political institutions ──────────────────────────────────
  'legco', 'basic law', 'national security law', 'article 23',
  'chief executive', 'financial secretary', 'security bureau',
  'immigration department', 'hong kong police', 'hk police',
  'hkma', 'sfc hk', 'hong kong monetary authority',
  'securities and futures commission',

  // ── Aviation ─────────────────────────────────────────────────────────────
  'cathay pacific', 'hk express', 'hong kong express',
  'greater bay airlines', 'hong kong airlines',
  'hong kong airport', 'hkia', 'airport authority hk',

  // ── Land transport & infrastructure ──────────────────────────────────────
  'mtrc', ' mtr ', 'octopus card', 'airport express',
  'kcr', 'light rail hk', 'citybus', 'kmb ', 'new world first bus',

  // ── Finance & listed companies ────────────────────────────────────────────
  'hang seng', 'hkex', 'hang seng index', ' hsi ',
  'hsbc hk', 'bank of east asia', 'hang seng bank', 'bochk',
  'link reit', 'sun hung kai', 'henderson land', 'new world development',
  'swire pacific', 'swire properties', 'jardine matheson',
  'hutchison', 'cheung kong', 'citic pacific', 'wharf holdings',

  // ── Utilities & services ─────────────────────────────────────────────────
  'clp holdings', 'hk electric', 'towngas', 'cwb',

  // ── Media & entertainment ─────────────────────────────────────────────────
  'tvb', 'now tv hk', 'cable tv hk', 'jockey club', 'hkjc',

  // ── Education & health ────────────────────────────────────────────────────
  ' hku ', 'hkust', 'cuhk', 'polyu hk', 'cityu hk', 'hkbu',
  'hospital authority', 'queen mary hospital', 'prince of wales hospital',
  'princess margaret hospital',
];

/**
 * Return true if the combined headlines of a cluster's members contain
 * recognisable Hong Kong geographic or institutional signals.
 * We intentionally check HEADLINES only — not articleUrls — to avoid
 * false positives where the HK outlet's own domain (e.g. rthk.hk) would
 * cause every RTHK-covered story to appear local regardless of its subject.
 */
function isHongKongStory(members) {
  const text = members.map(m => m.title).join(' ').toLowerCase();
  return HK_SIGNALS.some(s => text.includes(s));
}

/**
 * Determine the dominant bucket for a cluster.
 *
 * Rules (in order):
 *   1. Clear majority  → use the majority bucket (most sources agree).
 *   2. Tie             → determine by story location:
 *        • Story takes place in Hong Kong → 'local'
 *        • Story does not → 'international'
 *
 * This means a story covered equally by international and local sources
 * is classified by WHERE it happened, not by which source happened to be
 * processed first.
 */
function majorityBucket(members) {
  const counts = {};
  for (const m of members) counts[m.bucket] = (counts[m.bucket] || 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  // Clear majority — no ambiguity
  if (sorted.length === 1 || sorted[0][1] > sorted[1][1]) return sorted[0][0];

  // Tie: resolve by story geography
  return isHongKongStory(members) ? 'local' : 'international';
}
