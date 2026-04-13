// ── Story qualification and scoring ──────────────────────────────────────────
// Implements the bucketed scoring model:
//   1. Qualification: story must appear in top N positions of ≥ 2 free sources
//      (measured in effective votes — see cross-bucket rule below).
//      N expands through [3, 4, 5, 6]; ALL expansion levels are collected,
//      not just the first non-empty one, so stories at rank 6 can coexist
//      with stories at rank 3 in the same digest.
//   2. Base score: Σ (weight/rank) across rank-confirmed free sources.
//      Cross-bucket rule: cross-bucket coverage is elevated in both directions.
//      An international source covering a local story contributes 2× weight,
//      and a local source covering an international story also contributes 2×.
//      That reflects a stronger editorial signal when an outlet chooses to
//      surface a story outside its default focus area.
//   3. Bonus: paywalled sources add 0.5× or 1.0× weight depending on
//      match confidence, applied only AFTER qualification.
//   4. Sort: lower qualificationRank first, then higher totalScore.

/** Score and rank clusters within one bucket (international or local). */
export function scoreClusters(clusters, bucket) {
  const bucketClusters = clusters.filter(c => c.bucket === bucket);

  const allScored = [];
  const seen = new Set();

  const rankThresholds = bucket === 'local' ? [3, 4, 5, 6, 7, 8, 9, 10] : [3, 4, 5, 6];
  for (const maxRank of rankThresholds) {
    const qualified = qualify(bucketClusters, maxRank);
    for (const c of qualified) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      allScored.push({
        ...c,
        baseScore: computeBaseScore(c, maxRank),
        bonusScore: computeBonusScore(c),
        qualificationRank: maxRank,
      });
    }
  }

  if (allScored.length === 0) return [];

  allScored.sort((a, b) => {
    if (a.qualificationRank !== b.qualificationRank) {
      return a.qualificationRank - b.qualificationRank;
    }
    return (b.baseScore + b.bonusScore) - (a.baseScore + a.bonusScore);
  });

  return allScored;
}

function isCrossBucketCoverage(cluster, member) {
  return cluster.bucket !== member.bucket;
}

/**
 * Filter clusters that reach ≥ 2 effective votes from rank-confirmed free
 * sources within the given maxRank threshold.
 *
 * Cross-bucket rule:
 *   A source covering a story outside its default bucket counts as 2 votes.
 *   So an international source covering a local story = 2 votes, and a local
 *   source covering an international story = 2 votes.
 */
function qualify(clusters, maxRank) {
  return clusters.filter(cluster => {
    const freeWithinRank = cluster.members.filter(m =>
      !m.isPaywalled &&
      m.rank <= maxRank &&
      (m.scrapeConfidence === 'high' || m.scrapeConfidence === 'medium')
    );

    const effectiveVotes = freeWithinRank.reduce((sum, m) => {
      return sum + (isCrossBucketCoverage(cluster, m) ? 2 : 1);
    }, 0);

    return effectiveVotes >= 2;
  });
}

/**
 * Base score = Σ (weight / rank) for all rank-confirmed free members.
 *
 * Weight is 2× for cross-bucket coverage, 1× otherwise.
 */
function computeBaseScore(cluster, maxRank) {
  return cluster.members
    .filter(m =>
      !m.isPaywalled &&
      m.rank <= maxRank &&
      (m.scrapeConfidence === 'high' || m.scrapeConfidence === 'medium')
    )
    .reduce((sum, m) => {
      const weight = isCrossBucketCoverage(cluster, m) ? 2.0 : 1.0;
      return sum + weight / m.rank;
    }, 0);
}

/**
 * Bonus score from paywalled sources.
 * matchConfidence 'high'   → +1.0 × (1/rank)
 * matchConfidence 'medium' → +0.5 × (1/rank)
 * matchConfidence 'low'    → 0
 */
function computeBonusScore(cluster) {
  return cluster.members
    .filter(m => m.isPaywalled)
    .reduce((sum, m) => {
      const weight =
        m.matchConfidence === 'high' ? 1.0 :
        m.matchConfidence === 'medium' ? 0.5 : 0;
      return sum + weight * (1 / (m.rank || 99));
    }, 0);
}

const POOR_READ_URL_RE = /\/(live[-/]|live-updates|live-blog|liveblog)|\/video(s)?\/|\/(watch)\//i;

export function pickStoryUrl(cluster) {
  const free = cluster.members
    .filter(m => !m.isPaywalled && m.articleUrl)
    .sort((a, b) => {
      const aWeak = POOR_READ_URL_RE.test(a.articleUrl) ? 1 : 0;
      const bWeak = POOR_READ_URL_RE.test(b.articleUrl) ? 1 : 0;
      if (aWeak !== bWeak) return aWeak - bWeak;
      const conf = { high: 0, medium: 1, low: 2 };
      const cd = (conf[a.matchConfidence] ?? 2) - (conf[b.matchConfidence] ?? 2);
      return cd !== 0 ? cd : a.rank - b.rank;
    });
  return free[0]?.articleUrl ?? null;
}

export function buildSourceChips(cluster) {
  const best = new Map();
  for (const m of cluster.members) {
    const existing = best.get(m.label);
    if (!existing || m.rank < existing.rank) best.set(m.label, m);
  }
  return [...best.values()]
    .sort((a, b) => a.rank - b.rank)
    .map(m => ({
      name: m.label,
      position: m.rank,
      url: m.isPaywalled ? null : (m.articleUrl ?? null),
      paywalled: m.isPaywalled,
    }));
}
