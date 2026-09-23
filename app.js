/* ====================================================
   EMT-P 重點整理 — app.js
   主要邏輯：章節導航、Tab切換、搜尋、小測驗、深色模式
   ==================================================== */

'use strict';

// ── 資料檔版本（避免瀏覽器快取住舊的章節 JSON）──────────
// 沿用 index.html 載入 app.js 時的 ?v= 參數，所以更新章節資料後，
// 只要改 index.html 裡那一個版本號，所有 JSON 就會被重新抓取。
const DATA_VERSION = (() => {
  try {
    const src = (document.currentScript && document.currentScript.src)
      || [...document.scripts].map(s => s.src).find(s => s.includes('app.js'))
      || '';
    return new URL(src, location.href).searchParams.get('v') || '';
  } catch (e) {
    return '';
  }
})();

const dataUrl = path => (DATA_VERSION ? `${path}?v=${DATA_VERSION}` : path);

// ── 狀態 ──────────────────────────────────────────────
const state = {
  chapters: [],
  currentChId: null,
  currentChData: null,
  readChapters: new Set(JSON.parse(localStorage.getItem('readCh') || '[]')),
  theme: localStorage.getItem('theme') || 'light',
  searchQuery: '',
  inlineAnswers: {},   // qId -> 選項索引（模式一段落內嵌考題）

  // ── Mode 2 (題庫練習) 狀態 ──
  allQuizzes: [],
  geminiApiKey: localStorage.getItem('gemini_api_key') || '',
  geminiModel: localStorage.getItem('gemini_model') || 'gemini-3.8-flash',
  wrongQuestions: JSON.parse(localStorage.getItem('m2_wrong_questions') || '[]'),
  m2Stats: (() => {
    // 依使用者要求清空模式二作題數 (2026-09-05)
    if (!localStorage.getItem('m2_stats_cleared_user_req_20260905')) {
      const fresh = { total: 0, correct: 0 };
      localStorage.setItem('m2_stats', JSON.stringify(fresh));
      localStorage.setItem('m2_stats_cleared_user_req_20260905', 'true');
      return fresh;
    }
    return JSON.parse(localStorage.getItem('m2_stats') || '{"total":0, "correct":0}');
  })(),
  currentMode: 1,
  m2Runner: {
    type: '',
    title: '',
    questions: [],
    currentIndex: 0,
    userAnswers: {},
    timerSeconds: 0,
    timerInterval: null
  },

  // AI 出題背景生成狀態：可縮小視窗後在模式一複習，完成後再回來作答
  aiGenInProgress: false,
  pendingAiQuiz: null   // { title, questions } | null
};

// ── DOM refs ──────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const els = {
  sidebar:        $('#sidebar'),
  sidebarToggle:  $('#sidebar-toggle'),
  sidebarBackdrop:$('#sidebar-backdrop'),
  sidebarCloseBtn:$('#sidebar-close-btn'),
  chNav:          $('#chapter-nav'),
  searchInput:    $('#search-input'),
  searchCount:    $('#search-count'),
  searchView:     $('#search-view'),
  welcomeScreen:  $('#welcome-screen'),
  chapterView:    $('#chapter-view'),
  notesLoading:   $('#notes-loading'),
  notesContent:   $('#notes-content'),
  summaryContent: $('#summary-content'),
  themeIconLight: $('#theme-icon-light'),
  themeIconDark:  $('#theme-icon-dark'),
  progressBtn:    $('#progress-btn'),
  progressModal:  $('#progress-modal'),
  totalChCount:   $('#total-ch-count'),
  backToTop:      $('#back-to-top'),
  mainContent:    $('#main-content'),
  mode1Btn:       $('#mode1-btn'),
  mode2Btn:       $('#mode2-btn'),
  mode2Container: $('#mode2-container')
};

// ── Init ──────────────────────────────────────────────
async function init() {
  // Check if API key passed in URL query param (?key=...)
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const keyParam = urlParams.get('key');
    if (keyParam) {
      localStorage.setItem('gemini_api_key', keyParam.trim());
      state.geminiApiKey = keyParam.trim();
      const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
      window.history.replaceState({ path: cleanUrl }, '', cleanUrl);
    }
  } catch (e) {}

  if (!localStorage.getItem('red_initialized_v3')) {
    localStorage.setItem('readCh', JSON.stringify([]));
    state.readChapters.clear();
    localStorage.setItem('red_initialized_v3', '1');
  }
  document.body.classList.add('mode-1');
  applyTheme(state.theme);
  await loadChapterIndex();
  await loadAllQuizzes();
  sanitizeStoredQuizzes();
  buildSidebar();
  bindEvents();
  initMode2();
  initPwaInstallPrompt();
  initLandscapeController();
}

// ── Load all past exams for Mode 2 ────────────────────
async function loadAllQuizzes() {
  try {
    const r = await fetch(dataUrl('chapters/all_quizzes.json'));
    const fetched = await r.json();
    let storedAiQuizzes = [];
    try {
      storedAiQuizzes = JSON.parse(localStorage.getItem('m2_ai_chapter_quizzes') || '[]');
    } catch (err) {
      storedAiQuizzes = [];
    }
    state.allQuizzes = [...fetched, ...storedAiQuizzes];
    console.log(`Loaded ${state.allQuizzes.length} quiz questions (includes ${storedAiQuizzes.length} AI saved questions).`);
  } catch (e) {
    console.error('Failed to load all_quizzes.json:', e);
    try {
      state.allQuizzes = JSON.parse(localStorage.getItem('m2_ai_chapter_quizzes') || '[]');
    } catch (err) {
      state.allQuizzes = [];
    }
  }
}

// ── Load chapter index ────────────────────────────────
async function loadChapterIndex() {
  try {
    const r = await fetch(dataUrl('chapters/index.json'));
    const data = await r.json();
    state.chapters = data.chapters;
    if (els.totalChCount) els.totalChCount.textContent = state.chapters.length;
  } catch (e) {
    console.error('Failed to load chapter index:', e);
    state.chapters = [];
  }
}

// ── Build sidebar nav ─────────────────────────────────
function buildSidebar() {
  els.chNav.innerHTML = '';
  state.chapters.forEach(ch => {
    const isRead = state.readChapters.has(ch.id);
    const item = document.createElement('div');
    item.className = 'ch-item' + (isRead ? ' read' : '');
    item.dataset.chId = ch.id;
    item.innerHTML = `
      <span class="ch-num">${ch.num}</span>
      <span class="ch-name">${ch.title}</span>
      <span class="ch-read-dot" title="${isRead ? '🟢 已讀（點擊切換為未讀）' : '🔴 待讀（點擊切換為已讀）'}"></span>
    `;
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('ch-read-dot')) {
        e.stopPropagation();
        toggleReadStatus(ch.id);
        return;
      }
      selectChapter(ch.id);
    });
    els.chNav.appendChild(item);
  });
}

