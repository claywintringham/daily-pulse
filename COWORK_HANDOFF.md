# Daily Pulse — Cowork Development Handoff

## Your Mission
You are the sole developer of the Daily Pulse web app. Fix bugs, test the live app, and commit working code to the GitHub repository. Work autonomously in a loop: fix → commit → test → fix again until all issues are resolved and the testing checklist passes consistently.

---

## Repository & URLs
- **GitHub repo:** `https://github.com/claywintringham/daily-pulse`
- **Live app:** `https://daily-pulse-theta.vercel.app/daily-pulse.html`
- **API endpoint:** `https://daily-pulse-theta.vercel.app/api/digest`
- **Vercel project:** `daily-pulse-theta.vercel.app` (auto-deploys on every GitHub push to main)

## File Structure
```
daily-pulse/
├── daily-pulse.html      ← frontend UI only, no API key
├── api/
│   └── digest.js         ← Vercel serverless function, all Gemini calls
├── SKILL.md              ← coding workflow rules
└── COWORK_HANDOFF.md     ← this file
```

---

## Architecture Overview

### Frontend (`daily-pulse.html`)
Pure UI. No Gemini API key. Makes a single POST request to `/api/digest` and renders the response. Handles persistence via localStorage, merge logic, and card rendering.

### Backend (`api/digest.js`)
Vercel serverless function. Handles all three Gemini calls:
- **Call 1 (grounded):** Identifies trending stories from approved sources published within recency window
- **Call 2 (grounded):** Targeted `site:domain` searches to find exact article URLs per story per source
- **Call 3 (no grounding):** Structures everything into validated JSON

Also handles:
- URL validation (rejects homepages, unapproved domains, placeholder content)
- Forbidden source rejection
- Model fallback (gemini-2.5-flash → gemini-2.5-flash-lite on overload)

### Environment Variable
`GEMINI_API_KEY` is set in Vercel dashboard under Settings → Environment Variables. Never put it in code.

### API Contract
**Request:** `POST /api/digest`
```json
{ "type": "morning", "morningHeadlines": [], "isFirstRun": true }
```
**Response:**
```json
{
  "international": [
    {
      "headline": "...",
      "time": "3 hours ago",
      "summary": "...",
      "source_count": 4,
      "sources": [{"name": "Reuters", "position": 1, "url": "https://reuters.com/...", "paywalled": false}],
      "url": "https://reuters.com/..."
    }
  ],
  "local": [...],
  "no_update_intl": false,
  "no_update_local": false
}
```

---

## Source Lists

**International (13 sources):**
Reuters (reuters.com), BBC (bbc.com), Bloomberg (bloomberg.com), NYT (nytimes.com), CNN (cnn.com), WSJ (wsj.com), CNBC (cnbc.com), Fox News (foxnews.com), Fox Business (foxbusiness.com), FT (ft.com), AP (apnews.com), The Guardian (theguardian.com), NBC News (nbcnews.com)

**Local HK (8 sources):**
SCMP (scmp.com), RTHK (rthk.hk), HKET (hket.com), Ming Pao (mingpao.com), HKT (hkt.com), On.cc (on.cc), The Standard (thestandard.com.hk), HKFP (hongkongfp.com)

**Paywalled (chip shown with 🔒, never hyperlinked):** WSJ, Bloomberg, FT

**Forbidden (must never appear):** Al Jazeera, Anadolu Agency, The News Pakistan, Kurdistan24, Local Gazette, Global News, Times of India, or any outlet not in the approved lists

---

## Business Logic Rules

