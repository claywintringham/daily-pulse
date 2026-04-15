// ── Source Registry ──────────────────────────────────────────────────────────
// All sources are declared here.
// status: 'active'  → adapter is implemented and in use
// status: 'stub'    → returns empty result, excluded from scoring
//
// Each active source config drives its adapter's fetch/parse behaviour.
// Selectors are validated manually per source; update here when a site redesigns.
//
// Fetch-order flags (handled by lib/adapters/_base.js runDomAdapter):
//   skipDom:true  — skip DOM entirely; go straight to RSS with no DOM fallback.
//                   Use when DOM always returns 0 items (JS-rendered, bot-blocked).
//   rssFirst:true — try RSS first; fall back to DOM if RSS returns nothing.
//                   Use when RSS is more reliable but DOM is still worth keeping
//                   as a safety net (e.g. JS-heavy homepages that sometimes work).

export const SOURCES = [

  // ===================================================================
  // INTERNATIONAL — FREE (qualification pool)
  // ===================================================================

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
    rssFirst: true,
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

  {
    id:      'aljazeera',
    label:   'Al Jazeera',
    bucket:  'international',
    isPaywalled: false,
    phase:   2,
    status:  'active',
    entryUrl: 'https://www.aljazeera.com',
    rssFirst: true,
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
    rssFirst: true,
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
    skipDom:  true,
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
    skipDom:  true,
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
    skipDom:  true,
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
    rssFirst: true,
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
    rssFirst: true,
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

  // ===================================================================
  // HK LOCAL — FREE (qualification pool)
  // ===================================================================

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
    isPaywalled: true,
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

  {
    id:      'scmp',
    label:   'SCMP',
    bucket:  'local',
    isPaywalled: false,
    phase:   3,
    status:  'active',
    requiresPaywallCheck: true,
    entryUrl: 'https://www.scmp.com/news/hong-kong',
    rssFirst: true,
    rssUrl:   'https://www.scmp.com/rss/2/feed',
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

  {
    id:      'tvbpearl',
    label:   'TVB Pearl',
    bucket:  'local',
    isPaywalled: false,
    phase:   2,
    status:  'active',
    entryUrl: 'https://news.tvb.com/tc/pearlnews',
    rssUrl:   null,
    maxRank:  20,
  },

  {
    id:      'tvb',
    label:   'TVB News',
    bucket:  'local',
    isPaywalled: false,
    phase:   2,
    status:  'active',
    entryUrl: 'https://news.tvb.com/tc/local',
    rssUrl:   null,
    requiresTranslation: true,
    maxRank:  20,
  },

  {
    id:              'hket',
    label:           'HKET',
    bucket:          'local',
    isPaywalled:     true,
    phase:           3,
    status:          'active',
    needsTranslation: true,
    entryUrl:        'https://www.hket.com',
    rssUrl:          null,
    renderMode:      'fetch',
    containers:      ['.listing-title', '.listing-content-container', 'main'],
    itemSelectors:   ['a[href*="inews.hket.com/article/"]'],
    excludeSelectors: ['nav', 'footer', '[class*="ad"]', '[class*="sponsor"]'],
    maxRank:         10,
  },

  {
    id:                  'oncc',
    label:               'On.cc',
    bucket:              'local',
    isPaywalled:         false,
    phase:               3,
    status:              'active',
    needsTranslation:    true,
    entryUrl:            'https://hk.on.cc',
    sitemapUrl:          'https://hk.on.cc/sitemap.xml',
    includeUrlPatterns:  ['/cnt/news/', '/cnt/intnews/'],
    excludeUrlPatterns:  ['/cnt/entertainment/', '/cnt/sport/'],
    maxRank:             10,
  },

  {
    id:              'mingpao',
    label:           'Ming Pao',
    bucket:          'local',
    isPaywalled:     false,
    phase:           3,
    status:          'active',
    needsTranslation: true,
    entryUrl:        'https://news.mingpao.com',
    rssFirst:        true,
    rssUrl:          'https://news.mingpao.com/rss/pns/s00001.xml',
    renderMode:      'fetch',
    containers:      ['#news-content', 'main'],
    itemSelectors:   ['a[href*="mingpao.com/pns/"]', 'a[href*="mingpao.com/ins/"]'],
    excludeSelectors:['nav', 'footer', '[class*="ad"]'],
    maxRank:         10,
  },

  // ===================================================================
  // PAYWALLED — BONUS WEIGHT ONLY (never count toward qualification)
  // ===================================================================

  {
    id:          'wsj',
    label:       'WSJ',
    bucket:      'international',
    isPaywalled: true,
    phase:       3,
    status:      'active',
    entryUrl:    'https://www.wsj.com',
    rssFirst:    true,
    rssUrl:      'https://feeds.a.dj.com/rss/RSSWorldNews.xml',
    renderMode:  'fetch',
    containers: [
      '[class*="WSJTheme--headline"]',
      '[class*="style--story-headline"]',
      'main',
    ],
    itemSelectors: [
      'a[href*="wsj.com/articles/"]',
      'a[href*="wsj.com/world/"]',
      'a[href*="wsj.com/politics/"]',
      'h3 a[href*="wsj.com"]',
      'h2 a[href*="wsj.com"]',
    ],
    excludeSelectors: ['nav', 'footer', '[class*="ad"]', '[class*="sponsor"]', '[class*="most-popular"]'],
    maxRank: 10,
  },

  {
    id:          'nyt',
    label:       'NYT',
    bucket:      'international',
    isPaywalled: true,
    phase:       3,
    status:      'active',
    entryUrl:    'https://www.nytimes.com',
    rssFirst:    true,
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

  {
    id:          'bloomberg',
    label:       'Bloomberg',
    bucket:      'international',
    isPaywalled: true,
    phase:       3,
    status:      'active',
    skipDom:     true,
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

  // ── Additional international free sources ────────────────────────────────────

  // Sky News: UK broadcaster, free, good RSS feed for world news.
  {
    id:      'skynews',
    label:   'Sky News',
    bucket:  'international',
    isPaywalled: false,
    phase:   3,
    status:  'active',
    rssFirst: true,
    entryUrl: 'https://news.sky.com',
    rssUrl:   'https://feeds.skynews.com/feeds/rss/world.xml',
    renderMode: 'fetch',
    containers: ['.news-list', '.sdc-site-tile-grid', 'main'],
    itemSelectors: [
      'a.sdc-site-tile__headline-link',
      'h3 a[href*="sky.com"]',
      'h2 a[href*="sky.com"]',
    ],
    excludeSelectors: ['nav', 'footer', '.advertisement', '[class*="promo"]'],
    maxRank: 10,
  },

  // CBC News: Canadian public broadcaster, free, strong world news coverage.
  {
    id:      'cbcnews',
    label:   'CBC News',
    bucket:  'international',
    isPaywalled: false,
    phase:   3,
    status:  'active',
    rssFirst: true,
    entryUrl: 'https://www.cbc.ca/news/world',
    rssUrl:   'https://www.cbc.ca/cmlink/rss-world',
    renderMode: 'fetch',
    containers: ['.contentArea', '.col-xs-12', 'main'],
    itemSelectors: [
      'h3 a[href*="cbc.ca"]',
      'h2 a[href*="cbc.ca"]',
    ],
    excludeSelectors: ['nav', 'footer', '.ad', '[class*="promo"]'],
    maxRank: 10,
  },

  // The Times (UK): hard paywall — contributes bonus weight only; no article content fetched.
  {
    id:          'thetimes',
    label:       'The Times',
    bucket:      'international',
    isPaywalled: true,
    phase:       3,
    status:      'active',
    skipDom:     true,
    entryUrl:    'https://www.thetimes.com',
    rssUrl:      'https://www.thetimes.com/rss',
    renderMode:  'fetch',
    containers: ['main'],
    itemSelectors: ['h3 a[href*="thetimes.com"]', 'h2 a[href*="thetimes.com"]'],
    excludeSelectors: ['nav', 'footer', '[class*="ad"]'],
    maxRank: 10,
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

export const getActiveSources    = ()       => SOURCES.filter(s => s.status === 'active');
export const getActiveFreeSources= (bucket) => SOURCES.filter(s => s.status === 'active' && !s.isPaywalled && s.bucket === bucket);
export const getActivePaywalled  = ()       => SOURCES.filter(s => s.status === 'active' && s.isPaywalled);
export const getById             = (id)     => SOURCES.find(s => s.id === id);

// Minimum rank-confirmed free sources required to produce a reliable digest
export const MIN_INTL_CONFIRMED  = 5;
export const MIN_LOCAL_CONFIRMED = 2;
