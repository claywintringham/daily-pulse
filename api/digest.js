// Daily Pulse — Vercel Serverless Function
// Two-call pipeline: Call 1 grounded (find stories), Call 2 JSON (structure output)
// RSS feeds fetched in parallel with Call 1 to provide verified article URLs

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const PAYWALLED = ['WSJ', 'Bloomberg', 'FT'];
const APPROVED_DOMAINS = [
  'reuters.com', 'bbc.com', 'bloomberg.com', 'nytimes.com', 'cnn.com',
  'wsj.com', 'cnbc.com', 'foxnews.com', 'foxbusiness.com', 'ft.com',
  'apnews.com', 'theguardian.com', 'nbcnews.com',
  'scmp.com', 'rthk.hk', 'hket.com', 'mingpao.com', 'hkt.com', 'on.cc',
  'thestandard.com.hk', 'hongkongfp.com'
];
const INTL_SOURCES = 'Reuters (reuters.com), BBC (bbc.com), Bloomberg (bloomberg.com), ' +
  'NYT (nytimes.com), CNN (cnn.com), WSJ (wsj.com), CNBC (cnbc.com), ' +
  'Fox News (foxnews.com), Fox Business (foxbusiness.com), FT (ft.com), ' +
  'AP (apnews.com), The Guardian (theguardian.com), NBC News (nbcnews.com)';
const LOCAL_SOURCES = 'SCMP (scmp.com), RTHK (rthk.hk), HKET (hket.com), ' +
  'Ming Pao (mingpao.com), HKT (hkt.com), On.cc (on.cc), ' +
  'The Standard (thestandard.com.hk), HKFP (hongkongfp.com)';
const FORBIDDEN = 'Al Jazeera, Anadolu Agency, The News Pakistan, Kurdistan24, ' +
  'Local Gazette, Global News, Times of India, or any outlet not in the approved lists';