1. **Morning:** 2 international + 2 local HK headlines
2. **Evening:** 1 international + 1 local HK headline (different from morning's)
3. **First run of the day:** Must always return at least 1 intl AND 1 local. Never empty. Keep descending ranks until found. Never invent placeholder content.
4. **Subsequent runs:** Merge with existing using combined pool — rank by source_count desc; equal counts favour newer story. Keep top 2 (morning) or top 1 (evening).
5. **Story qualification:** Must appear in top 3 positions of at least 3 approved sources AND be covered by at least one free source.
6. **Recency:** Morning = last 12 hours only. Evening = last 6 hours only. Reject older stories.
7. **Paywalled sources:** WSJ, Bloomberg, FT chips show with 🔒 but are never hyperlinked.
8. **Free source chips:** Always hyperlinked to specific article URL (not homepage). Fall back to source homepage only if no article URL found.
9. **Read full article:** Always links to best free source article. Never a homepage. Never paywalled.
10. **Story time:** Show "Published X hours ago" in accent colour on each card.
11. **Evening exclusion:** Evening digest must not repeat morning stories.
12. **Persistence:** Both morning and evening digests saved to localStorage, restored on app reopen.
13. **Session guard:** Stale async responses (from previous runs) must be ignored using session token.
14. **No fabrication:** Any story where the source name is not in the approved list, or the URL is example.com or contains "placeholder", must be rejected before saving.

---

## Development Workflow

### Step 1 — Identify which file to edit
- Bug in API calls, URL validation, prompt logic, source filtering → edit `api/digest.js`
- Bug in UI rendering, card display, copy, persistence, merge → edit `daily-pulse.html`

### Step 2 — Make the edit
Use surgical string replacement. Never rewrite the whole file unless necessary. Verify each replacement succeeded.

### Step 3 — Syntax checks (for `daily-pulse.html` JS changes)
```python
import re
with open('daily-pulse.html', 'r') as f:
    content = f.read()
script_content = re.search(r'<script>([\s\S]*?)</script>', content).group(1)
backticks = script_content.count('`')
opens = script_content.count('{')
closes = script_content.count('}')
parens_o = script_content.count('(')
parens_c = script_content.count(')')
print(f"Backticks: {backticks} ({'OK' if backticks % 2 == 0 else 'UNBALANCED'})")
print(f"Braces: {opens}/{closes} ({'OK' if opens == closes else 'UNBALANCED'})")
print(f"Parens: {parens_o}/{parens_c} ({'OK' if parens_o == parens_c else 'UNBALANCED'})")
```

### Step 4 — Runtime JS check (for `daily-pulse.html` JS changes)
```python
import re, subprocess, tempfile, os
with open('daily-pulse.html', 'r') as f:
    content = f.read()
script_content = re.search(r'<script>([\s\S]*?)</script>', content).group(1)
stub = '''
const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const document = {
  getElementById: () => ({ style: {}, className: '', textContent: '', innerHTML: '', insertAdjacentHTML: () => {} }),
  createElement: () => ({ className: '', innerHTML: '', appendChild: () => {} }),
  querySelector: () => ({ textContent: '', className: '' }),
  body: { appendChild: () => {}, removeChild: () => {} }
};
const window = { addEventListener: () => {} };
const navigator = { clipboard: { writeText: () => Promise.resolve() } };
const fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
'''
wrapped = stub + '\n(function() {\n' + script_content + '\n})();'
with tempfile.NamedTemporaryFile(mode='w', suffix='.js', delete=False) as f:
    f.write(wrapped); tmpfile = f.name
result = subprocess.run(['node', '--check', tmpfile], capture_output=True, text=True)
os.unlink(tmpfile)
print("✅ Runtime OK" if result.returncode == 0 else "❌ " + result.stderr)
```

### Step 5 — Integrity check
Verify these strings are present in `daily-pulse.html`:
```
API_BASE, daily-pulse-theta.vercel.app, PAYWALLED_SOURCES, SOURCE_HOMES,
function runDigest, function mergeDigests, function renderSection,
function makeCard, function copyDigest, function restoreDigests,
currentSession, no_update_intl, no_update_local, source-chip-paywall,
card-time, Copy Morning to Capacities, Copy Evening to Capacities,
dp_digests, updateSubtitles
```

Verify these strings are present in `api/digest.js`:
```
GEMINI_KEY, PAYWALLED, APPROVED_DOMAINS, foxbusiness.com, hongkongfp.com,
apnews.com, theguardian.com, nbcnews.com, isArticleUrl, isApprovedDomain,
verifyUrl, validateAndClean, call1Prompt, call2Prompt, call3Prompt,
callGemini, placeholder, example.com, export default,
Access-Control-Allow-Origin
```

### Step 6 — Commit and push
- Title: under 50 characters, imperative tense, no full stop
- Description: bullet points, what changed and why, under 100 words
- Push to `main` branch
- Vercel auto-deploys — wait 30 seconds for deployment to complete

### Step 7 — Test the live app
Open `https://daily-pulse-theta.vercel.app/daily-pulse.html` in a browser.
- Tap ☀️ Morning — wait up to 90 seconds
- Record result: success or exact error message
- If success: run the testing checklist below
- Repeat 3 times minimum before declaring a fix successful

### Step 8 — If issues found, return to Step 1

---

## Testing Checklist

Run after every successful fetch. All must pass before declaring the app stable.

- [ ] Headlines are recent — "Published X hours ago" visible on every card in accent colour
- [ ] At least 1 intl + 1 local on first run — never empty, never placeholder
- [ ] No forbidden sources (Al Jazeera, AP News used without approval, Global News, Local Gazette, etc.)
- [ ] WSJ, Bloomberg, FT chips show 🔒 and are NOT hyperlinked
- [ ] All free source chips are hyperlinked to specific articles (not homepages)
- [ ] No chip links to an unapproved domain
- [ ] "Read full article →" links to a specific free-source article (not a homepage, not paywalled)
- [ ] No hallucinated/fabricated sources or URLs
- [ ] Summary is complete — never truncated mid-sentence
- [ ] Evening headlines differ from morning headlines
- [ ] Digest persists on close/reopen with correct timestamps
- [ ] Button subtitles show actual story counts (e.g. "2 intl · 2 local")
- [ ] No background fetches running without user action
- [ ] Error messages are user-friendly (not raw debug strings)

---

## Known Issues to Address (in priority order)

### 🔴 Critical
1. **STOP grounding error (dominant failure mode)** — 3/4 runs fail with "Grounding returned no text (STOP)". The STOP handler tries `groundingSupports` but often finds nothing there either. Fix: when STOP returns empty on the primary model, wait 3 seconds and retry the same call once before falling back to the next model. Also try a simpler, shorter prompt on retry.

2. **Fabricated placeholder content** — Gemini invents "Local Reporter" source with `example.com` URL when it can't find real local news. The `validateAndClean` function in `digest.js` should catch this — verify it's working. If not, add an additional check: reject any story where source name is not in the approved list.

3. **Forbidden sources appearing** — AP News, Global News, Times of India appeared in unguarded fetches. Domain validation in `validateAndClean` should strip these — verify it's working after the Vercel migration.

### 🟠 High
4. **Hallucinated article URLs (404s)** — `verifyUrl` in `digest.js` does a HEAD request to verify URLs before returning them. Verify this is being called and working. If a URL returns 404, the function should fall back to the source homepage rather than returning the broken URL.

5. **STOP grounding error shown as raw debug text** — Error messages should be user-friendly. Replace all technical error strings with: "Couldn't fetch headlines right now. Please try again in a moment."

### 🟡 Medium
6. **Summary truncated mid-sentence** — Call 3 prompt instructs "complete sentences only, never truncate". Verify this instruction is present and that maxOutputTokens (8000) is sufficient.

7. **Duplicate position numbers** — Multiple sources can independently rank the same story #1. This is correct behaviour — update the UI to not imply these are conflicting if needed.

8. **Static "X hours ago" labels** — Story times are fixed at fetch time. Add a note in the digest header: "Fetched at [time] — story times as reported at fetch".

---

## Gemini API Notes
- Primary model: `gemini-2.5-flash`
- Fallback model: `gemini-2.5-flash-lite`
- Google Search grounding and `responseMimeType: application/json` cannot be used together
- Call 1 and Call 2 use grounding (no JSON mode)
- Call 3 uses JSON mode (no grounding, `responseMimeType: application/json`)
- STOP finish reason with empty parts = grounding consumed response budget; retry or fall back
- Trend report truncated to 4000 chars before Call 2; both truncated to 3000 chars each before Call 3
- 429/503 errors = model overloaded; fall back to gemini-2.5-flash-lite