// ── Select chapter ────────────────────────────────────
async function selectChapter(chId) {
  if (window.podcastPlayer) {
    podcastPlayer.stop();
  }
  if (state.currentMode === 2) {
    switchMode(1);
  }
  if (state.currentChId === chId) {
    closeMobileSidebar();
    return;
  }
  state.currentChId = chId;

  // Auto close mobile sidebar on select
  closeMobileSidebar();
  toggleLandscapeHeader(false);

  // Update sidebar active state
  $$('.ch-item').forEach(el => el.classList.remove('active'));
  const activeItem = $(`.ch-item[data-ch-id="${chId}"]`);
  if (activeItem) {
    activeItem.classList.add('active');
    activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Show chapter view, hide welcome
  els.welcomeScreen.classList.add('hidden');
  els.chapterView.classList.remove('hidden');

  // Reset to notes tab
  switchTab('notes');

  // Scroll to top
  if (els.mainContent) els.mainContent.scrollTop = 0;

  // Load content
  await loadChapterData(chId);

  // Mark as read
  markRead(chId);
}

function openMobileSidebar() {
  els.sidebar.classList.add('mobile-open');
  els.sidebar.classList.remove('collapsed');
  if (els.sidebarBackdrop) els.sidebarBackdrop.classList.remove('hidden');
  document.body.classList.add('sidebar-open-lock');
}

function closeMobileSidebar() {
  els.sidebar.classList.remove('mobile-open');
  if (els.sidebarBackdrop) els.sidebarBackdrop.classList.add('hidden');
  document.body.classList.remove('sidebar-open-lock');
}

// ── Load chapter JSON data ────────────────────────────
async function loadChapterData(chId) {
  // Show loading
  els.notesLoading.style.display = 'flex';
  els.notesContent.classList.add('hidden');

  try {
    const r = await fetch(dataUrl(`chapters/${chId}.json`));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.currentChData = await r.json();
  } catch (e) {
    state.currentChData = null;
  }

  els.notesLoading.style.display = 'none';
  els.notesContent.classList.remove('hidden');

  if (!state.currentChData) {
    els.notesContent.innerHTML = renderNotReady(chId);
    els.summaryContent.innerHTML = '<p style="color:var(--text-muted);padding:20px">此章節重點一覽尚未生成。</p>';
    return;
  }

  const cd = state.currentChData;

  // Init quiz answers for this chapter

  // Render notes (includes inline quizzes)
  els.notesContent.innerHTML = renderNotes(cd, chId);

  // Init podcast player for this chapter
  if (window.podcastPlayer) {
    podcastPlayer.init(chId, cd);
  }

  // Render summary
  els.summaryContent.innerHTML = renderSummary(cd);
}

// ── Render: Chapter Not Ready ─────────────────────────
function renderNotReady(chId) {
  const ch = state.chapters.find(c => c.id === chId);
  return `
    <div style="text-align:center;padding:60px 20px;color:var(--text-muted)">
      <div style="font-size:3rem;margin-bottom:16px">📝</div>
      <h2 style="color:var(--text);margin-bottom:12px">${ch ? ch.num + '　' + ch.title : chId}</h2>
      <p>此章節的重點筆記尚未生成。</p>
      <p style="margin-top:8px;font-size:0.85rem">AI 教授正在整理中，請稍後再來查看。</p>
    </div>`;
}

// ── Render: Notes ─────────────────────────────────────
function renderNotes(cd, chId) {
  let html = '';

  // ① 標題區塊
  html += `
    <div class="section-title-block">
      <div class="section-num">${cd.num}</div>
      <div>
        <h1>${cd.title}</h1>
        ${cd.learningGoals && cd.learningGoals.length ? `
          <ul class="learning-goals">
            ${cd.learningGoals.map(g => `<li>${g}</li>`).join('')}
          </ul>` : ''}
      </div>
    </div>`;

  // ② 本章核心架構心智圖卡片 (點擊放大檢視)
  const mindmapSrc = dataUrl(`images/mindmaps/${chId}.svg`);
  const chFullTitle = `${cd.num} ${cd.title}`;
  html += `
    <div class="chapter-mindmap-card" onclick="openMindmapModal('${chId}', '${escapeHtml(chFullTitle)}')">
      <div class="mindmap-card-header">
        <div class="mindmap-card-badge">
          <span class="mindmap-badge-icon">🧠</span>
          <span class="mindmap-badge-text">本章核心架構圖譜</span>
          <span class="mindmap-badge-sub">MIND MAP</span>
        </div>
        <div class="mindmap-zoom-tip">
          <span class="zoom-icon">🔍</span> 點擊全螢幕放大探索
        </div>
      </div>
      <div class="mindmap-preview-stage">
        <img src="${mindmapSrc}" alt="${escapeHtml(cd.title)} 心智圖" class="mindmap-preview-img" loading="lazy" onerror="this.closest('.chapter-mindmap-card').style.display='none'">
        <div class="mindmap-overlay-hover">
          <span class="overlay-btn">🔍 點擊展開全螢幕高清探索</span>
        </div>
      </div>
    </div>`;

  // ②-2 本章專屬 Podcast 導讀播放器 (Dual-Mode: MP3 / AI 語音導讀)
  html += `
    <div id="chapter-podcast-card" class="chapter-podcast-card">
      <div class="podcast-card-header">
        <div class="podcast-badge">
          <span class="podcast-badge-icon">🎙️</span>
          <span class="podcast-badge-text">章節導讀 Podcast</span>
          <span id="podcast-mode-tag" class="podcast-mode-tag">AI 臨床講堂</span>
        </div>
        <button id="podcast-speed-btn" class="podcast-speed-btn" onclick="podcastPlayer.cycleSpeed()" title="點擊切換播放倍速">1.0x</button>
      </div>
      <div class="podcast-body">
        <div class="podcast-cover">
          <span>🎧</span>
          <div class="podcast-equalizer">
            <span class="eq-bar"></span>
            <span class="eq-bar"></span>
            <span class="eq-bar"></span>
            <span class="eq-bar"></span>
          </div>
        </div>
        <div class="podcast-info">
          <div class="podcast-title">${escapeHtml(cd.num)} ${escapeHtml(cd.title)}</div>
          <div class="podcast-subtitle">
            <span id="podcast-subtitle-text">雙向臨床導讀 ‧ 核心觀念與國考避坑講義</span>
          </div>
        </div>
      </div>
      <div class="podcast-progress-section">
        <input type="range" id="podcast-scrubber" class="podcast-scrubber" min="0" max="100" value="0" step="0.1" oninput="podcastPlayer.onSeekInput(this.value)" onchange="podcastPlayer.onSeekChange(this.value)">
        <div class="podcast-time-row">
          <span id="podcast-time-cur">00:00</span>
          <span id="podcast-time-dur">--:--</span>
        </div>
      </div>
      <div class="podcast-controls">
        <button class="podcast-ctrl-btn btn-skip" onclick="podcastPlayer.skip(-15)" title="倒退 15 秒">
          <span>⏪</span>
          <span style="font-size:0.6rem">15s</span>
        </button>
        <button id="podcast-play-btn" class="podcast-ctrl-btn btn-play-main" onclick="podcastPlayer.togglePlay()" title="播放 / 暫停">
          ▶
        </button>
        <button class="podcast-ctrl-btn btn-skip" onclick="podcastPlayer.skip(15)" title="快轉 15 秒">
          <span>⏩</span>
          <span style="font-size:0.6rem">15s</span>
        </button>
      </div>
      <audio id="chapter-audio-el" preload="metadata" style="display:none"></audio>
    </div>`;

  let secNum = 1;

  // ③ 內文重點
  if (cd.content && cd.content.length) {
    html += `<div class="section-label"><span class="s-num">${secNum++}</span> 內文重點整理</div>`;
    html += renderContentBlocks(cd.content, chId);
    html += renderSectionQuizBox(chId, null, '其他本章考題');
  }

  // ④ 重點一覽入口
  html += `
    <div class="section-label"><span class="s-num">${secNum++}</span> 重點一覽</div>
    <div class="summary-entry-card" onclick="switchTab('summary')">
      <div class="summary-entry-icon">⚡</div>
      <div class="summary-entry-text">
        <strong>查看本章公式、重要數字與快速複習</strong>
        <span>點擊快速切換至濃縮精華整理表</span>
      </div>
      <div class="summary-entry-arrow">→</div>
    </div>`;

  // ⑥ 上一章 / 下一章 導航 (方便手機閱讀)
  const curIdx = state.chapters.findIndex(c => c.id === chId);
  const prevCh = curIdx > 0 ? state.chapters[curIdx - 1] : null;
  const nextCh = curIdx < state.chapters.length - 1 ? state.chapters[curIdx + 1] : null;

  html += `
    <div class="ch-pagination">
      ${prevCh ? `
        <button class="page-btn prev-btn" onclick="selectChapter('${prevCh.id}')">
          <span class="page-btn-sub">← 上一章</span>
          <span class="page-btn-title">${prevCh.num} ${prevCh.title}</span>
        </button>` : '<div class="page-placeholder"></div>'}
      ${nextCh ? `
        <button class="page-btn next-btn" onclick="selectChapter('${nextCh.id}')">
          <span class="page-btn-sub">下一章 →</span>
          <span class="page-btn-title">${nextCh.num} ${nextCh.title}</span>
        </button>` : '<div class="page-placeholder"></div>'}
    </div>`;

  return html;
}

// ── Render: Content Blocks (四) ───────────────────────
function renderContentBlocks(blocks, chId) {
  let html = '';
  let curSec = null;
  blocks.forEach((block, bi) => {
    if (block.type === 'orange') {
      if (curSec !== null && chId) html += renderSectionQuizBox(chId, curSec);
      curSec = bi;
    }
    switch (block.type) {
      case 'orange':
        html += `<div class="orange-heading" id="sec-${bi}">${mdInline(block.text)}` +
                (block.page ? `<span class="sec-page" title="大白第三版 PDF 第 ${block.pdfPage} 頁">📖 p.${block.page}</span>` : '') +
                `</div>`;
        break;
      case 'blue':
        html += `<div class="blue-heading">${mdInline(block.text)}</div>`;
        break;
      case 'list':
        html += `<ul class="content-list">${block.items.map(i => `<li>${renderListItem(i)}</li>`).join('')}</ul>`;
        break;
      case 'table':
        html += renderCompTable(block);
        break;
      case 'box':
        html += `
          <details class="box-details">
            <summary>📦 ${block.title || 'BOX'}</summary>
            <div class="box-content">${block.html || renderMarkdown(block.text || '')}</div>
          </details>`;
        break;
      case 'mnemonic':
        html += `
          <div class="mnemonic-block">
            <div class="mnemonic-label">💡 記憶口訣</div>
            <div class="mnemonic-text">${mdInline(block.text)}</div>
          </div>`;
        break;
      case 'clinical':
        html += `
          <div class="clinical-block">
            <div class="clinical-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              ${block.label || '核心觀念 ‧ 臨床實務'}
            </div>
            <ul>${(block.points || []).map(p => `<li>${mdInline(p)}</li>`).join('')}</ul>
          </div>`;
        break;
      case 'text':
        html += `<p style="font-size:0.9rem;line-height:1.7;margin:8px 0 12px;padding-left:4px">${mdInline(block.text)}</p>`;
        break;
    }
  });
  if (curSec !== null && chId) html += renderSectionQuizBox(chId, curSec);
  return html;
}

// ── 模式一：段落內嵌考題 ────────────────────────────────
function sectionQuizzes(chId, secIdx) {
  return (state.allQuizzes || []).filter(q => q.chId === chId &&
    (secIdx === null ? (q.secIdx === undefined || q.secIdx === null) : q.secIdx === secIdx));
}

function renderSectionQuizBox(chId, secIdx, label) {
  const qs = sectionQuizzes(chId, secIdx);
  if (!qs.length) return '';
  return `
    <details class="sec-quiz">
      <summary>📝 ${label || '這一節的考題'}（${qs.length} 題）</summary>
      <div class="sec-quiz-body">${qs.map(q => renderInlineQuiz(q)).join('')}</div>
    </details>`;
}

function renderInlineQuiz(q) {
  const L = ['A', 'B', 'C', 'D'];
  const picked = state.inlineAnswers[q.id];
  const done = picked !== undefined;
  const ok = done && picked === q.answer;
  return `
    <div class="iq ${done ? (ok ? 'iq-ok' : 'iq-bad') : ''}" id="iq-${q.id}">
      <div class="iq-meta">
        <span class="iq-tag">${escapeHtml(q.year || '歷屆')}</span>
        <span class="iq-tag">${escapeHtml(q.sourceLabel || '甄試')}</span>
        ${done ? `<span class="iq-tag ${ok ? 'ok' : 'bad'}">${ok ? '✅ 答對' : '❌ 答錯'}</span>` : ''}
      </div>
      <div class="iq-q">${mdInline(q.question)}</div>
      ${q.image ? `<div class="m2-qimage-box" onclick="openImageModal('${escapeHtml(q.image)}')">
          <img src="${escapeHtml(q.image)}" class="m2-qimage" alt="題目附圖"></div>` : ''}
      <div class="iq-opts">
        ${(q.options || []).map((o, i) => {
          const cls = done ? (i === q.answer ? 'right' : (i === picked ? 'wrong' : '')) : '';
          return `<button class="iq-opt ${cls}" ${done ? 'disabled' : ''} onclick="answerInlineQuiz('${q.id}', ${i})">
                    <span class="iq-ol">${L[i]}</span><span>${mdInline(o)}</span></button>`;
        }).join('')}
      </div>
      ${done ? `
        <div class="iq-expl">
          <div class="iq-expl-head">正確答案：(${L[q.answer]})</div>
          <div class="iq-expl-text">${escapeHtml(q.explanation || '暫無解析').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</div>
          <button class="iq-reset" onclick="resetInlineQuiz('${q.id}')">🔄 再做一次</button>
        </div>` : ''}
    </div>`;
}

function repaintInlineQuiz(qid) {
  const q = (state.allQuizzes || []).find(x => x.id === qid);
  const el = document.getElementById('iq-' + qid);
  if (q && el) el.outerHTML = renderInlineQuiz(q);
}
function answerInlineQuiz(qid, oi) { state.inlineAnswers[qid] = oi; repaintInlineQuiz(qid); }
function resetInlineQuiz(qid) { delete state.inlineAnswers[qid]; repaintInlineQuiz(qid); }

// ── 模式二：就地展開教科書內容（取代跳轉到模式一）─────────────
const _chCache = {};
async function loadChapterCached(chId) {
  if (_chCache[chId]) return _chCache[chId];
  const r = await fetch(dataUrl(`chapters/${chId}.json`));
  if (!r.ok) throw new Error('chapter fetch failed');
  _chCache[chId] = await r.json();
  return _chCache[chId];
}

// ── 教科書段落即時比對（AI 題目沒有預先算好的 secIdx 時使用）──────────
const _SEC_SKIP = new Set(['情境', '情境解答', '問題交流', '重點整理', '參考資料']);
function _blockText(b) {
  if (!b) return '';
  const deep = x => typeof x === 'string' ? x : Array.isArray(x) ? x.map(deep).join(' ')
             : (x && typeof x === 'object') ? Object.values(x).map(deep).join(' ') : '';
  switch (b.type) {
    case 'text': case 'blue': case 'orange': case 'mnemonic': return b.text || '';
    case 'list': return deep(b.items);
    case 'box': return (b.title || '') + ' ' + String(b.html || '').replace(/<[^>]+>/g, ' ');
    case 'clinical': return (b.label || '') + ' ' + deep(b.points);
    case 'table': return deep(b.headers) + ' ' + deep(b.rows);
    default: return deep(b);
  }
}
function _norm(s) { return String(s || '').replace(/[\s*_`#>()（）、，。：；？！]/g, ''); }
function _grams(s) { const t = _norm(s); const g = new Set(); for (let i = 0; i + 3 <= t.length; i++) g.add(t.slice(i, i + 3)); return g; }

function matchSectionInChapter(content, q, relaxed) {
  const idxs = content.map((b, i) => b.type === 'orange' ? i : -1).filter(i => i >= 0);
  const secs = [];
  idxs.forEach((i, k) => {
    const title = (content[i].text || '').trim();
    if (_SEC_SKIP.has(title)) return;
    const end = k + 1 < idxs.length ? idxs[k + 1] : content.length;
    const heads = content.slice(i + 1, end).filter(b => b.type === 'blue').map(b => b.text || '');
    const body = content.slice(i + 1, end).map(_blockText).join(' ').slice(0, 8000);
    secs.push({ idx: i, title, heads, norm: _norm(title + heads.join('') + body), g: _grams(title + ' ' + heads.join(' ') + ' ' + body) });
  });
  if (!secs.length) return -1;
  const df = new Map();
  secs.forEach(s => s.g.forEach(g => df.set(g, (df.get(g) || 0) + 1)));
  const N = secs.length;
  const qText = (q.question || '') + ' ' + (q.options || []).join(' ');
  // 去掉【出處：大白 CHxx 章名】——章名會誤配到標題含章名的段落（如「泌尿與腎臟急症病人到院前救護提示」）
  const ex = String(q.explanation || '').replace(/【出處[^】]*】/g, ' ').replace(/出處[:：][^\n]*/g, ' ').slice(0, 1500);
  const qg = _grams(qText + ' ' + ex);
  const labels = (ex.match(/(?:表|Box|圖)\s?\d+[-–]\d+/g) || []).map(x => x.replace(/\s/g, ''));
  const qn = _norm(qText + ex.slice(0, 600));
  const scored = secs.map(s => {
    let sc = 0;
    qg.forEach(g => { if (s.g.has(g)) sc += Math.log(1 + N / df.get(g)); });
    sc /= Math.sqrt(s.g.size + 50);
    labels.forEach(L => { if (s.norm.includes(L)) sc += 12; });
    if (s.title.length >= 3 && qn.includes(_norm(s.title))) sc += 4;
    s.heads.forEach(h => { if (h.length >= 4 && qn.includes(_norm(h))) sc += 2; });
    return { idx: s.idx, sc };
  }).sort((a, b) => b.sc - a.sc);
  const best = scored[0], second = scored[1] || { sc: 0 };
  const confident = best.sc >= 0.8 && (second.sc === 0 || best.sc >= second.sc * 1.25);
  if (confident) { if (q) q.secGuess = false; return best.idx; }
  // 寬鬆模式（AI 題）：題目常同時涉及多段，沒有壓倒性的段落時仍取最相關的一段，
  // 並標記 secGuess，讓介面標示「最相關段落」而不是「這一段」。整章仍可展開。
  if (relaxed && (best.sc >= 0.45 || (best.sc >= 0.15 && best.sc >= second.sc * 1.15))) { if (q) q.secGuess = true; return best.idx; }
  return -1;
}

/** 補齊一題的段落／頁碼（AI 題目），完成後更新畫面上對應的元素 */
const _secResolving = new Map();
function resolveQuestionSection(q) {
  if (!q || !q.chId) return Promise.resolve(false);
  if (q.secIdx !== undefined && q.secIdx !== null && q.secIdx >= 0) return Promise.resolve(true);
  if (_secResolving.has(q.id)) return _secResolving.get(q.id);
  const p = loadChapterCached(q.chId).then(cd => {
    const content = cd.content || [];
    const idx = matchSectionInChapter(content, q, true);
    if (idx < 0) return false;
    const blk = content[idx];
    q.secIdx = idx; q.secTitle = (blk.text || '').trim();
    if (blk.page) { q.page = blk.page; q.pdfPage = blk.pdfPage; }
    document.querySelectorAll(`[data-qpage="${CSS.escape(String(q.id))}"]`).forEach(el => { el.outerHTML = renderQuizPageLine(q); });
    return true;
  }).catch(() => false);
  _secResolving.set(q.id, p);
  return p;
}

/** 詳解區塊裡的「📖 教科書 CHxx p.NNN」一行 */
function renderQuizPageLine(q) {
  const ch = `${escapeHtml(q.chNum || '')} ${escapeHtml(q.chTitle || q.chapterTitle || '')}`.trim();
  if (q.page) {
    return `<div class="expl-page" data-qpage="${escapeHtml(String(q.id))}">📖 教科書 ${ch}${q.secTitle ? ' ‧ ' + escapeHtml(q.secTitle) : ''} ‧ <b>p.${q.page}</b>${q.pdfPage ? `（PDF 第 ${q.pdfPage} 頁）` : ''}${q.secGuess ? '<span class="expl-guess">自動比對</span>' : ''}</div>`;
  }
  return `<div class="expl-page muted" data-qpage="${escapeHtml(String(q.id))}">📖 教科書 ${ch}${q.secTitle ? ' ‧ ' + escapeHtml(q.secTitle) : ''}</div>`;
}

function renderTextbookDetails(q) {
  const hasSec = q.secIdx !== undefined && q.secIdx !== null && q.secIdx >= 0;
  const pageTxt = q.page ? ` ‧ p.${q.page}${q.pdfPage ? `（PDF 第 ${q.pdfPage} 頁）` : ''}` : '';
  const label = hasSec
    ? `看教科書這一段：${escapeHtml(q.secTitle || '')}${pageTxt}`
    : `看教科書：${escapeHtml(q.chNum || '')} ${escapeHtml(q.chTitle || q.chapterTitle || '本章')}`;
  return `
    <details class="tb-details" data-qid="${escapeHtml(String(q.id))}" ontoggle="loadTextbook(this, '${escapeHtml(q.chId || '')}', ${hasSec ? q.secIdx : -1})">
      <summary>📖 <span class="tb-label">${label}</span></summary>
      <div class="tb-body"><div class="tb-msg">載入中…</div></div>
    </details>`;
}

async function loadTextbook(el, chId, secIdx) {
  if (!el.open || el.dataset.loaded) return;
  el.dataset.loaded = '1';
  const body = el.querySelector('.tb-body');
  const labelEl = el.querySelector('.tb-label');
  let guess = false;
  try {
    const cd = await loadChapterCached(chId);
    const content = cd.content || [];
    // 沒有預先對應的段落（AI 題）→ 現場比對
    if (!(secIdx >= 0 && content[secIdx])) {
      const q = (state.allQuizzes || []).find(x => String(x.id) === el.dataset.qid);
      if (q) { const idx = matchSectionInChapter(content, q, true); if (idx >= 0) { guess = !!q.secGuess; secIdx = idx; q.secIdx = idx; q.secTitle = (content[idx].text || '').trim(); if (content[idx].page) { q.page = content[idx].page; q.pdfPage = content[idx].pdfPage; } } }
    }
    let html = '';
    if (secIdx >= 0 && content[secIdx]) {
      const blk = content[secIdx];
      const title = (blk.text || '').trim();
      const pageTxt = blk.page ? ` ‧ p.${blk.page}${blk.pdfPage ? `（PDF 第 ${blk.pdfPage} 頁）` : ''}` : '';
      if (labelEl) labelEl.textContent = `${guess ? '看教科書最相關段落（自動比對）' : '看教科書這一段'}：${title}${pageTxt}`;
      const next = content.findIndex((b, i) => i > secIdx && b.type === 'orange');
      html += renderContentBlocks(content.slice(secIdx, next === -1 ? content.length : next));
      html += `<details class="tb-full"><summary>📚 展開整章重點整理</summary>
                 <div>${renderContentBlocks(content)}</div></details>`;
    } else {
      html += renderContentBlocks(content);
    }
    body.innerHTML = html || '<div class="tb-msg">本章尚無內容。</div>';
  } catch (e) {
    el.dataset.loaded = '';
    body.innerHTML = '<div class="tb-msg">載入失敗，請確認網路後再試一次。</div>';
  }
}

function renderListItem(item) {
  if (typeof item === 'string') return mdInline(item);
  if (item.text && item.sub) {
    return `${mdInline(item.text)}<ul class="sub-list">${item.sub.map(s => `<li>${mdInline(s)}</li>`).join('')}</ul>`;
  }
  return mdInline(item.text || String(item));
}

function renderCompTable(block) {
  const rows = block.rows || [];
  const headers = block.headers || [];
  if (!rows.length) return '';
  return `
    <div class="comp-table-wrap">
      <table class="comp-table">
        ${headers.length ? `<thead><tr>${headers.map((h, i) => `<th${i===0?' style="min-width:110px"':''}>${mdInline(h)}</th>`).join('')}</tr></thead>` : ''}
        <tbody>
          ${rows.map(row => `
            <tr>${row.map((cell, i) => i === 0
              ? `<td class="row-header">${mdInline(cell)}</td>`
              : `<td>${mdInline(cell)}</td>`).join('')}
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// 行內粗體：內容區塊使用 **文字** 標記重點
function mdInline(s) {
  return String(s == null ? '' : s).replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
}

function renderMarkdown(text) {
  // Very basic markdown: bold, lists
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n- (.+)/g, '<li>$1</li>')
    .replace(/\n/g, '<br>');
}

// ── Render: Summary ───────────────────────────────────
function renderSummary(cd) {
  if (!cd.summary) return '<p style="color:var(--text-muted);padding:20px">此章節重點一覽尚未生成。</p>';

  let html = '';
  const s = cd.summary;

  // Formulas
  if (s.formulas && s.formulas.length) {
    html += `
      <div class="summary-card">
        <h3>🧮 公式彙整</h3>
        ${s.formulas.map(f => `
          <div class="formula-box">
            <span class="formula-name">${f.name}</span>
            ${f.formula}
            ${f.note ? `<div style="margin-top:6px;font-size:0.82rem;color:#94a3b8">${f.note}</div>` : ''}
          </div>`).join('')}
      </div>`;
  }

  // Key numbers
  if (s.keyNumbers && s.keyNumbers.length) {
    html += `
      <div class="summary-card">
        <h3>🔢 重要數字 / 數值</h3>
        <table class="numbers-table">
          <thead><tr><th>項目</th><th>數值</th><th>說明</th></tr></thead>
          <tbody>
            ${s.keyNumbers.map(n => `
              <tr>
                <td>${mdInline(n.label)}</td>
                <td class="highlight-num">${mdInline(n.value)}</td>
                <td>${mdInline(n.note || '')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  // Quick review
  if (s.quickReview && s.quickReview.length) {
    html += `
      <div class="summary-card">
        <h3>⚡ 快速複習要點</h3>
        <ul style="padding-left:18px;font-size:0.9rem;line-height:1.8">
          ${s.quickReview.map(r => `<li>${mdInline(r)}</li>`).join('')}
        </ul>
      </div>`;
  }

  return html || '<p style="color:var(--text-muted);padding:20px">此章節重點一覽尚未生成。</p>';
}

// ── Tab Switch ────────────────────────────────────────
function switchTab(tabName) {
  $$('.c-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
  $$('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${tabName}`));
  // Scroll content to top
  $('#main-content').scrollTop = 0;
}

// ── Search ────────────────────────────────────────────
function handleSearch(query) {
  state.searchQuery = query.toLowerCase().trim();
  let visible = 0;
  $$('.ch-item').forEach((item, i) => {
    const ch = state.chapters[i];
    if (!ch) return;
    const match = !state.searchQuery
      || ch.title.toLowerCase().includes(state.searchQuery)
      || ch.num.toLowerCase().includes(state.searchQuery);
    item.classList.toggle('hidden', !match);
    if (match) visible++;
  });

  clearTimeout(_searchTimer);
  const q = state.searchQuery;
  if (q.length < 2) {
    hideSearchView();
    els.searchCount.textContent = q ? `找到 ${visible} 個章節` : '';
    return;
  }
  els.searchCount.textContent = '搜尋內文中…';
  _searchTimer = setTimeout(() => runFullTextSearch(q), 250);
}

// ── 全文搜尋：搜 60 章重點整理內文，並標出教科書頁碼 ──────────
let _searchTimer = null, _searchIndex = null, _searchIndexPromise = null;

async function ensureSearchIndex() {
  if (_searchIndex) return _searchIndex;
  if (!_searchIndexPromise) {
    _searchIndexPromise = fetch(dataUrl('chapters/search_index.json'))
      .then(r => { if (!r.ok) throw new Error('index http ' + r.status); return r.json(); })
      .then(j => (_searchIndex = j))
      .catch(err => { _searchIndexPromise = null; throw err; });
  }
  return _searchIndexPromise;
}

function showSearchView() {
  if (els.welcomeScreen) els.welcomeScreen.classList.add('hidden');
  if (els.chapterView) els.chapterView.classList.add('hidden');
  if (els.searchView) els.searchView.classList.remove('hidden');
}
function hideSearchView() {
  if (els.searchView) els.searchView.classList.add('hidden');
  if (state.currentChId) {
    if (els.chapterView) els.chapterView.classList.remove('hidden');
  } else if (els.welcomeScreen) {
    els.welcomeScreen.classList.remove('hidden');
  }
}

async function runFullTextSearch(q) {
  if (!els.searchView) return;
  showSearchView();
  els.searchView.innerHTML = `<div class="sr-loading"><div class="spinner"></div><span>載入全文索引…</span></div>`;
  let idx;
  try {
    idx = await ensureSearchIndex();
  } catch (e) {
    els.searchView.innerHTML = `<div class="sr-empty">搜尋索引載入失敗，請確認網路後再試。</div>`;
    els.searchCount.textContent = '';
    return;
  }
  if (state.searchQuery !== q) return;

  const hits = [];
  for (let i = 0; i < idx.blocks.length; i++) {
    const b = idx.blocks[i];
    const pos = b[2].toLowerCase().indexOf(q);
    if (pos < 0) continue;
    const sec = idx.secs[b[0]];
    const inTitle = sec && sec[2] && sec[2].toLowerCase().includes(q);
    hits.push({ sr: b[0], bi: b[1], txt: b[2], pos, score: (inTitle ? 1000 : 0) + Math.max(0, 300 - pos) });
    if (hits.length >= 600) break;
  }
  hits.sort((a, b) => b.score - a.score);
  renderSearchResults(idx, hits, q);
}

function renderSearchResults(idx, hits, q) {
  els.searchCount.textContent = hits.length ? `內文命中 ${hits.length} 處` : '內文找不到';
  if (!hits.length) {
    els.searchView.innerHTML = `<div class="sr-empty">「${escapeHtml(q)}」在 60 章內文中沒有找到。<br>試試更短的關鍵字，或改用中文專有名詞。</div>`;
    return;
  }
  const items = hits.slice(0, 60).map(h => {
    const sec = idx.secs[h.sr];
    const ch = sec ? idx.chs[sec[0]] : null;
    const st = Math.max(0, h.pos - 34);
    const en = Math.min(h.txt.length, h.pos + q.length + 70);
    const snip = (st > 0 ? '…' : '') + escapeHtml(h.txt.slice(st, h.pos))
      + '<mark>' + escapeHtml(h.txt.substr(h.pos, q.length)) + '</mark>'
      + escapeHtml(h.txt.slice(h.pos + q.length, en)) + (en < h.txt.length ? '…' : '');
    const page = sec && sec[3] ? sec[3] : 0;
    const pdfp = sec && sec[4] ? sec[4] : 0;
    return `
      <div class="sr-item" onclick="openSearchHit('${ch ? ch[0] : ''}', ${sec ? sec[1] : -1})">
        <div class="sr-head">
          <span class="sr-ch">${escapeHtml(ch ? ch[1] : '')}</span>
          <span class="sr-sec">${escapeHtml(sec ? sec[2] : '')}</span>
          ${page ? `<span class="sr-page">📖 教科書 p.${page}<span class="sr-pdfp"> ‧ PDF 第 ${pdfp} 頁</span></span>` : ''}
        </div>
        <div class="sr-snip">${snip}</div>
      </div>`;
  }).join('');
  els.searchView.innerHTML = `
    <div class="sr-bar">🔍 「${escapeHtml(q)}」在重點整理內文中找到 <b>${hits.length}</b> 處${hits.length > 60 ? '（顯示前 60 筆）' : ''}
      <span class="sr-hint">點一下可跳到該段落 ‧ 📖 頁碼對應大白第三版</span></div>
    ${items}`;
}

async function openSearchHit(chId, secIdx) {
  if (!chId) return;
  hideSearchView();
  await selectChapter(chId);
  setTimeout(() => {
    const el = document.getElementById('sec-' + secIdx);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('sec-flash');
    setTimeout(() => el.classList.remove('sec-flash'), 1800);
  }, 400);
}

// ── Theme ─────────────────────────────────────────────
function toggleTheme() {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
  applyTheme(state.theme);
  localStorage.setItem('theme', state.theme);
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (els.themeIconLight) els.themeIconLight.classList.toggle('hidden', theme === 'dark');
  if (els.themeIconDark) els.themeIconDark.classList.toggle('hidden', theme === 'light');
}

// ── Read tracking (🔴 紅點待讀 / 🟢 綠點已讀) ───────────
function markRead(chId) {
  state.readChapters.add(chId);
  localStorage.setItem('readCh', JSON.stringify([...state.readChapters]));
  updateChapterReadUi(chId);
}

function toggleReadStatus(chId) {
  if (state.readChapters.has(chId)) {
    state.readChapters.delete(chId);
  } else {
    state.readChapters.add(chId);
  }
  localStorage.setItem('readCh', JSON.stringify([...state.readChapters]));
  updateChapterReadUi(chId);
}

function updateChapterReadUi(chId) {
  const item = $(`.ch-item[data-ch-id="${chId}"]`);
  if (!item) return;
  const isRead = state.readChapters.has(chId);
  item.classList.toggle('read', isRead);
  const dot = item.querySelector('.ch-read-dot');
  if (dot) {
    dot.title = isRead ? '🟢 已讀（點擊切換為未讀）' : '🔴 待讀（點擊切換為已讀）';
  }
}

function resetAllChaptersToUnread() {
  state.readChapters.clear();
  localStorage.setItem('readCh', JSON.stringify([]));
  state.chapters.forEach(ch => updateChapterReadUi(ch.id));
  openProgressModal();
}

function markAllChaptersRead() {
  state.chapters.forEach(ch => state.readChapters.add(ch.id));
  localStorage.setItem('readCh', JSON.stringify([...state.readChapters]));
  state.chapters.forEach(ch => updateChapterReadUi(ch.id));
  openProgressModal();
}

// ── Progress Modal ────────────────────────────────────
function openProgressModal() {
  try { closeMobileSidebar(); } catch (e) {}
  const modal = document.getElementById('progress-modal');
  if (!modal) {
    console.warn('progress-modal not found');
    return;
  }
  const total = state.chapters ? state.chapters.length : 60;
  const read = state.readChapters ? state.readChapters.size : 0;
  const unread = Math.max(0, total - read);
  const pct = total > 0 ? Math.round((read / total) * 100) : 0;
  const contentEl = document.getElementById('progress-modal-content');
  if (contentEl) {
    contentEl.innerHTML = `
      <div style="font-size:1.15rem;font-weight:800;color:var(--text);margin-bottom:8px">
        🟢 <span style="color:var(--success)">${read}</span> 章已研讀 ‧ 🔴 <span style="color:#ef4444">${unread}</span> 章待研讀
      </div>
      <div style="height:10px;background:var(--border);border-radius:5px;overflow:hidden;margin-bottom:14px">
        <div style="width:${pct}%;height:100%;background:var(--success);border-radius:5px;transition:.4s"></div>
      </div>
      <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:16px">總研讀完成度：${pct}%（左側圓點可直接點擊切換紅綠狀態）</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="modal-btn" onclick="resetAllChaptersToUnread()">🔴 全部重設為紅色 (待讀)</button>
        <button class="modal-btn" onclick="markAllChaptersRead()">🟢 全部標記為綠色 (已讀)</button>
      </div>`;
  }
  modal.classList.remove('hidden');
  modal.style.cssText = 'display: flex !important; position: fixed !important; z-index: 9999 !important; inset: 0 !important;';
}

function closeProgressModal() {
  const modal = document.getElementById('progress-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.style.cssText = 'display: none !important;';
  }
}

// ── Pagination helpers ─────────────────────────────────
function prevChapter() {
  if (!state.chapters || state.chapters.length === 0) return;
  const curIdx = state.chapters.findIndex(c => c.id === state.currentChId);
  if (curIdx > 0) {
    selectChapter(state.chapters[curIdx - 1].id);
  } else if (curIdx === 0) {
    // 若在第一章，循環至最後一章
    selectChapter(state.chapters[state.chapters.length - 1].id);
  } else {
    // 尚未選中任何章節時（如首頁），直接進入第一章
    selectChapter(state.chapters[0].id);
  }
}

function nextChapter() {
  if (!state.chapters || state.chapters.length === 0) return;
  const curIdx = state.chapters.findIndex(c => c.id === state.currentChId);
  if (curIdx >= 0 && curIdx < state.chapters.length - 1) {
    selectChapter(state.chapters[curIdx + 1].id);
  } else if (curIdx >= state.chapters.length - 1) {
    // 若在最後一章，循環至第一章
    selectChapter(state.chapters[0].id);
  } else {
    // 尚未選中任何章節時（如首頁），直接進入第一章
    selectChapter(state.chapters[0].id);
  }
}

// ── Bind Events ───────────────────────────────────────
function bindEvents() {
  // Sidebar toggle
  els.sidebarToggle.addEventListener('click', () => {
    if (window.innerWidth <= 768) {
      if (els.sidebar.classList.contains('mobile-open')) {
        closeMobileSidebar();
      } else {
        openMobileSidebar();
      }
    } else {
      els.sidebar.classList.toggle('collapsed');
    }
  });

  // Mobile sidebar close button
  if (els.sidebarCloseBtn) {
    els.sidebarCloseBtn.addEventListener('click', closeMobileSidebar);
  }

  // Backdrop click closes mobile sidebar
  if (els.sidebarBackdrop) {
    els.sidebarBackdrop.addEventListener('click', closeMobileSidebar);
  }

  // Back to top floating button
  if (els.mainContent && els.backToTop) {
    els.mainContent.addEventListener('scroll', () => {
      if (els.mainContent.scrollTop > 280) {
        els.backToTop.classList.remove('hidden');
      } else {
        els.backToTop.classList.add('hidden');
      }
    });

    els.backToTop.addEventListener('click', () => {
      els.mainContent.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // Search
  els.searchInput.addEventListener('input', (e) => handleSearch(e.target.value));

  // Tab buttons
  $$('.c-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Theme toggle
  $('#theme-toggle').addEventListener('click', toggleTheme);

  // Progress button & drawer banner
  if (els.progressBtn) els.progressBtn.addEventListener('click', openProgressModal);
  const progressBanner = $('.sidebar-progress-banner');
  if (progressBanner) progressBanner.addEventListener('click', openProgressModal);

  // Close progress modal on backdrop click
  if (els.progressModal) {
    els.progressModal.addEventListener('click', (e) => {
      if (e.target === els.progressModal) closeProgressModal();
    });
  }

  // Mode buttons
  $$('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const mode = parseInt(btn.dataset.mode || '1', 10);
      switchMode(mode);
    });
  });

  // ── 鍵盤快捷鍵 (電腦端友善操作) ──
  window.addEventListener('keydown', (e) => {
    // 1. 若處於輸入框、文字區域、下拉選單或可編輯元素中，不觸發導航與選題快捷鍵
    const targetTag = (e.target && e.target.tagName) || '';
    const activeTag = (document.activeElement && document.activeElement.tagName) || '';
    const isEditing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(targetTag) ||
                      ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag) ||
                      e.target?.isContentEditable ||
                      document.activeElement?.isContentEditable;

    // 快捷鍵: / 聚焦搜尋框 (若非輸入中)
    if (e.key === '/' && !isEditing && document.activeElement !== els.searchInput) {
      e.preventDefault();
      els.searchInput?.focus();
      return;
    }

    // 快捷鍵: Escape 關閉所有彈窗與失焦搜尋
    if (e.key === 'Escape') {
      els.searchInput?.blur();
      closeProgressModal();
      closeMobileSidebar();
      closeApiModal();
      closeChapterQuizModal();
      closeAiQuizModal();
      closeManualAddModal();
      closePastExamModal();
      closeAiCompleteModal();
      closeImageModal();
      closePwaInstallModal();
      if (typeof window.closeSyncModal === 'function') window.closeSyncModal();
      return;
    }

    // 若使用者正在輸入，不執行後續快捷鍵
    if (isEditing) return;

    // 檢查是否有開啟中的浮動彈窗 (display 不為 none 且 不含 hidden)
    const openModal = Array.from(document.querySelectorAll('.modal-overlay')).find(m => {
      return !m.classList.contains('hidden') && window.getComputedStyle(m).display !== 'none';
    });
    if (openModal) return;

    const isUp = e.key === 'ArrowUp' || e.key === 'Up' || e.code === 'ArrowUp';
    const isDown = e.key === 'ArrowDown' || e.key === 'Down' || e.code === 'ArrowDown';
    const isLeft = e.key === 'ArrowLeft' || e.key === 'Left' || e.code === 'ArrowLeft';
    const isRight = e.key === 'ArrowRight' || e.key === 'Right' || e.code === 'ArrowRight';

    // ── 模式一快捷鍵 ──
    // 方向鍵上下控制捲動、左右控制章節
    if (state.currentMode === 1) {
      if (isUp || isDown) {
        e.preventDefault();
        const scrollEl = els.mainContent || document.getElementById('main-content') || window;
        const delta = isUp ? -180 : 180;
        if (scrollEl && typeof scrollEl.scrollBy === 'function') {
          scrollEl.scrollBy({ top: delta, behavior: 'smooth' });
        } else {
          window.scrollBy({ top: delta, behavior: 'smooth' });
        }
        return;
      }

      if (isLeft) {
        e.preventDefault();
        prevChapter();
        return;
      }

      if (isRight) {
        e.preventDefault();
        nextChapter();
        return;
      }
      return;
    }

    // ── 模式二快捷鍵 (僅在測驗進行中生效) ──
    // 方向鍵左右控制上一題下一題，數字鍵 1234 對應選項 ABCD
    if (state.currentMode === 2) {
      const runnerEl = document.getElementById('m2-quiz-runner');
      const isRunnerActive = runnerEl && !runnerEl.classList.contains('hidden') && state.m2Runner?.questions?.length > 0;
      if (!isRunnerActive) return;

      if (isLeft) {
        e.preventDefault();
        prevRunnerQ();
        return;
      }
      if (isRight) {
        e.preventDefault();
        nextRunnerQ();
        return;
      }

      const numMap = {
        '1': 0, '2': 1, '3': 2, '4': 3,
        'Digit1': 0, 'Digit2': 1, 'Digit3': 2, 'Digit4': 3,
        'Numpad1': 0, 'Numpad2': 1, 'Numpad3': 2, 'Numpad4': 3
      };
      const optIdx = numMap[e.key] !== undefined ? numMap[e.key] : numMap[e.code];
      if (optIdx !== undefined) {
        e.preventDefault();
        const curQ = state.m2Runner.questions[state.m2Runner.currentIndex];
        if (curQ && curQ.options && curQ.options[optIdx] !== undefined) {
          selectRunnerOption(state.m2Runner.currentIndex, optIdx);
        }
      }
    }
  });

  // Window resize: auto adjust mobile sidebar
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
      closeMobileSidebar();
    }
  });
}

// ══════════════════════════════════════════════════════
// 模式二：題庫練習 業務邏輯
// ══════════════════════════════════════════════════════

function initMode2() {
  if (state.geminiApiKey && !localStorage.getItem('gemini_api_key')) {
    localStorage.setItem('gemini_api_key', state.geminiApiKey);
  }
  updateM2LobbyStats();
  updateApiStatusBtn();

  // Close modals on overlay backdrop click
  ['gemini-api-modal', 'm2-ch-modal', 'm2-ai-modal', 'manual-add-modal', 'ai-complete-modal', 'm2-past-modal'].forEach(id => {
    const modal = $(`#${id}`);
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.add('hidden');
      });
    }
  });
}

