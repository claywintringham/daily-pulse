// ── Adapter dispatcher ────────────────────────────────────────────────
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
import { run as runTvb }          from './tvb.js';

// Phase 3 — paywalled international
import { run as runBloomberg }    from './bloomberg.js';
import { run as runFt }           from './ft.js';
import { run as runNyt }          from './nyt.js';
import { run as runWsj }          from './wsj.js';

// Phase 3 — additional international
import { run as runSkyNews }    from './skynews.js';
import { run as runCbcNews }    from './cbcnews.js';
import { run as runTheTimes }   from './thetimes.js';
import { run as runAbcAu }      from './abcau.js';

// Phase 3 — HK local
import { run as runScmp }         from './scmp.js';
import { run as runMingPao }      from './mingpao.js';
import { run as runOncc }         from './oncc.js';
import { run as runHket }         from './hket.js';

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
  tvb:          runTvb,
  // Phase 3 — paywalled international
  bloomberg:    runBloomberg,
  ft:           runFt,
  nyt:          runNyt,
  wsj:          runWsj,
  // Phase 3 — additional international
  skynews:      runSkyNews,
  cbcnews:      runCbcNews,
  thetimes:     runTheTimes,
  abcau:        runAbcAu,
  // Phase 3 — HK local
  scmp:         runScmp,
  mingpao:      runMingPao,
  oncc:         runOncc,
  hket:         runHket,
};

/** Stub result for sources without an implemented adapter. */
function stubResult(source) {
  return {
    sourceId:          source.id,
    label:             source.label,
    bucket:            source.bucket,
    isPaywalled:       source.isPaywalled,
    rssDescriptionOnly: source.rssDescriptionOnly ?? false,
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
 * Run active source adapters in parallel.
 * Pass bucket='international' or bucket='local' to run only that section's sources.
 * Omit bucket (or pass null) to run all active sources.
 * Uses Promise.allSettled so one failure never blocks others.
 */
export async function runAllAdapters(bucket = null) {
  const sources = bucket
    ? getActiveSources().filter(s => s.bucket === bucket)
    : getActiveSources();

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
        label:              source.label,
        bucket:             source.bucket,
        isPaywalled:        source.isPaywalled,
        rssDescriptionOnly: source.rssDescriptionOnly ?? false,
        rssUrl:             source.rssUrl,
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