// RSS feeds for approved free sources (reliable, direct article URLs)
const RSS_FEEDS = [
  { source: 'Reuters',      url: 'https://feeds.reuters.com/reuters/topNews' },
  { source: 'BBC',          url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { source: 'AP',           url: 'https://rsshub.app/apnews/topics/apf-topnews' },
  { source: 'CNN',          url: 'http://rss.cnn.com/rss/edition.rss' },
  { source: 'CNBC',         url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114' },
  { source: 'The Guardian', url: 'https://www.theguardian.com/world/rss' },
  { source: 'NBC News',     url: 'https://feeds.nbcnews.com/nbcnews/public/news' },
  { source: 'SCMP',         url: 'https://www.scmp.com/rss/91/feed' },
  { source: 'HKFP',         url: 'https://hongkongfp.com/feed/' },
  { source: 'RTHK',         url: 'https://rthk.hk/rthk/en/rss/news.xml' },
];

// ── URL VALIDATION ──

// Vertex AI grounding redirect URLs — always point to specific articles
function isVertexRedirect(url) {
  if (!url) return false;
  try {
    return new URL(url).hostname === 'vertexaisearch.cloud.google.com';
  } catch { return false; }
}

function isApprovedDomain(url) {
  if (!url || url === 'NOT FOUND') return false;
  // Vertex AI redirect URLs always resolve to real articles — accept them
  if (isVertexRedirect(url)) return true;
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    return APPROVED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch { return false; }
}

function isArticleUrl(url) {
  if (!url) return false;
  // Vertex AI redirect URLs always point to specific articles, never homepages
  if (isVertexRedirect(url)) return true;
  try {
    const u = new URL(url);
    // Reject pure homepages: path must be more than just /section-name
    // Require path length > 10 to filter out section pages like /world /news /asia
    const path = u.pathname.replace(/\/$/, '');
    return path.length > 10;
  } catch { return false; }
}

// ── GROUNDING URL EXTRACTION ──

// Extract all grounding chunk URIs (may be Vertex AI redirect URLs)
function extractGroundingUrls(chunks) {
  return (chunks || [])
    .filter(c => c.web && c.web.uri)
    .map(c => ({ uri: c.web.uri, title: c.web.title || '' }));
}

// Prepare grounding URLs for Call 2 — pass Vertex AI redirect URLs directly
// (browser follows redirects to actual articles; no server-side fetch needed)
function prepareGroundingUrls(rawUrls) {
  if (!rawUrls || !rawUrls.length) return [];
  return rawUrls
    .slice(0, 25)
    .filter(({ uri }) => isVertexRedirect(uri) || (isApprovedDomain(uri) && isArticleUrl(uri)));
}

// Fetch recent article URLs from RSS feeds in parallel — reliable direct article URLs
async function fetchRssUrls(type) {
  const recencyMs = (type === 'evening' ? 8 : 24) * 3600000;
  const cutoff = Date.now() - recencyMs;

  const results = await Promise.all(
    RSS_FEEDS.map(async ({ source, url }) => {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 6000);
        const res = await fetch(url, {
          headers: { 'User-Agent': 'DailyPulse/1.0 (news digest)' },
          redirect: 'follow',
          signal: ac.signal
        });
        clearTimeout(timer);
        if (!res.ok) return [];
        const xml = await res.text();
        const items = [];
        // Parse <item> blocks from RSS/Atom
        const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
        let m;
        while ((m = itemRe.exec(xml)) !== null) {
          const block = m[1];
          // Extract link (prefer <link> text, fallback to guid)
          const linkMatch = block.match(/<link>([^<]+)<\/link>/) ||
                            block.match(/<link[^>]+href="([^"]+)"/) ||
                            block.match(/<guid[^>]*>([^<]+)<\/guid>/);
          if (!linkMatch) continue;
          const link = linkMatch[1].trim();
          if (!isApprovedDomain(link) || !isArticleUrl(link)) continue;
          // Extract title
          const titleMatch = block.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                             block.match(/<title[^>]*>([^<]*)<\/title>/);
          const title = titleMatch ? titleMatch[1].trim().substring(0, 100) : '';
          // Extract pubDate and filter by recency
          const pubMatch = block.match(/<pubDate[^>]*>([^<]+)<\/pubDate>/);
          const pubDate = pubMatch ? new Date(pubMatch[1]).getTime() : Date.now();
          if (isNaN(pubDate) || pubDate >= cutoff) {
            items.push({ uri: link, title: source + ': ' + title });
          }
        }
        return items.slice(0, 8); // max 8 per source
      } catch { return []; }
    })
  );
  return results.flat();
}

// ── GEMINI API CALL ──

