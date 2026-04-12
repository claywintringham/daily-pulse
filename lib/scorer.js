// ── Story qualification and scoring ──────────────────────────────────────────
// Implements the bucketed scoring model:
//   1. Qualification: story must appear in top N positions of ≥ 3 free sources.
//      N starts at 3, expands to 4, then 5 if nothing qualifies.
//   2. Base score: Σ (1/rank) across rank-confirmed free sources.
//   3. Bonus:       paywalled sources add 0.5× or 1.0× weight depending on
//      match confidence, applied only AFTER qualification.
//   4. Top-3 qualifiers always outrank top-4, which always outrank top-5.

/** Score and rank clusters within one bucket (international or local). */
export function scoreClusters(clusters, bucket) {
  const bucketClusters = clusters.filter(c => c.bucket === bucket);

  // Try expansion levels in order: top-3, top-4, top-5
  for (const maxRank of [3, 4, 5]) {
    const qualified = qualify(bucketClusters, maxRank);
    if (qualified.length > 0) {
      const scored = qualified.map(c => ({
        ...c,
        baseScore:        computeBaseScore(c, maxRank),
        bonusScore:       computeBonusScore(c),
        qualificationRank:maxRank,
      }));
      // Sort: lower qualificationRank first, then higher totalScore
      scored.sort((a, b) => {
        if (a.qualificationRank !== b.qualificationRank)
          return a.qualificationRank - b.qualificationRank;
        return (b.baseScore + b.bonusScore) - (a.baseScore + a.bonusScore);
      });
      return scored;
    }
  }

  return []; // nothing qualified at any expansion level
}

/**
 * Filter clusters that have ≥ 3 rank-confirmed free-source members
 * within the given maxRank threshold.
 */
function qualify(clusters, maxRank) {
  return clusters.filter(cluster => {
    const confirmedFreeWithinRank = cluster.members.filter(m =>
      !m.isPaywalled &&
      m.rank <= maxRank &&
      (m.scrapeConfidence === 'high' || m.scrapeConfidence === 'medium')
    );
    return confirmedFreeWithinRank.length >= 3;
  });
}

/**
 * Base score = Σ (1 / rank) for all rank-confirmed free members.
 * Higher rank (closer to 1) → higher contribution.
 */
function computeBaseScore(cluster, maxRank) {
  return cluster.members
    .filter(m =>
      !m.isPaywalled &&
      m.rank <= maxRank &&
      (m.scrapeConfidence === 'high' || m.scrapeConfidence === 'medium')
    )
    .reduce((sum, m) => sum + 1 / m.rank, 0);
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
        m.matchConfidence === 'high'   ? 1.0 :
        m.matchConfidence === 'medium' ? 0.5 : 0;
      return sum + weight * (1 / (m.rank || 99));
    }, 0);
}

/**
 * Determine the best source URL to surface for a story.
 * Returns the URL from the highest-ranked, high-confidence, free member.
 */
export function pickStoryUrl(cluster) {
  const candidates = cluster.members
    .filter(m => !m.isPaywalled && m.matchConfidence === 'high' && m.articleUrl)
    .sort((a, b) => a.rank - b.rank);
  return candidates[0]?.articleUrl ?? null;
}

/**
 * Build the sources[] array for the digest response.
 * One entry per member; applies matchConfidence UI rule:
 *   high   → linked chip (url returned)
 *   medium → unlinked chip (url: null)
 *   low    → omit entirely
 */
export function buildSourceChips(cluster) {
  return cluster.members
    .filter(m => m.matchConfidence !== 'low')
    .map(m => ({
      name:      m.label,
      position:  m.rank,
      url:       m.matchConfidence === 'high' ? (m.articleUrl ?? null) : null,
      paywalled: m.isPaywalled,
    }));
}
