// ── Cross-source story clustering ─────────────────────────────────────────────
// Stage 2 of 2 in the matching pipeline.
// Groups DOM-ranked items from DIFFERENT sources into story clusters.
// Produces a `clusterConfidence` score per cluster.
// This is SEPARATE from within-source enrichment matching (matcher.js).

import { normaliseTitle, jaccard } from './matcher.js';

const CLUSTER_THRESHOLD = 0.15;

export function buildClusters(adapterResults) {
  const allItems = [];
  for (const src of adapterResults) {
    if (!src.items?.length) continue;
    for (const item of src.items) {
      allItems.push({
        ...item,
        sourceId: src.sourceId,
        label: src.label,
        bucket: src.bucket,
        isPaywalled: src.isPaywalled,
        scrapeConfidence: src.scrapeConfidence,
        tokens: normaliseTitle(item.title),
      });
    }
  }

  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < allItems.length; i++) {
    if (assigned.has(i)) continue;

    const cluster = [allItems[i]];
    assigned.add(i);

    for (let j = i + 1; j < allItems.length; j++) {
      if (assigned.has(j)) continue;
      if (allItems[j].sourceId === allItems[i].sourceId) continue;

      const sim = jaccard(allItems[i].tokens, allItems[j].tokens);
      if (sim >= CLUSTER_THRESHOLD) {
        cluster.push(allItems[j]);
        assigned.add(j);
      }
    }

    clusters.push(cluster);
  }

  return clusters.map((members, idx) => {
    const headline = pickBestHeadline(members);
    const freeMembers = members.filter(m => !m.isPaywalled);
    const freeRankConfirmed = freeMembers.filter(
      m => m.scrapeConfidence === 'high' || m.scrapeConfidence === 'medium'
    );

    const clusterConfidence =
      freeRankConfirmed.length >= 3 ? 'high' :
      freeRankConfirmed.length >= 2 ? 'medium' : 'low';

    const bucket = classifyStoryBucket(members);

    return {
      id: `cluster-${idx}`,
      bucket,
      headline,
      members: members.map(({ tokens: _t, ...rest }) => rest),
      clusterConfidence,
      freeSourceCount: freeRankConfirmed.length,
      baseScore: 0,
      qualificationRank: null,
    };
  });
}

const SUBJECTIVE_PATTERNS = [
  /\bmy\b/i, /\bme\b/i, /\bi ['']ve\b/i, /\bopinion[:\s]/i,
  /\bcomment[:\s]/i, /\banalysis[:\s]/i, /\binterview[:\s]/i,
  /\blive updates?\b/i, /\blive blog\b/i, /^live:/i, /\bexclusive:/i,
  /\bwatch:/i, /\?$/,
];
function looksSubjective(title) {
  return SUBJECTIVE_PATTERNS.some(p => p.test(title));
}

function pickBestHeadline(members) {
  if (members.length === 1) return members[0].title;
  const noSubj = pool => {
    const f = pool.filter(m => !looksSubjective(m.title));
    return f.length ? f : pool;
  };
  const primary = noSubj(members.filter(m => !m.isPaywalled && (m.scrapeConfidence === 'high' || m.scrapeConfidence === 'medium')));
  const free = noSubj(members.filter(m => !m.isPaywalled));
  const anyNeutral = noSubj(members);
  const candidates = primary.length ? primary : free.length ? free : anyNeutral.length ? anyNeutral : members;
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
  'securities and futures commission', 'cathay pacific', 'hk express',
  'hong kong express', 'greater bay airlines', 'hong kong airlines',
  'hong kong airport', 'hkia', 'airport authority hk', 'mtrc', ' mtr ',
  'octopus card', 'airport express', 'kcr', 'light rail hk', 'citybus',
  'kmb ', 'new world first bus', 'hang seng', 'hkex', 'hang seng index',
  ' hsi ', 'hsbc hk', 'bank of east asia', 'hang seng bank', 'bochk',
  'link reit', 'sun hung kai', 'henderson land', 'new world development',
  'swire pacific', 'swire properties', 'jardine matheson', 'hutchison',
  'cheung kong', 'citic pacific', 'wharf holdings', 'clp holdings',
  'hk electric', 'towngas', 'cwb', 'tvb', 'now tv hk', 'cable tv hk',
  'jockey club', 'hkjc', ' hku ', 'hkust', 'cuhk', 'polyu hk', 'cityu hk',
  'hkbu', 'hospital authority', 'queen mary hospital',
  'prince of wales hospital', 'princess margaret hospital',
];

function isHongKongStory(members) {
  const text = members.map(m => m.title).join(' ').toLowerCase();
  return HK_SIGNALS.some(s => text.includes(s));
}

function classifyStoryBucket(members) {
  // User rule: a story is local only when the subject matter or location is Hong Kong.
  // Coverage by a local outlet alone does not make the story local.
  return isHongKongStory(members) ? 'local' : 'international';
}
