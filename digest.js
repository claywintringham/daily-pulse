// Daily Pulse — Vercel Serverless Function
// Handles all three Gemini calls server-side with URL validation

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

const PAYWALLED = ['WSJ', 'Bloomberg', 'FT'];
const APPROVED_DOMAINS = [
  'reuters.com', 'bbc.com', 'bloomberg.com', 'nytimes.com', 'cnn.com',
  'wsj.com', 'cnbc.com', 'foxnews.com', 'foxbusiness.com', 'ft.com',
  'apnews.com', 'theguardian.com', 'nbcnews.com',
  'scmp.com', 'rthk.hk', 'hket.com', 'mingpao.com', 'hkt.com',
  'on.cc', 'thestandard.com.hk', 'hongkongfp.com'
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

// ── URL VALIDATION ──
function isApprovedDomain(url) {
  if (!url || url === 'NOT FOUND') return false;
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    return APPROVED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch { return false; }
}

function isArticleUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    // Reject pure homepages and section pages (path is / or just /section)
    const path = u.pathname.replace(/\/$/, '');
    return path.length > 10; // article paths are always longer than /news or /world
  } catch { return false; }
}

async function verifyUrl(url) {
  if (!isApprovedDomain(url) || !isArticleUrl(url)) return false;
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
    return res.ok || res.status === 405; // 405 = method not allowed but URL exists
  } catch { return false; }
}