async function callGemini(prompt, useGrounding, returnMeta) {
  let lastError = null;
  for (const model of MODELS) {
    try {
      const body = {
        contents: [{ parts: [{ text: prompt }], role: 'user' }],
        generationConfig: {
          temperature: useGrounding ? 0.1 : 0.0,
          maxOutputTokens: useGrounding ? 3000 : 8000
        }
      };
      if (useGrounding) body.tools = [{ google_search: {} }];
      if (!useGrounding) body.generationConfig.responseMimeType = 'application/json';

      const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + GEMINI_KEY,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      const data = await res.json();

      if (!res.ok) {
        const msg = data?.error?.message || '';
        if (res.status === 429 || res.status === 503 || msg.toLowerCase().includes('demand')) {
          lastError = new Error(msg);
          continue;
        }
        throw new Error(msg || 'Gemini API error');
      }

      // Extract text from all parts
      const parts = data.candidates?.[0]?.content?.parts || [];
      let text = parts.filter(p => p.text).map(p => p.text).join('\n');

      // STOP with empty parts — try grounding supports
      if (!text.trim()) {
        const supports = data.candidates?.[0]?.groundingMetadata?.groundingSupports || [];
        text = supports.map(s => s?.segment?.text || '').filter(Boolean).join('\n');
      }

      if (!text.trim()) {
        const reason = data.candidates?.[0]?.finishReason || 'unknown';

        // STOP = grounding consumed response budget; wait 3s and retry same model with shorter prompt
        if (useGrounding && reason === 'STOP') {
          await new Promise(r => setTimeout(r, 3000));
          const shortPrompt = prompt.length > 800
            ? prompt.substring(0, 800) + '\n\nBe brief. List key stories only with headlines and sources.'
            : prompt;
          try {
            const retryRes = await fetch(
              'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + GEMINI_KEY,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: shortPrompt }], role: 'user' }],
                  tools: [{ google_search: {} }],
                  generationConfig: { temperature: 0.1, maxOutputTokens: 2000 }
                })
              }
            );
            const retryData = await retryRes.json();
            if (retryRes.ok) {
              const rParts = retryData.candidates?.[0]?.content?.parts || [];
              let rText = rParts.filter(p => p.text).map(p => p.text).join('\n');
              if (!rText.trim()) {
                const rSupports = retryData.candidates?.[0]?.groundingMetadata?.groundingSupports || [];
                rText = rSupports.map(s => s?.segment?.text || '').filter(Boolean).join('\n');
              }
              if (rText.trim()) {
                if (returnMeta) {
                  const rChunks = retryData.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
                  return { text: rText, groundingUrls: extractGroundingUrls(rChunks) };
                }
                return rText;
              }
            }
          } catch(_) { /* fall through to next model */ }
        }

        lastError = new Error('Grounding returned no text (' + reason + ') from ' + model + '.');
        continue;
      }

      // Extract actual article URLs Gemini sourced during grounding
      const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      const groundingUrls = extractGroundingUrls(chunks);

      if (returnMeta) return { text, groundingUrls };
      return text;
    } catch(e) {
      lastError = e;
      if (e.message && (e.message.includes('demand') || e.message.includes('overload'))) continue;
      throw e;
    }
  }
  throw lastError || new Error('All models failed');
}

// ── PROMPTS ──

function call1Prompt(type, morningHeadlines, isFirstRun) {
  const isEvening = type === 'evening';
  const count = isEvening ? 1 : 2;
  const recency = isEvening ? '8 hours' : '24 hours';
  const today = new Date().toLocaleDateString('en-HK', {
    weekday:'long', year:'numeric', month:'long', day:'numeric'
  });
  const firstRunRule = isFirstRun
    ? 'CRITICAL: You MUST return at least ' + count + ' international AND at least 1 local HK story. Empty sections are FORBIDDEN on first run. Broaden search to top 5, 6, 7 ranked stories if needed. Articles MUST be published within the last ' + recency + ' — reject anything older. Never invent placeholder content.'
    : 'If no new qualifying story was published in the last ' + recency + ', return an empty array for that section.';
  const exclusion = (isEvening && morningHeadlines && morningHeadlines.length)
    ? 'EXCLUDE these morning stories:\n' + morningHeadlines.map((h,i) => (i+1)+'. '+h).join('\n') + '\n\n'
    : '';

  return 'You are Daily Pulse, a news digest for a Hong Kong reader. Today is ' + today + '.\n\n' +
    'TASK: Find the most repeated top headlines published within the LAST ' + recency + ' ONLY. Use ONLY approved sources. Never use ' + FORBIDDEN + '.\n\n' +
    'INTERNATIONAL SOURCES: ' + INTL_SOURCES + '\n' +
    'LOCAL HK SOURCES: ' + LOCAL_SOURCES + '\n\n' +
    'RULES:\n' +
    '- Story must appear in TOP 3 positions of at least 3 approved sources. Fall back to top 4, 5, 6 if needed.\n' +
    '- Story MUST be covered by at least one free source (not WSJ, Bloomberg, or FT).\n' +
    '- Published within last ' + recency + ' ONLY. Reject older stories.\n' +
    '- ' + firstRunRule + '\n\n' +
    exclusion +
    'Find the top ' + count + ' international and top ' + count + ' local HK qualifying stories.\n\n' +
    'For each story write:\n' +
    'HEADLINE: [headline]\n' +
    'TIME: [exact time, e.g. "2 hours ago" or "45 minutes ago" — MUST be specific, never just "Hours ago"]\n' +
    'COVERING SOURCES: [source name and position rank]\n' +
    'FREE SOURCES: [non-paywalled sources]\n' +
    'SUMMARY: [40-75 words. Write substantive sentences with context and key facts. NEVER just restate the headline. Include who, what, why/impact.]\n\n' +
    'Plain text only. No JSON. Label sections INTERNATIONAL STORIES and LOCAL HK STORIES.';
}