// ── Gemini API 核心通訊 (優先調用 gemini-3.8-flash，並具備智能容錯備援) ──
async function callGeminiApi(prompt, jsonMode = false, apiKey = state.geminiApiKey) {
  if (!apiKey) throw new Error('未設定 API Key');
  const preferredModel = state.geminiModel || 'gemini-3.8-flash';
  const fallbackList = [preferredModel, 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];
  const models = Array.from(new Set(fallbackList));
  let lastErr = null;

  for (const model of models) {
    try {
      const payload = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: jsonMode ? 0.6 : 0.7
        }
      };
      if (jsonMode) {
        payload.generationConfig.responseMimeType = 'application/json';
      }

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error?.message || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('API 回傳內容為空');
      console.log(`Gemini API 回應成功 (使用模型: ${model})`);
      return text;
    } catch (err) {
      lastErr = err;
      console.warn(`Model ${model} 連線遭遇問題，自動嘗試備援模型:`, err.message);
    }
  }
  throw lastErr || new Error('所有 Gemini 模型連線嘗試皆失敗');
}

// ── 模式切換 ─────────────────────────────────────────
function switchMode(mode) {
  if (window.podcastPlayer) {
    podcastPlayer.stop();
  }
  state.currentMode = mode;
  document.body.classList.toggle('mode-1', mode === 1);
  document.body.classList.toggle('mode-2', mode === 2);
  toggleLandscapeHeader(false);
  if (mode === 1) {
    $('#mode1-btn')?.classList.add('active');
    $('#mode2-btn')?.classList.remove('active');
    $('#side-mode1-btn')?.classList.add('active');
    $('#side-mode2-btn')?.classList.remove('active');
    $('#mode2-container')?.classList.add('hidden');
    $('#sidebar')?.classList.remove('hidden');
    $('#sidebar')?.classList.remove('hidden-desktop');
    $('#main-content')?.classList.remove('hidden');
    if ($('#sidebar-toggle')) $('#sidebar-toggle').style.display = '';
    if (state.currentChId) {
      $('#welcome-screen')?.classList.add('hidden');
      $('#chapter-view')?.classList.remove('hidden');
    } else {
      $('#welcome-screen')?.classList.remove('hidden');
      $('#chapter-view')?.classList.add('hidden');
    }
  } else {
    $('#mode2-btn')?.classList.add('active');
    $('#mode1-btn')?.classList.remove('active');
    $('#side-mode2-btn')?.classList.add('active');
    $('#side-mode1-btn')?.classList.remove('active');
    $('#sidebar')?.classList.add('hidden-desktop');
    $('#sidebar')?.classList.remove('hidden');
    $('#main-content')?.classList.add('hidden');
    $('#mode2-container')?.classList.remove('hidden');
    if ($('#sidebar-toggle')) $('#sidebar-toggle').style.display = '';
    closeMobileSidebar();
    showM2Subview('m2-lobby');
    updateM2LobbyStats();
    updateApiStatusBtn();
  }
}

function showM2Subview(subviewId) {
  $$('.m2-subview').forEach(el => el.classList.add('hidden'));
  const target = $(`#${subviewId}`);
  if (target) target.classList.remove('hidden');
  const container = $('#mode2-container');
  if (container) container.scrollTop = 0;
}

function returnToLobby() {
  if (state.m2Runner.timerInterval) {
    clearInterval(state.m2Runner.timerInterval);
    state.m2Runner.timerInterval = null;
  }
  showM2Subview('m2-lobby');
  updateM2LobbyStats();
  updateApiStatusBtn();
}

function updateM2LobbyStats() {
  const totalEl = $('#m2-stat-total');
  const accEl = $('#m2-stat-accuracy');
  const wrongEl = $('#m2-stat-wrong-cnt');
  if (totalEl) totalEl.textContent = state.m2Stats.total || 0;
  if (accEl) {
    const acc = state.m2Stats.total > 0 ? Math.round((state.m2Stats.correct / state.m2Stats.total) * 100) : 0;
    accEl.textContent = `${acc}%`;
  }
  if (wrongEl) wrongEl.textContent = state.wrongQuestions.length;
}

function resetM2Stats() {
  if (confirm('確定要清空模式二的「累計做題數」與「平均正確率」統計嗎？\n（作答題數將歸零，錯題本資料仍會保留）')) {
    state.m2Stats = { total: 0, correct: 0 };
    localStorage.setItem('m2_stats', JSON.stringify(state.m2Stats));
    updateM2LobbyStats();
    alert('模式二累計做題數已成功清空！');
  }
}

function updateApiStatusBtn() {
  const dot = $('#api-dot');
  const text = $('#api-status-text');
  const modelName = (state.geminiModel || 'gemini-3.8-flash').replace('models/', '').replace('-flash', '').replace('gemini-', 'Gemini ');
  if (state.geminiApiKey) {
    if (dot) dot.classList.add('active');
    if (text) text.textContent = `${modelName} 已就緒`;
  } else {
    if (dot) dot.classList.remove('active');
    if (text) text.textContent = 'Gemini API 設定';
  }
}

// ── API Key 設定彈窗 ─────────────────────────────────
function openApiModal() {
  const input = $('#gemini-key-input');
  if (input) input.value = state.geminiApiKey || '';
  const modelSelect = $('#gemini-model-select');
  if (modelSelect) modelSelect.value = state.geminiModel || 'gemini-3.8-flash';
  const res = $('#api-test-result');
  if (res) res.innerHTML = '';
  $('#gemini-api-modal')?.classList.remove('hidden');
}

function closeApiModal() {
  $('#gemini-api-modal')?.classList.add('hidden');
}

async function saveApiKey() {
  const input = $('#gemini-key-input');
  const key = (input ? input.value : '').trim();
  const modelSelect = $('#gemini-model-select');
  const chosenModel = modelSelect ? modelSelect.value : 'gemini-3.8-flash';
  const res = $('#api-test-result');
  if (!key) {
    if (res) res.innerHTML = '<span style="color:var(--error)">⚠️ 請輸入有效的 API Key！</span>';
    return;
  }

  if (res) res.innerHTML = `<span style="color:var(--blue)">連線驗證中（指定 ${chosenModel}）…</span>`;

  try {
    state.geminiModel = chosenModel;
    await callGeminiApi('請回覆 OK', false, key);
    state.geminiApiKey = key;
    localStorage.setItem('gemini_api_key', key);
    localStorage.setItem('gemini_model', chosenModel);
    updateApiStatusBtn();
    if (res) res.innerHTML = `<span style="color:var(--success)">✅ 驗證成功！已啟用 ${chosenModel}。</span>`;
    setTimeout(() => {
      closeApiModal();
    }, 1200);
  } catch (err) {
    console.error('API Key validation failed:', err);
    if (res) res.innerHTML = `<span style="color:var(--error)">❌ 驗證失敗：${escapeHtml(err.message)}</span>`;
  }
}

function clearApiKey() {
  state.geminiApiKey = '';
  localStorage.removeItem('gemini_api_key');
  const input = $('#gemini-key-input');
  if (input) input.value = '';
  const res = $('#api-test-result');
  if (res) res.innerHTML = '<span style="color:var(--text-muted)">金鑰已清除。</span>';
  updateApiStatusBtn();
}

