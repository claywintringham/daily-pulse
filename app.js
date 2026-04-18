
  let currentDigestData  = null;
  let currentLang        = 'en';
  let translationCache   = null;
  let currentGeneratedAt = null;
  let speakingId         = null;
  let currentAudio       = null;
  let audioCtx           = null;
  let currentSource      = null;
  const ttsCache         = new Map();
  let playAllActive      = false;

  // iOS detection — Web Audio API is unreliable on iOS Safari due to
  // AudioContext suspension behaviour; HTML Audio is more consistent.
  const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // Prefetch is disabled — it was consuming the Gemini TTS quota
  // (15 req/min) before users could play anything. On-demand only.

  const UI = {
    en: {
      updated:       'Updated',
      learnMore:     'Learn more →',
      breaking:      'Breaking',
      newBadge:      'New',
      international: 'International',
      hongKong:      'Hong Kong',
      loadingTitle:  'Fetching the latest digest…',
      loadingBody:   'This usually takes a minute.',
      noStoriesTitle:'No stories yet',
      noStoriesBody: 'The digest is being generated. Check back in a moment.',
      errTitle:      'Something went wrong',
      errRetry:      'Try refreshing, or check back in a few minutes.',
      errMeta:       'Could not load digest',
    },
    zh: {
      updated:       '更新於',
      learnMore:     '了解更多 →',
      breaking:      '突發',
      newBadge:      '最新',
      international: '國際',
      hongKong:      '香港',
      loadingTitle:  '正在載入最新摘要…',
      loadingBody:   '通常只需幾秒鐘。',
      noStoriesTitle:'暫無新聞',
      noStoriesBody: '摘要正在生成中，請稍後再查看。',
      errTitle:      '發生錯誤',
      errRetry:      '請重新整理，或稍後再試。',
      errMeta:       '無法載入摘要',
    },
  };
  function t(key) { return UI[currentLang]?.[key] ?? UI.en[key] ?? key; }




  const SEEN_TTL_MS = 36 * 60 * 60 * 1000;

  function getSeenHeadlines() {
    try {
      const raw = JSON.parse(localStorage.getItem('dp_seen') || '{}');
      const cutoff = Date.now() - SEEN_TTL_MS;
      const pruned = {};
      for (const [k, v] of Object.entries(raw)) {
        if (v > cutoff) pruned[k] = v;
      }
      return pruned;
    } catch { return {}; }
  }

  function markHeadlinesSeen(headlines) {
    try {
      const seen = getSeenHeadlines();
      const now  = Date.now();
      for (const h of headlines) {
        if (!seen[h]) seen[h] = now;
      }
      localStorage.setItem('dp_seen', JSON.stringify(seen));
    } catch {}
  }




  const LS_LANG     = 'dp_lang';
  const LS_XLAT_PFX = 'dp_xlat_';

  function saveLang(lang) {
    try { localStorage.setItem(LS_LANG, lang); } catch {}
  }

  function loadLang() {
    try { return localStorage.getItem(LS_LANG) || 'en'; } catch { return 'en'; }
  }

  function saveXlatCache(generatedAt, cache) {
    try {
      const target = LS_XLAT_PFX + generatedAt;
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(LS_XLAT_PFX) && k !== target) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
      localStorage.setItem(target, JSON.stringify(cache));
    } catch {}
  }

  function loadXlatCache(generatedAt) {
    try {
      const raw = localStorage.getItem(LS_XLAT_PFX + generatedAt);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }


  function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }


  function fmtPublished(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const diffMs    = Date.now() - d.getTime();
    const diffMins  = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays  = Math.floor(diffMs / 86400000);
    if (diffMins  <  1) return 'just now';
    if (diffMins  < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays  <  7) return `${diffDays}d ago`;
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short' });
  }


  function renderChips(sources) {
    return sources.map(s => {
      if (s.paywalled) {
        return `<span class="chip paywalled" title="Paywalled">${s.name} <span class="chip-pos">#${s.position}</span> 🔒</span>`;
      }
      if (!s.url) {
        return `<span class="chip unlinked">${s.name} <span class="chip-pos">#${s.position}</span></span>`;
      }
      return `<a class="chip" href="${s.url}" target="_blank" rel="noopener">${s.name} <span class="chip-pos">#${s.position}</span></a>`;
    }).join('');
  }


  function escAttr(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function getDisplayText(c) {
    if (currentLang === 'zh' && translationCache?.[c.id]) {
      return {
        headline: translationCache[c.id].headline,
        summary:  translationCache[c.id].summary,
      };
    }
    return { headline: c.headline, summary: c.summary };
  }

  function renderCluster(c, tag, isNew) {
    const { headline: displayHeadline, summary: displaySummary } = getDisplayText(c);

    const breakingBadge = c.isBreaking ? `<span class="breaking-badge">${t('breaking')}</span>` : '';
    const newBadge      = isNew        ? `<span class="new-badge">${t('newBadge')}</span>`      : '';
    const badge = breakingBadge || newBadge;
    const headlineHtml = c.readUrl
      ? `${badge}<a href="${c.readUrl}" target="_blank" rel="noopener">${displayHeadline}</a>`
      : `${badge}${displayHeadline}`;
    const pubTime  = fmtPublished(c.publishedAt);
    const timeHtml = pubTime ? `<time class="story-time">${pubTime}</time>` : '';

    const learnMoreHtml = c.learnMoreUrl
      ? `<a class="learn-more-link" href="${c.learnMoreUrl}" target="_blank" rel="noopener">${t('learnMore')}</a>`
      : '';

    const copyBtn = `<button class="story-copy-btn"
      data-headline="${escAttr(displayHeadline)}"
      data-summary="${escAttr(displaySummary || '')}"
      data-url="${escAttr(c.learnMoreUrl || c.readUrl || '')}"
      data-tag="${escAttr(tag || '')}"
      onclick="copyStory(this)"
      title="Copy story">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H6zM2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1h1v1a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1v1H2z"/>
      </svg>
    </button>`;

    const speakText = (displayHeadline ? displayHeadline + '. ' : '') + (displaySummary || '');
    const speakBtn = `<button class="story-speak-btn"
      data-id="${escAttr(c.id)}"
      data-text="${escAttr(speakText)}"
      onclick="speakStory(this)"
      title="Read aloud">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M11.536 14.01A8.473 8.473 0 0 0 14.026 8a8.473 8.473 0 0 0-2.49-6.01l-.708.707A7.476 7.476 0 0 1 13.025 8c0 2.071-.84 3.946-2.197 5.303l.708.707z"/>
        <path d="M10.121 12.596A6.48 6.48 0 0 0 12.025 8a6.48 6.48 0 0 0-1.904-4.596l-.707.707A5.483 5.483 0 0 1 11.025 8a5.483 5.483 0 0 1-1.61 3.89l.706.706z"/>
        <path d="M8.707 11.182A4.486 4.486 0 0 0 10.025 8a4.486 4.486 0 0 0-1.318-3.182L8 5.525A3.489 3.489 0 0 1 9.025 8 3.49 3.49 0 0 1 8 10.475l.707.707zM6.717 3.55A.5.5 0 0 1 7 4v8a.5.5 0 0 1-.812.39L3.825 10.5H1.5A.5.5 0 0 1 1 10V6a.5.5 0 0 1 .5-.5h2.325l2.363-1.89a.5.5 0 0 1 .529-.06z"/>
      </svg>
    </button>`;

    const footer = (learnMoreHtml || copyBtn || speakBtn)
      ? `<div class="story-footer">${learnMoreHtml}${copyBtn}${speakBtn}</div>`
      : '';

    return `
      <article class="story-card">
        <h2 class="story-headline">${headlineHtml}</h2>
        ${timeHtml}
        <p class="story-summary">${displaySummary || ''}</p>
        <div class="story-chips">${renderChips(c.sources)}</div>
        ${footer}
      </article>`;
  }

  function renderSection(label, clusters, tag, seenSet) {
    if (!clusters || clusters.length === 0) return '';
    return `
      <div class="section-header">
        <span class="section-label">${label}</span>
        <span class="section-rule"></span>
      </div>
      ${clusters.map(c => renderCluster(c, tag, !seenSet.has(c.headline))).join('')}`;
  }


  function updateMetaLine() {
    const meta = document.getElementById('meta-line');
    if (meta && currentGeneratedAt) {
      meta.textContent = `${t('updated')} ${fmtDate(currentGeneratedAt)}`;
    }
  }

  async function setLang(lang) {
    if (lang === currentLang && !(lang === 'zh' && !translationCache)) return;
    stopSpeaking();
    const btnEn = document.getElementById('lang-en');
    const btnZh = document.getElementById('lang-zh');
    const main = document.getElementById('main-content');
    const bar  = document.getElementById('translating-overlay');

    if (lang === 'zh') {
      if (!currentDigestData) return;
      btnEn.disabled = btnZh.disabled = true;
      btnZh.textContent = '…';
      if (!translationCache) {
        if (main) main.classList.add('translating');
        if (bar)  bar.classList.add('visible');
        const items = [
          ...(currentDigestData.international || []),
          ...(currentDigestData.local         || []),
        ].map(c => ({ id: c.id, headline: c.headline, summary: c.summary || '' }));
        try {
          const res = await fetch('/api/translate', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ items }),
          });
          if (!res.ok) throw new Error(`translate API ${res.status}`);
          const data = await res.json();
          translationCache = Object.fromEntries(
            (data.items || []).map(it => [it.id, it])
          );
          if (currentGeneratedAt) saveXlatCache(currentGeneratedAt, translationCache);
        } catch (err) {
          console.error('[lang] translation failed:', err);
          if (main) main.classList.remove('translating');
          if (bar)  bar.classList.remove('visible');
          btnEn.disabled = btnZh.disabled = false;
          btnZh.textContent = '中';
          return;
        }
        if (main) main.classList.remove('translating');
        if (bar)  bar.classList.remove('visible');
      }
      currentLang = 'zh';
      saveLang('zh');
      btnZh.textContent = '中';
      btnZh.classList.add('active');
      btnEn.classList.remove('active');
      btnEn.disabled = btnZh.disabled = false;
    } else {
      currentLang = 'en';
      saveLang('en');
      btnEn.classList.add('active');
      btnZh.classList.remove('active');
    }
    updateMetaLine();
    if (currentDigestData) {
      document.getElementById('main-content').innerHTML = renderDigest(currentDigestData);
    }
  }

  async function handleRefresh() {
    stopSpeaking();
    const btn = document.getElementById('refresh-btn');
    btn.disabled = true;
    translationCache = null;
    await loadDigest();
    btn.disabled = false;
  }


  function copyStory(btn) {
    const headline = btn.dataset.headline || '';
    const summary  = btn.dataset.summary  || '';
    const url      = btn.dataset.url      || '';
    const tag      = btn.dataset.tag      || '';
    const linkPart = url ? ` [(link)](${url})` : '';
    const tagPart  = tag ? ` #${tag}` : '';
    const text = `${summary}${linkPart}${tagPart}`;
    const finish = () => {
      btn.classList.add('copied');
      const origTitle = btn.title;
      btn.title = 'Copied!';
      setTimeout(() => { btn.classList.remove('copied'); btn.title = origTitle; }, 2000);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(finish).catch(() => fallbackCopy(text, finish));
    } else {
      fallbackCopy(text, finish);
    }
  }

  function fallbackCopy(text, cb) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); cb(); } catch {}
    document.body.removeChild(ta);
  }


  function stopSpeaking() {
    if (currentSource) {
      try { currentSource.stop(); } catch {}
      currentSource = null;
    }
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.src = '';
      currentAudio = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch {}
      audioCtx = null;
    }
    try { if (window.speechSynthesis?.speaking) window.speechSynthesis.cancel(); } catch {}
    speakingId = null;
    document.querySelectorAll('.story-speak-btn.speaking').forEach(b => {
      b.classList.remove('speaking');
      b.title = 'Read aloud';
    });
  }

  async function speakStory(btn) {
    const id         = btn.dataset.id;
    const text       = btn.dataset.text;
    const wasPlaying = (speakingId === id);
    stopSpeaking();
    if (wasPlaying || !id) return;
    speakingId = id;
    btn.classList.add('speaking');
    btn.title = 'Stop reading';
    const lang = currentLang === 'zh' ? 'zh' : 'en';

    // On iOS, skip Web Audio — AudioContext suspension is unreliable inside
    // a user-gesture callback; HTML Audio handles it more consistently.
    let ctx = null;
    if (!IS_IOS) {
      try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        ctx = audioCtx;
        if (ctx.state === 'suspended') await ctx.resume();
      } catch { ctx = null; }
    }

    try {
      const cacheKey = id + ':' + lang;
      let arrayBuffer = ttsCache.get(cacheKey);
      if (!arrayBuffer) {
        // Try up to 2 times — first attempt, then one retry after 8 s if rate-limited.
        let res;
        for (let attempt = 0; attempt < 2; attempt++) {
          res = await fetch('/api/tts', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ text, lang }),
          });
          if (res.ok || res.status !== 502) break;
          if (attempt === 0 && speakingId === id) {
            await new Promise(r => setTimeout(r, 8000));
          }
        }
        if (!res.ok) throw new Error(`TTS ${res.status}`);
        if (speakingId !== id) return;
        arrayBuffer = await res.arrayBuffer();
        ttsCache.set(cacheKey, arrayBuffer);
      }
      if (speakingId !== id) return;
      const cleanup = () => {
        currentSource = null;
        if (speakingId === id) {
          speakingId = null;
          btn.classList.remove('speaking');
          btn.title = 'Read aloud';
        }
      };
      if (ctx) {
        try {
          const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
          if (speakingId !== id) return;
          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(ctx.destination);
          source.onended = cleanup;
          source.start(0);
          currentSource = source;
          return;
        } catch (webAudioErr) {
          console.warn('[tts] Web Audio failed, trying HTML Audio:', webAudioErr.message);
        }
      }
      const blob  = new Blob([arrayBuffer], { type: 'audio/mpeg' });
      const url   = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudio = audio;
      const audioCleanup = () => {
        URL.revokeObjectURL(url);
        currentAudio = null;
        if (speakingId === id) {
          speakingId = null;
          btn.classList.remove('speaking');
          btn.title = 'Read aloud';
        }
      };
      audio.onended = audioCleanup;
      audio.onerror = audioCleanup;
      audio.play().catch(audioCleanup);
    } catch (err) {
      console.warn('[tts] API failed, falling back to Web Speech:', err.message);
      if (window.speechSynthesis && speakingId === id) {
        const utt  = new SpeechSynthesisUtterance(text);
        utt.lang   = lang === 'zh' ? 'zh-CN' : 'en-US';
        utt.rate   = 0.95;
        const done = () => {
          if (speakingId === id) {
            speakingId = null;
            btn.classList.remove('speaking');
            btn.title = 'Read aloud';
          }
        };
        utt.onend = utt.onerror = done;
        window.speechSynthesis.speak(utt);
      } else if (speakingId === id) {
        speakingId = null;
        btn.classList.remove('speaking');
        btn.title = 'Read aloud';
      }
    }
  }

  function renderDigest(data) {
    const seenMap  = getSeenHeadlines();
    const seenSet  = new Set(Object.keys(seenMap));
    const intl  = renderSection(t('international'), data.international, 'international', seenSet);
    const local = renderSection(t('hongKong'),      data.local,         'local',         seenSet);
    if (!intl && !local) {
      return `<div class="state-box"><h2>${t('noStoriesTitle')}</h2>
        <p>${t('noStoriesBody')}</p></div>`;
    }
    const allHeadlines = [
      ...(data.international || []),
      ...(data.local         || []),
    ].map(s => s.headline);
    markHeadlinesSeen(allHeadlines);
    return intl + local;
  }


  function _finishLoad(genAt) {
    translationCache = loadXlatCache(genAt);
    updateMetaLine();
    document.getElementById('api-link').href = '/api/digest';
    if (currentLang === 'zh' && !translationCache) {
      currentLang = 'en';
      const btnEn = document.getElementById('lang-en');
      const btnZh = document.getElementById('lang-zh');
      if (btnEn) btnEn.classList.add('active');
      if (btnZh) btnZh.classList.remove('active');
      setLang('zh');
    }
  }

  async function loadDigest() {
    const main = document.getElementById('main-content');
    const meta = document.getElementById('meta-line');
    main.innerHTML = `<div class="state-box">
      <div class="spinner"></div>
      <h2>${t('loadingTitle')}</h2>
      <p>${t('loadingBody')}</p>
    </div>`;
    try {
      const res = await fetch('/api/digest');
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/event-stream')) {
        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let cleared = false;
        if (!currentDigestData) currentDigestData = { international: [], local: [] };
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              let evt;
              try { evt = JSON.parse(line.slice(6)); } catch { continue; }
              if (evt.type === 'section') {
                if (!cleared) { main.innerHTML = ''; cleared = true; }
                const { section, stories } = evt;
                const seenSet = new Set(Object.keys(getSeenHeadlines()));
                if (section === 'international') {
                  currentDigestData.international = stories;
                  const html = renderSection(t('international'), stories, 'international', seenSet);
                  if (html) main.insertAdjacentHTML('beforeend', html);
                } else if (section === 'local') {
                  currentDigestData.local = stories;
                  const seenSet2 = new Set(Object.keys(getSeenHeadlines()));
                  const html = renderSection(t('hongKong'), stories, 'local', seenSet2);
                  if (html) main.insertAdjacentHTML('beforeend', html);
                  markHeadlinesSeen([
                    ...(currentDigestData.international || []),
                    ...(currentDigestData.local         || []),
                  ].map(s => s.headline));
                }
              } else if (evt.type === 'done') {
                currentGeneratedAt = evt.generatedAt;
                _finishLoad(evt.generatedAt);
              } else if (evt.type === 'error') {
                if (!cleared) {
                  meta.textContent = t('errMeta');
                  main.innerHTML = `<div class="state-box">
                    <h2>${t('errTitle')}</h2>
                    <p>${evt.message || t('errRetry')}</p>
                  </div>`;
                }
              }
            }
          }
        } catch (streamErr) {
          if (!cleared) throw streamErr;
          console.warn('[loadDigest] stream ended early:', streamErr.message);
          if (!currentGeneratedAt) meta.textContent = t('errMeta');
        }
      } else {
        const data = await res.json();
        currentDigestData  = data;
        currentGeneratedAt = data.generatedAt;
        main.innerHTML = renderDigest(data);
        _finishLoad(data.generatedAt);
      }
    } catch (err) {
      const hasContent = ((currentDigestData?.international?.length ?? 0) +
                          (currentDigestData?.local?.length ?? 0)) > 0;
      if (hasContent) {
        console.warn('[loadDigest] error after partial load:', err.message);
        if (!currentGeneratedAt) meta.textContent = t('errMeta');
        return;
      }
      meta.textContent = t('errMeta');
      main.innerHTML = `<div class="state-box">
        <h2>${t('errTitle')}</h2>
        <p>${err.message}</p>
        <p style="margin-top:0.5rem">${t('errRetry')}</p>
      </div>`;
    }
  }


  async function speakItemAsync(id, text) {
    if (!playAllActive) return;
    const lang = currentLang === 'zh' ? 'zh' : 'en';
    speakingId = id;
    const existingBtn = document.querySelector(`.story-speak-btn[data-id="${CSS.escape(id)}"]`);
    if (existingBtn) { existingBtn.classList.add('speaking'); existingBtn.title = 'Stop reading'; }

    // On iOS, skip Web Audio — AudioContext suspension is unreliable inside
    // a user-gesture callback; HTML Audio handles it more consistently.
    let ctx = null;
    if (!IS_IOS) {
      try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        ctx = audioCtx;
        if (ctx.state === 'suspended') await ctx.resume();
      } catch { ctx = null; }
    }

    try {
      const cacheKey = id + ':' + lang;
      let arrayBuffer = ttsCache.get(cacheKey);
      if (!arrayBuffer) {
        const res = await fetch('/api/tts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, lang }),
        });
        if (!res.ok) throw new Error(`TTS ${res.status}`);
        if (!playAllActive || speakingId !== id) return;
        arrayBuffer = await res.arrayBuffer();
        ttsCache.set(cacheKey, arrayBuffer);
      }
      if (!playAllActive || speakingId !== id) return;
      await new Promise(resolve => {
        const cleanup = () => {
          currentSource = null;
          if (speakingId === id) {
            speakingId = null;
            if (existingBtn) { existingBtn.classList.remove('speaking'); existingBtn.title = 'Read aloud'; }
          }
          resolve();
        };
        if (ctx) {
          ctx.decodeAudioData(arrayBuffer.slice(0))
            .then(audioBuffer => {
              if (!playAllActive) { resolve(); return; }
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              source.onended = cleanup;
              source.start(0);
              currentSource = source;
            })
            .catch(() => {
              const blob = new Blob([arrayBuffer.slice(0)], { type: 'audio/mpeg' });
              const burl = URL.createObjectURL(blob);
              const a = new Audio(burl);
              currentAudio = a;
              a.onended = a.onerror = () => { URL.revokeObjectURL(burl); currentAudio = null; cleanup(); };
              a.play().catch(cleanup);
            });
        } else {
          const blob = new Blob([arrayBuffer.slice(0)], { type: 'audio/mpeg' });
          const burl = URL.createObjectURL(blob);
          const a = new Audio(burl);
          currentAudio = a;
          a.onended = a.onerror = () => { URL.revokeObjectURL(burl); currentAudio = null; cleanup(); };
          a.play().catch(cleanup);
        }
      });
    } catch (err) {
      console.warn('[play-all] TTS error, falling back to Web Speech:', err.message);
      // Fall back to Web Speech API so Play All keeps working during TTS outages
      if (window.speechSynthesis && playAllActive) {
        await new Promise(resolve => {
          const utt = new SpeechSynthesisUtterance(text);
          utt.lang = lang === 'zh' ? 'zh-CN' : 'en-US';
          utt.rate = 0.95;
          utt.onend = utt.onerror = resolve;
          window.speechSynthesis.speak(utt);
        });
      }
      speakingId = null;
      if (existingBtn) { existingBtn.classList.remove('speaking'); existingBtn.title = 'Read aloud'; }
    }
  }

  async function announceLabelAsync(label) {
    // Chinese headings → Gemini TTS (WAV) via heading:true flag.
    // English headings → Speechify (MP3). Stories always use Speechify.
    if (!playAllActive) return;
    const lang = currentLang === 'zh' ? 'zh' : 'en';
    // Gemini returns WAV for Chinese headings; Speechify returns MP3 for English.
    const mimeType = lang === 'zh' ? 'audio/wav' : 'audio/mpeg';

    try {
      const cacheKey = 'label:' + label + ':' + lang;
      let arrayBuffer = ttsCache.get(cacheKey);
      if (!arrayBuffer) {
        const res = await fetch('/api/tts', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ text: label, lang, heading: true }),
        });
        if (!res.ok) throw new Error(`TTS ${res.status}`);
        if (!playAllActive) return;
        arrayBuffer = await res.arrayBuffer();
        ttsCache.set(cacheKey, arrayBuffer);
      }
      if (!playAllActive) return;
      await new Promise(resolve => {
        const blob = new Blob([arrayBuffer.slice(0)], { type: mimeType });
        const burl = URL.createObjectURL(blob);
        const a = new Audio(burl);
        currentAudio = a;
        a.onended = a.onerror = () => { URL.revokeObjectURL(burl); currentAudio = null; resolve(); };
        a.play().catch(resolve);
      });
    } catch {
      // Fallback to browser voice if TTS is unavailable
      if (!window.speechSynthesis || !playAllActive) return;
      await new Promise(resolve => {
        const utt = new SpeechSynthesisUtterance(label);
        utt.lang  = lang === 'zh' ? 'zh-TW' : 'en-US';
        utt.rate  = 1.0;
        utt.onend = utt.onerror = resolve;
        window.speechSynthesis.speak(utt);
      });
    }
  }

  function stopPlayAll() {
    playAllActive = false;
    stopSpeaking();
    try { if (window.speechSynthesis?.speaking) window.speechSynthesis.cancel(); } catch {}
    const btn = document.getElementById('play-all-btn');
    if (btn) { btn.textContent = ''; btn.insertAdjacentHTML('afterbegin', '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.596 8.697l-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393z"/></svg> Play All'); btn.classList.remove('playing'); btn.disabled = false; }
  }

  async function playAll() {
    const btn = document.getElementById('play-all-btn');
    if (playAllActive) { stopPlayAll(); return; }
    if (!currentDigestData) return;

    stopSpeaking();

    // On iOS, skip Web Audio context setup — HTML Audio is used instead.
    if (!IS_IOS) {
      try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') await audioCtx.resume();
      } catch {}
    }

    playAllActive = true;
    if (btn) { btn.innerHTML = '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3" y="2" width="4" height="12" rx="1"/><rect x="9" y="2" width="4" height="12" rx="1"/></svg> Stop'; btn.classList.add('playing'); }

    const intl  = currentDigestData.international || [];
    const local = currentDigestData.local         || [];

    for (const section of [['international', intl], ['local', local]]) {
      if (!playAllActive) break;
      const [tag, stories] = section;
      if (!stories.length) continue;
      const label = tag === 'international' ? t('international') : t('hongKong');
      await announceLabelAsync(label);
      for (const c of stories) {
        if (!playAllActive) break;
        const { headline, summary } = getDisplayText(c);
        const text = (headline ? headline + '. ' : '') + (summary || '');
        await speakItemAsync(c.id, text);
      }
    }

    stopPlayAll();
  }


  (function restoreLang() {
    const APP_VER = 'v2';
    try {
      if (localStorage.getItem('dp_app_ver') !== APP_VER) {
        localStorage.removeItem(LS_LANG);
        localStorage.setItem('dp_app_ver', APP_VER);
      }
    } catch {}
    const saved = loadLang();
    if (saved === 'zh') {
      currentLang = 'zh';
      const btnEn = document.getElementById('lang-en');
      const btnZh = document.getElementById('lang-zh');
      if (btnEn) btnEn.classList.remove('active');
      if (btnZh) btnZh.classList.add('active');
    }
  })();

  loadDigest();