function call2JsonPrompt(trendReport, type, isFirstRun, groundingUrls) {
  const count = type === 'evening' ? 1 : 2;
  const firstRunNote = isFirstRun
    ? 'CRITICAL: First run. international MUST have at least ' + count + ' real stories. local MUST have at least 1 real HK story. Both arrays MUST be non-empty. No placeholders. No invented sources. If local HK stories are sparse, include the most prominent HK story available within the recency window.'
    : 'Empty arrays allowed if no stories qualified.';
  const groundingSection = (groundingUrls && groundingUrls.length)
    ? '\nVERIFIED ARTICLE URLs (sourced during research — these are real URLs, prefer these):\n' +
      groundingUrls.slice(0, 25).map(u => '- ' + u.uri + (u.title ? ' [' + u.title.substring(0, 80) + ']' : '')).join('\n') + '\n'
    : '';

  return 'Convert this trend report into a JSON object.\n\n' +
    'TREND REPORT:\n' + trendReport + '\n\n' +
    groundingSection +
    'APPROVED SOURCES ONLY: ' + INTL_SOURCES + ', ' + LOCAL_SOURCES + '\n\n' +
    'JSON SCHEMA:\n' +
    '{"international":[{"headline":"...","time":"3 hours ago","summary":"...","source_count":N,' +
    '"sources":[{"name":"Reuters","position":1,"url":"https://reuters.com/world/story-slug-2026-04-12/","paywalled":false}],' +
    '"url":"https://reuters.com/world/story-slug-2026-04-12/"}],"local":[...]}\n\n' +
    'STRICT RULES:\n' +
    '- ' + firstRunNote + '\n' +
    '- international: up to ' + count + ' stories. local: up to ' + count + ' stories.\n' +
    '- ONLY include sources from the approved list above. Reject any unapproved source name.\n' +
    '- paywalled: true for WSJ, Bloomberg, FT only.\n' +
    '- story url and source url: ONLY use URLs from VERIFIED ARTICLE URLs above. NEVER a homepage like https://reuters.com. NEVER invent URLs. Set null if not found in VERIFIED list.\n' +
    '- time: specific elapsed time like "2 hours ago" or "45 minutes ago". NEVER vague like "Hours ago".\n' +
    '- summary: 40-75 words. Complete sentences with context, key facts, and impact. NEVER just restate the headline. Include who did what, why it matters, and any key numbers/consequences.\n' +
    '- source_count: integer count of approved sources covering this story.\n' +
    '- no_update_intl: true if international empty.\n' +
    '- no_update_local: true if local empty.\n' +
    '- Return ONLY the JSON object. No markdown. No explanation.';
}

// ── APPROVED SOURCE NAMES (for validation) ──
const APPROVED_SOURCE_NAMES = [
  'Reuters', 'BBC', 'Bloomberg', 'NYT', 'CNN', 'WSJ', 'CNBC',
  'Fox News', 'Fox Business', 'FT', 'AP', 'The Guardian', 'NBC News',
  'SCMP', 'RTHK', 'HKET', 'Ming Pao', 'HKT', 'On.cc', 'The Standard', 'HKFP'
];

// ── VALIDATE AND CLEAN RESPONSE ──

