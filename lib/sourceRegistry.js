// ── Source Registry ──────────────────────────────────────────────────────────
// All 24 sources are declared here from day one.
// status: 'active'  → adapter is implemented and in use
// status: 'stub'    → returns empty result, excluded from scoring
//
// Each active source config drives its adapter's fetch/parse behaviour.
// Selectors are validated manually per source; update here when a site redesigns.

export const SOURCES = [

  // ═══════════════════════════════════════════════════════════════════
  // INTERNATIONAL — FREE (qualification pool)
  // ═══════════════════════════════════════════════════════════════════

  {
    id:      'reuters',
    label:   'Reuters',
    bucket:  'international',
    isPaywalled: false,
    phase:   2,
    // Reuters blocks all scrapers (bot detection) and shut down all public RSS feeds.
    // Demoted to Phase 2 stub until a viable access method is found (e.g. Reuters API).
    // Their stories are covered by AP, BBC, Guardian and CNBC in the meantime.
    status:  'stub',
    entryUrl: 'https://www.reuters.com',
    rssUrl:   null,
    renderMode: 'fetch',
    // Primary container tried first; falls back to subsequent entries
    containers: [
      '[data-testid="homepage-section-index-0"]',
      'main [class*="MediaStoryCard"]',
      'main',
    ],
    itemSelectors: [
      '[data-testid="Heading"] a',
      'h3 a[href*="/article/"]',
      'h2 a[href*="/article/"]',
      'a[href*="/article/"]',
    ],
    excludeSelectors: [
      '[data-testid="recommended"]',
      '[data-testid="most-read"]',
      '.advertisement',
      'nav',
      'footer',
    ],
    maxRank: 10,
  },

  {
    id:      'ap',
    label:   'AP',
    bucket:  'international',
    isPaywalled: false,
    phase:   1,
    status:  'active',
    entryUrl: 'https://apnews.com',
    rssUrl:   'https://rsshub.app/apnews/topics/apf-topnews',
    renderMode: 'fetch',
    containers: [
      '.PagePromo',
      '.Page-content',
      'main',
    ],
    itemSelectors: [
      '.PagePromo-title a',
      'h2 a[href*="/article/"]',
      'h3 a[href*="/article/"]',
    ],
    excludeSelectors: [
      '.advertisement',
      '.ad-container',
      '[data-key="most-popular"]',
      'nav',
      'footer',
    ],
    maxRank: 10,
  },

  {
    id:      'bbc',
    label:   'BBC',
    bucket:  'international',
    isPaywalled: false,
    phase:   1,
    status:  'active',
    entryUrl: 'https://www.bbc.com/news',
    rssUrl:   'https://feeds.bbci.co.uk/news/world/rss.xml',
    renderMode: 'fetch',
    containers: [
      '[data-testid="edinburgh-hero"]',
      '[data-testid="topic-promos"]',
      '[data-testid="manchester-front-page"]',
      'main',
    ],
    // NOTE: [data-testid="card-headline"] is an H2 *inside* an <a data-testid="internal-link">.
    // _base.js scrapeEditorialRail handles non-anchor elements by finding the nearest <a>
    // ancestor for the href — this gives a clean title (no metadata text).
    itemSelectors: [
      '[data-testid="card-headline"]',
      'h2[data-testid="card-headline"]',
    ],
    excludeSelectors: [
      '[data-testid="most-read"]',
      '[data-testid="topic-list"]',
      '.promo',
      'nav',
      'footer',
    ],
    maxRank: 10,
  },

  {
    id:      'guardian',
    label:   'The Guardian',
    bucket:  'international',
    isPaywalled: false,
    phase:   1,
    status:  'active',
    entryUrl: 'https://www.theguardian.com/international',
    rssUrl:   'https://www.theguardian.com/world/rss',
    renderMode: 'fetch',
    containers: [
      '.fc-container--first',
      '[data-component="container"]',
      'main',
    ],
    itemSelectors: [
      '.fc-item__title a',
      '.js-headline-text',
      'h3 a[href*="theguardian.com"]',
      'a[data-link-name="article"]',
    ],
    excludeSelectors: [
      '.fc-container--sponsored',
      '.ad-slot',
      '[data-component="most-viewed"]',
      'nav',
      'footer',
    ],
    maxRank: 10,
  },

  {
    id:      'cnbc',
    label:   'CNBC',
    bucket:  'international',
    isPaywalled: false,
    phase:   1,
    status:  'active',
    entryUrl: 'https://www.cnbc.com',
    rssUrl:   'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114',
    renderMode: 'fetch',
    containers: [
      '.PageBuilder-col',
      '.RiverHeadline',
      '.LatestNews',
      'main',
    ],
    itemSelectors: [
      '.RiverHeadline__headline a',
      '.LatestNews__headline a',
      'a.Card-title',
      'h2 a[href*="cnbc.com"]',
      'h3 a[href*="cnbc.com"]',
    ],
    excludeSelectors: [
      '.Advertisement',
      '.sponsored',
      '.MarketsTicker',
      'nav',
      'footer',
    ],
    maxRank: 10,
  },

  // Phase 2 — international stubs (adapters not yet implemented)
  { id: 'cnn',         label: 'CNN',         bucket: 'international', isPaywalled: false, phase: 2, status: 'stub', entryUrl: 'https://www.cnn.com' },
  { id: 'nbcnews',     label: 'NBC News',    bucket: 'international', isPaywalled: false, phase: 2, status: 'stub', entryUrl: 'https://www.nbcnews.com' },
  { id: 'cbsnews',     label: 'CBS News',    bucket: 'international', isPaywalled: false, phase: 2, status: 'stub', entryUrl: 'https://www.cbsnews.com' },
  { id: 'aljazeera',   label: 'Al Jazeera',  bucket: 'international', isPaywalled: false, phase: 2, status: 'stub', entryUrl: 'https://www.aljazeera.com' },
  { id: 'dw',          label: 'DW',          bucket: 'international', isPaywalled: false, phase: 2, status: 'stub', entryUrl: 'https://www.dw.com/en/' },
  { id: 'france24',    label: 'France 24',   bucket: 'international', isPaywalled: false, phase: 2, status: 'stub', entryUrl: 'https://www.france24.com/en/' },
  { id: 'foxnews',     label: 'Fox News',    bucket: 'international', isPaywalled: false, phase: 2, status: 'stub', entryUrl: 'https://www.foxnews.com' },
  { id: 'foxbusiness', label: 'Fox Business',bucket: 'international', isPaywalled: false, phase: 2, status: 'stub', entryUrl: 'https://www.foxbusiness.com' },

  // ═══════════════════════════════════════════════════════════════════
  // HK LOCAL — FREE (qualification pool)
  // ═══════════════════════════════════════════════════════════════════

  {
    id:      'rthk',
    label:   'RTHK',
    bucket:  'local',
    isPaywalled: false,
    phase:   1,
    status:  'active',
    entryUrl: 'https://news.rthk.hk/rthk/en/latest-news.htm',
    rssUrl:   'https://rthk.hk/rthk/en/rss/news.xml',
    renderMode: 'fetch',
    // Live DOM confirmed: each article is wrapped in .ns2-column > div > .ns2-inner > h4.ns2-title > a
    // .ns2-list does NOT exist; use .ns2-column (one per article) as the container collection.
    // RSS fallback active: if DOM selectors still miss, _base.js will use rssUrl automatically.
    containers: [
      '.ns2-column',
      '.ns2-inner',
      'body',
    ],
    itemSelectors: [
      '.ns2-title a',
      'h4 a[href*="rthk.hk"]',
      'a[href*="/component/k2/"]',
    ],
    excludeSelectors: ['nav', 'footer', '.advertisement', '.widget'],
    maxRank: 10,
  },

  {
    id:      'hkfp',
    label:   'HKFP',
    bucket:  'local',
    isPaywalled: false,
    phase:   1,
    status:  'active',
    entryUrl: 'https://hongkongfp.com',
    rssUrl:   'https://hongkongfp.com/feed/',
    renderMode: 'fetch',
    containers: [
      '.site-main article',
      '.posts-container',
      'main',
    ],
    itemSelectors: [
      'h2.entry-title a',
      'h3.entry-title a',
      '.post-title a',
      'a[rel="bookmark"]',
    ],
    excludeSelectors: ['.widget', '.sidebar', '.sticky', 'nav', 'footer'],
    maxRank: 10,
  },

  {
    id:      'thestandard',
    label:   'The Standard',
    bucket:  'local',
    isPaywalled: false,
    phase:   1,
    status:  'active',
    entryUrl: 'https://www.thestandard.com.hk',
    rssUrl:   null,
    renderMode: 'fetch',
    // Live DOM confirmed: articles use .homepage-general__section-title (featured)
    // and .homepage-general__article-list-title (list items) as link wrappers.
    containers: [
      '.focus__description',
      '.homepage-general__section-info',
      '.homepage-general__article-list-table',
      'main',
    ],
    itemSelectors: [
      '.homepage-general__section-title a',
      '.homepage-general__article-list-title a',
      'a[href*="thestandard.com.hk/news/"]',
      'a[href*="thestandard.com.hk/world/"]',
      'a[href*="thestandard.com.hk/hong-kong"]',
    ],
    excludeSelectors: ['nav', 'footer', '.advertisement', '.sponsor', '.submenu-drawer'],
    maxRank: 10,
  },

  // Phase 3 — HK local stubs
  { id: 'scmp',    label: 'SCMP',     bucket: 'local', isPaywalled: false, phase: 3, status: 'stub', entryUrl: 'https://www.scmp.com',  requiresPaywallCheck: true },
  { id: 'hket',    label: 'HKET',     bucket: 'local', isPaywalled: false, phase: 3, status: 'stub', entryUrl: 'https://www.hket.com',  requiresTranslation: true },
  { id: 'mingpao', label: 'Ming Pao', bucket: 'local', isPaywalled: false, phase: 3, status: 'stub', entryUrl: 'https://www.mingpao.com',requiresTranslation: true },
  { id: 'oncc',    label: 'On.cc',    bucket: 'local', isPaywalled: false, phase: 3, status: 'stub', entryUrl: 'https://hk.on.cc',      requiresTranslation: true },

  // ═══════════════════════════════════════════════════════════════════
  // PAYWALLED — BONUS WEIGHT ONLY (never count toward qualification)
  // ═══════════════════════════════════════════════════════════════════

  { id: 'wsj',       label: 'WSJ',       bucket: 'international', isPaywalled: true, phase: 3, status: 'stub', entryUrl: 'https://www.wsj.com' },
  { id: 'bloomberg', label: 'Bloomberg', bucket: 'international', isPaywalled: true, phase: 3, status: 'stub', entryUrl: 'https://www.bloomberg.com' },
  { id: 'ft',        label: 'FT',        bucket: 'international', isPaywalled: true, phase: 3, status: 'stub', entryUrl: 'https://www.ft.com' },
  { id: 'nyt',       label: 'NYT',       bucket: 'international', isPaywalled: true, phase: 3, status: 'stub', entryUrl: 'https://www.nytimes.com' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

export const getActiveSources    = ()       => SOURCES.filter(s => s.status === 'active');
export const getActiveFreeSources= (bucket) => SOURCES.filter(s => s.status === 'active' && !s.isPaywalled && s.bucket === bucket);
export const getActivePaywalled  = ()       => SOURCES.filter(s => s.status === 'active' && s.isPaywalled);
export const getById             = (id)     => SOURCES.find(s => s.id === id);

// Minimum rank-confirmed free sources required to produce a reliable digest
export const MIN_INTL_CONFIRMED  = 3; // out of 5 Phase-1 international actives
export const MIN_LOCAL_CONFIRMED = 2; // out of 3 Phase-1 local actives
