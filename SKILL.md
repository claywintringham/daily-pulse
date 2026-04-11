---
name: daily-pulse-dev
description: Use this skill when debugging, revising, or delivering updates to the Daily Pulse web app. Covers the full workflow from code edits through checks to commit message generation.
---

# Daily Pulse Dev Skill

Follow this workflow for every code change, no matter how small.

## Project Structure
```
daily-pulse/
├── daily-pulse.html      ← frontend UI only, no API key
├── api/
│   └── digest.js         ← Vercel serverless function, all Gemini calls
├── SKILL.md              ← this file
└── COWORK_HANDOFF.md     ← full app context and bug list
```

**Live app:** `https://daily-pulse-theta.vercel.app/daily-pulse.html`
**API endpoint:** `https://daily-pulse-theta.vercel.app/api/digest`
**Vercel auto-deploys on every push to main.**

---

## Step 1 — Identify which file to edit
- API calls, URL validation, prompt logic, source filtering → `api/digest.js`
- UI rendering, card display, copy, persistence, merge logic → `daily-pulse.html`

## Step 2 — Make the Edit
- Use surgical string replacement — never rewrite the whole file unless necessary
- After each replacement, verify the old string was found and replaced (print confirmation)
- If a replacement fails, print surrounding content to diagnose before retrying

## Step 3 — Syntax Checks (for `daily-pulse.html` JS only)
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

Common failure causes:
- Raw `{}` inside a template literal
- Duplicate closing backtick after a template literal
- Extra `}` left over from a regex replacement

## Step 4 — Runtime JS Check (for `daily-pulse.html` JS only)
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
**Do not commit if this fails.**

This catches: undefined function references, scoping issues, syntax errors that brace-counting misses.

## Step 5 — Feature Integrity Check
Run before every commit. Verify these strings exist in each file:

**`daily-pulse.html` must contain:**
```
API_BASE, daily-pulse-theta.vercel.app, PAYWALLED_SOURCES, SOURCE_HOMES,
function runDigest, function mergeDigests, function renderSection,
function makeCard, function copyDigest, function restoreDigests,
currentSession, no_update_intl, no_update_local, source-chip-paywall,
card-time, Copy Morning to Capacities, Copy Evening to Capacities,
dp_digests, updateSubtitles
```

**`api/digest.js` must contain:**
```
GEMINI_KEY, PAYWALLED, APPROVED_DOMAINS, foxbusiness.com, hongkongfp.com,
apnews.com, theguardian.com, nbcnews.com, isArticleUrl, isApprovedDomain,
verifyUrl, validateAndClean, call1Prompt, call2Prompt, call3Prompt,
callGemini, placeholder, example.com, export default,
Access-Control-Allow-Origin
```

**Do not commit if any are missing.**

## Step 6 — Commit and Push
- Push to `main` branch — Vercel auto-deploys within 30 seconds
- Wait for green **Ready** status in Vercel dashboard before testing

## Step 7 — Test the Live App
Open `https://daily-pulse-theta.vercel.app/daily-pulse.html`
- Tap ☀️ Morning — wait up to 90 seconds
- Run at least 3 times before declaring a fix successful
- Check all items in the testing checklist (see COWORK_HANDOFF.md)

## Step 8 — Draft Commit Message

**Title** (fewer than 50 characters)
- Imperative tense: "Fix", "Add", "Remove", "Update"
- Specific — name the thing that changed
- No full stop
- Examples:
  - `Fix STOP grounding empty response retry`
  - `Reject fabricated placeholder sources`
  - `Add URL verification to digest.js`

**Extended description**
- Bullet points only
- Each bullet: what changed and why
- End with: `No changes to [X]` for anything deliberately untouched
- Under 100 words total

---

## App Reference

| Property | Value |
|---|---|
| Live app | https://daily-pulse-theta.vercel.app/daily-pulse.html |
| API | https://daily-pulse-theta.vercel.app/api/digest |
| GitHub | https://github.com/claywintringham/daily-pulse |
| API key | In Vercel env as `GEMINI_API_KEY` — never in code |
| Primary model | gemini-2.5-flash |
| Fallback model | gemini-2.5-flash-lite |
| Morning | 2 intl + 2 local headlines |
| Evening | 1 intl + 1 local headline |
| Paywalled | WSJ, Bloomberg, FT — chip shown 🔒, never linked |
| Recency | Morning: last 12h · Evening: last 6h |
| Summary limit | 70 words, complete sentences only |
| Story time | "Published X hours ago" in accent colour |