// ── 題庫核心作答引擎 (Runner) ────────────────────────
function startM2Quiz(type, title, questions) {
  if (!questions || questions.length === 0) {
    alert('找不到符合條件的題目！');
    return;
  }

  // 支援自由自訂題數（不再強制截斷為 10 題）
  const finalQuestions = questions;

  if (state.m2Runner.timerInterval) {
    clearInterval(state.m2Runner.timerInterval);
    state.m2Runner.timerInterval = null;
  }

  state.m2Runner = {
    type: type,
    title: title,
    questions: finalQuestions,
    currentIndex: 0,
    userAnswers: {},
    timerSeconds: 0,
    timerInterval: null
  };

  // 計時器
  const timerEl = $('#m2-runner-timer');
  if (timerEl) timerEl.textContent = '⏱️ 00:00';
  state.m2Runner.timerInterval = setInterval(() => {
    state.m2Runner.timerSeconds++;
    if (timerEl) timerEl.textContent = `⏱️ ${formatTimer(state.m2Runner.timerSeconds)}`;
  }, 1000);

  // 標題 Badge
  const badge = $('#m2-runner-type');
  if (badge) badge.textContent = title;

  // 渲染題號列與第一題
  renderRunnerNavBar();
  renderRunnerQuestion(0);

  // 進入作答視圖
  showM2Subview('m2-quiz-runner');
}

function formatTimer(totalSecs) {
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function cleanOptionText(text) {
  if (!text) return '';
  return text.replace(/^(\s*[\(\（]?[A-Da-d][\)\）\.\s、·]\s*)+/, '').trim();
}

function renderRunnerNavBar() {
  const bar = $('#m2-qnav-bar');
  if (!bar) return;
  bar.innerHTML = '';
  const total = state.m2Runner.questions.length;
  for (let i = 0; i < total; i++) {
    const pill = document.createElement('button');
    pill.className = 'm2-qnav-pill' + (i === 0 ? ' active' : '');
    pill.id = `m2-pill-${i}`;
    pill.textContent = i + 1;
    pill.addEventListener('click', () => renderRunnerQuestion(i));
    bar.appendChild(pill);
  }
}

function renderRunnerQuestion(idx) {
  state.m2Runner.currentIndex = idx;
  const total = state.m2Runner.questions.length;
  const q = state.m2Runner.questions[idx];

  // 更新題號按鈕樣式
  for (let i = 0; i < total; i++) {
    const pill = $(`#m2-pill-${i}`);
    if (pill) {
      pill.classList.remove('active');
      if (i === idx) pill.classList.add('active');
      if (state.m2Runner.userAnswers[i] !== undefined) {
        pill.classList.add('answered');
      } else {
        pill.classList.remove('answered');
      }
    }
  }

  // 標籤
  const tagMeta = $('#m2-qmeta-tag');
  const chTag = $('#m2-qmeta-ch');
  let diffBadgeHtml = '';
  if (q.difficulty) {
    const diffClass = q.difficulty === '中等' ? 'diff-medium' : (q.difficulty === '困難' ? 'diff-expert' : 'diff-hard');
    diffBadgeHtml = `<span class="m2-qdiff-badge ${diffClass}">${escapeHtml(q.difficulty)}</span>`;
  }
  if (tagMeta) tagMeta.innerHTML = `第 ${idx + 1} / ${total} 題 ${diffBadgeHtml}`;
  if (chTag) chTag.textContent = `${q.chNum || ''} ${q.chTitle || ''}`;

  // 題幹文字
  const qText = $('#m2-qtext');
  if (qText) qText.textContent = q.question;

  // 附圖 (心電圖 / 題幹附圖)
  const imgWrap = $('#m2-runner-img');
  if (imgWrap) {
    if (q.image) {
      imgWrap.innerHTML = `
        <div class="m2-qimage-box" onclick="openImageModal('${escapeHtml(q.image)}')">
          <img src="${escapeHtml(q.image)}" alt="題目心電圖/附圖" class="m2-qimage">
          <div class="m2-qimage-hint">🔍 點擊圖片可放大檢視心電圖細節</div>
        </div>`;
      imgWrap.classList.remove('hidden');
    } else {
      imgWrap.innerHTML = '';
      imgWrap.classList.add('hidden');
    }
  }

  // 四個選項渲染
  const optWrap = $('#m2-runner-options');
  if (!optWrap) return;
  optWrap.innerHTML = '';
  const letters = ['A', 'B', 'C', 'D'];
  const userChoice = state.m2Runner.userAnswers[idx];

  (q.options || []).forEach((optText, optIdx) => {
    const optDiv = document.createElement('div');
    optDiv.className = 'm2-runner-opt' + (userChoice === optIdx ? ' selected' : '');
    optDiv.innerHTML = `
      <div class="m2-opt-letter">${letters[optIdx]}</div>
      <div class="m2-opt-text">${escapeHtml(cleanOptionText(optText))}</div>
    `;
    optDiv.addEventListener('click', () => {
      selectRunnerOption(idx, optIdx);
    });
    optWrap.appendChild(optDiv);
  });

  // 上下題按鈕狀態
  const prevBtn = $('#m2-prev-btn');
  const nextBtn = $('#m2-next-btn');
  if (prevBtn) prevBtn.disabled = (idx === 0);
  if (nextBtn) {
    nextBtn.disabled = false;
    if (idx === total - 1) {
      nextBtn.textContent = '完成交卷 🏁';
    } else {
      nextBtn.textContent = '下一題 →';
    }
  }
}

function selectRunnerOption(qIdx, optIdx) {
  state.m2Runner.userAnswers[qIdx] = optIdx;

  // 更新選項樣式
  $$('.m2-runner-opt').forEach((el, i) => {
    if (i === optIdx) el.classList.add('selected');
    else el.classList.remove('selected');
  });

  // 更新上方題號列
  const pill = $(`#m2-pill-${qIdx}`);
  if (pill) pill.classList.add('answered');
}

function prevRunnerQ() {
  if (state.m2Runner.currentIndex > 0) {
    renderRunnerQuestion(state.m2Runner.currentIndex - 1);
  }
}

function nextRunnerQ() {
  const total = state.m2Runner.questions.length;
  if (state.m2Runner.currentIndex < total - 1) {
    renderRunnerQuestion(state.m2Runner.currentIndex + 1);
  } else {
    submitRunnerQuiz();
  }
}

function confirmQuitQuiz() {
  if (confirm('確定要結束本次測驗回大廳嗎？作答進度將不會被保存。')) {
    returnToLobby();
  }
}

// ── 交卷結算與 10 題逐題詳解 ─────────────────────────
function submitRunnerQuiz() {
  const total = state.m2Runner.questions.length;
  const answeredCount = Object.keys(state.m2Runner.userAnswers).length;
  if (answeredCount < total) {
    const unanswered = total - answeredCount;
    if (!confirm(`您還有 ${unanswered} 題尚未作答，確定要現在交卷結算嗎？`)) {
      return;
    }
  }

  // 停止計時
  if (state.m2Runner.timerInterval) {
    clearInterval(state.m2Runner.timerInterval);
    state.m2Runner.timerInterval = null;
  }

  let correctCount = 0;
  const questions = state.m2Runner.questions;
  const newWrongQuestions = [];

  questions.forEach((q, i) => {
    const userChoice = state.m2Runner.userAnswers[i];
    const isCorrect = (userChoice === q.answer);
    if (isCorrect) {
      correctCount++;
    } else {
      const resolved = resolveQuestionChapter(q);
      const wrongItem = {
        id: q.id || `m2-${Date.now()}-${i}`,
        question: q.question,
        options: q.options,
        answer: q.answer,
        userAnswer: userChoice !== undefined ? userChoice : -1,
        explanation: q.explanation || '依據教科書臨床指引解析。',
        chId: resolved.chId,
        chNum: resolved.chNum,
        chTitle: resolved.chTitle,
        timestamp: Date.now()
      };
      // 依題目內容去重
      const exists = state.wrongQuestions.some(wq => wq.question === wrongItem.question);
      if (!exists) {
        state.wrongQuestions.unshift(wrongItem);
        newWrongQuestions.push(wrongItem);
      }
    }
  });

  // 更新累計統計與錯題本保存
  state.m2Stats.total += total;
  state.m2Stats.correct += correctCount;
  localStorage.setItem('m2_stats', JSON.stringify(state.m2Stats));
  localStorage.setItem('m2_wrong_questions', JSON.stringify(state.wrongQuestions));

  // 結算分數
  const score = Math.round((correctCount / total) * 100);
  const scoreEl = $('#m2-res-score');
  const titleEl = $('#m2-res-title');
  const statsEl = $('#m2-res-stats');
  const msgEl = $('#m2-res-msg');

  // 若為 AI 測驗，答題結束後依照詳解歸類自動加入章節專項題庫
  let autoSavedAiCount = 0;
  if (state.m2Runner.type === 'ai') {
    autoSavedAiCount = saveAiQuestionsToChapterPool(state.m2Runner.questions);
  }

  if (scoreEl) scoreEl.textContent = score;
  if (titleEl) {
    if (score >= 90) titleEl.textContent = '🌟 卓越神準！甄試實力頂尖！';
    else if (score >= 80) titleEl.textContent = '🎉 表現優良！核心觀念清晰！';
    else if (score >= 60) titleEl.textContent = '💪 順利及格！再接再厲保持！';
    else titleEl.textContent = '🔥 需補強觀念！請詳讀下方解析！';
  }
  if (statsEl) {
    statsEl.textContent = `答對 ${correctCount} / ${total} 題 ‧ 測驗用時 ${formatTimer(state.m2Runner.timerSeconds)}`;
  }
  if (msgEl) {
    let baseMsg = '';
    if (score === 100) baseMsg = '全對滿分！臨床鑑別與處置思維完美無缺！';
    else if (newWrongQuestions.length > 0) baseMsg = `已自動將本次 ${newWrongQuestions.length} 道錯題收錄至錯題本，點擊筆記連結即可複習！`;
    else baseMsg = `請仔細檢閱下方 ${total} 題完整詳解與考點關鍵，加深記憶！`;

    if (autoSavedAiCount > 0) {
      baseMsg += ` 🎯 同步將本次 ${autoSavedAiCount} 道 AI 臨床精選試題依章節解析歸入「章節專項題庫」！`;
    }
    msgEl.textContent = baseMsg;
  }

  // 渲染逐題詳解與跳轉筆記連結
  renderQuizReviewList(questions, state.m2Runner.userAnswers);

  // 切換至結果視圖
  showM2Subview('m2-quiz-result');
}

// ── 模式二：考點速記精簡解析萃取函數 ────────────────────────
function getBriefExplanation(q) {
  if (!q) return '詳見各章重點筆記。';
  let expl = (q.explanation || '').trim();
  const ansIdx = (typeof q.answer === 'number' && q.answer >= 0 && q.answer < 4) ? q.answer : 0;
  const letters = ['A', 'B', 'C', 'D'];
  const ansLetter = letters[ansIdx] || 'A';

  const defaultFallback = () => {
    if (q.options && q.options[ansIdx]) {
      const cleanOpt = String(q.options[ansIdx]).replace(/^[A-Da-d][\.\s、:]*/, '').trim();
      return `正確選項為 (${ansLetter}) ${cleanOpt}。`;
    }
    return '詳見該章重點筆記與教材指引。';
  };

  if (!expl) return defaultFallback();

  // 清除跨行括號斷裂，例如 "(\nC)"
  expl = expl.replace(/[(（]\s*\r?\n\s*/g, '(');

  // 以空行先切分段落
  const rawParagraphs = expl.split(/\r?\n\s*\r?\n/).map(p => p.trim()).filter(Boolean);

  const optStartPat = /^(?:重點解析[:：]\s*)?[\uf0e8\*\-•\s]*(?:[(（][A-Da-d][)）]|【[A-Da-d]】|[A-Da-d][:：\s、\.])/;
  const headerPat = /^(?:重點解析[:：]?\s*$|衛生福利部.*|\d+\s*台大\s*田鴻毅.*|台大\s*田鴻毅.*|參考出處[:：].*|【出處】.*|[─_=*]{3,}|第\s*\d+\s*章.*(?:\(p\d+.*?\))?)$/i;

  const validBlocks = [];
  let reachedStop = false;

  for (const para of rawParagraphs) {
    if (reachedStop) break;
    const lines = para.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let curr = [];

    for (const l of lines) {
      if (headerPat.test(l)) continue;
      if (/(?:\(延伸閱讀\)|法規名稱：|救護技術員管理辦法修正總說明|緊急醫療救護法修正條文)/.test(l)) {
        reachedStop = true;
        break;
      }
      if (optStartPat.test(l)) {
        if (curr.length > 0) {
          validBlocks.push(curr.join(' ').replace(/\s+/g, ' ').trim());
          curr = [];
        }
        curr.push(l);
      } else {
        if (curr.length > 0) {
          curr.push(l);
        } else {
          validBlocks.push(l);
        }
      }
    }
    if (curr.length > 0) {
      validBlocks.push(curr.join(' ').replace(/\s+/g, ' ').trim());
    }
  }

  // 過濾無效或分隔線區塊
  const filteredBlocks = validBlocks
    .map(b => b.replace(/\s+/g, ' ').trim())
    .filter(b => b && !/^(?:重點解析[:：]?|[─_=*\.]{3,}|…+|~+)$/.test(b));

  if (filteredBlocks.length === 0) return defaultFallback();

  // 1. 優先比對正確答案選項標記
  const ansRegexes = [
    new RegExp(`^(?:重點解析[:：]\\s*)?[\\uf0e8\\*\\-•\\s]*(?:[(（]${ansLetter}[)）]|【${ansLetter}】|${ansLetter}[:：\\s、\\.])\\s*(.*)`, 'i'),
    new RegExp(`^(?:重點解析[:：]\\s*)?[\\uf0e8\\*\\-•\\s]*(?:正確|錯誤|錯|對)[。、\\s]*[(（]${ansLetter}[)）]\\s*(.*)`, 'i'),
    new RegExp(`^(?:重點解析[:：]\\s*)?[\\uf0e8\\*\\-•\\s]*正確[:：\\s]*[(（]?${ansLetter}[)）]`, 'i')
  ];

  let targetBlock = null;
  let targetIdx = -1;
  for (let idx = 0; idx < filteredBlocks.length; idx++) {
    for (let r of ansRegexes) {
      if (r.test(filteredBlocks[idx])) {
        targetBlock = filteredBlocks[idx];
        targetIdx = idx;
        break;
      }
    }
    if (targetBlock) break;
  }

  let chosen = '';
  if (targetBlock) {
    let cleanB = targetBlock
      .replace(/^重點解析[:：]\s*/, '')
      .replace(/^第\s*\d+\s*章\s*[^\s]+[\s/]*/, '')
      .trim();

    // 若僅有單純結論判定（如「(A) 錯誤。」或過短），向後探尋實質說明
    const isBare = /^[\uf0e8\*\-•\s]*(?:[(（]?[A-D][)）][:：\s、\.]*|【[A-D]】\s*|[A-D][:：\s]*)(?:正確|錯誤|錯|對|是|否|無誤)[。！!~.]*$/i.test(cleanB);
    if (isBare || cleanB.length < 16) {
      for (let ni = targetIdx + 1; ni < filteredBlocks.length; ni++) {
        const nextB = filteredBlocks[ni];
        if (optStartPat.test(nextB)) continue;
        const cleanNext = nextB
          .replace(/^重點解析[:：]\s*/, '')
          .replace(/^第\s*\d+\s*章\s*[^\s]+[\s/]*/, '')
          .trim();
        if (cleanNext) {
          cleanB = `${cleanB} ${cleanNext}`;
          break;
        }
      }
    }
    chosen = cleanB;
  }

  // 2. 若無直接對應，找第一個非其他選項的解析段落
  if (!chosen) {
    const otherLetters = letters.filter(l => l !== ansLetter);
    const otherPats = otherLetters.map(l => new RegExp(`^[\\uf0e8\\*\\-•\\s]*(?:[(（]${l}[)）]|【${l}】|${l}[:：\\s、\\.])`, 'i'));
    for (let idx = 0; idx < filteredBlocks.length; idx++) {
      const b = filteredBlocks[idx];
      if (otherPats.some(p => p.test(b))) continue;
      let cleanB = b
        .replace(/^重點解析[:：]\s*/, '')
        .replace(/^第\s*\d+\s*章\s*[^\s]+[\s/]*/, '')
        .trim();
      if (/^(?:原始答案|公布答案)[:：\s]*/.test(cleanB) && idx + 1 < filteredBlocks.length) {
        cleanB += ' ' + filteredBlocks[idx + 1];
      }
      if (cleanB) {
        chosen = cleanB;
        break;
      }
    }
  }

  // 3. 兜底取首段
  if (!chosen && filteredBlocks.length > 0) {
    chosen = filteredBlocks[0]
      .replace(/^重點解析[:：]\s*/, '')
      .replace(/^第\s*\d+\s*章\s*[^\s]+[\s/]*/, '')
      .trim();
  }

  if (!chosen) return defaultFallback();

  let res = chosen
    .replace(/\s+/g, ' ')
    .replace(/^[\uf0e8\*\-•\s]+/, '')
    .replace(/^更正[\uf0e8\s]*/, '')
    .trim();

  // 精簡長度控制，約 1~3 句話，若過長於標點截斷
  if (res.length > 150) {
    const cutMatch = res.slice(80, 150).match(/[。；！？]/);
    if (cutMatch && typeof cutMatch.index === 'number') {
      res = res.slice(0, 80 + cutMatch.index + 1).trim();
    } else {
      res = res.slice(0, 145).trim() + '...';
    }
  }

  return res || defaultFallback();
}

// ── 切換展開/收合完整解析 ────────────────────────────
function toggleFullExpl(btn) {
  const box = btn.closest('.review-expl-box');
  if (!box) return;
  const fullContainer = box.querySelector('.full-expl-container');
  if (!fullContainer) return;
  const isHidden = fullContainer.style.display === 'none' || !fullContainer.style.display;
  if (isHidden) {
    fullContainer.style.display = 'block';
    btn.innerHTML = '🔼 收合完整解析';
    btn.classList.add('expanded');
  } else {
    fullContainer.style.display = 'none';
    btn.innerHTML = '📖 展開完整解析';
    btn.classList.remove('expanded');
  }
}

function renderQuizReviewList(questions, userAnswers) {
  const container = $('#m2-review-list');
  if (!container) return;
  container.innerHTML = '';
  const letters = ['A', 'B', 'C', 'D'];

  const titleEl = $('#m2-review-title');
  if (titleEl) {
    titleEl.textContent = `📋 本次測驗逐題詳解與考點對照 (共 ${questions.length} 題)`;
  }

  questions.forEach((q, i) => {
    const userChoice = userAnswers[i];
    const isCorrect = (userChoice === q.answer);

    const card = document.createElement('div');
    card.className = `m2-review-card ${isCorrect ? 'correct' : 'incorrect'}`;

    let optionsHtml = '';
    (q.options || []).forEach((optText, optIdx) => {
      let optClass = 'm2-rev-opt';
      let badge = '';
      if (optIdx === q.answer) {
        optClass += ' is-correct-answer';
        badge = ' <b style="color:var(--success);margin-left:auto">(正確答案)</b>';
      }
      if (optIdx === userChoice) {
        optClass += ' is-user-answer';
        if (!isCorrect) badge += ' <b style="color:var(--error);margin-left:auto">(您的選擇 ❌)</b>';
        else badge = ' <b style="color:var(--success);margin-left:auto">(您的選擇 ✅)</b>';
      }
      optionsHtml += `
        <div class="${optClass}">
          <b>(${letters[optIdx]})</b>
          <span>${escapeHtml(cleanOptionText(optText))}</span>
          ${badge}
        </div>
      `;
    });

    card.innerHTML = `
      <div class="m2-rev-meta">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="m2-qtag">第 ${i + 1} 題</span>
          <span class="m2-qtag ch">${escapeHtml(q.chNum || '')} ${escapeHtml(q.chTitle || '')}</span>
          ${q.difficulty ? `<span class="m2-qdiff-badge ${q.difficulty === '中等' ? 'diff-medium' : (q.difficulty === '困難' ? 'diff-expert' : 'diff-hard')}">${escapeHtml(q.difficulty)}</span>` : ''}
        </div>
        <span class="m2-rev-status ${isCorrect ? 'correct' : 'incorrect'}">
          ${isCorrect ? '✅ 答對' : '❌ 答錯'}
        </span>
      </div>
      <div class="m2-qtext" style="font-size:1.05rem;margin-bottom:12px">${escapeHtml(q.question)}</div>
      ${q.image ? `
        <div class="m2-qimage-wrap">
          <div class="m2-qimage-box" onclick="openImageModal('${escapeHtml(q.image)}')">
            <img src="${escapeHtml(q.image)}" alt="題目心電圖/附圖" class="m2-qimage">
            <div class="m2-qimage-hint">🔍 點擊圖片可放大檢視心電圖細節</div>
          </div>
        </div>` : ''}
      <div class="m2-rev-options">
        ${optionsHtml}
      </div>
      <div class="review-expl-box">
        <div class="review-expl-header">
          <span class="review-expl-title">💡 考點速記：</span>
          <button type="button" class="toggle-full-expl-btn" onclick="toggleFullExpl(this)">
            📖 展開完整解析
          </button>
        </div>
        <div class="brief-expl-text">${escapeHtml(getBriefExplanation(q))}</div>
        <div class="full-expl-container" style="display:none">
          <div class="full-expl-divider"></div>
          <div class="full-expl-title">📋 完整教材／法規詳解：</div>
          ${renderQuizPageLine(q)}
          <div class="full-expl-content">${escapeHtml(q.explanation || '暫無完整解析')}</div>
        </div>
      </div>
      ${renderTextbookDetails(q)}
    `;

    container.appendChild(card);
    if (!q.page && q.chId) resolveQuestionSection(q);   // AI 題：補齊段落與教科書頁碼
  });
}

// ── 跳轉至模式一重點筆記 ─────────────────────────────
function jumpToMode1Chapter(chId) {
  if (!chId) chId = 'ch01';
  $('#m2-review-modal')?.classList.add('hidden');
  $('#m2-ch-modal')?.classList.add('hidden');
  switchMode(1);
  selectChapter(chId);
  switchTab('notes');
  setTimeout(() => {
    const target = $('#notes-content') || $('#chapter-view');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 120);
}

// ── 功能二：歷屆試題全真抽測 ──────────────────
function openPastExamModal() {
  $('#m2-past-modal')?.classList.remove('hidden');
}

function closePastExamModal() {
  $('#m2-past-modal')?.classList.add('hidden');
}

function confirmStartPastExam() {
  const select = $('#past-count-select');
  const count = select ? parseInt(select.value, 10) || 10 : 10;
  closePastExamModal();
  startPastExamQuiz(count);
}

function startPastExamQuiz(count = 10) {
  if (!state.allQuizzes || state.allQuizzes.length === 0) {
    alert('正在載入歷屆試題庫，請稍候重試…');
    return;
  }
  // 依使用者要求：歷屆全真嚴格限定新北小考與衛福部甄試真題，排除所有 AI 題目
  const pastExamPool = state.allQuizzes.filter(q => !q.isAiGenerated && !String(q.id || '').startsWith('ai-'));
  if (pastExamPool.length === 0) {
    alert('歷屆真題載入中，請稍候重試…');
    return;
  }
  const shuffled = [...pastExamPool].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, count);
  startM2Quiz('past', `🎲 歷屆全真抽測 (${selected.length}題 ‧ 純歷屆真題)`, selected);
}

// ── 功能三：章節專項出題 ──────────────────────
function openChapterQuizModal() {
  const grid = $('#m2-ch-grid');
  if (grid) {
    grid.innerHTML = '';
    state.chapters.forEach(ch => {
      const totalInCh = state.allQuizzes.filter(q => q.chId === ch.id).length;
      const aiInCh = state.allQuizzes.filter(q => q.chId === ch.id && q.isAiGenerated).length;
      const label = document.createElement('label');
      label.className = 'ch-checkbox-label';
      label.innerHTML = `
        <input type="checkbox" value="${ch.id}" class="m2-ch-cb" onchange="updateChSelectCount()">
        <span style="display:flex;align-items:center;width:100%">
          <b>${ch.num}</b>&nbsp;${escapeHtml(ch.title)}
          ${aiInCh > 0 ? `<span class="ch-ai-badge" title="收錄 ${aiInCh} 道 AI 精選題">🤖 +${aiInCh}</span>` : ''}
          <span class="ch-total-badge">${totalInCh}題</span>
        </span>
      `;
      grid.appendChild(label);
    });
  }
  updateChSelectCount();
  $('#m2-ch-modal')?.classList.remove('hidden');
}

function closeChapterQuizModal() {
  $('#m2-ch-modal')?.classList.add('hidden');
}

function updateChSelectCount() {
  const cbs = Array.from($$('.m2-ch-cb:checked')).map(cb => cb.value);
  const countEl = $('#ch-selected-count');
  if (countEl) {
    const selectedSet = new Set(cbs);
    const totalInSelected = state.allQuizzes.filter(q => selectedSet.has(q.chId)).length;
    countEl.textContent = `已選 ${cbs.length} 個章節 (共 ${totalInSelected} 題)`;
  }
}

function selectAllChapters(checked) {
  $$('.m2-ch-cb').forEach(cb => cb.checked = checked);
  updateChSelectCount();
}

function selectPresetChapters(category) {
  selectAllChapters(false);
  let targetIds = [];
  if (category === 'cardio') {
    targetIds = ['ch23', 'ch24', 'ch33', 'ch34'];
  } else if (category === 'trauma') {
    targetIds = ['ch25', 'ch26', 'ch27', 'ch28', 'ch29', 'ch30', 'ch31', 'ch32'];
  } else if (category === 'airway') {
    targetIds = ['ch14', 'ch15', 'ch35'];
  } else if (category === 'neuro') {
    targetIds = ['ch20', 'ch36', 'ch37', 'ch46'];
  } else if (category === 'peds') {
    targetIds = ['ch48', 'ch49'];
  } else if (category === 'toxic') {
    targetIds = ['ch44', 'ch45', 'ch50', 'ch52', 'ch53', 'ch57'];
  }
  const set = new Set(targetIds);
  $$('.m2-ch-cb').forEach(cb => {
    if (set.has(cb.value)) cb.checked = true;
  });
  updateChSelectCount();
}

function startSelectedChapterQuiz() {
  const selectedCbs = Array.from($$('.m2-ch-cb:checked')).map(cb => cb.value);
  if (selectedCbs.length === 0) {
    alert('請至少勾選一個章節！');
    return;
  }
  const countSelect = $('#ch-quiz-count-select');
  const countVal = countSelect ? countSelect.value : '10';

  const selectedSet = new Set(selectedCbs);
  const matched = state.allQuizzes.filter(q => selectedSet.has(q.chId));

  if (matched.length === 0) {
    alert('所選章節目前題目較少，為您隨機抽取題目進行專項挑戰！');
    const targetCount = countVal === 'all' ? 10 : (parseInt(countVal, 10) || 10);
    const shuffled = [...state.allQuizzes].sort(() => Math.random() - 0.5).slice(0, targetCount);
    closeChapterQuizModal();
    startM2Quiz('chapter', `📚 章節專項抽測 (${shuffled.length}題)`, shuffled);
    return;
  }

  let pool = [...matched].sort(() => Math.random() - 0.5);
  let targetCount = countVal === 'all' ? pool.length : (parseInt(countVal, 10) || 10);

  // 若所選章節不足目標題數且非全選，自其他題目補足
  if (pool.length < targetCount && countVal !== 'all') {
    const others = state.allQuizzes.filter(q => !selectedSet.has(q.chId)).sort(() => Math.random() - 0.5);
    pool = pool.concat(others.slice(0, targetCount - pool.length));
  }
  const selected = pool.slice(0, targetCount);
  closeChapterQuizModal();
  startM2Quiz('chapter', `📚 章節專項抽測 (${selected.length}題 ‧ ${selectedCbs.length}章節)`, selected);
}

// ── 功能一：AI 智慧出題 (10題) ──────────────────────
function openAiQuizModal() {
  if (!state.geminiApiKey) {
    alert('使用 AI 智慧出題前，請先點擊上方按鈕設定 Google Gemini API Key！');
    openApiModal();
    return;
  }
  $('#m2-ai-modal')?.classList.remove('hidden');
  // 若上一份 AI 測驗仍在背景生成中，重新打開視窗時應顯示生成中狀態，
  // 而不是重置成空白表單（避免使用者誤以為可以重新按「開始生成」）。
  setAiGenModalUI(state.aiGenInProgress);
}

function closeAiQuizModal() {
  // 純粹隱藏視窗，不會中斷背景中仍在進行的生成請求，
  // 讓使用者可以安心切回模式一繼續複習。
  $('#m2-ai-modal')?.classList.add('hidden');
}

// 切換 AI 出題視窗在「生成中」與「待設定」兩種狀態下的顯示
function setAiGenModalUI(generating) {
  const statusEl = $('#ai-gen-status');
  const btn = $('#ai-start-gen-btn');
  const cancelBtn = $('#ai-cancel-btn');
  const topicSelect = $('#ai-topic-select');
  const diffSelect = $('#ai-diff-select');
  if (statusEl) statusEl.style.display = generating ? 'block' : 'none';
  if (btn) btn.disabled = generating;
  if (topicSelect) topicSelect.disabled = generating;
  if (diffSelect) diffSelect.disabled = generating;
  if (cancelBtn) cancelBtn.textContent = generating ? '🔽 縮小視窗（背景生成中）' : '取消';
}

// AI 測驗生成完成後的提醒：小紅點 + 大廳橫幅
function showAiReadyNotice() {
  $('#mode2-ready-dot')?.classList.remove('hidden');
  $('#side-mode2-ready-dot')?.classList.remove('hidden');
  $('#ai-pending-banner')?.classList.remove('hidden');
}

function clearAiReadyNotice() {
  $('#mode2-ready-dot')?.classList.add('hidden');
  $('#side-mode2-ready-dot')?.classList.add('hidden');
  $('#ai-pending-banner')?.classList.add('hidden');
}

// 點擊大廳橫幅或小紅點提醒 → 正式進入剛才背景生成好的 AI 測驗
function openPendingAiQuiz() {
  if (!state.pendingAiQuiz) return;
  const { title, questions } = state.pendingAiQuiz;
  state.pendingAiQuiz = null;
  clearAiReadyNotice();
  if (state.currentMode !== 2) switchMode(2);
  startM2Quiz('ai', title, questions);
}

// 只是先關掉大廳橫幅提示，測驗本身仍保留，頁籤小紅點會繼續提醒
function dismissPendingAiQuiz() {
  $('#ai-pending-banner')?.classList.add('hidden');
}

// ── Web Audio 提示音（安全零依賴） ──
function playSuccessBeep() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(587.33, now); // D5
    osc.frequency.setValueAtTime(880, now + 0.12); // A5
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.start(now);
    osc.stop(now + 0.35);
  } catch (e) {
    // 瀏覽器若未互動可能阻止音訊，靜默容錯
  }
}

