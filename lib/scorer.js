// ── Story qualification and scoring ──────────────────────────────────────────
// Implements the bucketed scoring model:
//   1. Qualification: story must appear in top N positions of ≥ 2 free sources
//      (measured in effective votes — see cross-bucket rule below).
//      N expands through [3, 4, 5, 6]; ALL expansion levels are collected,
//      not just the first non-empty one, so stories at rank 6 can coexist
//      with stories at rank 3 in the same digest.
//   2. Base score: Σ (weight/rank) across rank-confirmed free sources.
//      Cross-bucket rule: an international source covering a local story
//      contributes 2× weight (elevated) — its editors chose to surface a
//      HK story globally, which is a strong editorial signal. Conversely,
//      a local source covering an international story contributes 1× (normal).
//   3. Bonus: paywalled sources add 0.5× or 1.0× weight depending on
//      match confidence, applied only AFTER qualification.
//   4. Sort: lower qualificationRank first, then higher totalScore.

/** Score and rank clusters within one bucket (international or local). */
export function scoreClusters(clusters, bucket) {
  const bucketClusters = clusters.filter(c => c.bucket === bucket);

  // Collect qualifying stories across ALL expansion levels.
  // Earlier levels (rank 3) outrank later ones (rank 6), but stories from
  // different levels can coexist — we never stop early.
  const allScored = [];
  const seen = new Set();

  for (const maxRank of [3, 4, 5, 6]) {
    const qualified = qualify(bucketClusters, maxRank);
    for (const c of qualified) {
      if (seen.has(c.id)) continue; // already captured at a tighter rank
      seen.add(c.id);
      allScored.push({
        ...c,
        baseScore:         computeBaseScore(c, maxRank),
        bonusScore:        computeBonusScore(c),
        qualificationRank: maxRank,
      });
    }
  }

  if (allScored.length === 0) return [];

  // Sort: lower qualificationRank first, then higher totalScore
  allScored.sort((a, b) => {
    if (a.qualificationRank !== b.qualificationRank)
      return a.qualificationRank - b.qualificationRank;
    return (b.baseScore + b.bonusScore) - (a.baseScore + a.bonusScore);
  });

  return allScored;
}

/**
 * Filter clusters that reach ≥ 2 effective votes from rank-confirmed free
 * sources within the given maxRank threshold.
 *
 * Cross-bucket rule (local bucket only):
 *   An international source covering a local story = 2 effective votes.
 *   This means a single international outlet mention is sufficient to qualify
 *   a local story — international editors are selective about which HK stories
 *   they surface globally, making their coverage a strong editorial signal.
 *
 *   A local source covering an international story = 1 vote (normal weight).
 */
function qualify(clusters, maxRank) {
  return clusters.filter(cluster => {
    const freeWithinRank = cluster.members.filter(m =>
      !m.isPaywalled &&
      m.rank <= maxRank &&
      (m.scrapeConfidence === 'high' || m.scrapeConfidence === 'medium')
    );

    const effectiveVotes = freeWithinRank.reduce((sum, m) => {
      const intlCoversLocal =
        cluster.bucket === 'local' && m.bucket === 'international';
      return sum + (intlCoversLocal ? 2 : 1);
    }, 0);

    if (effectiveVotes >= 2) return true;

    // Breaking-news singleton override: a single high-confidence source
    // ranked #1 is trusted enough to qualify alone. This covers the window
    // between a story breaking and a second source picking it up.
    if (effectiveVotes === 1) {
      const top = freeWithinRank.find(m => m.rank === 1 && m.scrapeConfidence === 'high');
      if (top) return true;
    }

    return false;
  });
}

/**
 * Base score = Σ (weight / rank) for all rank-confirmed free members.
 *
 * Weight is 2× when an international source covers a local story,
 * 1× in all other cases (including local source covering international).
 */
function computeBaseScore(cluster, maxRank) {
  return cluster.members
    .filter(m =>
      !m.isPaywalled &&
      m.rank <= maxRank &&
      (m.scrapeConfidence === 'high' || m.scrapeConfidence === 'medium')
    )
    .reduce((sum, m) => {
      const weight = (cluster.bucket === 'local' && m.bucket === 'international')
        ? 2.0
        : 1.0;
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
// Live blogs and video pages make poor primary read destinations:
// live blogs have ephemeral content and video pages lack prose.
// Prefer regular article URLs; fall back to these only if nothing else exists.
const POOR_READ_URL_RE = /\/(live[-/]|live-updates|live-blog|liveblog)|\/video(s)?\/|\/(watch)\//i;

export function pickStoryUrl(cluster) {
  const free = cluster.members
    .filter(m => !m.isPaywalled && m.articleUrl)
    .sort((a, b) => {
      // Prefer regular article URLs over live blogs / video pages
      const aWeak = POOR_READ_URL_RE.test(a.articleUrl) ? 1 : 0;
      const bWeak = POOR_READ_URL_RE.test(b.articleUrl) ? 1 : 0;
      if (aWeak !== bWeak) return aWeak - bWeak;
      const conf = { high: 0, medium: 1, low: 2 };
      const cd = (conf[a.matchConfidence] ?? 2) - (conf[b.matchConfidence] ?? 2);
      return cd !== 0 ? cd : a.rank - b.rank;
    });
  return free[0]?.articleUrl ?? null;
}

/**
 * Build the sources[] array for the digest response.
 * UI chip rules:
 *   paywalled              → unlinked chip with 🔒
 *   free with articleUrl   → linked chip
 *   free without articleUrl→ unlinked chip (no lock)
 *
 * Deduplication: one chip per outlet. When the same source contributes
 * multiple matching articles (e.g. The Guardian #1, #2, #3), keep only the
 * best-ranked member so the UI never shows repeated source names.
 */
export function buildSourceChips(cluster) {
  // Deduplicate: one entry per outlet label, keeping the lowest rank (best position)
  const best = new Map();
  for (const m of cluster.members) {
    const existing = best.get(m.label);
    if (!existing || m.rank < existing.rank) best.set(m.label, m);
  }
  return [...best.values()]
    .sort((a, b) => a.rank - b.rank)
    .map(m => ({
      name:      m.label,
      position:  m.rank,
      url:       m.isPaywalled ? null : (m.articleUrl ?? null),
      paywalled: m.isPaywalled,
    }));
}
