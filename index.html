// ── Adapter dispatcher ────────────────────────────────────────────────────────
// Routes each source to its specific adapter, or returns a stub result for
// sources whose adapters are not yet implemented.

import { getActiveSources } from '../sourceRegistry.js';
import { validateItems, checkDrift } from '../validate.js';

// Phase 1 — implemented
import { run as runReuters }      from './reuters.js';
import { run as runAp }           from './ap.js';
import { run as runBbc }          from './bbc.js';
import { run as runGuardian }     from './guardian.js';
import { run as runCnbc }         from './cnbc.js';
import { run as runRthk }         from './rthk.js';
import { run as runHkfp }         from './hkfp.js';
import { run as runTheStandard }  from './thestandard.js';

// Phase 2 — international
import { run as runAlJazeera }    from './aljazeera.js';
import { run as runCnn }          from './cnn.js';
import { run as runNbcNews }      from './nbcnews.js';
import { run as runCbsNews }      from './cbsnews.js';
import { run as runDw }           from './dw.js';
import { run as runFrance24 }     from './france24.js';
import { run as runFoxNews }      from './foxnews.js';
import { run as runFoxBusiness }  from './foxbusiness.js';

// Phase 2 — HK local
import { run as runTvbPearl }     from './tvbpearl.js';

// Phase 3 — HK local
import { run as runScmp }         from './scmp.js';

const ADAPTERS = {
  // Phase 1
  reuters:      runReuters,
  ap:           runAp,
  bbc:          runBbc,
  guardian:     runGuardian,
  cnbc:         runCnbc,
  rthk:         runRthk,
  hkfp:         runHkfp,
  thestandard:  runTheStandard,
  // Phase 2
  aljazeera:    runAlJazeera,
  cnn:          runCnn,
  nbcnews:      runNbcNews,
  cbsnews:      runCbsNews,
  dw:           runDw,
  france24:     runFrance24,
  foxnews:      runFoxNews,
  foxbusiness:  runFoxBusiness,
  // Phase 2 — HK local
  tvbpearl:     runTvbPearl,
  // Phase 3
  scmp:         runScmp,
};

/** Stub result for sources without an implemented adapter. */
function stubResult(source) {
  return {
    sourceId:          source.id,
    label:             source.label,
    bucket:            source.bucket,
    isPaywalled:       source.isPaywalled,
    presenceConfirmed: false,
    rankConfirmed:     false,
    rankMethod:        'stub',
    items:             [],
    scrapeConfidence:  'none',
    matchConfidence:   'none',
    error:             'adapter not yet implemented',
  };
}

/**
 * Run all active source adapters in parallel.
 * Returns an array of standardised adapter results.
 * Uses Promise.allSettled so one failure never blocks others.
 */
export async function runAllAdapters() {
  const sources = getActiveSources();

  const tasks = sources.map(async (source) => {
    // Return stub immediately for unimplemented sources
    const adapterFn = ADAPTERS[source.id];
    if (!adapterFn) return stubResult(source);

    try {
      const result = await adapterFn(source);

      // Validate the returned items
      const domainHint = new URL(source.entryUrl).hostname.replace('www.', '');
      const { scrapeConfidence, warnings } = validateItems(source.id, result.items, domainHint);
      if (warnings.length) console.warn(`[${source.id}] validation warnings:`, warnings);

      // Drift detection (non-blocking — fire and forget)
      checkDrift(source.id, result.items).then(drifted => {
        if (drifted) console.warn(`[${source.id}] DRIFT DETECTED — selectors may need update`);
      }).catch(() => {});

      return {
        ...result,
        label:       source.label,
        bucket:      source.bucket,
        isPaywalled: source.isPaywalled,
        rssUrl:      source.rssUrl,
        scrapeConfidence,
        warnings,
      };
    } catch (err) {
      console.error(`[${source.id}] adapter threw:`, err.message);
      return {
        ...stubResult(source),
        scrapeConfidence: 'none',
        error: err.message,
      };
    }
  });

  const settled = await Promise.allSettled(tasks);
  return settled.map(r => r.status === 'fulfilled' ? r.value : {
    sourceId: 'unknown', scrapeConfidence: 'none', items: [], error: r.reason?.message,
  });
}