// ── 台灣高級救護技術員教科書（大白第三版）權威 60 章節目錄 ──
const CHAPTER_CATALOG = [
  { id: 'ch01', num: 'CH01', title: '緊急醫療救護體系概論' },
  { id: 'ch02', num: 'CH02', title: '台灣緊急醫療救護體系' },
  { id: 'ch03', num: 'CH03', title: '救護技術員的角色與責任' },
  { id: 'ch04', num: 'CH04', title: '緊急醫療救護相關法律規範' },
  { id: 'ch05', num: 'CH05', title: '救護技術員的職業安全與傳染病防治' },
  { id: 'ch06', num: 'CH06', title: '救護技術員的心理衛生' },
  { id: 'ch07', num: 'CH07', title: '緊急醫療救護派遣系統' },
  { id: 'ch08', num: 'CH08', title: '社區層級的緊急醫療反應' },
  { id: 'ch09', num: 'CH09', title: '緊急醫療救護的品質管理' },
  { id: 'ch10', num: 'CH10', title: '緊急救護之新科技應用' },
  { id: 'ch11', num: 'CH11', title: '救護技術員的科學思考基礎' },
  { id: 'ch12', num: 'CH12', title: '人體基本解剖與生理' },
  { id: 'ch13', num: 'CH13', title: '從出生到死亡：一生的成長與發展' },
  { id: 'ch14', num: 'CH14', title: '呼吸道處置與通氣-原理篇' },
  { id: 'ch15', num: 'CH15', title: '呼吸道處置與通氣-技術篇' },
  { id: 'ch16', num: 'CH16', title: '緊急救護藥理學' },
  { id: 'ch17', num: 'CH17', title: '藥物給予及給藥途徑' },
  { id: 'ch18', num: 'CH18', title: '醫病關係與溝通技巧' },
  { id: 'ch19', num: 'CH19', title: '病史詢問' },
  { id: 'ch20', num: 'CH20', title: '身體診察' },
  { id: 'ch21', num: 'CH21', title: '到院前超音波應用' },
  { id: 'ch22', num: 'CH22', title: '病人評估與決策策' },
  { id: 'ch23', num: 'CH23', title: '基本生命支持與急救' },
  { id: 'ch24', num: 'CH24', title: '復甦醫學新進展' },
  { id: 'ch25', num: 'CH25', title: '外傷總論與重大外傷' },
  { id: 'ch26', num: 'CH26', title: '出血、休克與止血治療' },
  { id: 'ch27', num: 'CH27', title: '頭頸脊椎與顏面外傷' },
  { id: 'ch28', num: 'CH28', title: '胸部外傷' },
  { id: 'ch29', num: 'CH29', title: '腹骨盆部外傷' },
  { id: 'ch30', num: 'CH30', title: '軟組織肌肉骨骼外傷與壓砸傷' },
  { id: 'ch31', num: 'CH31', title: '灼傷與電灼害' },
  { id: 'ch32', num: 'CH32', title: '特殊創傷族群及親密伴侶暴力' },
  { id: 'ch33', num: 'CH33', title: '心電圖判定' },
  { id: 'ch34', num: 'CH34', title: '心臟與血管急症' },
  { id: 'ch35', num: 'CH35', title: '呼吸系統急症' },
  { id: 'ch36', num: 'CH36', title: '神經系統急症與急性腦中風' },
  { id: 'ch37', num: 'CH37', title: '內分泌與代謝急症' },
  { id: 'ch38', num: 'CH38', title: '腸胃急症' },
  { id: 'ch39', num: 'CH39', title: '血液與腫瘤急症' },
  { id: 'ch40', num: 'CH40', title: '過敏與免疫急症' },
  { id: 'ch41', num: 'CH41', title: '泌尿與腎臟急症' },
  { id: 'ch42', num: 'CH42', title: '感染急症' },
  { id: 'ch43', num: 'CH43', title: '新興傳染病與疫災防治' },
  { id: 'ch44', num: 'CH44', title: '環境急症' },
  { id: 'ch45', num: 'CH45', title: '野外醫學' },
  { id: 'ch46', num: 'CH46', title: '行為急症與精神急症' },
  { id: 'ch47', num: 'CH47', title: '高齡緊急救護概論' },
  { id: 'ch48', num: 'CH48', title: '新生兒急救與小兒急症' },
  { id: 'ch49', num: 'CH49', title: '婦產急症' },
  { id: 'ch50', num: 'CH50', title: '毒物學' },
  { id: 'ch51', num: 'CH51', title: '醫療管路、維生器材與常見的院內檢查' },
  { id: 'ch52', num: 'CH52', title: '大量病人與災難應變' },
  { id: 'ch53', num: 'CH53', title: '危害物質與核生化應變' },
  { id: 'ch54', num: 'CH54', title: '大型活動之緊急醫療救護' },
  { id: 'ch55', num: 'CH55', title: '運動賽事救護人員的角色與任務' },
  { id: 'ch56', num: 'CH56', title: '高危情境或侷限空間病人之緊急醫療救護' },
  { id: 'ch57', num: 'CH57', title: '常見天然災害' },
  { id: 'ch58', num: 'CH58', title: '空中救護體系' },
  { id: 'ch59', num: 'CH59', title: '緊急救護中的團隊資源管理' },
  { id: 'ch60', num: 'CH60', title: '緊急救護技術的教學技巧' }
];

