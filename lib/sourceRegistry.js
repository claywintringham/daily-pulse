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

  // ── Phase 2 — international (active) ────────────────────────────────────────
  // All use RSS-primary strategy: DOM selectors improve rank fidelity, but RSS
  // fallback ensures items are always returned even if the homepage DOM changes.

  {
    id:      'aljazeera',
    label:   'Al Jazeera',
    bucket:  'international',
    isPaywalled: false,
    phase:   2,
    status:  'active',
    entryUrl: 'https://www.aljazeera.com',
    rssUrl:   'https://www.aljazeera.com/xml/rss/all.xml',
    renderMode: 'fetch',
    containers: [
      '[class*="article-card"]',
      '.featured-articles-list',
      'main',
    ],
    itemSelectors: [
      'h3 a[href*="aljazeera.com"]',
      'h2 a[href*="aljazeera.com"]',
      'a[href*="/news/"]',
    ],
    excludeSelectors: ['nav', 'footer', '.advertisement', '[class*="most-read"]'],
    maxRank: 10,
  },

  {
    id:      'cnn',
    label:   'CNN',
    bucket:  'international',
    isPaywalled: false,
    phase:   2,
    status:  'active',
    entryUrl: 'https://www.cnn.com',
    rssUrl:   'https://rss.cnn.com/rss/edition.rss',
    renderMode: 'fetch',
    containers: [
      '.zone--t-light',
      '.container__field-links',
      'main',
    ],
    itemSelectors: [
      'a.container__link--type-article',
      '.container__headline a',
      'span.container__headline a',
      'h2 a[href*="cnn.com"]',
    ],
    excludeSelectors: [
      '.advertisement',
      '.zn-ad',
      '[data-type="mostpopular"]',
      'nav',
      'footer',
    ],
    maxRank: 10,
  },

  {
    id:      'nbcnews',
    label:   'NBC News',
    bucket:  'international',
    isPaywalled: false,
    phase:   2,
    status:  'active',
    entryUrl: 'https://www.nbcnews.com',
    rssUrl:   'https://feeds.nbcnews.com/nbcnews/public/news',
    renderMode: 'fetch',
    containers: [
      '.layout-grid article',
      '.wide-tease-item',
      'main',
    ],
    itemSelectors: [
      'h2 a[href*="nbcnews.com"]',
      'h3 a[href*="nbcnews.com"]',
      '.wide-tease-item__headline a',
      '.tease-card__headline a',
    ],
    excludeSelectors: ['nav', 'footer', '.ad', '[class*="sponsored"]'],
    maxRank: 10,
  },

  {
    id:      'cbsnews',
    label:   'CBS News',
    bucket:  'international',
    isPaywalled: false,
    phase:   2,
    status:  'active',
    entryUrl: 'https://www.cbsnews.com',
    rssUrl:   'https://www.cbsnews.com/latest/rss/main',
    renderMode: 'fetch',
    containers: [
      '.content-list',
      '.item article',
      'main',
    ],
    itemSelectors: [
      '.item__anchor',
      'h4 a[href*="cbsnews.com"]',
      'h3 a[href*="cbsnews.com"]',
      'a.anchor-inner',
    ],
    excludeSelectors: ['nav', 'footer', '.ad', '[class*="promo"]'],
    maxRank: 10,
  },

  {
    id:      'dw',
    label:   'DW',
    bucket:  'international',
    isPaywalled: false,
    phase:   2,
    status:  'active',
    entryUrl: 'https://www.dw.com/en/',
    rssUrl:   'https://rss.dw.com/xml/rss-en-all',
    renderMode: 'fetch',
    containers: [
      '.marquee--featured',
      '.js-teaser-container',
      'main',
    ],
    itemSelectors: [
      'a.linktracking[href*="dw.com"]',
      '.group__media-desc a',
      'h3 a[href*="dw.com"]',
      'h2 a[href*="dw.com"]',
    ],
    excludeSelectors: ['nav', 'footer', '.advertisement', '[class*="most-read"]'],
    maxRank: 10,
  },

  {
    id:      'france24',
    label:   'France 24',
    bucket:  'international',
    isPaywalled: false,
    phase:   2,
    status:  'active',
    entryUrl: 'https://www.france24.com/en/',
    rssUrl:   'https://www.france24.com/en/rss',
    renderMode: 'fetch',
    containers: [
      '.top-stories__grid',
      '.article-list',
      'main',
    ],
    itemSelectors: [
      'a.article__link[href*="france24.com"]',
      'h2 a[href*="france24.com/en/"]',
      'h3 a[href*="france24.com/en/"]',
    ],
    excludeSelectors: ['nav', 'footer', '.advertisement', '[class*="sponsor"]'],
    maxRank: 10,
  },

  {
    id:      'foxnews',
    label:   'Fox News',
    bucket:  'international',
    isPaywalled: false,
    phase:   2,
    status:  'active',
    entryUrl: 'https://www.foxnews.com',
    rssUrl:   'https://feeds.foxnews.com/foxnews/latest',
    renderMode: 'fetch',
    containers: [
      '.collection-article-list',
      '.top-stories',
      'main',
    ],
    itemSelectors: [
      'h3 a[href*="foxnews.com"]',
      'h4 a[href*="foxnews.com"]',
      'a.title[href*="foxnews.com"]',
    ],
    excludeSelectors: ['nav', 'footer', '.advertisement', '[class*="ad-"]'],
    maxRank: 10,
  },

  {
    id:      'foxbusiness',
    label:   'Fox Business',
    bucket:  'international',
    isPaywalled: false,
    phase:   2,
    status:  'active',
    entryUrl: 'https://www.foxbusiness.com',
    rssUrl:   'https://feeds.foxbusiness.com/foxbusiness/latest',
    renderMode: 'fetch',
    containers: [
      '.collection-article-list',
      '.top-stories',
      'main',
    ],
    itemSelectors: [
      'h3 a[href*="foxbusiness.com"]',
      'h4 a[href*="foxbusiness.com"]',
      'a.title[href*="foxbusiness.com"]',
    ],
    excludeSelectors: ['nav', 'footer', '.advertisement', '[class*="ad-"]'],
    maxRank: 10,
  },

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
    isPaywalled: true,   // soft paywall — used for cluster confidence only; no article fetch
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

  // ── Phase 3 — HK local ──────────────────────────────────────────────────────

  // SCMP: soft paywall — many articles are freely readable. Treated as a
  // QUALIFYING FREE SOURCE (isPaywalled: false). Headlines and URLs from the
  // HK section RSS are surfaced; paywall articles will lack a clickable URL
  // (rendered as plain-text chip per the paywall chip rules in index.html).
  {
    id:      'scmp',
    label:   'SCMP',
    bucket:  'local',
    isPaywalled: false,
    phase:   3,
    status:  'active',
    requiresPaywallCheck: true,
    entryUrl: 'https://www.scmp.com/news/hong-kong',
    rssUrl:   'https://www.scmp.com/rss/2/feed', // Hong Kong section RSS
    renderMode: 'fetch',
    containers: [
      '#main-content',
      '[class*="article-list"]',
      'main',
    ],
    itemSelectors: [
      'h3 a[href*="scmp.com"]',
      'h2 a[href*="scmp.com"]',
      'a[href*="/article/"]',
    ],
    excludeSelectors: ['nav', 'footer', '.advertisement', '[class*="most-read"]'],
    maxRank: 10,
  },

  // ── Phase 2 — HK local ──────────────────────────────────────────────────────

  // TVB Pearl: English-language news from TVB's Pearl channel.
  // Uses the TVB internal content API (inews-api.tvb.com/news/entry/category)
  // which is publicly accessible. Returns full English article text and
  // accurate publish timestamps — no Google News RSS workaround needed.
  {
    id:      'tvbpearl',
    label:   'TVB Pearl',
    bucket:  'local',
    isPaywalled: false,
    phase:   2,
    status:  'active',
    entryUrl: 'https://news.tvb.com/tc/pearlnews',
    rssUrl:   null, // Google News RSS handled directly in the adapter
    maxRank:  20,
  },

  // Phase 2 — HK local (Chinese, with LLM translation in adapter)
  {
    id:      'tvb',
    label:   'TVB News',
    bucket:  'local',
    isPaywalled: false,
    phase:   2,
    status:  'active',
    entryUrl: 'https://news.tvb.com/tc/local',
    rssUrl:   null,
    requiresTranslation: true, // titles translated to English inside the adapter
    maxRank:  20,
  },
  { id: 'hket',    label: 'HKET',     bucket: 'local', isPaywalled: false, phase: 3, status: 'stub', entryUrl: 'https://www.hket.com',       requiresTranslation: true },
  { id: 'mingpao', label: 'Ming Pao', bucket: 'local', isPaywalled: false, phase: 3, status: 'stub', entryUrl: 'https://www.mingpao.com',    requiresTranslation: true },
  { id: 'oncc',    label: 'On.cc',    bucket: 'local', isPaywalled: false, phase: 3, status: 'stub', entryUrl: 'https://hk.on.cc',           requiresTranslation: true },

  // ═══════════════════════════════════════════════════════════════════
  // PAYWALLED — BONUS WEIGHT ONLY (never count toward qualification)
  // ═══════════════════════════════════════════════════════════════════

  { id: 'wsj', label: 'WSJ', bucket: 'international', isPaywalled: true, phase: 3, status: 'stub', entryUrl: 'https://www.wsj.com' },

  // NYT: hard paywall. Public RSS feeds are the reliable path — the homepage
  // is JS-rendered and requires login for article content. The HomePage RSS
  // returns ~15 top cross-section headlines; DOM selectors are best-effort
  // fallback in case the RSS feed changes.
  {
    id:          'nyt',
    label:       'NYT',
    bucket:      'international',
    isPaywalled: true,
    phase:       3,
    status:      'active',
    entryUrl:    'https://www.nytimes.com',
    rssUrl:      'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
    renderMode:  'fetch',
    containers: [
      'section[data-testid="storylist"]',
      '[class*="css-ye6x8s"]',
      'main',
    ],
    itemSelectors: [
      'a[href*="nytimes.com/20"]',
      'h3 a[href*="nytimes.com"]',
      'h2 a[href*="nytimes.com"]',
    ],
    excludeSelectors: ['nav', 'footer', '[class*="ad"]', '[class*="sponsor"]', '[class*="nytint-"]'],
    maxRank: 10,
  },

  // Bloomberg: hard paywall. RSS is the reliable path — their homepage is
  // heavily JS-rendered and blocks scrapers. RSS returns ~15 headlines from
  // the Markets/World News feed. DOM selectors kept as a best-effort fallback.
  {
    id:          'bloomberg',
    label:       'Bloomberg',
    bucket:      'international',
    isPaywalled: true,
    phase:       3,
    status:      'active',
    entryUrl:    'https://www.bloomberg.com',
    rssUrl:      'https://feeds.bloomberg.com/markets/news.rss',
    renderMode:  'fetch',
    containers: [
      '[class*="story-list-story"]',
      '[class*="top-news"]',
      'main',
    ],
    itemSelectors: [
      'a[href*="bloomberg.com/news/articles"]',
      'a[href*="bloomberg.com/news/videos"]',
      'h3 a[href*="bloomberg.com"]',
      'h2 a[href*="bloomberg.com"]',
    ],
    excludeSelectors: ['nav', 'footer', '[class*="ad"]', '[class*="sponsor"]', '[class*="most-read"]'],
    maxRank: 10,
  },

  // FT: hard paywall. Homepage is accessible and shows top headlines.
  // RSS at /?format=rss returns world-section headlines without requiring login.
  // DOM selectors target the FT's teaser component structure.
  {
    id:          'ft',
    label:       'FT',
    bucket:      'international',
    isPaywalled: true,
    phase:       3,
    status:      'active',
    entryUrl:    'https://www.ft.com',
    rssUrl:      'https://www.ft.com/?format=rss',
    renderMode:  'fetch',
    containers: [
      '.o-teaser-collection',
      '[data-trackable="top-stories"]',
      'main',
    ],
    itemSelectors: [
      '.js-teaser-heading-link',
      'a.js-teaser-heading-link',
      'h3 a[href*="ft.com/content/"]',
      'h2 a[href*="ft.com/content/"]',
    ],
    excludeSelectors: ['nav', 'footer', '.o-ads', '[class*="ad-"]', '[class*="sponsor"]'],
    maxRank: 10,
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

export const getActiveSources    = ()       => SOURCES.filter(s => s.status === 'active');
export const getActiveFreeSources= (bucket) => SOURCES.filter(s => s.status === 'active' && !s.isPaywalled && s.bucket === bucket);
export const getActivePaywalled  = ()       => SOURCES.filter(s => s.status === 'active' && s.isPaywalled);
export const getById             = (id)     => SOURCES.find(s => s.id === id);

// Minimum rank-confirmed free sources required to produce a reliable digest
export const MIN_INTL_CONFIRMED  = 5; // out of 13 active international sources
export const MIN_LOCAL_CONFIRMED = 2; // out of 4 active local sources
