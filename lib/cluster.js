// ── Cross-source story clustering ─────────────────────────────────────────────
// Stage 2 of 2 in the matching pipeline.
// Groups DOM-ranked items from DIFFERENT sources into story clusters.
// Produces a `clusterConfidence` score per cluster.
// This is SEPARATE from within-source enrichment matching (matcher.js).

import { normaliseTitle, jaccard } from './matcher.js';

const CLUSTER_THRESHOLD = 0.35; // Jaccard ≥ this → same story (tunable)

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
 *   qualificationRank: number (3, 4, or 5 — which expansion level qualified it),
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

/** Pick the representative headline for a cluster. */
function pickBestHeadline(members) {
  // Prefer a high scrapeConfidence member's title; fallback to longest
  const highConf = members.filter(m =>
    m.scrapeConfidence === 'high' && !m.isPaywalled
  );
  const pool = highConf.length ? highConf : members;
  return pool.reduce((best, m) => (m.title.length > best.title.length ? m : best), pool[0]).title;
}

function majorityBucket(members) {
  const counts = {};
  for (const m of members) counts[m.bucket] = (counts[m.bucket] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}