// ── 智慧章節校驗與歸類函式 ──
function resolveQuestionChapter(q) {
  if (!q) return { chId: 'ch01', chNum: 'CH01', chTitle: '緊急醫療救護體系概論' };

  const getChapterById = (id) => {
    const cleanId = String(id || '').toLowerCase();
    const foundInState = state.chapters && state.chapters.find(c => c.id.toLowerCase() === cleanId);
    if (foundInState) return { chId: foundInState.id, chNum: foundInState.num, chTitle: foundInState.title };
    const foundInCatalog = CHAPTER_CATALOG.find(c => c.id.toLowerCase() === cleanId);
    if (foundInCatalog) return { chId: foundInCatalog.id, chNum: foundInCatalog.num, chTitle: foundInCatalog.title };
    return null;
  };

  const explanation = String(q.explanation || '');
  const fullText = `${q.chNum || ''} ${q.chTitle || ''} ${q.chapterTitle || ''} ${explanation} ${q.question || ''} ${Array.isArray(q.options) ? q.options.join(' ') : ''}`.toLowerCase();

  // ── 1. 詳解的【出處：大白 CHxx】是最可靠的訊號 ──────────────────────
  //   AI 出題 prompt 第 7 條明確要求附上，且它描述的是「題目考什麼」，
  //   比題幹裡偶然出現的藥名（如 Atropine 也用於心搏過緩）可靠得多。
  //   取「出處」後面出現的第一個章號；沒有「出處」字樣時退而取第一個「大白 CHxx」。
  const citeHead = explanation.match(/出處[^\n】]{0,60}?(?:CH|ch|第)\s*0?([1-9][0-9]?)/);
  const citeAny  = explanation.match(/(?:大白|教科書)\s*(?:第三版)?\s*(?:CH|第)\s*0?([1-9][0-9]?)(?!\s*頁)/i);
  const cite = citeHead || citeAny;
  if (cite) {
    const matched = getChapterById(`ch${String(parseInt(cite[1], 10)).padStart(2, '0')}`);
    if (matched) return matched;
  }

  // ── 2. 題目自帶的 chId（AI 回傳或歷屆題原本的歸屬）────────────────
  if (q.chId) {
    const matched = getChapterById(q.chId);
    if (matched) {
      // 防呆：AI 偶爾把毒物題回成 ch41 但標題寫毒物
      if (String(q.chId).toLowerCase() === 'ch41' && /毒/i.test(q.chTitle || '')) {
        return getChapterById('ch50') || matched;
      }
      return matched;
    }
  }

  // ── 3. 關鍵字兜底（前兩者都拿不到才用）────────────────────────────
  //   毒物學觸發詞已拿掉 atropine / naloxone / 阿托平 / 納洛酮：
  //   這些藥在心搏過緩、RSI、鴉片類過量之外也常見，單獨出現不代表中毒。
  const isToxic = /(沙林|sarin|2-pam|pralidoxime|有機磷|氨基甲酸|sludge|膽鹼性危象|解毒劑|毒物學|中毒|巴拉刈|除草劑|農藥|氰化物|一氧化碳中毒|安非他命|古柯鹼|大花曼陀羅|曼陀羅|毒蛇|抗毒素血清|肉毒桿菌|烏頭|毒性物質)/i.test(fullText);
  if (isToxic) {
    const isPureHazmat = /(除污走廊|除污帳棚|黃區除污|防護衣等級|level a|level b|初級除污)/i.test(fullText) && !/(2-pam|解毒|sludge)/i.test(fullText);
    if (isPureHazmat) { const m53 = getChapterById('ch53'); if (m53) return m53; }
    const m50 = getChapterById('ch50'); if (m50) return m50;
  }

  // ② 出血、休克與止血治療 (CH26)
  const isBleedingShock = /(大出血|出血性休克|失血性休克|低容積休克|止血帶|止血包紮|骨盆帶|休克指數|大量輸血)/i.test(fullText);
  if (isBleedingShock) {
    const match26 = getChapterById('ch26');
    if (match26) return match26;
  }

  // ③ 心電圖判定 (CH33)
  const isEcg = /(心電圖|\becg\b|\bekg\b|\bstemi\b|心室顫動|\bvf\b|\bvt\b|心室頻脈|房室傳導阻滯|av block|st段|導程)/i.test(fullText);
  if (isEcg) {
    const match33 = getChapterById('ch33');
    if (match33) return match33;
  }

  // ④ 心臟血管急症 (CH34)
  const isCardio = /(急性冠心症|\bacs\b|心肌梗塞|心絞痛|心因性休克|主動脈剝離|心衰竭)/i.test(fullText);
  if (isCardio) {
    const match34 = getChapterById('ch34');
    if (match34) return match34;
  }

  // ⑤ 困難呼吸道與通氣技術 (CH15)
  const isAirwayTech = /(氣管內管|插管|聲門上呼吸道|\bsga\b|\blma\b|\bburp\b|\blemon\b|甦醒球|\bbvm\b|環甲膜)/i.test(fullText);
  if (isAirwayTech) {
    const match15 = getChapterById('ch15');
    if (match15) return match15;
  }

  // ⑥ 呼吸系統急症 (CH35)
  const isAirwayMed = /(氣喘|copd|慢性阻塞性肺病|呼吸窘迫|喘鳴|哮鳴)/i.test(fullText);
  if (isAirwayMed) {
    const match35 = getChapterById('ch35');
    if (match35) return match35;
  }

  // ⑦ 神經急症與腦中風 (CH36)
  const isNeuro = /(腦中風|辛辛那提|\bcpss\b|\blams\b|\blvo\b|大血管阻塞|\btpa\b|血栓溶解|癲癇重積)/i.test(fullText);
  if (isNeuro) {
    const match36 = getChapterById('ch36');
    if (match36) return match36;
  }

  // ⑧ 新生兒與小兒急症 (CH48)
  const isPeds = /(新生兒急救|小兒急症|小兒|兒童|\bpat\b|小兒三角|\bnrp\b)/i.test(fullText);
  if (isPeds) {
    const match48 = getChapterById('ch48');
    if (match48) return match48;
  }

  // ⑨ 婦產急症 (CH49)
  const isOb = /(分娩|產婦|臍帶脫垂|前置胎盤|胎盤早期剝離|子癇|產後大出血|妊娠)/i.test(fullText);
  if (isOb) {
    const match49 = getChapterById('ch49');
    if (match49) return match49;
  }

  // ⑩ 環境急症 (CH44)
  const isEnv = /(熱中暑|中暑|熱衰竭|失溫|低體溫|高山症|潛水伕病|減壓病|雷擊|溺水)/i.test(fullText);
  if (isEnv) {
    const match44 = getChapterById('ch44');
    if (match44) return match44;
  }


  // 4. 章節標題關鍵字匹配
  for (const c of CHAPTER_CATALOG) {
    if (c.title && fullText.includes(c.title.toLowerCase())) {
      return getChapterById(c.id);
    }
  }

    // 兜底預設
  return { chId: 'ch01', num: 'CH01', chNum: 'CH01', title: '緊急醫療救護體系概論', chTitle: '緊急醫療救護體系概論' };
}

// ── 歷史題目與錯題本資料自動校正修復 ──
function sanitizeStoredQuizzes() {
  let dirtyWrong = false;

  // 1. 校驗並修復 state.wrongQuestions
  //   官方題（id 在 all_quizzes.json 裡）一律以題庫為準：章節、段落、頁碼、校正過的題目文字
  //   都直接覆蓋，不再跑關鍵字規則——舊版曾把「Patient-centered」當成小兒 PAT 而誤歸 CH48。
  const canon = new Map();
  (state.allQuizzes || []).forEach(c => { if (c && c.id && !c.isAiGenerated) canon.set(String(c.id), c); });
  const CANON_KEYS = ['question', 'options', 'answer', 'explanation', 'chId', 'chNum', 'chapter', 'chapterTitle',
                      'secIdx', 'secTitle', 'page', 'pdfPage', 'source', 'sourceLabel', 'year', 'qnum'];
  if (Array.isArray(state.wrongQuestions)) {
    state.wrongQuestions.forEach(q => {
      if (!q) return;
      const c = canon.get(String(q.id));
      if (c && !q.isAiGenerated) {
        CANON_KEYS.forEach(k => {
          if (c[k] !== undefined && JSON.stringify(q[k]) !== JSON.stringify(c[k])) { q[k] = c[k]; dirtyWrong = true; }
        });
        const title = c.chapterTitle || q.chTitle || '';
        if (q.chTitle !== title) { q.chTitle = title; dirtyWrong = true; }
        return;
      }
      const resolved = resolveQuestionChapter(q);
      if (q.chId !== resolved.chId || q.chTitle !== resolved.chTitle || q.chNum !== resolved.chNum) {
        q.chId = resolved.chId;
        q.chNum = resolved.chNum;
        q.chTitle = resolved.chTitle;
        q.chapterTitle = resolved.chTitle;
        dirtyWrong = true;
      }
    });
    if (dirtyWrong) {
      try {
        localStorage.setItem('m2_wrong_questions', JSON.stringify(state.wrongQuestions));
        console.log('已自動校正錯題本中的章節歸類與標籤。');
      } catch (e) {}
    }
  }

  // 2. 校驗並修復 m2_ai_chapter_quizzes
  let aiStored = [];
  try {
    aiStored = JSON.parse(localStorage.getItem('m2_ai_chapter_quizzes') || '[]');
  } catch (e) {
    aiStored = [];
  }
  let aiDirty = false;
  if (Array.isArray(aiStored) && aiStored.length > 0) {
    aiStored.forEach(q => {
      if (!q) return;
      const resolved = resolveQuestionChapter(q);
      if (q.chId !== resolved.chId || q.chTitle !== resolved.chTitle || q.chNum !== resolved.chNum) {
        q.chId = resolved.chId;
        q.chNum = resolved.chNum;
        q.chTitle = resolved.chTitle;
        q.chapterTitle = resolved.chTitle;
        aiDirty = true;
      }
    });
    if (aiDirty) {
      try {
        localStorage.setItem('m2_ai_chapter_quizzes', JSON.stringify(aiStored));
        console.log('已自動校正 AI 專項題庫中的章節歸類與標籤。');
      } catch (e) {}
    }
  }

  // 3. 同步校驗 state.allQuizzes 中 AI 題目
  if (Array.isArray(state.allQuizzes)) {
    state.allQuizzes.forEach(q => {
      if (!q || !q.isAiGenerated) return;
      const resolved = resolveQuestionChapter(q);
      q.chId = resolved.chId;
      q.chNum = resolved.chNum;
      q.chTitle = resolved.chTitle;
      q.chapterTitle = resolved.chTitle;
    });
  }
}