// ── GEMINI API CALL ──
async function callGemini(prompt, useGrounding) {
  let lastError = null;
  for (const model of MODELS) {
    try {
      const body = {
        contents: [{ parts: [{ text: prompt }], role: 'user' }],
        generationConfig: { temperature: useGrounding ? 0.1 : 0.0, maxOutputTokens: useGrounding ? 3000 : 8000 }
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
          lastError = new Error(msg); continue;
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
        lastError = new Error('Empty response (reason: ' + reason + ') from ' + model);
        continue;
      }

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
  const recency = isEvening ? '6 hours' : '12 hours';
  const today = new Date().toLocaleDateString('en-HK', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const firstRunRule = isFirstRun
    ? 'CRITICAL FIRST RUN: You MUST return at least one international AND one local story. Empty sections are strictly forbidden. Descend to top 4, 5, 6 and beyond until real stories are found. Never invent placeholder content.'
    : 'If no qualifying story exists, mark that section as no update.';
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
    'TIME: [e.g. "3 hours ago"]\n' +
    'COVERING SOURCES: [source name and position rank]\n' +
    'FREE SOURCES: [non-paywalled sources]\n' +
    'SUMMARY: [70 words max]\n\n' +
    'Plain text only. No JSON. Label sections INTERNATIONAL STORIES and LOCAL HK STORIES.';
}

function call2Prompt(trendReport) {
  return 'You are a URL retrieval assistant.\n\n' +
    'TREND REPORT:\n' + trendReport + '\n\n' +
    'TASK: For each story and source listed, find the exact article URL using targeted searches like "site:reuters.com [headline keywords]".\n\n' +
    'APPROVED DOMAINS ONLY: ' + APPROVED_DOMAINS.join(', ') + '\n\n' +
    'RULES:\n' +
    '- URL must be a specific article page with a path longer than /section-name. Reject homepages.\n' +
    '- WSJ, Bloomberg, FT: mark paywalled:yes. Still find URL if possible.\n' +
    '- If no article URL found, write NOT FOUND.\n' +
    '- Never use URLs from unapproved domains.\n\n' +
    'Output for each story:\n' +
    'STORY: [headline]\n' +
    'URLS:\n' +
    '  - [Source] | paywalled:[yes/no] | [URL or NOT FOUND]\n' +
    'BEST FREE URL: [best free article URL]\n\n' +
    'Plain text only.';
}

function call3Prompt(trendReport, urlReport, type, isFirstRun) {
  const count = type === 'evening' ? 1 : 2;
  const firstRunNote = isFirstRun
    ? 'CRITICAL: First run. Both arrays must be non-empty with real stories only. No placeholders. No invented sources.'
    : 'Empty arrays allowed if no stories qualified.';
  return 'Convert these reports into a single JSON object.\n\n' +
    'TREND REPORT:\n' + trendReport + '\n\n' +
    'URL REPORT:\n' + urlReport + '\n\n' +
    'APPROVED SOURCES ONLY: ' + INTL_SOURCES + ', ' + LOCAL_SOURCES + '\n\n' +
    'JSON SCHEMA:\n' +
    '{"international":[{"headline":"...","time":"X hours ago","summary":"...","source_count":N,"sources":[{"name":"Reuters","position":1,"url":"https://...","paywalled":false}],"url":"https://..."}],"local":[...]}\n\n' +
    'STRICT RULES:\n' +
    '- ' + firstRunNote + '\n' +
    '- international: up to ' + count + ' stories. local: up to ' + count + ' stories.\n' +
    '- ONLY include sources from the approved list. Reject AP News, Global News, Local Gazette, or any unapproved source.\n' +
    '- paywalled: true for WSJ, Bloomberg, FT only.\n' +
    '- story url: best free article URL. Never a homepage. Never paywalled URL.\n' +
    '- source url: from URL report only. If NOT FOUND and free, use source homepage as last resort.\n' +
    '- summary: complete sentences only. Never truncate mid-sentence. 70 words max.\n' +
    '- source_count: integer count of approved sources covering this story.\n' +
    '- no_update_intl: true if international empty.\n' +
    '- no_update_local: true if local empty.\n' +
    '- Return ONLY the JSON object. No markdown. No explanation.';
}

// ── VALIDATE AND CLEAN RESPONSE ──
async function validateAndClean(parsed) {
  async function cleanSection(stories) {
    if (!stories || !stories.length) return [];
    const cleaned = [];
    for (const story of stories) {
      // Validate sources — strip any not in approved list
      const validSources = (story.sources || []).filter(s => {
        const name = s.name || '';
        return APPROVED_DOMAINS.some(d => {
          const src = name.toLowerCase().replace(/\s/g, '');
          return d.includes(src) || src.includes(d.split('.')[0]);
        }) || ['Reuters','BBC','Bloomberg','NYT','CNN','WSJ','CNBC','Fox News',
               'Fox Business','FT','AP','The Guardian','NBC News','SCMP','RTHK',
               'HKET','Ming Pao','HKT','On.cc','The Standard','HKFP'].includes(name);
      });

      // Strip sources with unapproved domains
      const approvedSources = validSources.filter(s => !s.url || isApprovedDomain(s.url));

      // Must have at least one valid free source
      const hasFreeSource = approvedSources.some(s => !s.paywalled);
      if (!hasFreeSource) continue;

      // Verify story-level URL
      let storyUrl = story.url;
      if (!isApprovedDomain(storyUrl) || !isArticleUrl(storyUrl)) {
        // Find best free source URL as fallback
        const freeSource = approvedSources.find(s => !s.paywalled && isArticleUrl(s.url));
        storyUrl = freeSource ? freeSource.url : null;
      }

      // Skip entirely fabricated stories (example.com, placeholder text)
      if (storyUrl && storyUrl.includes('example.com')) continue;
      if ((story.summary || '').toLowerCase().includes('placeholder')) continue;
      if ((story.headline || '').toLowerCase().includes('local news update')) continue;

      cleaned.push({ ...story, sources: approvedSources, url: storyUrl });
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
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (!GEMINI_KEY) {
    res.status(500).json({ error: 'GEMINI_API_KEY not configured on server.' });
    return;
  }

  const { type, morningHeadlines, isFirstRun } = req.method === 'POST'
    ? req.body
    : { type: req.query.type, morningHeadlines: [], isFirstRun: true };

  if (!type || !['morning', 'evening'].includes(type)) {
    res.status(400).json({ error: 'Invalid type. Must be morning or evening.' });
    return;
  }

  try {
    // Call 1: Identify trending stories
    const trendReport = await callGemini(
      call1Prompt(type, morningHeadlines || [], isFirstRun !== false),
      true
    );

    // Call 2: Retrieve exact article URLs
    const urlReport = await callGemini(
      call2Prompt(trendReport.substring(0, 4000)),
      true
    );

    // Call 3: Structure into JSON
    const raw = await callGemini(
      call3Prompt(trendReport.substring(0, 3000), urlReport.substring(0, 3000), type, isFirstRun !== false),
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
      res.status(500).json({ error: 'Failed to parse Gemini response: ' + e.message });
      return;
    }

    // Validate and clean
    const validated = await validateAndClean(parsed);

    res.status(200).json(validated);
  } catch(e) {
    res.status(500).json({ error: e.message || 'Unknown server error' });
  }
}
