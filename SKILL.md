---
name: daily-pulse-dev
description: Use this skill when debugging, revising, or delivering updates to the Daily Pulse HTML app. Covers the full workflow from code edits through syntax checks to commit message generation.
---

# Daily Pulse Dev Skill

Follow this workflow for every code change, no matter how small.

## 1. Make the Edit

- Use surgical Python `str.replace` or `re.sub` for targeted changes — never rewrite the whole file unless explicitly asked
- After each replacement, verify the old string was actually found and replaced (print a confirmation)
- If a replacement fails, print the surrounding content to diagnose before retrying

## 2. Syntax Checks (run before every delivery)

Extract the JS from the HTML and verify all of the following pass:

```python
import re
with open('/mnt/user-data/outputs/daily-pulse.html', 'r') as f:
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

**Do not deliver if any check fails.** Fix the issue first, then re-run checks.

Common causes of failures:
- Raw `{}` inside a template literal (JS reads them as code braces)
- Duplicate closing backtick after a template literal
- Extra `}` left over from a regex replacement
- Prompt strings that contain JS-like syntax

## 3. Runtime JS Check (run before every delivery)

Run Node.js to catch real runtime errors — undefined variables, bad syntax, scoping issues:

```python
import re, subprocess, tempfile, os

with open('/mnt/user-data/outputs/daily-pulse.html', 'r') as f:
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

if result.returncode == 0:
    print("✅ JS runtime check passed")
else:
    print("❌ JS runtime errors:")
    print(result.stderr)
```

**Do not deliver if this check fails.** Fix the runtime error first.

This catches:
- Undefined function references (e.g. `renderSection` called but not defined)
- Variable scoping issues
- Syntax errors that brace-counting misses
- Template literal problems with complex strings

## 4. Feature Integrity Check (run before every delivery)

Check that all critical strings are still present in the file after edits:

```python
checks = [
    ('function researchPrompt',     'researchPrompt'),
    ('function structurePrompt',    'structurePrompt'),
    ('function mergeDigests',       'mergeDigests'),
    ('function callGeminiGrounded', 'callGeminiGrounded'),
    ('function callGeminiStructured','callGeminiStructured'),
    ('function runDigest',          'runDigest'),
    ('function renderSection',      'renderSection'),
    ('function makeCard',           'makeCard'),
    ('function copyDigest',         'copyDigest'),
    ('function restoreDigests',     'restoreDigests'),
    ('mergeDigests(',               'merge called in runDigest'),
    ('google_search',               'search grounding tool'),
    ('isFirstRun',                  'first run detection'),
    ('CRITICAL FIRST RUN',          'strong first-run rule'),
    ('source_count',                'source_count field'),
    ('SOURCE_HOMES',                'source homepage fallbacks'),
    ('card-time',                   'story time display'),
    ('no_update_intl',              'intl no-update flag'),
    ('no_update_local',             'local no-update flag'),
    ('gemini-2.5-flash-lite',       'fallback model'),
    ('thestandard.com.hk',          'The Standard source'),
    ('Al Jazeera',                  'forbidden sources warning'),
    ('dp_gemini_key',               'API key storage'),
    ('dp_digests',                  'digest persistence'),
    ('Copy Morning to Capacities',  'morning copy button'),
    ('Copy Evening to Capacities',  'evening copy button'),
]

all_ok = True
for check, label in checks:
    found = check in content
    print(f"{'✅' if found else '❌'} {label}")
    if not found: all_ok = False

print()
print("✅ Ready to deliver" if all_ok else "❌ Fix issues before delivering")
```

**Do not deliver if any check fails.**

## 5. Deliver the File

Only call `present_files` after steps 2, 3, and 4 all pass cleanly.

## 6. Draft Commit Message

After delivering, always generate a commit message with:

**Title** (fewer than 50 characters)
- Imperative tense ("Fix", "Add", "Remove", "Update")
- Specific — name the thing that changed
- No full stop at the end
- Examples:
  - `Fix STOP reason treated as error in Call 1`
  - `Merge logic, story time, fix empty chips`
  - `Restore missing render and copy functions`

**Extended description**
- Bullet points only — no prose paragraphs
- Each bullet covers one discrete change
- State what changed and why, not just what
- End with: `No changes to [X]` for anything deliberately untouched
- Keep it under 100 words total

## App Reference

**File:** `daily-pulse.html`
**Hosted:** `claywintringham.github.io/daily-pulse/daily-pulse.html`
**Stack:** Single-file HTML, Vanilla JS, Gemini API with Google Search grounding
**Key storage:** `localStorage` — `dp_gemini_key`, `dp_digests`
**Sources — International:** Reuters, BBC, Bloomberg, NYT, CNN, WSJ, CNBC, Fox News
**Sources — Local HK:** SCMP, RTHK, HKET, Ming Pao, HKT, On.cc, The Standard
**Forbidden sources:** Al Jazeera, AP, Anadolu Agency, The News Pakistan
**Summary limit:** 70 words
**Story time format:** "X hours ago" as reported by the news source
**First run rule:** MUST return at least one intl and one local story — keep descending ranks until found
**Subsequent run rule:** Merge with existing using combined pool; rank by source_count desc, ties favour newer story
**Two-call architecture:** Call 1 = grounded research (plain text); Call 2 = structured JSON (no grounding)
**Fallback model:** gemini-2.5-flash → gemini-2.5-flash-lite on overload