// ── 將 AI 題目自動歸檔至章節專項題庫 ──
function saveAiQuestionsToChapterPool(questions) {
  if (!Array.isArray(questions) || questions.length === 0) return 0;
  let stored = [];
  try {
    stored = JSON.parse(localStorage.getItem('m2_ai_chapter_quizzes') || '[]');
  } catch (e) {
    stored = [];
  }

  let addedCount = 0;
  questions.forEach(q => {
    if (!q || !q.question) return;
    const cleanQText = q.question.trim();
    // 依題幹去重，避免重複添加
    const alreadyExists = stored.some(item => item.question && item.question.trim() === cleanQText) ||
                          state.allQuizzes.some(item => item.question && item.question.trim() === cleanQText && item.isAiGenerated);
    if (!alreadyExists) {
      const resolved = resolveQuestionChapter(q);
      const newAiItem = {
        id: q.id || `ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        question: q.question,
        options: q.options,
        answer: q.answer,
        explanation: q.explanation || '依據教科書臨床指引解析。',
        difficulty: q.difficulty || '中等偏上',
        chId: resolved.chId,
        chNum: resolved.chNum,
        chTitle: resolved.chTitle,
        chapterTitle: resolved.chTitle,
        sourceLabel: '🤖 AI 精選',
        source: `AI 智慧出題 (${q.difficulty || '全真模擬'})`,
        isAiGenerated: true,
        addedAt: Date.now()
      };
      stored.unshift(newAiItem);
      state.allQuizzes.push(newAiItem);
      addedCount++;
    }
  });

  if (addedCount > 0) {
    try {
      localStorage.setItem('m2_ai_chapter_quizzes', JSON.stringify(stored));
      console.log(`成功將 ${addedCount} 道 AI 題目歸檔至章節題庫，總計 ${stored.length} 題。`);
    } catch (err) {
      console.warn('儲存 AI 題目至 localStorage 失敗:', err);
    }
  }
  return addedCount;
}

// ── AI 出題完成醒目彈出視窗控制 ──
function showAiCompleteModal(title, questions, topicDesc, diff) {
  const titleEl = $('#ai-complete-title');
  const topicEl = $('#ai-complete-topic');
  const diffEl = $('#ai-complete-diff');
  if (titleEl) titleEl.textContent = title;
  if (topicEl) {
    const cleanTopic = (topicDesc || '全科綜合').split('（')[0].replace('高級救護技術員(EMT-P)', '').trim();
    topicEl.textContent = cleanTopic.length > 12 ? cleanTopic.slice(0, 12) + '…' : cleanTopic;
  }
  if (diffEl) {
    diffEl.textContent = diff === 'expert' ? '教授級地獄挑戰' : '甄試全真 (40%中+60%難)';
  }
  const metaItems = $$('#ai-complete-modal .ai-meta-val');
  if (metaItems && metaItems.length >= 3) {
    metaItems[2].textContent = `精選 ${questions.length} 題`;
  }
  $('#ai-complete-modal')?.classList.remove('hidden');
  playSuccessBeep();
}

function closeAiCompleteModal() {
  $('#ai-complete-modal')?.classList.add('hidden');
}

function startCompletedAiQuiz() {
  closeAiCompleteModal();
  if (!state.pendingAiQuiz) return;
  const { title, questions } = state.pendingAiQuiz;
  state.pendingAiQuiz = null;
  clearAiReadyNotice();
  if (state.currentMode !== 2) switchMode(2);
  startM2Quiz('ai', title, questions);
}

async function generateAiQuiz() {
  if (!state.geminiApiKey) {
    alert('請先設定 Gemini API Key！');
    openApiModal();
    return;
  }
  if (state.aiGenInProgress) {
    // 已經有一份在背景生成中，避免重複發送請求；只把視窗切回生成中狀態。
    setAiGenModalUI(true);
    return;
  }

  const topicSelect = $('#ai-topic-select');
  const diffSelect = $('#ai-diff-select');
  const countSelect = $('#ai-count-select');
  const topic = topicSelect ? topicSelect.value : 'all';
  const diff = diffSelect ? diffSelect.value : 'high';
  const count = countSelect ? parseInt(countSelect.value, 10) || 10 : 10;
  const medCount = Math.max(1, Math.round(count * 0.4));
  const hardCount = count - medCount;

  state.aiGenInProgress = true;
  setAiGenModalUI(true);

  const topicMap = {
    all: '高級救護技術員(EMT-P)全科綜合（涵蓋心肺復甦、困難呼吸道、重大創傷、急性冠心症、腦中風、特殊急症、毒物與災難應變）',
    cardio: '心臟急症、致命性心律不整、12導程心電圖判定、心肌梗塞併發症與ACLS急救給藥時機',
    trauma: '重大創傷機轉、大失血休克處置、張力性氣胸減壓、骨盆固定與大量輸液低體溫防範',
    airway: '困難呼吸道評估與處置(LEMON/BURP)、氣管內插管與聲門上呼吸道(SGA)技術、正壓通氣參數設定',
    neuro: '神經急症、急性缺血性腦中風轉送準則(LVO/LAMS)、顱內壓上升處置與癲癇重積狀態',
    peds: '小兒急症評估(PAT)、新生兒復甦(NRP)、小兒嚴重氣喘及過敏性休克處置',
    toxic: '常見農藥有機磷中毒、一氧化碳中毒、毒藥物過量拮抗劑(Naloxone/Atropine)與環境急症'
  };

  const topicDesc = topicMap[topic] || topicMap.all;
  const diffDesc = (diff === 'expert')
    ? `教授級地獄挑戰：全卷 ${count} 題皆為極高難度，包含複合臨床情境、雙重陷阱、生理數值邊緣變動與處置邏輯先後抉擇，難度超越歷屆甄試。`
    : `甄試全真強度（依 4:6 配比共 ${count} 題）：\n` +
      `  - 第 1～${medCount} 題【中等難度】：評量核心法規、標準作業程序(SOP)、常規藥物劑量與基礎急救評估機轉。\n` +
      `  - 第 ${medCount + 1}～${count} 題【中等偏上甚至困難】：評量進階臨床決策、非典型症狀鑑別、高難度心電圖判讀、矛盾生命徵象的急救優先順序抉擇、特殊族群處置陷阱。`;

  const prompt = `你是一位具有20年急診醫學臨床專科與高級救護技術員(EMT-P)甄試命題委員經驗的資深醫學教授。
請依據台灣高級救護技術員教科書（大白第三版）及最新國際與台灣急救指引命題：
【主題】：${topicDesc}
【難易度】：${diffDesc}

【台灣高級救護技術員教科書（大白第三版）標準 60 章節權威對照表】：
CH01 緊急醫療救護體系概論, CH02 台灣緊急醫療救護體系, CH03 救護技術員的角色與責任, CH04 緊急醫療救護相關法律規範, CH05 救護技術員的職業安全與傳染病防治, CH06 救護技術員的心理衛生, CH07 緊急醫療救護派遣系統, CH08 社區層級的緊急醫療反應, CH09 緊急醫療救護的品質管理, CH10 緊急救護之新科技應用, CH11 救護技術員的科學思考基礎, CH12 人體基本解剖與生理, CH13 從出生到死亡：一生的成長與發展, CH14 呼吸道處置與通氣-原理篇, CH15 呼吸道處置與通氣-技術篇, CH16 緊急救護藥理學, CH17 藥物給予及給藥途徑, CH18 醫病關係與溝通技巧, CH19 病史詢問, CH20 身體診察, CH21 到院前超音波應用, CH22 病人評估與決策, CH23 基本生命支持與急救, CH24 復甦醫學新進展, CH25 外傷總論與重大外傷, CH26 出血、休克與止血治療, CH27 頭頸脊椎與顏面外傷, CH28 胸部外傷, CH29 腹骨盆部外傷, CH30 軟組織肌肉骨骼外傷與壓砸傷, CH31 灼傷與電灼害, CH32 特殊創傷族群及親密伴侶暴力, CH33 心電圖判定, CH34 心臟與血管急症, CH35 呼吸系統急症, CH36 神經系統急症與急性腦中風, CH37 內分泌與代謝急症, CH38 腸胃急症, CH39 血液與腫瘤急症, CH40 過敏與免疫急症, CH41 泌尿與腎臟急症, CH42 感染急症, CH43 新興傳染病與疫災防治, CH44 環境急症, CH45 野外醫學, CH46 行為急症與精神急症, CH47 高齡緊急救護概論, CH48 新生兒急救與小兒急症, CH49 婦產急症, CH50 毒物學, CH51 醫療管路、維生器材與常見的院內檢查, CH52 大量病人與災難應變, CH53 危害物質與核生化應變, CH54 大型活動之緊急醫療救護, CH55 運動賽事救護人員的角色與任務, CH56 高危情境或侷限空間病人之緊急醫療救護, CH57 常見天然災害, CH58 空中救護體系, CH59 緊急救護中的團隊資源管理, CH60 緊急救護技術的教學技巧。

【章節分類絕對嚴格要求（防呆規範）】：
1. 毒物、有機磷、沙林毒氣、Atropine、2-PAM、Naloxone、一氧化碳、化學毒物過量等題目【必須且只能歸為 CH50 毒物學】（若情境涉及化災熱區恐攻應變則為 CH53 危害物質與核生化應變）。【嚴禁將毒物題目誤標為 CH41 或 CH26】！
2. 創傷出血、止血帶、低容積休克、骨盆帶、大量輸血【必須歸為 CH26 出血、休克與止血治療】！
3. 泌尿急症、腎衰竭、透析、高血鉀【才是 CH41 泌尿與腎臟急症】！
4. 回傳之 chId、chNum、chTitle 必須完全精確符合上述 60 章標準名稱（例如 chId: "ch50", chNum: "CH50", chTitle: "毒物學"），不得隨意拼湊自創名稱（如不可自創「毒物急症」）！

【嚴格規則】：
1. 嚴格產出剛好「${count} 題」單選題。
2. 每題包含 4 個選項（A, B, C, D），單一正解。
3. 每題必須提供極為詳細的中文解析（解釋正解原因、各干擾選項錯誤點、關鍵生理機轉）。
4. 每題附上對應章節資訊（chId 例如 ch50, chNum 例如 CH50, chTitle 例如 毒物學）。
5. 回傳必須是純標準 JSON 陣列格式，嚴禁任何 markdown 包裝或多餘前言，直接以 [ 開頭、以 ] 結尾。
6. 難易度配比嚴格要求：
   - 若難易度為「甄試全真強度」，第 1～${medCount} 題必須為「中等」難度，第 ${medCount + 1}～${count} 題必須為「中等偏上」或「困難」難度。
   - 若難易度為「教授級地獄挑戰」，全部 ${count} 題皆為「困難」難度。
   - 每題 JSON 必須包含 "difficulty" 欄位，值為 "中等"、"中等偏上" 或 "困難"。
7. 章節分類與出處要求：每題必須精準歸屬至上述 60 章之一，詳解開頭包含【出處：大白 CHxx ...】以利系統依詳解自動歸入專項題庫。

JSON 陣列結構：
[
  {
    "question": "題目情境敘述...",
    "options": ["選項A", "選項B", "選項C", "選項D"],
    "answer": 0,
    "explanation": "詳細解析...",
    "difficulty": "中等",
    "chId": "ch50",
    "chNum": "CH50",
    "chTitle": "毒物學"
  }
]`;

  try {
    const candidateText = await callGeminiApi(prompt, true, state.geminiApiKey);

    const cleanJson = candidateText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleanJson);

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('AI 未能生成題目陣列，請重試！');
    }

    const validatedQuestions = parsed.map((item, idx) => {
      const resolved = resolveQuestionChapter(item);
      return {
        id: `ai-${Date.now()}-${idx + 1}`,
        question: item.question || `AI 題目 ${idx + 1}`,
        options: Array.isArray(item.options) && item.options.length >= 4 ? item.options.slice(0, 4) : ['選項A', '選項B', '選項C', '選項D'],
        answer: typeof item.answer === 'number' && item.answer >= 0 && item.answer <= 3 ? item.answer : 0,
        explanation: item.explanation || '依據教科書臨床指引解析。',
        difficulty: item.difficulty || (diff === 'expert' ? '困難' : (idx < medCount ? '中等' : '中等偏上')),
        chId: resolved.chId,
        chNum: resolved.chNum,
        chTitle: resolved.chTitle,
        chapterTitle: resolved.chTitle
      };
    }).slice(0, count);

    state.aiGenInProgress = false;
    const title = `🤖 AI 智慧出題 (${diff === 'expert' ? '地獄挑戰級' : '甄試全真強度'} ‧ ${validatedQuestions.length}題)`;

    // 關閉出題等待視窗並重置表單按鈕
    closeAiQuizModal();
    setAiGenModalUI(false);

    // 保存待測資料並點亮紅點/大廳橫幅
    state.pendingAiQuiz = { title, questions: validatedQuestions };
    showAiReadyNotice();

    // 直接彈出醒目的「完成彈出視窗」
    showAiCompleteModal(title, validatedQuestions, topicDesc, diff);

  } catch (err) {
    console.error('AI Quiz Generation failed:', err);
    state.aiGenInProgress = false;
    const modalVisible = !$('#m2-ai-modal')?.classList.contains('hidden');
    setAiGenModalUI(false);
    if (modalVisible) {
      alert(`AI 出題失敗：${err.message}\n請檢查 API Key 或網路連線後重試！`);
    } else {
      // 使用者已縮小視窗去複習，避免用 alert 打斷閱讀，改用 console 記錄，
      // 下次打開 AI 出題視窗時可再重新嘗試。
      console.warn('背景 AI 出題失敗:', err.message);
    }
  }
}

// ── 功能四：錯題本 & AI 核心觀念弱點診斷 ──────────────
function openWrongBookView() {
  sanitizeStoredQuizzes();
  showM2Subview('m2-wrong-book');
  renderWrongBookContent();
}

function renderWrongBookContent() {
  const listEl = $('#m2-wb-list');
  const tagsEl = $('#m2-wb-tags');
  const countEl = $('#m2-wb-count-text');
  const filterSelect = $('#m2-wb-filter-select');

  if (countEl) countEl.textContent = `共 ${state.wrongQuestions.length} 道錯題`;

  // 計算章節錯題分佈
  const chCounts = {};
  state.wrongQuestions.forEach(q => {
    const key = `${q.chNum || 'CH??'} ${q.chTitle || '未分類'}`;
    chCounts[key] = (chCounts[key] || 0) + 1;
  });

  // 渲染章節統計標籤
  if (tagsEl) {
    tagsEl.innerHTML = '';
    const sortedChs = Object.entries(chCounts).sort((a, b) => b[1] - a[1]);
    if (sortedChs.length === 0) {
      tagsEl.innerHTML = '<span style="color:var(--text-muted);font-size:0.85rem">目前尚無錯題紀錄，快去測驗自我挑戰吧！</span>';
    } else {
      sortedChs.forEach(([chName, cnt]) => {
        const tag = document.createElement('div');
        tag.className = 'wb-ch-tag';
        tag.innerHTML = `
          <span>${escapeHtml(chName)}</span>
          <span class="wb-ch-tag-badge">${cnt}</span>
        `;
        tag.addEventListener('click', () => {
          if (filterSelect) {
            filterSelect.value = chName;
            filterWrongBook();
          }
        });
        tagsEl.appendChild(tag);
      });
    }
  }

  // 更新篩選下拉清單
  if (filterSelect) {
    const currentVal = filterSelect.value;
    filterSelect.innerHTML = '<option value="all">全部章節錯題</option>';
    Object.keys(chCounts).sort().forEach(chName => {
      const opt = document.createElement('option');
      opt.value = chName;
      opt.textContent = `${chName} (${chCounts[chName]}題)`;
      filterSelect.appendChild(opt);
    });
    if (chCounts[currentVal]) filterSelect.value = currentVal;
    else filterSelect.value = 'all';
  }

  filterWrongBook();
}

function filterWrongBook() {
  const filterSelect = $('#m2-wb-filter-select');
  const filterVal = filterSelect ? filterSelect.value : 'all';
  const listEl = $('#m2-wb-list');
  if (!listEl) return;

  const filtered = (filterVal === 'all')
    ? state.wrongQuestions
    : state.wrongQuestions.filter(q => `${q.chNum || 'CH??'} ${q.chTitle || '未分類'}` === filterVal);

  listEl.innerHTML = '';
  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div style="text-align:center;padding:40px;color:var(--text-muted)">
        <div style="font-size:2rem;margin-bottom:8px">🎉</div>
        <div>此分類目前沒有任何錯題！</div>
      </div>
    `;
    return;
  }

  const letters = ['A', 'B', 'C', 'D'];
  filtered.forEach((q) => {
    const card = document.createElement('div');
    card.className = 'm2-wb-card';

    let optionsHtml = '';
    (q.options || []).forEach((optText, optIdx) => {
      const isCorrect = (optIdx === q.answer);
      optionsHtml += `
        <div class="m2-rev-opt ${isCorrect ? 'is-correct-answer' : ''}" style="margin-bottom:6px">
          <b>(${letters[optIdx]})</b>
          <span>${escapeHtml(cleanOptionText(optText))}</span>
          ${isCorrect ? '<b style="color:var(--success);margin-left:auto">(正確答案)</b>' : ''}
        </div>
      `;
    });

    card.innerHTML = `
      <div class="m2-wb-card-top">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="m2-qtag ch">${escapeHtml(q.chNum || '')} ${escapeHtml(q.chTitle || '')}</span>
          <span style="font-size:0.75rem;color:var(--text-muted)">
            ${q.timestamp ? new Date(q.timestamp).toLocaleDateString() : ''}
          </span>
        </div>
        <button class="wb-del-btn" onclick="deleteWrongQuestion('${q.id}')">🗑️ 移出錯題本</button>
      </div>
      <div class="m2-qtext" style="font-size:1.02rem;margin-bottom:12px">${escapeHtml(q.question)}</div>
      ${q.image ? `
        <div class="m2-qimage-wrap">
          <div class="m2-qimage-box" onclick="openImageModal('${escapeHtml(q.image)}')">
            <img src="${escapeHtml(q.image)}" alt="題目心電圖/附圖" class="m2-qimage">
            <div class="m2-qimage-hint">🔍 點擊圖片可放大檢視心電圖細節</div>
          </div>
        </div>` : ''}
      <div class="m2-rev-options" style="margin:10px 0">
        ${optionsHtml}
      </div>
      <div class="review-expl-box" style="margin-top:10px">
        <div class="review-expl-header">
          <span class="review-expl-title">💡 考點速記：</span>
          <button type="button" class="toggle-full-expl-btn" onclick="toggleFullExpl(this)">
            📖 展開完整解析
          </button>
        </div>
        <div class="brief-expl-text">${escapeHtml(getBriefExplanation(q))}</div>
        <div class="full-expl-container" style="display:none">
          <div class="full-expl-divider"></div>
          <div class="full-expl-title">📋 完整教材／法規詳解：</div>
          ${renderQuizPageLine(q)}
          <div class="full-expl-content">${escapeHtml(q.explanation || '暫無完整解析')}</div>
        </div>
      </div>
      <div style="margin-top:12px">
      ${renderTextbookDetails(q)}
      </div>
    `;
    listEl.appendChild(card);
    if (!q.page && q.chId) resolveQuestionSection(q);   // AI 題：補齊段落與教科書頁碼
  });
}

function deleteWrongQuestion(id) {
  state.wrongQuestions = state.wrongQuestions.filter(q => q.id !== id);
  localStorage.setItem('m2_wrong_questions', JSON.stringify(state.wrongQuestions));
  renderWrongBookContent();
  updateM2LobbyStats();
}

function clearAllWrongQuestions() {
  if (state.wrongQuestions.length === 0) return;
  if (confirm('確定要清空錯題本中的所有題目嗎？此動作無法復原。')) {
    state.wrongQuestions = [];
    localStorage.setItem('m2_wrong_questions', JSON.stringify(state.wrongQuestions));
    renderWrongBookContent();
    updateM2LobbyStats();
  }
}

function startWrongQuiz() {
  if (state.wrongQuestions.length === 0) {
    alert('錯題本目前空空如也！請先進行測驗挑戰或手動新增題目。');
    return;
  }
  const shuffled = [...state.wrongQuestions].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 10);
  startM2Quiz('wrong', `⚡ 錯題重測 (共 ${selected.length} 題)`, selected);
}

// ── 手動新增題目彈窗 ──────────────────────────────────
function openManualAddModal() {
  const select = $('#madd-chapter');
  if (select && select.children.length === 0) {
    state.chapters.forEach(ch => {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = `${ch.num} ${ch.title}`;
      select.appendChild(opt);
    });
  }
  $('#madd-question').value = '';
  $('#madd-opt-0').value = '';
  $('#madd-opt-1').value = '';
  $('#madd-opt-2').value = '';
  $('#madd-opt-3').value = '';
  $('#madd-explanation').value = '';
  $('#manual-add-modal')?.classList.remove('hidden');
}

function closeManualAddModal() {
  $('#manual-add-modal')?.classList.add('hidden');
}

function saveManualQuestion() {
  const chId = $('#madd-chapter').value || 'ch01';
  const chObj = state.chapters.find(c => c.id === chId) || { num: 'CH01', title: '概論' };
  const question = $('#madd-question').value.trim();
  const opt0 = $('#madd-opt-0').value.trim();
  const opt1 = $('#madd-opt-1').value.trim();
  const opt2 = $('#madd-opt-2').value.trim();
  const opt3 = $('#madd-opt-3').value.trim();
  const answer = parseInt($('#madd-answer').value, 10) || 0;
  const explanation = $('#madd-explanation').value.trim();

  if (!question) {
    alert('請輸入題目題幹敘述！');
    return;
  }
  if (!opt0 || !opt1) {
    alert('至少需要填寫選項 (A) 與 (B)！');
    return;
  }

  const newQ = {
    id: `custom-${Date.now()}`,
    question: question,
    options: [opt0, opt1, opt2 || '—', opt3 || '—'],
    answer: answer,
    explanation: explanation || '自訂錯題重點紀錄。',
    chId: chId,
    chNum: chObj.num,
    chTitle: chObj.title,
    timestamp: Date.now()
  };

  state.wrongQuestions.unshift(newQ);
  localStorage.setItem('m2_wrong_questions', JSON.stringify(state.wrongQuestions));

  closeManualAddModal();
  renderWrongBookContent();
  updateM2LobbyStats();
  alert('已成功新增題目至錯題本！');
}

// ── AI 弱點診斷 (幫我統整我有哪個部份的核心觀念沒有明白) ──
async function runAiWeaknessAnalysis() {
  if (state.wrongQuestions.length === 0) {
    alert('錯題本中目前沒有題目，請先進行測驗以累積錯題！');
    return;
  }
  if (!state.geminiApiKey) {
    alert('AI 弱點診斷需要 Google Gemini API Key，請先設定！');
    openApiModal();
    return;
  }

  const diagCard = $('#m2-ai-diagnosis-card');
  const diagBody = $('#m2-diag-body');
  if (diagCard) diagCard.classList.remove('hidden');
  if (diagBody) {
    diagBody.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;color:var(--blue);padding:14px 0">
        <div class="spinner" style="width:22px;height:22px;border-width:2.5px"></div>
        <span>醫學教授 AI 正全面審查您的錯題紀錄，診斷核心觀念盲點中…</span>
      </div>
    `;
  }

  const sampleWrong = state.wrongQuestions.slice(0, 15).map((q, i) => {
    return `${i + 1}. [${q.chNum} ${q.chTitle}] 題目：${q.question.slice(0, 70)}... 正解關鍵：${(q.explanation || '').slice(0, 80)}`;
  }).join('\n');

  const prompt = `你是一位擁有20年急診醫學專科與高級救護技術員(EMT-P)國家甄試培訓經驗的資深醫學教授。
學生目前在題庫測驗中累積了 ${state.wrongQuestions.length} 道錯題，以下是近期最具代表性的錯題清單：
${sampleWrong}

請針對學生的錯題情況，進行一場深刻、專業且條理清晰的【核心觀念弱點剖析與臨床思維診斷】：
1. 🎯【核心觀念盲點統整】：歸納出學生究竟在哪些核心生理病理機轉（如代償機轉、心電圖傳導、通氣與酸鹼平衡）、藥物作用/禁忌症，或情境先後處置流程上「沒有完全理解」？
2. ⚠️【臨床陷阱與易混淆考點】：點出學生最容易踩中的甄試陷阱與思維誤區。
3. 📖【各章節複習與強化清單】：明確列出建議優先重點複習的教科書章節與具體複習指引。
4. 💡【教授勉勵與應試叮嚀】。

請直接使用繁體中文回覆，段落分明，重點標題清楚，排版親切易讀。`;

  try {
    const replyText = await callGeminiApi(prompt, false, state.geminiApiKey);

    const formattedHtml = replyText
      .replace(/^### (.*$)/gim, '<h4 style="margin:12px 0 6px;color:var(--orange)">$1</h4>')
      .replace(/^## (.*$)/gim, '<h3 style="margin:14px 0 8px;color:var(--blue)">$1</h3>')
      .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
      .replace(/^\* (.*$)/gim, '• $1<br>')
      .replace(/^- (.*$)/gim, '• $1<br>')
      .replace(/\n\n/g, '<br><br>');

    if (diagBody) {
      diagBody.innerHTML = `
        <div style="line-height:1.8;font-size:0.93rem">
          ${formattedHtml}
        </div>
      `;
    }
  } catch (err) {
    console.error('AI diagnosis error:', err);
    if (diagBody) {
      diagBody.innerHTML = `<span style="color:var(--error)">診斷生成失敗：${escapeHtml(err.message)}。請確認 API Key 與網路連線後再試。</span>`;
    }
  }
}

function closeDiagCard() {
  $('#m2-ai-diagnosis-card')?.classList.add('hidden');
}

function retryCurrentQuizType() {
  const type = state.m2Runner.type;
  if (type === 'past') startPastExamQuiz();
  else if (type === 'chapter') openChapterQuizModal();
  else if (type === 'ai') openAiQuizModal();
  else if (type === 'wrong') startWrongQuiz();
  else startPastExamQuiz();
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── Expose globals for inline handlers ────────────────
window.openSearchHit = openSearchHit;
window.answerInlineQuiz = answerInlineQuiz;
window.resetInlineQuiz = resetInlineQuiz;
window.loadTextbook = loadTextbook;
window.selectChapter = selectChapter;
window.prevChapter = prevChapter;
window.nextChapter = nextChapter;
window.switchTab = switchTab;
window.closeProgressModal = closeProgressModal;
window.openProgressModal = openProgressModal;
window.toggleReadStatus = toggleReadStatus;
window.resetAllChaptersToUnread = resetAllChaptersToUnread;
window.markAllChaptersRead = markAllChaptersRead;
window.closeMobileSidebar = closeMobileSidebar;

// Mode 2 Globals
window.switchMode = switchMode;
window.showM2Subview = showM2Subview;
window.returnToLobby = returnToLobby;
window.openApiModal = openApiModal;
window.closeApiModal = closeApiModal;
window.saveApiKey = saveApiKey;
window.clearApiKey = clearApiKey;
window.openAiQuizModal = openAiQuizModal;
window.closeAiQuizModal = closeAiQuizModal;
window.generateAiQuiz = generateAiQuiz;
window.startPastExamQuiz = startPastExamQuiz;
window.openChapterQuizModal = openChapterQuizModal;
window.closeChapterQuizModal = closeChapterQuizModal;
window.selectAllChapters = selectAllChapters;
window.selectPresetChapters = selectPresetChapters;
window.updateChSelectCount = updateChSelectCount;
window.startSelectedChapterQuiz = startSelectedChapterQuiz;
window.openWrongBookView = openWrongBookView;
window.prevRunnerQ = prevRunnerQ;
window.nextRunnerQ = nextRunnerQ;
window.confirmQuitQuiz = confirmQuitQuiz;
window.submitRunnerQuiz = submitRunnerQuiz;
window.retryCurrentQuizType = retryCurrentQuizType;
window.jumpToMode1Chapter = jumpToMode1Chapter;
window.openManualAddModal = openManualAddModal;
window.closeManualAddModal = closeManualAddModal;
window.saveManualQuestion = saveManualQuestion;
window.runAiWeaknessAnalysis = runAiWeaknessAnalysis;
window.closeDiagCard = closeDiagCard;
window.filterWrongBook = filterWrongBook;
window.deleteWrongQuestion = deleteWrongQuestion;
window.clearAllWrongQuestions = clearAllWrongQuestions;
window.startWrongQuiz = startWrongQuiz;

// ── PWA Install Prompt (no Service Worker — app is plain static, always network-fresh) ──
let deferredInstallPrompt = null;

function initPwaInstallPrompt() {
  // Detect Android Chrome install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const promptContainer = document.getElementById('pwa-android-prompt');
    if (promptContainer) {
      promptContainer.classList.remove('hidden');
    }
  });

  window.addEventListener('appinstalled', () => {
    console.log('[PWA] App installed successfully');
    deferredInstallPrompt = null;
    closePwaInstallModal();
  });
}

function openPwaInstallModal() {
  closeMobileSidebar();
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isStandalone) {
    alert('恭喜！您目前已經在使用獨立 App 模式瀏覽。');
    return;
  }
  const modal = document.getElementById('pwa-install-modal');
  if (modal) {
    modal.classList.remove('hidden');
  }
}

function closePwaInstallModal() {
  const modal = document.getElementById('pwa-install-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

function triggerNativeInstall() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then((choiceResult) => {
      if (choiceResult.outcome === 'accepted') {
        console.log('[PWA] User accepted installation');
      } else {
        console.log('[PWA] User dismissed installation');
      }
      deferredInstallPrompt = null;
      closePwaInstallModal();
    });
  } else {
    alert('【安裝至主畫面提示】\n• 三星瀏覽器 (Samsung)：請點右下角「☰」選單 ➔「新增頁面至」➔「主螢幕」，或看網址列最右邊有無「⤓」\n• Chrome：請點右上角「⋮」選單 ➔「加到主畫面」\n• iPhone Safari：請點底部「📤」分享 ➔「加入主畫面」');
  }
}

window.openPwaInstallModal = openPwaInstallModal;
window.closePwaInstallModal = closePwaInstallModal;
window.triggerNativeInstall = triggerNativeInstall;

// ── Image Lightbox Modal ──────────────────────────────
function openImageModal(src) {
  if (!src) return;
  const modal = document.getElementById('image-modal');
  const img = document.getElementById('image-modal-img');
  if (modal && img) {
    img.src = src;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
}

function closeImageModal() {
  const modal = document.getElementById('image-modal');
  if (modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }
}

window.openImageModal = openImageModal;
window.closeImageModal = closeImageModal;

// ── Chapter Podcast Player (Dual-Mode: MP3 / Web Speech) ──
const podcastPlayer = {
  currentChId: null,
  isPlaying: false,
  mode: 'speech', // 'audio' (mp3 file) | 'speech' (Web Speech API)
  speed: parseFloat(localStorage.getItem('podcast_speed') || '1.0'),
  speeds: [1.0, 1.25, 1.5, 2.0],
  audioEl: null,
  speechSynth: window.speechSynthesis || null,
  speechUtterance: null,
  speechText: '',
  progressTimer: null,
  virtualCurrentTime: 0,
  virtualDuration: 180,

  init(chId, chapterData) {
    this.stop();
    this.currentChId = chId;
    this.audioEl = document.getElementById('chapter-audio-el');
    this.virtualCurrentTime = 0;
    this.updateSpeedUI();

    // Check if MP3 file exists
    const mp3Url = dataUrl(`audio/podcasts/${chId}.mp3`);
    if (this.audioEl) {
      this.audioEl.src = mp3Url;
      this.audioEl.playbackRate = this.speed;

      this.audioEl.onloadedmetadata = () => {
        this.mode = 'audio';
        const tag = document.getElementById('podcast-mode-tag');
        if (tag) tag.textContent = 'MP3 原聲廣播';
        const sub = document.getElementById('podcast-subtitle-text');
        if (sub) sub.textContent = 'NotebookLM 雙人深度對談原聲錄音';
        const dur = document.getElementById('podcast-time-dur');
        if (dur) dur.textContent = this.formatTime(this.audioEl.duration);
      };

      this.audioEl.onerror = () => {
        this.mode = 'speech';
        const tag = document.getElementById('podcast-mode-tag');
        if (tag) tag.textContent = 'AI 智慧語音';
        const sub = document.getElementById('podcast-subtitle-text');
        if (sub) sub.textContent = 'AI 臨床重點精華快讀導讀電台';
      };

      this.audioEl.ontimeupdate = () => {
        if (this.mode === 'audio' && this.isPlaying) {
          this.updateAudioProgress();
        }
      };

      this.audioEl.onended = () => {
        this.stop();
      };
    }

    this.prepareSpeechScript(chapterData);
  },

  prepareSpeechScript(cd) {
    if (!cd) return;
    const parts = [];
    parts.push(`歡迎收聽高級救護技術員重點導讀電台。今天我們來探討 ${cd.num}，${cd.title}。`);
    
    if (cd.learningGoals && cd.learningGoals.length) {
      parts.push(`本章學習目標包含：${cd.learningGoals.slice(0, 4).join('。')}。`);
    }

    if (cd.keywords && cd.keywords.length) {
      const kwList = cd.keywords.slice(0, 5).map(k => `${k.zh}，也就是 ${k.en || ''}，定義是：${k.def || ''}`).join('。');
      parts.push(`在核心觀念部分，必須掌握的專有名詞有：${kwList}。`);
    }

    if (cd.content && cd.content.length) {
      const orangeSections = cd.content.filter(b => b.type === 'orange' && !['情境', '解答', '複習思考題'].includes(b.text)).map(b => b.text);
      if (orangeSections.length) {
        parts.push(`本章主要核心大綱分為：${orangeSections.slice(0, 5).join('、')}。請在複習時特別注意各環節的臨床處置順序與鑑別重點。`);
      }
    }

    parts.push(`以上是 ${cd.num} 的核心重點快讀，祝您複習順利！`);
    this.speechText = parts.join('\n');
    this.virtualDuration = Math.max(60, Math.round(this.speechText.length / 4));
    const dur = document.getElementById('podcast-time-dur');
    if (dur && this.mode === 'speech') {
      dur.textContent = this.formatTime(this.virtualDuration);
    }
  },

  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  },

  play() {
    if (this.mode === 'audio' && this.audioEl && this.audioEl.src && !this.audioEl.error) {
      this.audioEl.playbackRate = this.speed;
      this.audioEl.play().then(() => {
        this.setPlayingState(true);
      }).catch(() => {
        this.mode = 'speech';
        this.playSpeech();
      });
    } else {
      this.playSpeech();
    }
  },

  playSpeech() {
    if (!this.speechSynth) {
      alert('您的瀏覽器不支援語音合成功能，建議使用 Chrome 或 Safari 瀏覽器。');
      return;
    }

    if (this.speechSynth.paused) {
      this.speechSynth.resume();
      this.setPlayingState(true);
      this.startVirtualTimer();
      return;
    }

    this.speechSynth.cancel();
    const ratio = this.virtualDuration > 0 ? (this.virtualCurrentTime / this.virtualDuration) : 0;
    const startChar = Math.floor(this.speechText.length * ratio);
    const textToSpeak = this.speechText.slice(startChar) || this.speechText;

    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    utterance.lang = 'zh-TW';
    utterance.rate = this.speed;

    const voices = this.speechSynth.getVoices();
    const twVoice = voices.find(v => v.lang === 'zh-TW' || v.lang === 'zh_TW') ||
                    voices.find(v => v.lang.startsWith('zh'));
    if (twVoice) utterance.voice = twVoice;

    utterance.onend = () => {
      this.stop();
    };

    utterance.onerror = () => {
      this.stop();
    };

    this.speechUtterance = utterance;
    this.speechSynth.speak(utterance);
    this.setPlayingState(true);
    this.startVirtualTimer();
  },

  pause() {
    if (this.mode === 'audio' && this.audioEl) {
      this.audioEl.pause();
    } else if (this.speechSynth) {
      this.speechSynth.pause();
    }
    this.setPlayingState(false);
    this.stopVirtualTimer();
  },

  stop() {
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.currentTime = 0;
    }
    if (this.speechSynth) {
      this.speechSynth.cancel();
    }
    this.setPlayingState(false);
    this.stopVirtualTimer();
    this.virtualCurrentTime = 0;
    this.updateProgressUI(0, this.mode === 'audio' && this.audioEl?.duration ? this.audioEl.duration : this.virtualDuration);
  },

  setPlayingState(isPlaying) {
    this.isPlaying = isPlaying;
    const card = document.getElementById('chapter-podcast-card');
    const playBtn = document.getElementById('podcast-play-btn');
    if (card) {
      card.classList.toggle('is-playing', isPlaying);
    }
    if (playBtn) {
      playBtn.textContent = isPlaying ? '⏸' : '▶';
    }
  },

  skip(seconds) {
    if (this.mode === 'audio' && this.audioEl) {
      this.audioEl.currentTime = Math.max(0, Math.min(this.audioEl.duration || 0, this.audioEl.currentTime + seconds));
      this.updateAudioProgress();
    } else {
      this.virtualCurrentTime = Math.max(0, Math.min(this.virtualDuration, this.virtualCurrentTime + seconds));
      this.updateProgressUI(this.virtualCurrentTime, this.virtualDuration);
      if (this.isPlaying && this.speechSynth) {
        this.playSpeech();
      }
    }
  },

  onSeekInput(val) {
    const ratio = parseFloat(val) / 100;
    const duration = this.mode === 'audio' && this.audioEl?.duration ? this.audioEl.duration : this.virtualDuration;
    const curSpan = document.getElementById('podcast-time-cur');
    if (curSpan) curSpan.textContent = this.formatTime(duration * ratio);
  },

  onSeekChange(val) {
    const ratio = parseFloat(val) / 100;
    const duration = this.mode === 'audio' && this.audioEl?.duration ? this.audioEl.duration : this.virtualDuration;
    const targetTime = duration * ratio;
    if (this.mode === 'audio' && this.audioEl) {
      this.audioEl.currentTime = targetTime;
    } else {
      this.virtualCurrentTime = targetTime;
      if (this.isPlaying && this.speechSynth) {
        this.playSpeech();
      }
    }
  },

  cycleSpeed() {
    const idx = this.speeds.indexOf(this.speed);
    const nextIdx = (idx + 1) % this.speeds.length;
    this.speed = this.speeds[nextIdx];
    localStorage.setItem('podcast_speed', this.speed.toString());
    this.updateSpeedUI();
    if (this.mode === 'audio' && this.audioEl) {
      this.audioEl.playbackRate = this.speed;
    } else if (this.isPlaying && this.speechSynth) {
      this.playSpeech();
    }
  },

  updateSpeedUI() {
    const btn = document.getElementById('podcast-speed-btn');
    if (btn) btn.textContent = `${this.speed}x`;
  },

  startVirtualTimer() {
    this.stopVirtualTimer();
    this.progressTimer = setInterval(() => {
      this.virtualCurrentTime += 0.5 * this.speed;
      if (this.virtualCurrentTime >= this.virtualDuration) {
        this.stop();
      } else {
        this.updateProgressUI(this.virtualCurrentTime, this.virtualDuration);
      }
    }, 500);
  },

  stopVirtualTimer() {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  },

  updateAudioProgress() {
    if (!this.audioEl) return;
    this.updateProgressUI(this.audioEl.currentTime, this.audioEl.duration || 1);
  },

  updateProgressUI(current, total) {
    const scrubber = document.getElementById('podcast-scrubber');
    const curSpan = document.getElementById('podcast-time-cur');
    const durSpan = document.getElementById('podcast-time-dur');
    if (scrubber && total > 0) {
      scrubber.value = ((current / total) * 100).toFixed(1);
    }
    if (curSpan) curSpan.textContent = this.formatTime(current);
    if (durSpan && total > 0) durSpan.textContent = this.formatTime(total);
  },

  formatTime(secs) {
    if (!secs || isNaN(secs)) return '00:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
};

window.podcastPlayer = podcastPlayer;

// ── Chapter Mindmap Modal Controller (Zoom & Pan Lightbox) ──
const mindmapViewer = {
  scale: 1,
  translateX: 0,
  translateY: 0,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
  initialPinchDist: 0,
  initialPinchScale: 1
};

function updateMindmapTransform() {
  const wrapper = document.getElementById('mindmap-transform-wrapper');
  const label = document.getElementById('mindmap-zoom-label');
  if (wrapper) {
    wrapper.style.transform = `translate(${mindmapViewer.translateX}px, ${mindmapViewer.translateY}px) scale(${mindmapViewer.scale})`;
  }
  if (label) {
    label.textContent = `${Math.round(mindmapViewer.scale * 100)}%`;
  }
}

function openMindmapModal(chId, title) {
  if (!chId) return;
  const modal = document.getElementById('mindmap-modal');
  const img = document.getElementById('mindmap-modal-img');
  const titleText = document.getElementById('mindmap-modal-title-text');
  if (!modal || !img) return;

  if (titleText) titleText.textContent = `${title || chId} 核心架構圖譜`;
  img.src = dataUrl(`images/mindmaps/${chId}.svg`);

  // Reset zoom & pan state
  mindmapViewer.scale = 1;
  mindmapViewer.translateX = 0;
  mindmapViewer.translateY = 0;
  mindmapViewer.isDragging = false;
  updateMindmapTransform();

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  initMindmapInteractions();
}

function closeMindmapModal() {
  const modal = document.getElementById('mindmap-modal');
  if (modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
}

function mindmapZoomIn() {
  mindmapViewer.scale = Math.min(4.0, Number((mindmapViewer.scale * 1.25).toFixed(2)));
  updateMindmapTransform();
}

function mindmapZoomOut() {
  mindmapViewer.scale = Math.max(0.4, Number((mindmapViewer.scale / 1.25).toFixed(2)));
  updateMindmapTransform();
}

function mindmapResetZoom() {
  mindmapViewer.scale = 1;
  mindmapViewer.translateX = 0;
  mindmapViewer.translateY = 0;
  updateMindmapTransform();
}

function mindmapToggleFullscreen() {
  const modal = document.getElementById('mindmap-modal');
  if (!modal) return;
  if (!document.fullscreenElement) {
    modal.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

let mindmapEventsBound = false;
function initMindmapInteractions() {
  if (mindmapEventsBound) return;
  const container = document.getElementById('mindmap-canvas-container');
  if (!container) return;

  mindmapEventsBound = true;

  // 1. 滑鼠拖曳平移 (Mouse Drag)
  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    mindmapViewer.isDragging = true;
    mindmapViewer.dragStartX = e.clientX - mindmapViewer.translateX;
    mindmapViewer.dragStartY = e.clientY - mindmapViewer.translateY;
    container.classList.add('is-dragging');
  });

  window.addEventListener('mousemove', (e) => {
    if (!mindmapViewer.isDragging) return;
    mindmapViewer.translateX = e.clientX - mindmapViewer.dragStartX;
    mindmapViewer.translateY = e.clientY - mindmapViewer.dragStartY;
    updateMindmapTransform();
  });

  window.addEventListener('mouseup', () => {
    if (mindmapViewer.isDragging) {
      mindmapViewer.isDragging = false;
      const c = document.getElementById('mindmap-canvas-container');
      if (c) c.classList.remove('is-dragging');
    }
  });

  // 2. 滑鼠滾輪縮放 (Mouse Wheel Zoom)
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.88;
    const newScale = Math.min(4.0, Math.max(0.4, mindmapViewer.scale * factor));
    mindmapViewer.scale = Number(newScale.toFixed(2));
    updateMindmapTransform();
  }, { passive: false });

  // 3. 手機觸控操作 (單指拖曳平移、雙指捏合縮放 Pinch-to-zoom)
  let lastTouchX = 0;
  let lastTouchY = 0;

  function getTouchDistance(e) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  container.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      mindmapViewer.isDragging = true;
      lastTouchX = e.touches[0].clientX;
      lastTouchY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      mindmapViewer.isDragging = false;
      mindmapViewer.initialPinchDist = getTouchDistance(e);
      mindmapViewer.initialPinchScale = mindmapViewer.scale;
    }
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && mindmapViewer.isDragging) {
      const dx = e.touches[0].clientX - lastTouchX;
      const dy = e.touches[0].clientY - lastTouchY;
      mindmapViewer.translateX += dx;
      mindmapViewer.translateY += dy;
      lastTouchX = e.touches[0].clientX;
      lastTouchY = e.touches[0].clientY;
      updateMindmapTransform();
    } else if (e.touches.length === 2 && mindmapViewer.initialPinchDist > 0) {
      const dist = getTouchDistance(e);
      const ratio = dist / mindmapViewer.initialPinchDist;
      mindmapViewer.scale = Math.min(4.0, Math.max(0.4, Number((mindmapViewer.initialPinchScale * ratio).toFixed(2))));
      updateMindmapTransform();
    }
  }, { passive: true });

  container.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) {
      mindmapViewer.isDragging = false;
      mindmapViewer.initialPinchDist = 0;
    } else if (e.touches.length === 1) {
      lastTouchX = e.touches[0].clientX;
      lastTouchY = e.touches[0].clientY;
      mindmapViewer.isDragging = true;
      mindmapViewer.initialPinchDist = 0;
    }
  }, { passive: true });
}

window.openMindmapModal = openMindmapModal;
window.closeMindmapModal = closeMindmapModal;
window.mindmapZoomIn = mindmapZoomIn;
window.mindmapZoomOut = mindmapZoomOut;
window.mindmapResetZoom = mindmapResetZoom;
window.mindmapToggleFullscreen = mindmapToggleFullscreen;

// ── 行動端橫向全螢幕沉浸閱讀控制器 ──
//   手機橫向（高度 ≤ 500px）時，模式一、模式二的頂欄與側欄一律收起，
//   只有「從螢幕頂緣下拉」「內容已在最頂端再往下拉」或「點中央手柄」才會出現；
//   往下閱讀捲動就自動收回。不會因為捲回頂端或往上捲而自己跳出來。
function isMobileLandscape() {
  return window.matchMedia('(orientation: landscape) and (max-height: 500px)').matches;
}

function toggleLandscapeHeader(forceState) {
  const isOpen = (typeof forceState === 'boolean')
    ? forceState
    : !document.body.classList.contains('landscape-header-open');

  document.body.classList.toggle('landscape-header-open', isOpen);

  const iconEl = document.getElementById('landscape-pull-icon');
  const textEl = document.getElementById('landscape-pull-text');
  if (iconEl) iconEl.textContent = isOpen ? '▲' : '▼';
  if (textEl) textEl.textContent = isOpen ? '收起' : '選單';
}

function initLandscapeController() {
  // 模式一捲的是 #main-content，模式二捲的是 #mode2-container
  const scrollers = [document.getElementById('main-content'), document.getElementById('mode2-container')].filter(Boolean);
  const activeScroller = () => scrollers.find(el => el.offsetParent !== null) || scrollers[0];

  // 1. 往下閱讀捲動：自動收起（往上捲不會自動展開）
  let lastScrollTop = 0;
  let scrollTicking = false;
  scrollers.forEach(el => el.addEventListener('scroll', () => {
    if (!isMobileLandscape()) return;
    if (!scrollTicking) {
      window.requestAnimationFrame(() => {
        const st = el.scrollTop;
        if (st > lastScrollTop + 15 && st > 40) toggleLandscapeHeader(false);
        lastScrollTop = Math.max(0, st);
        scrollTicking = false;
      });
      scrollTicking = true;
    }
  }, { passive: true }));

  // 2. 下拉手勢：從螢幕頂緣 60px 內往下拖，或內容已在最頂端時再往下拉 → 喚出選單
  let touchStartY = 0, touchStartX = 0, touchAtTop = false, touchHandled = false;
  window.addEventListener('touchstart', (e) => {
    if (!isMobileLandscape()) return;
    const t = e.touches[0];
    if (!t) return;
    touchStartY = t.clientY;
    touchStartX = t.clientX;
    const sc = activeScroller();
    touchAtTop = !sc || sc.scrollTop <= 0;
    touchHandled = false;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!isMobileLandscape() || touchHandled) return;
    const t = e.touches[0];
    if (!t) return;
    const dy = t.clientY - touchStartY;
    const dx = Math.abs(t.clientX - touchStartX);
    if (dy <= dx) return;
    if ((touchStartY <= 60 && dy > 30) || (touchAtTop && dy > 45)) {
      touchHandled = true;
      toggleLandscapeHeader(true);
    }
  }, { passive: true });

  // 3. 旋轉螢幕／視窗尺寸變化：離開橫向就清掉狀態；進入橫向一律先收起
  const resetLandscape = () => {
    document.body.classList.remove('landscape-header-open');
    const iconEl = document.getElementById('landscape-pull-icon');
    const textEl = document.getElementById('landscape-pull-text');
    if (iconEl) iconEl.textContent = '▼';
    if (textEl) textEl.textContent = '選單';
    lastScrollTop = 0;
  };
  window.addEventListener('resize', resetLandscape);
  if (window.screen && window.screen.orientation) {
    window.screen.orientation.addEventListener('change', resetLandscape);
  }
}

window.toggleLandscapeHeader = toggleLandscapeHeader;

// Keyboard shortcuts (Esc to close modals)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMindmapModal();
    closeImageModal();
    closePwaInstallModal();
  }
  const mindmapModal = document.getElementById('mindmap-modal');
  if (mindmapModal && !mindmapModal.classList.contains('hidden')) {
    if (e.key === '+' || e.key === '=') {
      mindmapZoomIn();
    } else if (e.key === '-' || e.key === '_') {
      mindmapZoomOut();
    } else if (e.key === '0') {
      mindmapResetZoom();
    }
  }
});

// ── Boot ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);


