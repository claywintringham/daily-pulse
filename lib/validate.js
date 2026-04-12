// ── Adapter output validation and drift detection ────────────────────────────
// Called after every adapter run.  Returns scrapeConfidence and an array of
// warnings.  Confidence drives whether a source counts toward qualification.

import { redis } from './redis.js';

const DRIFT_TTL  = 60 * 60 * 24; // store baseline for 24 h
const DRIFT_KEY  = (id) => `drift:${id}`;

/**
 * Validate a raw list of scraped items from one source adapter.
 * Returns { scrapeConfidence: 'high'|'medium'|'low'|'none', warnings: [] }
 */
export function validateItems(sourceId, items, expectedDomain) {
  const warnings = [];

  if (!items || items.length === 0) {
    return { scrapeConfidence: 'none', warnings: ['No items returned'] };
  }

  // 1. Minimum item count
  if (items.length < 3) {
    warnings.push(`Only ${items.length} items (need ≥ 3)`);
  }

  // 2. Domain check — all article URLs should belong to the source domain
  if (expectedDomain) {
    const offDomain = items.filter(i => i.articleUrl && !i.articleUrl.includes(expectedDomain));
    if (offDomain.length > items.length / 2) {
      warnings.push(`>50% of URLs are off-domain (expected ${expectedDomain})`);
    }
  }

  // 3. Non-empty, meaningful titles
  const badTitles = items.filter(i => !i.title || i.title.trim().length < 12);
  if (badTitles.length > items.length / 2) {
    warnings.push('More than half of titles are empty or too short');
  }

  // 4. Top-3 should look like articles, not nav links
  const navWords = /^(home|news|sport|weather|about|contact|subscribe|login|search|menu|more)$/i;
  const top3NavLike = items.slice(0, 3).filter(i => navWords.test(i.title?.trim() ?? ''));
  if (top3NavLike.length > 0) {
    warnings.push('Top items look like navigation links, not articles');
  }

  // 5. No duplicate titles in top items
  const topTitles = items.slice(0, 5).map(i => i.title?.trim().toLowerCase());
  const dupes = topTitles.filter((t, idx) => topTitles.indexOf(t) !== idx);
  if (dupes.length > 0) {
    warnings.push(`Duplicate titles in top 5: ${dupes.join(', ').substring(0, 60)}`);
  }

  const confidence =
    warnings.length === 0 ? 'high'   :
    warnings.length === 1 ? 'medium' :
                            'low';

  return { scrapeConfidence: confidence, warnings };
}

/**
 * Compare current scrape result against stored baseline.
 * Returns true if the shape has materially changed (possible scraper drift).
 */
export async function checkDrift(sourceId, items) {
  const key  = DRIFT_KEY(sourceId);
  const prev = await redis.get(key);

  // Store current as new baseline (24-h TTL)
  const snapshot = items.slice(0, 5).map(i => i.title?.trim().substring(0, 60));
  await redis.set(key, snapshot, DRIFT_TTL);

  if (!prev || !Array.isArray(prev)) return false; // no baseline yet

  // Count how many of the previous top-5 titles are completely absent now
  const prevSet = new Set(prev.map(t => t?.toLowerCase()));
  const overlap = snapshot.filter(t => prevSet.has(t?.toLowerCase())).length;
  const overlapRatio = overlap / Math.max(prev.length, 1);

  // If fewer than 1 out of 5 titles overlap, flag as drift
  // (some turnover is normal; zero overlap suggests something is wrong)
  return overlapRatio === 0 && prev.length >= 3;
}
