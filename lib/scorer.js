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
 * Filter clusters that have ≥ 2 rank-confirmed free-source members
 * within the given maxRank threshold.
 * (Lowered from 3 to 2 for Phase 1 while source count is small.)
 */
function qualify(clusters, maxRank) {
  return clusters.filter(cluster => {
    const confirmedFreeWithinRank = cluster.members.filter(m =>
      !m.isPaywalled &&
      m.rank <= maxRank &&
      (m.scrapeConfidence === 'high' || m.scrapeConfidence === 'medium')
    );
    return confirmedFreeWithinRank.length >= 2;
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
 * Determine the best source URL to surface for a story ("Read full article" link).
 * Prefers high matchConfidence, but falls back to any free member with an articleUrl
 * so DOM-scraped URLs (which are already article-level links) are never discarded.
 */
export function pickStoryUrl(cluster) {
  const free = cluster.members
    .filter(m => !m.isPaywalled && m.articleUrl)
    .sort((a, b) => {
      // Prefer higher matchConfidence, then lower rank
      const conf = { high: 0, medium: 1, low: 2 };
      const cd = (conf[a.matchConfidence] ?? 2) - (conf[b.matchConfidence] ?? 2);
      return cd !== 0 ? cd : a.rank - b.rank;
    });
  return free[0]?.articleUrl ?? null;
}

/**
 * Build the sources[] array for the digest response.
 * UI chip rules:
 *   high matchConfidence   → linked chip (RSS-confirmed article URL)
 *   medium matchConfidence → linked chip (DOM URL, partially RSS-confirmed)
 *   low matchConfidence    → linked chip if DOM gave us an articleUrl; unlinked if not
 *   paywalled              → always unlinked (url: null), show 🔒 in frontend
 */
export function buildSourceChips(cluster) {
  return cluster.members.map(m => ({
    name:      m.label,
    position:  m.rank,
    url:       m.isPaywalled ? null : (m.articleUrl ?? null),
    paywalled: m.isPaywalled,
  }));
}
