/* ====================================================
   EMT-P 重點整理 — app.js
   主要邏輯：章節導航、Tab切換、搜尋、小測驗、深色模式
   ==================================================== */

'use strict';

// ── 狀態 ──────────────────────────────────────────────
const state = {
  chapters: [],
  currentChId: null,
  currentChData: null,
  readChapters: new Set(JSON.parse(localStorage.getItem('readCh') || '[]')),
  theme: localStorage.getItem('theme') || 'light',
  quizAnswers: {},   // chId -> { qIdx -> selectedOption }
  quizScores: {},    // chId -> { correct, total }
  searchQuery: '',

  // ── Mode 2 (題庫練習) 狀態 ──
  allQuizzes: [],
  geminiApiKey: localStorage.getItem('gemini_api_key') || '',
  geminiModel: localStorage.getItem('gemini_model') || 'gemini-3.8-flash',
  wrongQuestions: JSON.parse(localStorage.getItem('m2_wrong_questions') || '[]'),
  m2Stats: JSON.parse(localStorage.getItem('m2_stats') || '{"total":0, "correct":0}'),
  currentMode: 1,
  m2Runner: {
    type: '',
    title: '',
    questions: [],
    currentIndex: 0,
    userAnswers: {},
    timerSeconds: 0,
    timerInterval: null
  }
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
  applyTheme(state.theme);
  await loadChapterIndex();
  await loadAllQuizzes();
  buildSidebar();
  bindEvents();
  initMode2();
  registerServiceWorker();
}

// ── Load all past exams for Mode 2 ────────────────────
async function loadAllQuizzes() {
  try {
    const r = await fetch('chapters/all_quizzes.json');
    state.allQuizzes = await r.json();
    console.log(`Loaded ${state.allQuizzes.length} quiz questions.`);
  } catch (e) {
    console.error('Failed to load all_quizzes.json:', e);
    state.allQuizzes = [];
  }
}