async function validateAndClean(parsed) {
  async function cleanSection(stories) {
    if (!stories || !stories.length) return [];
    const cleaned = [];
    for (const story of stories) {
      // Validate sources — strip any not in approved list
      const validSources = (story.sources || []).filter(s => {
        const name = (s.name || '').trim();
        if (APPROVED_SOURCE_NAMES.includes(name)) return true;
        return APPROVED_DOMAINS.some(d => {
          const src = name.toLowerCase().replace(/\s/g, '');
          return d.includes(src) || src.includes(d.split('.')[0]);
        });
      });

      // Strip sources with unapproved domains
      const approvedSources = validSources.filter(s => !s.url || s.url === 'NOT FOUND' || isApprovedDomain(s.url));

      // Must have at least one valid free source
      const hasFreeSource = approvedSources.some(s => !s.paywalled);
      if (!hasFreeSource) continue;

      // Reject fabricated stories
      if ((story.url || '').includes('example.com')) continue;
      if ((story.summary || '').toLowerCase().includes('placeholder')) continue;
      if ((story.headline || '').toLowerCase().includes('local news update')) continue;
      if ((story.headline || '').toLowerCase().includes('placeholder')) continue;

      // Determine story-level URL: must be a specific article URL, never a homepage
      let storyUrl = story.url;
      if (!isApprovedDomain(storyUrl) || !isArticleUrl(storyUrl)) {
        // Look for a valid article URL from free sources
        const freeArticle = approvedSources.find(s => !s.paywalled && isApprovedDomain(s.url) && isArticleUrl(s.url));
        storyUrl = freeArticle ? freeArticle.url : null;
      }

      // Clean source URLs: null if NOT FOUND, unapproved domain, or homepage/section URL
      const cleanedSources = approvedSources.map(s => {
        const isPaywalled = s.paywalled || PAYWALLED.includes(s.name);
        let sourceUrl = s.url;
        if (!sourceUrl || sourceUrl === 'NOT FOUND' || !isApprovedDomain(sourceUrl) || !isArticleUrl(sourceUrl)) {
          sourceUrl = null;
        }
        return { ...s, paywalled: isPaywalled, url: sourceUrl };
      });

      cleaned.push({ ...story, sources: cleanedSources, url: storyUrl });
    }
    return cleaned;
  }

  return {
    international: await cleanSection(parsed.international),
    local: await cleanSection(parsed.local),
    no_update_intl: parsed.no_update_intl,
    no_update_local: parsed.no_update_local,
  };
}

// ── MAIN HANDLER ──

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (!GEMINI_KEY) {
    res.status(500).json({ error: 'Server configuration error. Please contact the administrator.' });
    return;
  }

  const { type, morningHeadlines, isFirstRun } = req.method === 'POST'
    ? req.body
    : { type: req.query.type, morningHeadlines: [], isFirstRun: true };

  if (!type || !['morning', 'evening'].includes(type)) {
    res.status(400).json({ error: 'Invalid request.' });
    return;
  }

  try {
    // Run Call 1 (grounded search) + RSS feed fetch in parallel to save time
    const [call1Result, rssUrls] = await Promise.all([
      callGemini(
        call1Prompt(type, morningHeadlines || [], isFirstRun !== false),
        true, true
      ),
      fetchRssUrls(type)
    ]);
    const trendReport = call1Result.text;
    // Combine grounding chunks + RSS article URLs for verified source links
    const groundingUrls = [
      ...prepareGroundingUrls(call1Result.groundingUrls || []),
      ...rssUrls
    ].slice(0, 30);

    // Call 2 (JSON mode): Structure output using trend report + verified grounding URLs
    const raw = await callGemini(
      call2JsonPrompt(trendReport.substring(0, 4000), type, isFirstRun !== false, groundingUrls),
      false,
      false
    );

    // Parse JSON
    let parsed;
    try {
      const clean = raw.replace(/```json|```/gi, '').trim();
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON found');
      parsed = JSON.parse(match[0]);
    } catch(e) {
      console.error('Daily Pulse JSON parse error:', e.message);
      res.status(500).json({ error: "Couldn't fetch headlines right now. Please try again in a moment." });
      return;
    }

    // Validate and clean
    const validated = await validateAndClean(parsed);
    res.status(200).json(validated);
  } catch(e) {
    console.error('Daily Pulse digest error:', e.message);
    res.status(500).json({ error: "Couldn't fetch headlines right now. Please try again in a moment." });
  }
}
