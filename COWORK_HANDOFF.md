# Daily Pulse — Cowork Development Handoff

## Your Mission
You are the sole developer of the Daily Pulse web app. Your job is to fix bugs, test the live app, and commit working code to the GitHub repository. Work autonomously in a loop: fix → commit → test → fix again until all issues are resolved.

---

## Repository
**GitHub repo:** `https://github.com/claywintringham/daily-pulse`
**Live app URL:** `https://claywintringham.github.io/daily-pulse/daily-pulse.html`
**File to edit:** `daily-pulse.html` (single file, entire app)

---

## App Overview
Daily Pulse is a single-file iPhone PWA that fetches live news headlines for a Hong Kong reader using the Gemini API with Google Search grounding. It makes three sequential API calls per run:

- **Call 1 (grounded):** Gemini searches the web and identifies the most repeated top headlines from approved sources published in the last 12h (morning) or 6h (evening). Returns plain text report.
- **Call 2 (grounded):** Gemini does targeted `site:domain headline` searches to find exact article URLs for each story from each source. Returns plain text URL report.
- **Call 3 (no grounding):** Gemini receives both reports and structures everything into clean JSON. Uses `responseMimeType` is NOT set — JSON is extracted via greedy regex + brace-counting parser.

**Morning run:** 3 international + 3 local HK headlines
**Evening run:** 1 international + 1 local HK headline (different from morning's)

---

## Source Lists

**International (approved only):**
Reuters (reuters.com), BBC (bbc.com), Bloomberg (bloomberg.com), NYT (nytimes.com), CNN (cnn.com), WSJ (wsj.com), CNBC (cnbc.com), Fox News (foxnews.com), Fox Business (foxbusiness.com), FT (ft.com)

**Local HK (approved only):**
SCMP (scmp.com), RTHK (rthk.hk), HKET (hket.com), Ming Pao (mingpao.com), HKT (hkt.com), On.cc (on.cc), The Standard (thestandard.com.hk)

**Paywalled (chip shown with 🔒, never hyperlinked):** WSJ, Bloomberg, FT
**Free (chip always hyperlinked to specific article):** all others

**Forbidden sources (must never appear):** Al Jazeera, AP, Anadolu Agency, The News Pakistan, Kurdistan24, or any unlisted outlet

---

## Business Logic Rules

1. **First run of the day:** Must always return at least one international AND one local story. Never empty. Keep descending ranks (top 4, 5, 6...) until stories are found.
2. **Subsequent runs same day:** Merge new results with existing using combined pool — rank by `source_count` descending; equal counts favour the newer (more recent) story. Keep top 3.
3. **Story qualification:** Must appear in top 3 positions of at least 3 approved sources, AND be covered by at least one free source.
4. **Recency:** Morning = last 12 hours only. Evening = last 6 hours only. Reject older stories.
5. **Paywall rule:** WSJ, Bloomberg, FT chips show with 🔒 but are never hyperlinked. All free source chips must be hyperlinked to a specific article (not homepage).
6. **Read full article:** Always links to best free source article URL.
7. **Story time:** Show "X hours ago" as reported by the news source on each card, in accent colour.
8. **Evening exclusion:** Evening digest must not repeat morning stories.
9. **Persistence:** Both morning and evening digests saved to localStorage, restored on app reopen with date + time stamps.

---

## Development Workflow (follow every time before committing)

### Step 1 — Make the edit
Use surgical string replacement. Never rewrite the whole file unless necessary. Verify each replacement succeeded before continuing.

### Step 2 — Syntax checks
```python
import re
with open('daily-pulse.html', 'r') as f:
    content = f.read()
script_content = re.search(r'<script>([\s\S]*?)</script>', content).group(1)
backticks = script_content.count('`')
opens     = script_content.count('{')
closes    = script_content.count('}')
parens_o  = script_content.count('(')
parens_c  = script_content.count(')')
print(f"Backticks: {backticks} ({'OK' if backticks % 2 == 0 else 'UNBALANCED'})")
print(f"Braces:    {opens}/{closes} ({'OK' if opens == closes else 'UNBALANCED'})")
print(f"Parens:    {parens_o}/{parens_c} ({'OK' if parens_o == parens_c else 'UNBALANCED'})")
```
**Do not commit if any check fails.**

### Step 3 — Runtime JS check
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
    f.write(wrapped)
    tmpfile = f.name
result = subprocess.run(['node', '--check', tmpfile], capture_output=True, text=True)
os.unlink(tmpfile)
print("✅ Runtime OK" if result.returncode == 0 else "❌ " + result.stderr)
```
**Do not commit if this fails.**

### Step 4 — Integrity check
Verify all of the following strings are present in the file:
```
function call1Prompt
function call2Prompt
function call3Prompt
function mergeDigests
function renderSection
function makeCard
function copyDigest
function callGeminiGrounded
function callGeminiStructured
function runDigest
function restoreDigests
PAYWALLED_SOURCES
foxbusiness.com
ft.com
CRITICAL FIRST RUN
source-chip-paywall
card-time
SOURCE_HOMES
mergeDigests(
call1Prompt(
call2Prompt(
call3Prompt(
no_update_intl
no_update_local
gemini-2.5-flash-lite
google_search
dp_gemini_key
dp_digests
Copy Morning to Capacities
Copy Evening to Capacities
```
**Do not commit if any are missing.**

### Step 5 — Commit and push
Commit with a title under 50 characters. Push to `main` branch. Wait 60 seconds for GitHub Pages to deploy.

### Step 6 — Test the live app
Open `https://claywintringham.github.io/daily-pulse/daily-pulse.html` in a browser.
- Tap ☀️ Morning — wait up to 90 seconds
- Record: success or exact error message
- If success: check all items in the testing checklist below
- Repeat 3 times minimum

### Step 7 — If errors found, go back to Step 1

---

## Testing Checklist (check after every successful run)

- [ ] Headlines are recent — all show "X hours ago" label in accent colour
- [ ] At least 1 international + 1 local HK headline on first run (never empty)
- [ ] No forbidden sources appear (Al Jazeera, AP, Anadolu, etc.)
- [ ] WSJ, Bloomberg, FT chips show 🔒 and are NOT hyperlinked
- [ ] All free source chips are hyperlinked to specific articles (not homepages)
- [ ] "Read full article →" links to a specific free-source article
- [ ] No source links go to unapproved domains
- [ ] Evening headlines differ from morning headlines
- [ ] Digest persists when app is closed and reopened
- [ ] Both morning and evening sections show date + time fetched

---

## Known Issues to Fix (start here)

These bugs were identified in the last test session and are not yet resolved:

1. **Stale headlines** — App sometimes surfaces old stories despite the 12h recency rule. Investigate whether Call 1 grounding is respecting the recency constraint. Consider adding `after:` date operator to grounding search queries.

2. **Wrong article URLs** — Some source chips link to homepages instead of specific articles. Call 2 targeted `site:domain` searches are not always returning article-level URLs. Consider adding a validation step that rejects any URL that is just a domain root (e.g. `https://reuters.com` with no path).

3. **Forbidden sources appearing** — Kurdistan24 and other unlisted sources have appeared in results. Add a URL domain validation step in Call 3 — reject any source whose URL domain is not in the approved domains list.

4. **Intermittent empty first run** — Despite CRITICAL FIRST RUN rule, occasionally returns empty sections on first run. The prompt instruction may need to be even more forceful, or a retry mechanism added that re-runs Call 1 if the result is empty.

5. **STOP finish reason returning empty** — When Gemini returns `finishReason: STOP` with 0 parts, the current fallback extracts from `groundingSupports` which may also be empty. Need a more robust fallback — consider retrying the same call once before falling back to the next model.

---

## Commit Message Format

**Title:** Under 50 characters, imperative tense, no full stop
**Description:** Bullet points only, what changed and why, under 100 words

---

## Notes on Gemini API behaviour

- `gemini-2.5-flash` is the primary model; `gemini-2.5-flash-lite` is the fallback on 429/503
- Google Search grounding and `responseMimeType: application/json` cannot be used together — Call 1 and Call 2 use grounding without JSON mode; Call 3 uses JSON mode without grounding
- Grounding responses sometimes return text across multiple `parts` — always concatenate all text parts
- When `finishReason` is `STOP` with empty parts, attempt to extract from `groundingSupports[].segment.text` before failing
- Research report from Call 1 is truncated to 4000 chars before passing to Call 2, and both are truncated to 3000 chars each before passing to Call 3