// ── Load chapter index ────────────────────────────────
async function loadChapterIndex() {
  try {
    const r = await fetch('chapters/index.json');
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
    const r = await fetch(`chapters/${chId}.json`);
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
  if (!state.quizAnswers[chId]) state.quizAnswers[chId] = {};

  // Render notes (includes inline quizzes)
  els.notesContent.innerHTML = renderNotes(cd, chId);

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

  // ② 歷屆試題（直接嵌入在最開頭）
  if (cd.quizzes && cd.quizzes.length) {
    html += `<div class="section-label"><span class="s-num">1</span> 歷屆試題（共 ${cd.quizzes.length} 題）</div>`;
    html += `<div class="quiz-score-bar" id="quiz-score-bar" style="display:none">
      <div>
        <div class="score-label">本章得分</div>
        <div class="score-value" id="quiz-score-text">0 / 0</div>
      </div>
      <div class="score-progress">
        <div class="score-fill" id="quiz-score-fill" style="width:0%"></div>
      </div>
    </div>`;
    html += `<div class="quiz-container">`;
    cd.quizzes.forEach((q, qi) => {
      html += renderQuizItem(q, qi, chId);
    });
    html += `</div>`;
  }

  // ③ 關鍵詞句
  if (cd.keywords && cd.keywords.length) {
    html += `<div class="section-label"><span class="s-num">2</span> 關鍵詞句及定義</div>`;
    html += `
      <div class="table-responsive">
        <table class="keyword-table">
          <thead><tr>
            <th style="min-width:110px">中文術語</th>
            <th style="min-width:110px">English</th>
            <th style="min-width:180px">定義與核心精神</th>
          </tr></thead>
          <tbody>
            ${cd.keywords.map(kw => `
              <tr>
                <td><span class="keyword-zh">${kw.zh}</span></td>
                <td><span class="keyword-en">${kw.en || '—'}</span></td>
                <td>${kw.def}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  // ④ 內文重點
  if (cd.content && cd.content.length) {
    html += `<div class="section-label"><span class="s-num">3</span> 內文重點整理</div>`;
    html += renderContentBlocks(cd.content);
  }

  // ⑤ 重點一覽入口
  html += `
    <div class="section-label"><span class="s-num">4</span> 重點一覽</div>
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
function renderContentBlocks(blocks) {
  let html = '';
  for (const block of blocks) {
    switch (block.type) {
      case 'orange':
        html += `<div class="orange-heading">${block.text}</div>`;
        break;
      case 'blue':
        html += `<div class="blue-heading">${block.text}</div>`;
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
      case 'clinical':
        html += `
          <div class="clinical-block">
            <div class="clinical-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              ${block.label || '核心觀念 ‧ 臨床實務'}
            </div>
            <ul>${(block.points || []).map(p => `<li>${p}</li>`).join('')}</ul>
          </div>`;
        break;
      case 'text':
        html += `<p style="font-size:0.9rem;line-height:1.7;margin:8px 0 12px;padding-left:4px">${block.text}</p>`;
        break;
    }
  }
  return html;
}

function renderListItem(item) {
  if (typeof item === 'string') return item;
  if (item.text && item.sub) {
    return `${item.text}<ul class="sub-list">${item.sub.map(s => `<li>${s}</li>`).join('')}</ul>`;
  }
  return item.text || String(item);
}

function renderCompTable(block) {
  const rows = block.rows || [];
  const headers = block.headers || [];
  if (!rows.length) return '';
  return `
    <div class="comp-table-wrap">
      <table class="comp-table">
        ${headers.length ? `<thead><tr>${headers.map((h, i) => `<th${i===0?' style="min-width:110px"':''}>${h}</th>`).join('')}</tr></thead>` : ''}
        <tbody>
          ${rows.map(row => `
            <tr>${row.map((cell, i) => i === 0
              ? `<td class="row-header">${cell}</td>`
              : `<td>${cell}</td>`).join('')}
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderMarkdown(text) {
  // Very basic markdown: bold, lists
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n- (.+)/g, '<li>$1</li>')
    .replace(/\n/g, '<br>');
}

// ── Render: Single Quiz Item ──────────────────────────
function renderQuizItem(q, qi, chId) {
  const isAnswered = state.quizAnswers[chId] && state.quizAnswers[chId][qi] !== undefined;
  const userAns = isAnswered ? state.quizAnswers[chId][qi] : null;
  const isCorrect = isAnswered && userAns === q.answer;

  return `
    <div class="quiz-item ${isAnswered ? (isCorrect ? 'answered-correct' : 'answered-wrong') : ''}" id="quiz-item-${qi}" data-qi="${qi}">
      <div class="quiz-meta">
        <span class="quiz-tag year">${q.year || '歷屆'}</span>
        <span class="quiz-tag">${q.sourceLabel || '甄試考題'}</span>
        <span class="quiz-tag q-status-tag ${isAnswered ? (isCorrect ? 'correct' : 'wrong') : ''}" id="q-status-tag-${qi}">
          ${isAnswered ? (isCorrect ? '✅ 答對' : '❌ 答錯') : '尚未作答'}
        </span>
      </div>
      <div class="quiz-q">${qi + 1}. ${q.question}</div>
      <div class="quiz-options">
        ${q.options.map((opt, oi) => {
          let extraClass = '';
          if (isAnswered) {
            if (oi === q.answer) extraClass = 'correct';
            else if (oi === userAns && !isCorrect) extraClass = 'wrong';
          }
          return `
            <button class="quiz-option ${extraClass}" data-qi="${qi}" data-oi="${oi}"
                    ${isAnswered ? 'disabled' : ''}
                    onclick="selectOption(${qi}, ${oi}, '${chId}')">
              <span class="opt-label">${String.fromCharCode(65 + oi)}</span>
              <span class="opt-text">${opt}</span>
            </button>`;
        }).join('')}
      </div>
      <div class="quiz-explanation ${isAnswered ? 'show' : ''}" id="quiz-exp-${qi}">
        <div class="exp-header">
          <div class="exp-title">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
            詳解與核心解析
          </div>
          <button class="quiz-reset-btn" onclick="resetQuiz(${qi}, '${chId}')" title="重新作答此題">🔄 重做</button>
        </div>
        <div class="exp-result-banner" id="exp-banner-${qi}">
          ${isAnswered ? (isCorrect 
            ? '<span class="banner-correct">✅ 恭喜答對！請研讀下方考題解析：</span>' 
            : `<span class="banner-wrong">❌ 答錯了！正確答案為：<strong>(${String.fromCharCode(65 + q.answer)})</strong></span>`) : ''}
        </div>
        <div class="exp-body">${q.explanation || '（詳解整理中）'}</div>
        ${q.source ? `<div class="exp-source">📖 出處：${q.source}</div>` : ''}
      </div>
    </div>`;
}

function selectOption(qi, oi, chId) {
  const item = $(`#quiz-item-${qi}`);
  if (!item || item.classList.contains('answered-correct') || item.classList.contains('answered-wrong')) return;

  const cd = state.currentChData;
  if (!cd || !cd.quizzes || !cd.quizzes[qi]) return;
  const q = cd.quizzes[qi];

  state.quizAnswers[chId][qi] = oi;
  const isCorrect = (oi === q.answer);

  // Style options immediately
  item.querySelectorAll('.quiz-option').forEach((btn, idx) => {
    btn.disabled = true;
    if (idx === q.answer) {
      btn.classList.add('correct');
    } else if (idx === oi && !isCorrect) {
      btn.classList.add('wrong');
    }
  });

  item.classList.add(isCorrect ? 'answered-correct' : 'answered-wrong');

  // Update status badge
  const statusTag = $(`#q-status-tag-${qi}`);
  if (statusTag) {
    statusTag.textContent = isCorrect ? '✅ 答對' : '❌ 答錯';
    statusTag.className = `quiz-tag q-status-tag ${isCorrect ? 'correct' : 'wrong'}`;
  }

  // Update banner in explanation
  const banner = $(`#exp-banner-${qi}`);
  if (banner) {
    banner.innerHTML = isCorrect 
      ? '<span class="banner-correct">✅ 恭喜答對！請研讀下方考題解析：</span>' 
      : `<span class="banner-wrong">❌ 答錯了！正確答案為：<strong>(${String.fromCharCode(65 + q.answer)})</strong></span>`;
  }

  // Reveal explanation immediately!
  const exp = $(`#quiz-exp-${qi}`);
  if (exp) {
    exp.classList.add('show');
    // Scroll smoothly to explanation if needed
    setTimeout(() => {
      exp.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 80);
  }

  // Update score bar
  if (!state.quizScores[chId]) state.quizScores[chId] = { correct: 0, total: 0 };
  state.quizScores[chId].total++;
  if (isCorrect) state.quizScores[chId].correct++;
  updateQuizScore(chId);
}

function resetQuiz(qi, chId) {
  if (state.quizAnswers[chId]) {
    delete state.quizAnswers[chId][qi];
  }
  const item = $(`#quiz-item-${qi}`);
  if (!item) return;
  item.classList.remove('answered-correct', 'answered-wrong');
  item.querySelectorAll('.quiz-option').forEach(btn => {
    btn.disabled = false;
    btn.classList.remove('correct', 'wrong', 'selected');
  });
  const statusTag = $(`#q-status-tag-${qi}`);
  if (statusTag) {
    statusTag.textContent = '尚未作答';
    statusTag.className = 'quiz-tag q-status-tag';
  }
  const exp = $(`#quiz-exp-${qi}`);
  if (exp) exp.classList.remove('show');
}

function updateQuizScore(chId) {
  const score = state.quizScores[chId];
  const bar = $('#quiz-score-bar');
  const text = $('#quiz-score-text');
  const fill = $('#quiz-score-fill');
  if (!score || score.total === 0 || !bar) {
    if (bar) bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  if (text) text.textContent = `${score.correct} / ${score.total}`;
  const pct = Math.round((score.correct / score.total) * 100);
  if (fill) fill.style.width = pct + '%';
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
                <td>${n.label}</td>
                <td class="highlight-num">${n.value}</td>
                <td>${n.note || ''}</td>
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
          ${s.quickReview.map(r => `<li>${r}</li>`).join('')}
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
  els.searchCount.textContent = state.searchQuery
    ? `找到 ${visible} 個章節`
    : '';
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
  const modal = els.progressModal || document.getElementById('progress-modal');
  if (!modal) return;
  const total = state.chapters.length;
  const read = state.readChapters.size;
  const unread = total - read;
  const pct = total > 0 ? Math.round((read / total) * 100) : 0;
  const contentEl = modal.querySelector('#progress-modal-content');
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
  modal.style.display = '';
  modal.classList.remove('hidden');
}

function closeProgressModal() {
  const modal = els.progressModal || document.getElementById('progress-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

// ── Pagination helpers ─────────────────────────────────
function prevChapter() {
  const curIdx = state.chapters.findIndex(c => c.id === state.currentChId);
  if (curIdx > 0) {
    selectChapter(state.chapters[curIdx - 1].id);
  }
}

function nextChapter() {
  const curIdx = state.chapters.findIndex(c => c.id === state.currentChId);
  if (curIdx < state.chapters.length - 1) {
    selectChapter(state.chapters[curIdx + 1].id);
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

  // Progress button
  if (els.progressBtn) els.progressBtn.addEventListener('click', openProgressModal);

  // Close progress modal on backdrop click
  els.progressModal.addEventListener('click', (e) => {
    if (e.target === els.progressModal) closeProgressModal();
  });

  // Mode buttons
  $$('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const mode = parseInt(btn.dataset.mode || '1', 10);
      switchMode(mode);
    });
  });

  // Keyboard shortcut: / to focus search
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== els.searchInput) {
      e.preventDefault();
      els.searchInput.focus();
    }
    if (e.key === 'Escape') {
      els.searchInput.blur();
      closeProgressModal();
      closeMobileSidebar();
      closeApiModal();
      closeChapterQuizModal();
      closeAiQuizModal();
      closeManualAddModal();
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
  ['gemini-api-modal', 'm2-ch-modal', 'm2-ai-modal', 'manual-add-modal'].forEach(id => {
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
  state.currentMode = mode;
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

  // 確保每輪最多 10 題
  const finalQuestions = questions.slice(0, 10);

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
  if (tagMeta) tagMeta.textContent = `第 ${idx + 1} / ${total} 題`;
  if (chTag) chTag.textContent = `${q.chNum || ''} ${q.chTitle || ''}`;

  // 題幹文字
  const qText = $('#m2-qtext');
  if (qText) qText.textContent = q.question;

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
      <div class="m2-opt-text">${escapeHtml(optText)}</div>
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
  if (nextBtn) nextBtn.disabled = (idx === total - 1);
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
  if (state.m2Runner.currentIndex < state.m2Runner.questions.length - 1) {
    renderRunnerQuestion(state.m2Runner.currentIndex + 1);
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
      const wrongItem = {
        id: q.id || `m2-${Date.now()}-${i}`,
        question: q.question,
        options: q.options,
        answer: q.answer,
        userAnswer: userChoice !== undefined ? userChoice : -1,
        explanation: q.explanation || '依據教科書臨床指引解析。',
        chId: q.chId || 'ch01',
        chNum: q.chNum || 'CH01',
        chTitle: q.chTitle || '未分類章節',
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
    if (score === 100) msgEl.textContent = '全對滿分！臨床鑑別與處置思維完美無缺！';
    else if (newWrongQuestions.length > 0) msgEl.textContent = `已自動將本次 ${newWrongQuestions.length} 道錯題收錄至錯題本，點擊筆記連結即可複習！`;
    else msgEl.textContent = '請仔細檢閱下方 10 題完整詳解與考點關鍵，加深記憶！';
  }

  // 渲染逐題詳解與跳轉筆記連結
  renderQuizReviewList(questions, state.m2Runner.userAnswers);

  // 切換至結果視圖
  showM2Subview('m2-quiz-result');
}

function renderQuizReviewList(questions, userAnswers) {
  const container = $('#m2-review-list');
  if (!container) return;
  container.innerHTML = '';
  const letters = ['A', 'B', 'C', 'D'];

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
          <span>${escapeHtml(optText)}</span>
          ${badge}
        </div>
      `;
    });

    card.innerHTML = `
      <div class="m2-rev-meta">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="m2-qtag">第 ${i + 1} 題</span>
          <span class="m2-qtag ch">${escapeHtml(q.chNum || '')} ${escapeHtml(q.chTitle || '')}</span>
        </div>
        <span class="m2-rev-status ${isCorrect ? 'correct' : 'incorrect'}">
          ${isCorrect ? '✅ 答對' : '❌ 答錯'}
        </span>
      </div>
      <div class="m2-qtext" style="font-size:1.05rem;margin-bottom:12px">${escapeHtml(q.question)}</div>
      <div class="m2-rev-options">
        ${optionsHtml}
      </div>
      <div class="review-expl-box">
        <div class="review-expl-title">💡 題目詳解與考點關鍵：</div>
        <div>${escapeHtml(q.explanation || '暫無解析')}</div>
      </div>
      <button class="jump-ch-btn" onclick="jumpToMode1Chapter('${q.chId || 'ch01'}')">
        🔗 跳轉至 ${escapeHtml(q.chNum || '')} ${escapeHtml(q.chTitle || '該章')} 重點筆記
      </button>
    `;

    container.appendChild(card);
  });
}

// ── 跳轉至模式一重點筆記 ─────────────────────────────
function jumpToMode1Chapter(chId) {
  if (!chId) chId = 'ch01';
  switchMode(1);
  selectChapter(chId);
  switchTab('notes');
  setTimeout(() => {
    const target = $('#notes-content') || $('#chapter-view');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 120);
}

// ── 功能二：歷屆試題全真抽測 (10題) ──────────────────
function startPastExamQuiz() {
  if (!state.allQuizzes || state.allQuizzes.length === 0) {
    alert('正在載入歷屆試題庫，請稍候重試…');
    return;
  }
  const shuffled = [...state.allQuizzes].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 10);
  startM2Quiz('past', '🎲 歷屆全真抽測 (10題)', selected);
}

// ── 功能三：章節專項出題 (10題) ──────────────────────
function openChapterQuizModal() {
  const grid = $('#m2-ch-grid');
  if (grid && grid.children.length === 0) {
    state.chapters.forEach(ch => {
      const label = document.createElement('label');
      label.className = 'ch-checkbox-label';
      label.innerHTML = `
        <input type="checkbox" value="${ch.id}" class="m2-ch-cb" onchange="updateChSelectCount()">
        <span><b>${ch.num}</b> ${escapeHtml(ch.title)}</span>
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
  const cbs = $$('.m2-ch-cb:checked');
  const countEl = $('#ch-selected-count');
  if (countEl) countEl.textContent = `已選 ${cbs.length} 個章節`;
}

function selectAllChapters(checked) {
  $$('.m2-ch-cb').forEach(cb => cb.checked = checked);
  updateChSelectCount();
}

function selectPresetChapters(category) {
  selectAllChapters(false);
  const targetIds = [];
  if (category === 'trauma') {
    for (let i = 28; i <= 36; i++) targetIds.push(`ch${String(i).padStart(2, '0')}`);
  } else if (category === 'cardio') {
    for (let i = 20; i <= 23; i++) targetIds.push(`ch${String(i).padStart(2, '0')}`);
  } else if (category === 'airway') {
    for (let i = 9; i <= 11; i++) targetIds.push(`ch${String(i).padStart(2, '0')}`);
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
  const selectedSet = new Set(selectedCbs);
  const matched = state.allQuizzes.filter(q => selectedSet.has(q.chId));

  if (matched.length === 0) {
    alert('所選章節在歷屆甄試中題目較少，為您隨機抽取題目進行專項挑戰！');
    const shuffled = [...state.allQuizzes].sort(() => Math.random() - 0.5).slice(0, 10);
    closeChapterQuizModal();
    startM2Quiz('chapter', `📚 章節專項抽測 (精選10題)`, shuffled);
    return;
  }

  let pool = [...matched].sort(() => Math.random() - 0.5);
  // 若所選章節不足 10 題，自其他題目補足至 10 題
  if (pool.length < 10) {
    const others = state.allQuizzes.filter(q => !selectedSet.has(q.chId)).sort(() => Math.random() - 0.5);
    pool = pool.concat(others.slice(0, 10 - pool.length));
  }
  const selected = pool.slice(0, 10);
  closeChapterQuizModal();
  startM2Quiz('chapter', `📚 章節專項抽測 (${selectedCbs.length} 個章節)`, selected);
}

// ── 功能一：AI 智慧出題 (10題) ──────────────────────
function openAiQuizModal() {
  if (!state.geminiApiKey) {
    alert('使用 AI 智慧出題前，請先點擊上方按鈕設定 Google Gemini API Key！');
    openApiModal();
    return;
  }
  const statusEl = $('#ai-gen-status');
  if (statusEl) statusEl.style.display = 'none';
  const btn = $('#ai-start-gen-btn');
  if (btn) btn.disabled = false;
  $('#m2-ai-modal')?.classList.remove('hidden');
}

function closeAiQuizModal() {
  $('#m2-ai-modal')?.classList.add('hidden');
}

async function generateAiQuiz() {
  if (!state.geminiApiKey) {
    alert('請先設定 Gemini API Key！');
    openApiModal();
    return;
  }

  const topicSelect = $('#ai-topic-select');
  const diffSelect = $('#ai-diff-select');
  const topic = topicSelect ? topicSelect.value : 'all';
  const diff = diffSelect ? diffSelect.value : 'high';

  const statusEl = $('#ai-gen-status');
  const btn = $('#ai-start-gen-btn');
  if (statusEl) statusEl.style.display = 'block';
  if (btn) btn.disabled = true;

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
    ? '地獄挑戰級：包含複合臨床情境、雙重陷阱、生命徵象判斷與先後處置邏輯，難度超越歷屆甄試。'
    : '甄試全真級：比照衛福部高級救護技術員甄試等級，重視標準作業流程、精確劑量、適應症與禁忌症。';

  const prompt = `你是一位具有20年急診醫學臨床專科與高級救護技術員(EMT-P)甄試命題委員經驗的資深醫學教授。
請依據台灣高級救護技術員教科書（大白）及最新國際與台灣急救指引命題：
【主題】：${topicDesc}
【難易度】：${diffDesc}

【嚴格規則】：
1. 嚴格產出剛好「10 題」單選題。
2. 每題包含 4 個選項（A, B, C, D），單一正解。
3. 每題必須提供極為詳細的中文解析（解釋正解原因、各干擾選項錯誤點、關鍵生理機轉）。
4. 每題附上對應章節資訊（chId 例如 ch21, chNum 例如 CH21, chTitle 例如 心律不整之判讀與處置）。
5. 回傳必須是純標準 JSON 陣列格式，嚴禁任何 markdown 包裝或多餘前言，直接以 [ 開頭、以 ] 結尾。

JSON 陣列結構：
[
  {
    "question": "題目情境敘述...",
    "options": ["選項A", "選項B", "選項C", "選項D"],
    "answer": 0,
    "explanation": "詳細解析...",
    "chId": "ch21",
    "chNum": "CH21",
    "chTitle": "心律不整之判讀與處置"
  }
]`;

  try {
    const candidateText = await callGeminiApi(prompt, true, state.geminiApiKey);

    const cleanJson = candidateText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleanJson);

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('AI 未能生成題目陣列，請重試！');
    }

    const validatedQuestions = parsed.map((item, idx) => ({
      id: `ai-${Date.now()}-${idx + 1}`,
      question: item.question || `AI 題目 ${idx + 1}`,
      options: Array.isArray(item.options) && item.options.length >= 4 ? item.options.slice(0, 4) : ['選項A', '選項B', '選項C', '選項D'],
      answer: typeof item.answer === 'number' && item.answer >= 0 && item.answer <= 3 ? item.answer : 0,
      explanation: item.explanation || '依據教科書臨床指引解析。',
      chId: item.chId || 'ch01',
      chNum: item.chNum || 'CH01',
      chTitle: item.chTitle || '重點章節'
    })).slice(0, 10);

    closeAiQuizModal();
    if (statusEl) statusEl.style.display = 'none';
    if (btn) btn.disabled = false;

    startM2Quiz('ai', `🤖 AI 智慧出題 (${diff === 'expert' ? '地獄挑戰級' : '甄試全真級'})`, validatedQuestions);

  } catch (err) {
    console.error('AI Quiz Generation failed:', err);
    alert(`AI 出題失敗：${err.message}\n請檢查 API Key 或網路連線後重試！`);
    if (statusEl) statusEl.style.display = 'none';
    if (btn) btn.disabled = false;
  }
}

// ── 功能四：錯題本 & AI 核心觀念弱點診斷 ──────────────
function openWrongBookView() {
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
          <span>${escapeHtml(optText)}</span>
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
      <div class="m2-rev-options" style="margin:10px 0">
        ${optionsHtml}
      </div>
      <div class="review-expl-box" style="margin-top:10px">
        <div class="review-expl-title">💡 重點解析：</div>
        <div>${escapeHtml(q.explanation || '暫無解析')}</div>
      </div>
      <div style="margin-top:12px">
        <button class="jump-ch-btn" onclick="jumpToMode1Chapter('${q.chId || 'ch01'}')">
          🔗 跳轉至 ${escapeHtml(q.chNum || '')} ${escapeHtml(q.chTitle || '該章')} 重點筆記
        </button>
      </div>
    `;
    listEl.appendChild(card);
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
window.selectOption = selectOption;
window.resetQuiz = resetQuiz;
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

// ── PWA & Service Worker ──────────────────────────────────
let deferredInstallPrompt = null;

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then((reg) => {
          console.log('[PWA] Service Worker registered:', reg.scope);
        })
        .catch((err) => {
          console.warn('[PWA] Service Worker failed:', err);
        });
    });
  }

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

// ── Boot ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);


