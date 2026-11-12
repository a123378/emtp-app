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
  chapterProgress: JSON.parse(localStorage.getItem('chProgress') || '{}'),
  theme: localStorage.getItem('theme') || 'light',
  searchQuery: '',
  searchBrowseChId: null,   // 從搜尋結果跳入的章節：瀏覽期間不計入研讀進度
  scrollBeforeSearch: null, // 開啟搜尋前，目前章節的捲動位置（清掉搜尋時還原）
  browseReturnTop: null,    // 搜尋瀏覽結束時要跳回的位置（同章節跳轉才有）
  inlineAnswers: {},   // qId -> 選項索引（模式一段落內嵌考題）
  isLoadingChapter: false,

  allQuizzes: [],      // 歷屆試題（模式一段落內嵌考題）
  quizzesReady: Promise.resolve(), // 歷屆試題載入完成的 Promise（init 時換成實際下載）
  currentMode: 1
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
  mode1Btn:       $('#mode1-btn')
};

// ── 手動強制檢查並更新 App（手機端一鍵刷新最新版本）──
// 離線快取由 sw.js / offline.js 負責（網路優先，平常就會拿到最新版）；
// 這裡只重抓網頁本體，不會刪掉已下載的離線包。
async function forceAppUpdate() {
  if (!navigator.onLine) {
    alert('目前沒有網路，連上網路後再更新。');
    return;
  }
  if (confirm('即將重新下載最新版本的網頁，確定要更新嗎？\n（已下載的離線內容會保留）')) {
    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#1e293b;color:#fff;padding:12px 24px;border-radius:12px;font-size:0.9rem;font-weight:700;box-shadow:0 10px 25px rgba(0,0,0,0.3);z-index:99999;display:flex;align-items:center;gap:8px';
    toast.innerHTML = '<span>🔄 正在載入最新版本…</span>';
    document.body.appendChild(toast);

    if (window.OfflineCache) await window.OfflineCache.refreshShell();

    setTimeout(() => {
      const cleanUrl = window.location.protocol + '//' + window.location.host + window.location.pathname;
      window.location.href = cleanUrl + '?ts=' + Date.now();
    }, 350);
  }
}
window.forceAppUpdate = forceAppUpdate;

// ── Init ──────────────────────────────────────────────
async function init() {
  if (!localStorage.getItem('red_initialized_v3')) {
    localStorage.setItem('readCh', JSON.stringify([]));
    state.readChapters.clear();
    localStorage.setItem('red_initialized_v3', '1');
  }
  document.body.classList.add('mode-1');
  applyTheme(state.theme);
  // 歷屆試題（2 MB）只有章節內嵌考題用得到：與章節目錄同時下載，不擋側欄顯示
  state.quizzesReady = loadAllQuizzes();
  await loadChapterIndex();
  // 同步已讀與各章 % 數進度（以各章實質百分比為準，唯有 >= 100% 才標為已讀）
  state.readChapters = new Set();
  Object.entries(state.chapterProgress).forEach(([id, pct]) => {
    if (pct >= 100) state.readChapters.add(id);
  });
  localStorage.setItem('chProgress', JSON.stringify(state.chapterProgress));
  localStorage.setItem('readCh', JSON.stringify([...state.readChapters]));

  buildSidebar();
  bindEvents();
  initReadingProgressPill();
  initPwaInstallPrompt();
  initLandscapeController();
}

// ── 載入歷屆試題（模式一段落內嵌考題）────────────────────
async function loadAllQuizzes() {
  try {
    const r = await fetch(dataUrl('chapters/all_quizzes.json'));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.allQuizzes = await r.json();
  } catch (e) {
    console.error('Failed to load all_quizzes.json:', e);
    state.allQuizzes = [];
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
    const pct = state.chapterProgress[ch.id] || 0;
    const isRead = pct >= 100 || state.readChapters.has(ch.id);
    const item = document.createElement('div');
    item.className = 'ch-item' + (isRead ? ' read' : '');
    item.dataset.chId = ch.id;
    item.innerHTML = `
      <span class="ch-num">${ch.num}</span>
      <span class="ch-name">${ch.title}</span>
      <span class="ch-status-indicator ${isRead ? 'is-read' : (pct > 0 ? 'in-progress' : '')}">
        ${isRead ? '<span class="ch-read-dot" title="🟢 100% 已研讀（點擊重設為未讀）"></span>' : `<span class="ch-pct-tag" title="📖 研讀進度 ${pct}%（需達 100% 才能標為已讀）">${pct}%</span>`}
      </span>
    `;
    item.addEventListener('click', (e) => {
      if (e.target.closest('.ch-status-indicator')) {
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
async function selectChapter(chId, opts = {}) {
  const fromSearch = !!opts.fromSearch;
  if (state.currentChId === chId) {
    closeMobileSidebar();
    // 從側欄點回正在「搜尋瀏覽」的章節 → 視為回到上次進度
    if (!fromSearch && state.searchBrowseChId === chId) exitSearchBrowse();
    return;
  }
  saveChapterProgressToStorage();
  state.isLoadingChapter = true;
  state.currentChId = chId;
  updateReadingProgressPill();
  state.searchBrowseChId = fromSearch ? chId : null;
  state.scrollBeforeSearch = null;
  state.browseReturnTop = null;
  hideProgressRestoreToast();

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

  // 1A + 2A + 3A: 自動跳轉至上次進度 (1% ~ 99%)；從搜尋跳入則改跳到命中段落
  if (!fromSearch) restoreChapterReadingProgress(chId);

  // 渲染完成後解除載入鎖（唯有讀者親自滾動至底部才計 100%）
  setTimeout(() => {
    state.isLoadingChapter = false;
  }, 350);
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
// 這次開啟網頁期間讀過的章節留在記憶體，回頭再看不必重新下載
const CHAPTER_MEMORY_LIMIT = 20;
const _chapterMemory = new Map();

async function fetchChapterJson(chId) {
  if (_chapterMemory.has(chId)) return _chapterMemory.get(chId);
  try {
    const r = await fetch(dataUrl(`chapters/${chId}.json`));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    _chapterMemory.set(chId, data);
    if (_chapterMemory.size > CHAPTER_MEMORY_LIMIT) {
      _chapterMemory.delete(_chapterMemory.keys().next().value); // 丟掉最早讀的
    }
    return data;
  } catch (e) {
    return null;
  }
}

async function loadChapterData(chId) {
  // 已在記憶體的章節直接顯示，不閃載入動畫
  if (!_chapterMemory.has(chId)) {
    els.notesLoading.style.display = 'flex';
    els.notesContent.classList.add('hidden');
  }

  const chData = await fetchChapterJson(chId);
  // 筆記裡要嵌入歷屆試題，渲染前確定題庫已載入（通常早就好了；失敗時 loadAllQuizzes 會給空陣列）
  await state.quizzesReady;
  // 等待期間使用者已換到別章：丟掉這份資料，交給新的那次載入
  if (state.currentChId !== chId) return;
  state.currentChData = chData;

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
      </div>
    </div>`;

  // ② 本章核心架構心智圖（點擊開啟互動樹狀圖，可切換原始 SVG 圖譜）
  html += renderChapterMindmapCard(cd, chId);

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
        <strong>查看本章公式、關鍵數字與比較表格</strong>
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
        html += mnemonicHtml(block, mdInline);
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
      case 'm3ref':
        html += renderM3Ref(block);
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
  const s = cd && cd.summary;
  const cards = s ? buildSummaryCards(cd, s) : [];
  if (!cards.length) {
    return '<p style="color:var(--text-muted);padding:20px">此章節重點一覽尚未生成。</p>';
  }

  const chTitle = escapeHtml(`${cd.num || ''} ${cd.title || ''}`.trim());
  let html = `
    <div class="summary-print-bar">
      <span>可直接列印，或在列印視窗選「另存為 PDF」</span>
      <button class="summary-print-btn" onclick="printSummary()">🖨️ 列印／存成 PDF</button>
    </div>
    <div class="summary-print-title">
      <h2>${chTitle} — 重點一覽</h2>
      <div class="summary-print-sub">高級救護技術員教科書（大白第三版）章節摘要</div>
    </div>`;

  cards.forEach((c, i) => {
    html += `
      <div class="summary-card" id="sum-${c.key}">
        <h3><span class="sum-num">${SUMMARY_NUMERALS[i] || i + 1}、</span>${c.icon} ${c.title}</h3>
        ${c.body}
      </div>`;
  });
  return html;
}

const SUMMARY_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/**
 * 重點一覽只顯示：公式（僅限 summary.showFormulas 指定的條目）、關鍵數字、比較表格、章末速記。
 * 關鍵字白話表、口訣、章末重點一覽的資料仍保留在 JSON（口訣已併入分組速記）。
 * @returns {{key: string, icon: string, title: string, body: string}[]}
 */
function buildSummaryCards(cd, s) {
  const cards = [];
  const add = (key, icon, title, body) => { if (body) cards.push({ key, icon, title, body }); };

  add('formulas', '🧮', '公式彙整', renderSummaryFormulas(pickShownFormulas(s)));
  add('numbers', '🔢', '關鍵數字整理', renderSummaryNumbers(s.keyNumbers));
  add('tables', '📊', '重點比較表格', renderSummaryTables(cd, s.tables));
  add('quick', '✅', '章末重點速記', renderSummaryQuick(s.quickReview));
  return cards;
}

/** summary.showFormulas 是要顯示的公式索引；沒有這個欄位的章節不顯示公式。 */
function pickShownFormulas(s) {
  const keep = s.showFormulas;
  if (!Array.isArray(keep) || !Array.isArray(s.formulas)) return [];
  return keep.map(i => s.formulas[i]).filter(Boolean);
}

function renderSummaryFormulas(list) {
  if (!list || !list.length) return '';
  return list.map(f => `
    <div class="formula-box">
      <span class="formula-name">${f.name}</span>
      ${f.formula}
      ${f.note ? `<div class="formula-note">${f.note}</div>` : ''}
    </div>`).join('');
}

function renderSummaryNumbers(list) {
  if (!list || !list.length) return '';
  return `
    <div class="comp-table-wrap">
      <table class="numbers-table">
        <thead><tr><th>項目</th><th>數值</th><th>說明／臨床連結</th></tr></thead>
        <tbody>
          ${list.map(n => `
            <tr>
              <td>${mdInline(n.label)}</td>
              <td class="highlight-num">${mdInline(n.value)}</td>
              <td>${mdInline(n.note || '')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/** 表格可直接寫 headers/rows，或用 fromContent 指向重點筆記中同名標題下的表格，避免兩份資料不同步 */
function renderSummaryTables(cd, list) {
  if (!list || !list.length) return '';
  return list.map(t => {
    const tbl = t.fromContent ? findContentTable(cd, t.fromContent, t.nth || 0) : t;
    if (!tbl || !tbl.rows || !tbl.rows.length) return '';
    return `
      <div class="sum-subhead">${mdInline(t.title || t.fromContent)}</div>
      ${renderCompTable(tbl)}
      ${t.note ? `<div class="sum-table-note">${mdInline(t.note)}</div>` : ''}`;
  }).join('');
}

function findContentTable(cd, heading, nth) {
  let last = '';
  let count = 0;
  for (const b of cd.content || []) {
    if (b.type === 'orange' || b.type === 'blue') last = (b.text || '').trim();
    if (b.type === 'table' && last === heading) {
      if (count === nth) return b;
      count++;
    }
  }
  return null;
}

/**
 * 章末重點速記。舊格式是字串陣列（逐條編號）；新格式是分組陣列，每組可含
 * intro（引言）、mnemonic（口訣）、items（條列）、groups（分組表）、table（比較表）。
 * @param {Array<string|{title: string, intro?: string, mnemonic?: string, items?: string[],
 *   groups?: {label: string, items: string[]}[], groupHeaders?: string[],
 *   table?: {headers: string[], rows: string[][]}}>} list
 */
function renderSummaryQuick(list) {
  if (!list || !list.length) return '';
  if (typeof list[0] === 'string') {
    return `<ol class="sum-quick">${list.map(q => `<li>${mdInline(q)}</li>`).join('')}</ol>`;
  }
  return list.map(renderQuickSection).join('');
}

function renderQuickList(items) {
  if (!items || !items.length) return '';
  return `<ul class="sum-quick-list">${items.map(it => `<li>${mdInline(it)}</li>`).join('')}</ul>`;
}

function renderQuickSection(sec) {
  const groupTable = sec.groups && sec.groups.length
    ? renderCompTable({
        headers: sec.groupHeaders || ['分組', '內容'],
        rows: sec.groups.map(g => [g.label, renderQuickList(g.items)]),
      })
    : '';
  return `
    <div class="sum-quick-sec">
      <div class="sum-subhead">${mdInline(sec.title)}</div>
      ${sec.intro ? `<div class="sum-quick-intro">${mdInline(sec.intro)}</div>` : ''}
      ${sec.mnemonic ? `<div class="sum-quick-mn">口訣：${mdInline(sec.mnemonic)}</div>` : ''}
      ${renderQuickList(sec.items)}
      ${groupTable}
      ${sec.table ? renderCompTable(sec.table) : ''}
    </div>`;
}

// ── 列印／存成 PDF：只印重點一覽，深色模式暫時切回淺色 ─────────────
let _printThemeRestore = null;

function beginSummaryPrint() {
  document.body.classList.add('print-summary');
  const root = document.documentElement;
  if (root.getAttribute('data-theme') === 'dark' && _printThemeRestore === null) {
    _printThemeRestore = 'dark';
    root.setAttribute('data-theme', 'light');
  }
}

function endSummaryPrint() {
  document.body.classList.remove('print-summary');
  if (_printThemeRestore !== null) {
    document.documentElement.setAttribute('data-theme', _printThemeRestore);
    _printThemeRestore = null;
  }
}

function printSummary() {
  switchTab('summary');
  beginSummaryPrint();
  window.print();
}

window.addEventListener('beforeprint', () => {
  const panel = document.getElementById('tab-summary');
  if (panel && !panel.classList.contains('hidden') && document.querySelector('.summary-print-bar')) beginSummaryPrint();
});
window.addEventListener('afterprint', endSummaryPrint);

// ── Tab Switch ────────────────────────────────────────
function switchTab(tabName) {
  hideProgressRestoreToast();
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

function isSearchViewOpen() {
  return !!els.searchView && !els.searchView.classList.contains('hidden');
}

function showSearchView() {
  const wasOpen = isSearchViewOpen();
  // 第一次打開搜尋結果時，記住目前章節讀到哪裡，關閉搜尋時還原
  if (!wasOpen && state.currentChId && els.mainContent
      && els.chapterView && !els.chapterView.classList.contains('hidden')) {
    state.scrollBeforeSearch = els.mainContent.scrollTop;
  }
  if (els.welcomeScreen) els.welcomeScreen.classList.add('hidden');
  if (els.chapterView) els.chapterView.classList.add('hidden');
  if (els.searchView) els.searchView.classList.remove('hidden');
  if (!wasOpen && els.mainContent) els.mainContent.scrollTop = 0;
}

/** @param {{ restoreScroll?: boolean }} [opts] 關閉搜尋時是否回到搜尋前的捲動位置 */
function hideSearchView(opts = {}) {
  const restoreScroll = opts.restoreScroll !== false;
  const wasOpen = isSearchViewOpen();
  if (els.searchView) els.searchView.classList.add('hidden');
  if (state.currentChId) {
    if (els.chapterView) els.chapterView.classList.remove('hidden');
    if (wasOpen && restoreScroll && state.scrollBeforeSearch !== null && els.mainContent) {
      els.mainContent.scrollTop = state.scrollBeforeSearch;
    }
  } else if (els.welcomeScreen) {
    els.welcomeScreen.classList.remove('hidden');
  }
  if (wasOpen && restoreScroll) state.scrollBeforeSearch = null;
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
  const sameChapter = state.currentChId === chId;
  // 同章節：記住搜尋前讀到的位置（已在瀏覽中就沿用最初那個），供「回到上次進度」使用
  const returnTop = !sameChapter ? null
    : (state.searchBrowseChId === chId ? state.browseReturnTop : state.scrollBeforeSearch);
  // 跳到命中段落，不還原搜尋前位置
  hideSearchView({ restoreScroll: false });
  state.scrollBeforeSearch = null;
  state.browseReturnTop = returnTop;
  state.searchBrowseChId = chId;
  await selectChapter(chId, { fromSearch: true });
  showSearchBrowseToast();
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

// ── Read tracking (研讀達 100% 才標記已讀，支援各章 % 數進度) ───────────
let _saveProgressDebounceTimer = null;

function saveChapterProgressToStorage() {
  clearTimeout(_saveProgressDebounceTimer);
  try {
    localStorage.setItem('chProgress', JSON.stringify(state.chapterProgress));
    localStorage.setItem('readCh', JSON.stringify([...state.readChapters]));
  } catch (e) {}
}

window.saveChapterProgressToStorage = saveChapterProgressToStorage;

function queueSaveChapterProgress() {
  clearTimeout(_saveProgressDebounceTimer);
  _saveProgressDebounceTimer = setTimeout(saveChapterProgressToStorage, 300);
}

function checkChapterReadingProgress() {
  if (state.currentMode !== 1 || !state.currentChId) return;
  if (state.isLoadingChapter || !state.currentChData) return;
  // 搜尋結果畫面開著（捲的是搜尋清單），或正從搜尋跳入瀏覽 → 不計入研讀進度
  if (isSearchViewOpen() || state.searchBrowseChId === state.currentChId) return;
  if (els.chapterView && els.chapterView.classList.contains('hidden')) return;
  const sc = els.mainContent;
  if (!sc) return;

  // 僅在「重點筆記」分頁且內容完全顯現時計算章節閱讀進度
  const notesPanel = $('#tab-notes');
  if (!notesPanel || notesPanel.classList.contains('hidden')) return;
  if (!els.notesContent || els.notesContent.classList.contains('hidden')) return;
  if (els.notesLoading && els.notesLoading.style.display !== 'none') return;

  const chId = state.currentChId;
  const scrollHeight = sc.scrollHeight;
  const clientHeight = sc.clientHeight;
  const scrollTop = sc.scrollTop;
  const maxScroll = scrollHeight - clientHeight;

  // 內容尚未載入完整或高度尚未長出，嚴禁計算
  if (maxScroll <= 50) return;

  let pct = 0;
  if (scrollTop + clientHeight >= scrollHeight - 35) {
    // 距底部小於等於 35px 視為 100% 完讀
    pct = 100;
  } else if (scrollTop <= 10) {
    pct = 0;
  } else {
    // 1A: 以讀者眼睛實際看到的視線位置（視窗下緣 85%）計算閱讀進度
    const visibleBottom = scrollTop + (clientHeight * 0.85);
    pct = Math.min(99, Math.max(1, Math.round((visibleBottom / scrollHeight) * 100)));
  }

  const currentRecorded = state.chapterProgress[chId] || 0;
  if (pct > currentRecorded) {
    state.chapterProgress[chId] = pct;
    if (pct >= 100) {
      state.readChapters.add(chId);
      saveChapterProgressToStorage();
    } else {
      queueSaveChapterProgress();
    }
    // 2A: 0ms 即刻更新 UI
    updateChapterReadUi(chId);
  }
}

function markRead(chId) {
  state.chapterProgress[chId] = 100;
  state.readChapters.add(chId);
  saveChapterProgressToStorage();
  updateChapterReadUi(chId);
}

function resetChapterToUnread(chId) {
  state.chapterProgress[chId] = 0;
  state.readChapters.delete(chId);
  // 若正好是目前開啟的章節，鎖定載入並將滾動軸歸零，避免被滾動事件誤判
  if (state.currentChId === chId && els.mainContent) {
    state.isLoadingChapter = true;
    els.mainContent.scrollTop = 0;
    setTimeout(() => { state.isLoadingChapter = false; }, 250);
  }
  saveChapterProgressToStorage();
  updateChapterReadUi(chId);
  if (typeof window.pushSyncNow === 'function') {
    window.pushSyncNow();
  }
}

function toggleReadStatus(chId) {
  const pct = state.chapterProgress[chId] || 0;
  const isRead = pct >= 100 || state.readChapters.has(chId);
  const ch = (state.chapters || []).find(c => c.id === chId);
  const title = ch ? `${ch.num} ${ch.title}` : chId;

  if (isRead) {
    if (confirm(`本章目前已完讀 (100%)。\n確定要將「${title}」的研讀進度重設為 0% (未讀) 嗎？`)) {
      resetChapterToUnread(chId);
    }
  } else if (pct > 0) {
    if (confirm(`本章目前研讀進度為 ${pct}%。\n確定要將「${title}」的進度重設為 0% (未讀) 嗎？`)) {
      resetChapterToUnread(chId);
    }
  } else {
    alert(`💡 「${title}」目前尚未研讀（0%）。\n閱讀內容累積進度至章節最底部（100%），將自動判定完讀並點亮綠燈！`);
  }
}

function updateChapterReadUi(chId) {
  const item = $(`.ch-item[data-ch-id="${chId}"]`);
  if (!item) return;
  const pct = state.chapterProgress[chId] || 0;
  const isRead = pct >= 100 || state.readChapters.has(chId);
  item.classList.toggle('read', isRead);

  let statusEl = item.querySelector('.ch-status-indicator');
  if (!statusEl) {
    statusEl = document.createElement('span');
    statusEl.className = 'ch-status-indicator';
    item.appendChild(statusEl);
  }

  statusEl.className = 'ch-status-indicator ' + (isRead ? 'is-read' : (pct > 0 ? 'in-progress' : ''));
  const pctTag = statusEl.querySelector('.ch-pct-tag');
  if (pctTag && !isRead) {
    pctTag.textContent = `${pct}%`;
  } else {
    statusEl.innerHTML = isRead
      ? '<span class="ch-read-dot" title="🟢 100% 已研讀（點擊重設為未讀）"></span>'
      : `<span class="ch-pct-tag" title="📖 研讀進度 ${pct}%（需達 100% 才能標為已讀）">${pct}%</span>`;
  }
  if (chId === state.currentChId) updateReadingProgressPill();
}

window.updateChapterReadUi = updateChapterReadUi;

// ── 浮動研讀進度條：側欄收起時，仍看得到本章進度 ──────────
const MOBILE_BREAKPOINT = 768;

function isSidebarHidden() {
  const sb = els.sidebar;
  if (!sb) return true;
  if (window.innerWidth <= MOBILE_BREAKPOINT) return !sb.classList.contains('mobile-open');
  return sb.classList.contains('collapsed') || sb.classList.contains('hidden-desktop');
}

function updateReadingProgressPill() {
  const pill = document.getElementById('reading-progress-pill');
  if (!pill) return;
  const chId = state.currentChId;
  const ch = chId && (state.chapters || []).find(c => c.id === chId);
  const visible = Boolean(ch) && state.currentMode === 1 && isSidebarHidden();
  pill.classList.toggle('show', visible);
  if (!ch) return;

  const pct = state.chapterProgress[chId] || 0;
  const isRead = pct >= 100 || state.readChapters.has(chId);
  const shown = isRead ? 100 : pct;
  pill.classList.toggle('is-read', isRead);
  pill.querySelector('.rp-ch').textContent = ch.num;
  pill.querySelector('.rp-pct').textContent = isRead ? '✓ 完讀' : `${shown}%`;
  pill.querySelector('.rp-fill').style.transform = `scaleX(${shown / 100})`;
  pill.setAttribute('aria-label', `${ch.num} ${ch.title} 研讀進度 ${shown}%`);
}

function initReadingProgressPill() {
  const pill = document.getElementById('reading-progress-pill');
  if (!pill) return;
  pill.addEventListener('click', () => {
    if (window.innerWidth <= MOBILE_BREAKPOINT) {
      openMobileSidebar();
    } else {
      els.sidebar.classList.remove('collapsed');
    }
  });
  // 側欄開合、模式切換都會改 class，用 observer 統一同步，不必在每個入口各自呼叫
  const observer = new MutationObserver(updateReadingProgressPill);
  [els.sidebar, document.body].filter(Boolean).forEach(el => {
    observer.observe(el, { attributes: true, attributeFilter: ['class'] });
  });
  window.addEventListener('resize', updateReadingProgressPill, { passive: true });
  updateReadingProgressPill();
}

// ── 自動還原上次觀看進度 (1A + 2A + 3A) ─────────────────
let _restoreToastTimer = null;

function restoreChapterReadingProgress(chId) {
  const sc = els.mainContent;
  if (!sc) return;
  const savedPct = state.chapterProgress[chId] || 0;

  // 1A: 僅在 1% ~ 99% 時自動跳轉；若 0% 或已達 100% 則保留在頂部方便重讀
  if (savedPct < 1 || savedPct >= 100) return;

  // 等候 DOM 渲染與高度解析完成後平滑滾動
  setTimeout(() => {
    if (state.currentChId !== chId) return;
    const targetTop = scrollTopForProgress(sc, savedPct);
    if (targetTop === null) return;
    sc.scrollTo({ top: targetTop, behavior: 'smooth' });

    // 3A: 顯示輕量提示標籤
    showProgressRestoreToast(savedPct);
  }, 120);
}

/** 1A: 依視線位置（視窗下緣 85%）反算某 % 數對應的捲動位置；內容太短回傳 null */
function scrollTopForProgress(sc, pct) {
  const scrollHeight = sc.scrollHeight;
  const clientHeight = sc.clientHeight;
  const maxScroll = scrollHeight - clientHeight;
  if (maxScroll <= 25) return null;
  const visibleBottom = (scrollHeight * pct) / 100;
  return Math.max(0, Math.min(maxScroll, Math.round(visibleBottom - clientHeight * 0.85)));
}

function getProgressToastEl() {
  let toast = document.getElementById('progress-restore-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'progress-restore-toast';
    toast.className = 'progress-restore-toast';
    document.body.appendChild(toast);
  }
  return toast;
}

// ── 搜尋瀏覽模式：從搜尋結果跳進章節時，不動研讀進度 ─────────
function showSearchBrowseToast() {
  const toast = getProgressToastEl();
  toast.innerHTML = `
    <span class="toast-icon">🔍</span>
    <span>搜尋瀏覽中，<b>不計入</b>研讀進度</span>
    <button class="toast-btn-top" onclick="exitSearchBrowse()">回到上次進度</button>
    <button class="toast-close" onclick="hideProgressRestoreToast()" title="關閉（仍不計進度，點側欄本章可回到進度）">✕</button>
  `;
  requestAnimationFrame(() => toast.classList.add('show'));
  // 不自動消失：讓使用者隨時能回到原本的進度位置
  clearTimeout(_restoreToastTimer);
}

function exitSearchBrowse() {
  const chId = state.currentChId;
  state.searchBrowseChId = null;
  hideProgressRestoreToast();
  const sc = els.mainContent;
  if (!sc || !chId) return;

  // 同章節：回到搜尋前的位置；換了章節：回到記錄的 % 數位置（0% 或 100% 則回頂部）
  let targetTop = state.browseReturnTop;
  state.browseReturnTop = null;
  if (targetTop === null) {
    const pct = state.chapterProgress[chId] || 0;
    targetTop = (pct >= 1 && pct < 100) ? scrollTopForProgress(sc, pct) : 0;
  }
  // 直接跳回（不用平滑捲動），避免捲動途中經過的位置被誤記成進度
  sc.scrollTo({ top: targetTop || 0, behavior: 'auto' });
}

window.exitSearchBrowse = exitSearchBrowse;

function showProgressRestoreToast(pct) {
  const toast = getProgressToastEl();

  toast.innerHTML = `
    <span class="toast-icon">📍</span>
    <span>已自動跳轉至上次進度 <b>${pct}%</b></span>
    <button class="toast-btn-top" onclick="scrollToChapterTop()">回到頂部</button>
    <button class="toast-close" onclick="hideProgressRestoreToast()" title="關閉">✕</button>
  `;

  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  clearTimeout(_restoreToastTimer);
  _restoreToastTimer = setTimeout(() => {
    hideProgressRestoreToast();
  }, 4500);
}

function hideProgressRestoreToast() {
  clearTimeout(_restoreToastTimer);
  const toast = document.getElementById('progress-restore-toast');
  if (toast) {
    toast.classList.remove('show');
  }
}

function scrollToChapterTop() {
  hideProgressRestoreToast();
  if (els.mainContent) {
    els.mainContent.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

window.scrollToChapterTop = scrollToChapterTop;
window.hideProgressRestoreToast = hideProgressRestoreToast;

function resetAllChaptersToUnread() {
  if (!confirm('確定要將全書 60 章的研讀進度全部重設為 0% (未讀) 嗎？')) return;
  state.chapterProgress = {};
  state.readChapters.clear();
  localStorage.setItem('chProgress', JSON.stringify({}));
  localStorage.setItem('readCh', JSON.stringify([]));
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
  let readCount = 0;
  let inProgressCount = 0;
  let unreadCount = 0;
  let sumPct = 0;

  const chList = state.chapters || [];
  chList.forEach(ch => {
    const p = state.chapterProgress[ch.id] || 0;
    sumPct += p;
    if (p >= 100 || state.readChapters.has(ch.id)) {
      readCount++;
    } else if (p > 0) {
      inProgressCount++;
    } else {
      unreadCount++;
    }
  });

  const avgPct = total > 0 ? Math.round(sumPct / total) : 0;
  const contentEl = document.getElementById('progress-modal-content');
  if (contentEl) {
    // Generate chapter cards (一列4個，直接寫章節與 % 數)
    const cardsHtml = chList.map(ch => {
      const p = state.chapterProgress[ch.id] || 0;
      const isDone = p >= 100 || state.readChapters.has(ch.id);
      const bg = isDone ? 'rgba(22,163,74,0.1)' : (p > 0 ? 'rgba(232,119,34,0.1)' : 'var(--surface)');
      const borderColor = isDone ? 'rgba(22,163,74,0.35)' : (p > 0 ? 'rgba(232,119,34,0.35)' : 'var(--border)');
      const pctColor = isDone ? 'var(--success)' : (p > 0 ? 'var(--orange)' : 'var(--text-muted)');
      return `
        <div class="progress-ch-card" onclick="selectChapter('${ch.id}');closeProgressModal()" title="${ch.num} ${ch.title} (${p}%)" style="display:flex;align-items:center;justify-content:space-between;padding:7px 8px;border-radius:8px;border:1px solid ${borderColor};background:${bg};cursor:pointer;user-select:none;transition:all .15s">
          <span style="font-size:0.8rem;font-weight:800;color:var(--text);letter-spacing:-0.2px">${ch.num}</span>
          <span style="font-size:0.76rem;font-weight:800;color:${pctColor}">${p}%</span>
        </div>
      `;
    }).join('');

    contentEl.innerHTML = `
      <div style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <span style="font-size:1.15rem;font-weight:800;color:var(--text)">全書研讀總進度：${avgPct}%</span>
          <span style="font-size:0.85rem;font-weight:700;color:var(--text-muted)">(${readCount} / ${total} 章完讀)</span>
        </div>
        <div style="height:10px;background:var(--border);border-radius:5px;overflow:hidden;margin-bottom:10px">
          <div style="width:${avgPct}%;height:100%;background:linear-gradient(90deg, var(--orange), var(--success));border-radius:5px;transition:.4s"></div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:0.84rem;color:var(--text);padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:8px">
          <span>🟢 <b>已完讀 (100%)</b>：<span style="color:var(--success);font-weight:800">${readCount}</span> 章</span>
          <span>🟡 <b>研讀中</b>：<span style="color:var(--orange);font-weight:800">${inProgressCount}</span> 章</span>
          <span>🔴 <b>待研讀 (0%)</b>：<span style="color:#ef4444;font-weight:800">${unreadCount}</span> 章</span>
        </div>
      </div>

      <div style="margin-bottom:10px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-weight:800;font-size:0.92rem;color:var(--text)">📑 各章 % 數進度（一列 4 章）</span>
        <button class="modal-btn" onclick="resetAllChaptersToUnread()" style="background:#fee2e2;color:#dc2626;border:1px solid #fca5a5;padding:4px 10px;font-size:0.8rem;font-weight:700;border-radius:6px;cursor:pointer">
          🔴 一鍵全部標為未讀
        </button>
      </div>

      <div class="progress-ch-grid" style="display:grid;grid-template-columns:repeat(4, 1fr);gap:6px;max-height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;padding:8px;background:var(--bg)">
        ${cardsHtml}
      </div>

      <p style="font-size:0.78rem;color:var(--text-muted);margin-top:10px;margin-bottom:0">
        💡 提示：點擊任一章節卡片可直接跳轉。需滾動閱讀至章節最底部達 100% 才會自動判定已讀。
      </p>
    `;
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

  // Back to top floating button & Chapter reading progress tracker
  if (els.mainContent) {
    let scrollTicking = false;
    els.mainContent.addEventListener('scroll', () => {
      if (els.backToTop) {
        if (els.mainContent.scrollTop > 280) {
          els.backToTop.classList.remove('hidden');
        } else {
          els.backToTop.classList.add('hidden');
        }
      }
      if (!scrollTicking) {
        window.requestAnimationFrame(() => {
          checkChapterReadingProgress();
          scrollTicking = false;
        });
        scrollTicking = true;
      }
    }, { passive: true });

    window.addEventListener('beforeunload', saveChapterProgressToStorage);
    window.addEventListener('pagehide', saveChapterProgressToStorage);

    if (els.backToTop) {
      els.backToTop.addEventListener('click', () => {
        els.mainContent.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
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

  // Mode buttons：改由 HTML onclick="pickMode(n)" 處理（避免重複觸發）

  // 模式三側邊目錄：點項目先收起抽屜再捲動
  const m3Side = document.getElementById('m3-side-nav');
  if (m3Side) {
    m3Side.addEventListener('click', (e) => {
      if (e.target.closest('.m3-toc-item, .m3-toc-topic')) closeMobileSidebar();
    }, true);
  }

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

  });

  // Window resize: auto adjust mobile sidebar
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
      closeMobileSidebar();
    }
  });
}

// ── 使用者點選模式（頂部按鈕 / 側邊選單）──────────────
// 模式一、模式三：手機版直接打開側邊選單（模式一＝章節列表，模式三＝口試目錄）
function pickMode(mode) {
  switchMode(mode);
  if (window.innerWidth <= 768 && (mode === 1 || mode === 3)) {
    openMobileSidebar();
    requestAnimationFrame(() => {
      const sel = mode === 1 ? '#chapter-nav .ch-item.active' : '#m3-side-nav .m3-toc-item.active';
      document.querySelector(sel)?.scrollIntoView({ block: 'center' });
    });
  } else {
    closeMobileSidebar();
  }
}
window.pickMode = pickMode;

// ── 模式切換 ─────────────────────────────────────────
function switchMode(mode) {
  state.currentMode = mode;
  document.body.classList.toggle('mode-1', mode === 1);
  document.body.classList.toggle('mode-3', mode === 3);
  toggleLandscapeHeader(false);
  [1, 3].forEach(m => {
    $(`#mode${m}-btn`)?.classList.toggle('active', m === mode);
    $(`#side-mode${m}-btn`)?.classList.toggle('active', m === mode);
  });
  $('#mode3-container')?.classList.toggle('hidden', mode !== 3);
  $('#sidebar')?.classList.remove('hidden');
  if ($('#sidebar-toggle')) $('#sidebar-toggle').style.display = '';
  if (mode === 1) {
    $('#sidebar')?.classList.remove('hidden-desktop');
    $('#main-content')?.classList.remove('hidden');
    if (state.currentChId) {
      $('#welcome-screen')?.classList.add('hidden');
      $('#chapter-view')?.classList.remove('hidden');
    } else {
      $('#welcome-screen')?.classList.remove('hidden');
      $('#chapter-view')?.classList.add('hidden');
    }
  } else {
    $('#sidebar')?.classList.add('hidden-desktop');
    $('#main-content')?.classList.add('hidden');
    closeMobileSidebar();
    initMode3();
  }
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
window.selectChapter = selectChapter;
window.prevChapter = prevChapter;
window.nextChapter = nextChapter;
window.switchTab = switchTab;
window.closeProgressModal = closeProgressModal;
window.openProgressModal = openProgressModal;
window.toggleReadStatus = toggleReadStatus;
window.resetAllChaptersToUnread = resetAllChaptersToUnread;
window.closeMobileSidebar = closeMobileSidebar;

window.switchMode = switchMode;

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

// ── 章節開頭心智圖卡片（原始 SVG 圖譜縮圖，點擊放大檢視） ──
function renderChapterMindmapCard(cd, chId) {
  const fullTitle = `${cd.num || ''} ${cd.title || ''}`.trim();
  return `
    <div class="chapter-mindmap-card" data-ch-id="${escapeHtml(chId)}" data-title="${escapeHtml(fullTitle)}"
         onclick="openMindmapModal(this.dataset.chId, this.dataset.title)">
      <div class="mindmap-card-header">
        <div class="mindmap-card-badge">
          <span class="mindmap-badge-icon">🧠</span>
          <span class="mindmap-badge-text">本章核心架構心智圖</span>
        </div>
        <div class="mindmap-zoom-tip"><span class="zoom-icon">🔍</span> 點擊放大</div>
      </div>
      <div class="mindmap-card-preview">
        <img src="${dataUrl(`images/mindmaps/${chId}.svg`)}" alt="${escapeHtml(fullTitle)} 心智圖" loading="lazy" draggable="false"
             onerror="this.closest('.chapter-mindmap-card').remove()">
      </div>
    </div>`;
}

// ── 心智圖放大檢視器（縮放、拖曳） ──
const MINDMAP_MIN_SCALE = 0.4;
const MINDMAP_MAX_SCALE = 4.0;
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

function clampMindmapScale(scale) {
  return Number(Math.min(MINDMAP_MAX_SCALE, Math.max(MINDMAP_MIN_SCALE, scale)).toFixed(2));
}

const MINDMAP_FIT_RATIO = 0.94;

/**
 * 以實際寬高縮放圖片（而非 CSS scale），讓瀏覽器依新尺寸重新繪製 SVG，放大後文字才清晰。
 */
function sizeMindmapImage() {
  const img = document.getElementById('mindmap-modal-img');
  const container = document.getElementById('mindmap-canvas-container');
  if (!img || !container || !img.naturalWidth || !img.naturalHeight) return;
  const aspect = img.naturalWidth / img.naturalHeight;
  const fitWidth = Math.min(
    container.clientWidth * MINDMAP_FIT_RATIO,
    container.clientHeight * MINDMAP_FIT_RATIO * aspect
  );
  const width = fitWidth * mindmapViewer.scale;
  img.style.width = `${Math.round(width)}px`;
  img.style.height = `${Math.round(width / aspect)}px`;
}

function updateMindmapTransform() {
  const wrapper = document.getElementById('mindmap-transform-wrapper');
  const label = document.getElementById('mindmap-zoom-label');
  sizeMindmapImage();
  if (wrapper) {
    wrapper.style.transform = `translate(${mindmapViewer.translateX}px, ${mindmapViewer.translateY}px)`;
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
  if (!modal) return;

  if (titleText) titleText.textContent = `${title || chId} 核心架構圖譜`;
  if (img) {
    img.onload = updateMindmapTransform;
    img.src = dataUrl(`images/mindmaps/${chId}.svg`);
  }

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  mindmapResetZoom();
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
  mindmapViewer.scale = clampMindmapScale(mindmapViewer.scale * 1.25);
  updateMindmapTransform();
}

function mindmapZoomOut() {
  mindmapViewer.scale = clampMindmapScale(mindmapViewer.scale / 1.25);
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

  // 視窗大小或全螢幕切換時，重新計算圖片尺寸
  window.addEventListener('resize', () => {
    const modal = document.getElementById('mindmap-modal');
    if (modal && !modal.classList.contains('hidden')) updateMindmapTransform();
  });

  // 1. 滑鼠拖曳平移
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

  // 2. 滑鼠滾輪縮放
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.88;
    mindmapViewer.scale = clampMindmapScale(mindmapViewer.scale * factor);
    updateMindmapTransform();
  }, { passive: false });

  // 3. 手機觸控縮放平移
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
      mindmapViewer.scale = clampMindmapScale(mindmapViewer.initialPinchScale * ratio);
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
//   手機橫向（高度 ≤ 500px）時，模式一、口試重點的頂欄與側欄一律收起，
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
  // 模式一捲的是 #main-content，口試重點捲的是 #mode3-container
  const scrollers = [document.getElementById('main-content'), document.getElementById('mode3-container')].filter(Boolean);
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


/* ════════════════════════════════════════════════════════
   模式三：口試重點整理
   資料：chapters/oral_ch07.json
   （《緊急救護之道—EMT-P 術科考試全攻略》第七章 口試重點整理）
   ════════════════════════════════════════════════════════ */
const m3 = {
  data: null, loading: null, rendered: false, pendingTarget: null,
  view: (() => { try { return localStorage.getItem('m3_view') === 'practice' ? 'practice' : 'notes'; } catch (e) { return 'notes'; } })(),
  sections: null, secById: {}, marks: {},
  p: { filter: 'all', random: false, order: [], idx: 0, revealed: false, done: false },
};

async function initMode3(target) {
  if (target) m3.pendingTarget = target;
  if (!m3.data) {
    if (!m3.loading) {
      const getJson = url => fetch(dataUrl(url)).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
      // 情境題載入失敗不影響口試重點本身
      const scenarios = getJson('chapters/oral_scenarios.json').catch(e => {
        console.warn('[口試練習] 情境題載入失敗', e);
        return null;
      });
      m3.loading = Promise.all([getJson('chapters/oral_ch07.json'), scenarios])
        .then(([d, sc]) => { m3.data = d; m3.scenarios = sc; })
        .catch(e => { m3.loading = null; throw e; });
    }
    try { await m3.loading; }
    catch (e) {
      const box = document.getElementById('m3-content');
      if (box) box.innerHTML = '<div class="tb-msg" style="padding:40px 10px;text-align:center">口試重點載入失敗，請確認網路後再切換一次模式二。</div>';
      return;
    }
  }
  if (!m3.rendered) renderMode3();
  if (m3.pendingTarget) {
    const t = m3.pendingTarget; m3.pendingTarget = null;
    requestAnimationFrame(() => scrollToM3(t, false));
  }
}

/** 頁碼標籤：預設是術科攻略書頁；src（例 "CH52"）表示取自教科書該章 */
function m3PageLabel(x) {
  return x.src ? `${x.src} p.${x.page}` : `p.${x.page}`;
}

function m3Text(s) {
  return mdInline(escapeHtml(String(s == null ? '' : s)).replace(/&ast;/g, '*'));
}

/**
 * 記憶口訣框：text 是口訣本身；口訣下方可再接
 *   table（{headers, rows}）→ 對照表，timeline（[{t: 時間點, d: 發生什麼}]）→ 時間軸，
 * 取代一長串「A→B→C」或「X 是…、Y 是…」的文字；note 是放在最後的一行補充（※）。
 * @param {{text?: string, table?: {headers?: string[], rows: string[][]},
 *          timeline?: Array<{t: string, d: string}>, note?: string}} b
 * @param {(s: string) => string} fmt 行內格式化函式（各模式各自的 mdInline 包裝）
 */
function mnemonicHtml(b, fmt) {
  const steps = Array.isArray(b.timeline) ? b.timeline : [];
  const table = b.table && Array.isArray(b.table.rows) ? renderM3Table(b.table) : '';
  const timeline = steps.length
    ? `<ol class="mn-timeline">${steps.map(s =>
        `<li><span class="mn-tl-time">${fmt(s.t)}</span><span class="mn-tl-desc">${fmt(s.d)}</span></li>`).join('')}</ol>`
    : '';
  const note = b.note ? `<div class="mn-note">※ ${fmt(b.note)}</div>` : '';
  return `<div class="mnemonic-block"><div class="mnemonic-label">💡 記憶口訣</div>` +
    `<div class="mnemonic-text">${fmt(b.text || '')}</div>${table}${timeline}${note}</div>`;
}

function renderM3Table(b) {
  const headers = (b.headers || []);
  const hasHead = headers.some(h => String(h || '').trim());
  const ncol = Math.max(headers.length, ...(b.rows || []).map(r => r.length), 1);
  const cell = (c, tag) => `<${tag}>${m3Text(c)}</${tag}>`;
  let head = '';
  if (hasHead) {
    const filled = headers.filter(h => String(h || '').trim());
    head = filled.length === 1
      ? `<thead><tr><th colspan="${ncol}">${m3Text(filled[0])}</th></tr></thead>`
      : `<thead><tr>${headers.map(h => cell(h, 'th')).join('')}</tr></thead>`;
  }
  const body = (b.rows || []).map(r => {
    const nonEmpty = r.filter(c => String(c || '').trim());
    // 表內的分段小標（只有第一格有字、且是粗體）→ 跨欄顯示
    if (nonEmpty.length === 1 && String(r[0] || '').trim().startsWith('**') && r.length > 1) {
      return `<tr class="m3-subhead"><td colspan="${ncol}">${m3Text(r[0])}</td></tr>`;
    }
    return `<tr>${r.map(c => cell(c, 'td')).join('')}</tr>`;
  }).join('');
  return `<div class="comp-table-wrap"><table class="comp-table m3-table">${head}<tbody>${body}</tbody></table></div>`;
}

function renderM3ListItem(it) {
  if (typeof it === 'string') return m3Text(it);
  const sub = (it.sub || []).length ? `<ul class="sub-list">${it.sub.map(x => `<li>${renderM3ListItem(x)}</li>`).join('')}</ul>` : '';
  return m3Text(it.text || '') + sub;
}

/** 模式三內容區塊（文字／清單／表格／圖片）→ HTML；重點整理與口試練習答案共用 */
function m3BlockHtml(b) {
  switch (b.type) {
    case 'text':
      return `<p class="m3-text">${m3Text(b.text)}</p>`;
    case 'list':
      return `<ul class="content-list">${(b.items || []).map(i => `<li>${renderM3ListItem(i)}</li>`).join('')}</ul>`;
    case 'table':
      return renderM3Table(b);
    case 'blue':
      return `<div class="blue-heading">${m3Text(b.text)}</div>`;
    case 'mnemonic':
      return mnemonicHtml(b, m3Text);
    case 'clinical':
      return `<div class="clinical-block"><div class="clinical-label">${m3Text(b.label || '核心觀念 ‧ 臨床實務')}</div>` +
        `<ul>${(b.points || []).map(p => `<li>${m3Text(p)}</li>`).join('')}</ul></div>`;
    case 'image':
      return `
          <figure class="m3-figure">
            <img src="${escapeHtml(dataUrl(b.src))}" alt="${escapeHtml(b.alt || b.caption || '')}"${b.w && b.h ? ` width="${b.w}" height="${b.h}"` : ''} loading="lazy" onclick="openImageModal(this.src)">
            ${b.caption ? `<figcaption>${m3Text(b.caption)}<span class="m3-zoom-tip">🔍 點圖放大</span></figcaption>` : ''}
          </figure>`;
  }
  return '';
}

function renderMode3() {
  const d = m3.data;
  const box = document.getElementById('m3-content');
  if (!d || !box) return;
  let html = '';
  let lastPage = null;
  d.content.forEach(b => {
    const pg = b.page && b.page !== lastPage
      ? (b.src ? `<span class="sec-page" title="高級救護技術員教科書 ${escapeHtml(b.src)} 書頁">📕 ${escapeHtml(m3PageLabel(b))}</span>`
               : `<span class="sec-page" title="術科攻略 書頁">📖 p.${b.page}</span>`)
      : '';
    switch (b.type) {
      case 'topic':
        html += `<h2 class="m3-topic" id="m3-${b.id}">${m3Text(b.text)}</h2>`;
        break;
      case 'orange':
        html += `<div class="orange-heading m3-heading" id="m3-${b.id}">${m3Text(b.text)}${pg}</div>`;
        lastPage = b.page;
        break;
      default:
        html += m3BlockHtml(b);
    }
  });
  box.innerHTML = html;

  // 目錄（依大標題分組）
  let toc = '';
  let open = false;
  d.content.forEach(b => {
    if (b.type === 'topic') {
      if (open) toc += '</div>';
      toc += `<div class="m3-toc-group"><button class="m3-toc-topic" onclick="m3Goto('${b.id}')">${m3Text(b.text)}</button>`;
      open = true;
    } else if (b.type === 'orange') {
      if (!open) { toc += '<div class="m3-toc-group">'; open = true; }
      toc += `<button class="m3-toc-item" data-m3="${b.id}" onclick="m3Goto('${b.id}')"><span>${m3Text(String(b.text).replace(/\*\*/g, ''))}</span><em>${escapeHtml(m3PageLabel(b))}</em></button>`;
    }
  });
  if (open) toc += '</div>';
  ['m3-toc-list', 'm3-toc-list-mobile', 'm3-toc-list-side'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = toc; });

  // 捲動時標示目前段落、顯示回到頂端
  const sc = document.getElementById('mode3-container');
  const topBtn = document.getElementById('m3-back-to-top');
  if (sc && !sc.dataset.m3bound) {
    sc.dataset.m3bound = '1';
    let ticking = false;
    sc.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        if (topBtn) topBtn.classList.toggle('hidden', sc.scrollTop < 400);
        if (m3.view === 'practice') return;
        const heads = sc.querySelectorAll('.m3-heading');
        const top = sc.getBoundingClientRect().top + 90;
        let cur = null;
        heads.forEach(h => { if (h.getBoundingClientRect().top <= top) cur = h.id.replace('m3-', ''); });
        document.querySelectorAll('.m3-toc-item').forEach(el => el.classList.toggle('active', el.dataset.m3 === cur));
      });
    }, { passive: true });
  }
  m3.rendered = true;
  buildM3Sections();
  setM3View(m3.view, false);
}

// ══════════════════════════════════════════════════════
// 模式三：口試練習（每段一題 → 想好答案 → 翻答案 → 標記會了／不熟）
// ══════════════════════════════════════════════════════
const M3_MARKS_KEY = 'm3_oral_marks';
const M3_VIEW_KEY = 'm3_view';

function m3LoadMarks() {
  try { return JSON.parse(localStorage.getItem(M3_MARKS_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function m3SaveMarks() {
  try { localStorage.setItem(M3_MARKS_KEY, JSON.stringify(m3.marks)); } catch (e) { /* 無法儲存時只保留本次 */ }
}

function buildM3Sections() {
  const secs = [];
  let topic = null, cur = null;
  m3.data.content.forEach(b => {
    if (b.type === 'topic') { topic = b; cur = null; }
    else if (b.type === 'orange') {
      cur = { id: b.id, topicId: topic ? topic.id : '', topicTitle: topic ? topic.text : '', title: b.text, page: b.page, src: b.src, q: b.q || `請說明「${String(b.text).replace(/\*\*/g, '')}」。`, blocks: [] };
      secs.push(cur);
    } else if (cur) cur.blocks.push(b);
  });
  secs.push(...buildScenarioSections(m3.scenarios));
  m3.sections = secs;
  m3.secById = Object.fromEntries(secs.map(x => [x.id, x]));
  m3.marks = m3LoadMarks();
}

// 教科書各章「情境」→ 題目、「情境解答」→ 答案（chapters/oral_scenarios.json）
const M3_SCENARIO_TOPIC = 'sc';

function buildScenarioSections(sc) {
  return ((sc && sc.items) || []).map(it => ({
    id: `sc-${it.chId}`,
    topicId: M3_SCENARIO_TOPIC,
    topicTitle: '情境題',
    title: `${it.num} ${it.title}`,
    chId: it.chId,
    qBlocks: it.question || [],
    blocks: it.answer || [],
  }));
}

function m3OpenChapterNotes(chId) {
  switchMode(1);
  selectChapter(chId);
}

function setM3View(view, scroll = true) {
  m3.view = view === 'practice' ? 'practice' : 'notes';
  try { localStorage.setItem(M3_VIEW_KEY, m3.view); } catch (e) {}
  document.querySelectorAll('.m3-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === m3.view));
  const notes = document.getElementById('m3-content');
  const prac = document.getElementById('m3-practice');
  if (notes) notes.classList.toggle('hidden', m3.view !== 'notes');
  if (prac) prac.classList.toggle('hidden', m3.view !== 'practice');
  document.getElementById('mode3-container')?.classList.toggle('m3-practicing', m3.view === 'practice');
  if (m3.view === 'practice') {
    if (!m3.p.order.length) m3BuildOrder();
    renderM3Practice();
    if (scroll) m3ScrollToPractice();
  } else {
    document.querySelectorAll('.m3-toc-item').forEach(el => el.classList.remove('active'));
  }
}

function m3Shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

/** 依目前篩選（全部／主題／不熟）與順序（依序／隨機）建立題目順序 */
function m3BuildOrder(startId) {
  const f = m3.p.filter;
  let ids = m3.sections.filter(x =>
    f === 'all' ? true : f === 'unsure' ? m3.marks[x.id] === 'unsure' : f === 'new' ? !m3.marks[x.id] : x.topicId === f
  ).map(x => x.id);
  if (m3.p.random) m3Shuffle(ids);
  m3.p.order = ids;
  m3.p.idx = Math.max(0, startId ? ids.indexOf(startId) : 0);
  m3.p.revealed = false;
  m3.p.done = false;
}

function m3SetFilter(f) {
  m3.p.filter = f;
  m3BuildOrder();
  renderM3Practice();
}
function m3ToggleRandom() {
  m3.p.random = !m3.p.random;
  m3BuildOrder();
  renderM3Practice();
}
function m3Reveal() {
  m3.p.revealed = true;
  renderM3Practice();
}
function m3Step(d) {
  const n = m3.p.order.length;
  if (!n) return;
  if (m3.p.done) { m3.p.done = false; m3.p.idx = d < 0 ? n - 1 : 0; }
  else if (m3.p.idx + d >= n) { m3.p.done = true; }
  else m3.p.idx = Math.max(0, m3.p.idx + d);
  m3.p.revealed = false;
  renderM3Practice();
  m3ScrollToPractice();
}
function m3Mark(v) {
  const id = m3.p.order[m3.p.idx];
  if (!id) return;
  m3.marks[id] = v;
  m3SaveMarks();
  m3Step(1);
}
function m3ResetMarks() {
  if (!Object.keys(m3.marks).length) return;
  if (!confirm('確定要清除所有「會了／不熟」標記嗎？')) return;
  m3.marks = {};
  m3SaveMarks();
  m3BuildOrder();
  renderM3Practice();
}
function m3RestartUnsure() {
  m3.p.filter = 'unsure';
  m3BuildOrder();
  renderM3Practice();
  m3ScrollToPractice();
}
function m3SeeInNotes(id) {
  setM3View('notes', false);
  requestAnimationFrame(() => scrollToM3(id));
}

/** 目錄點擊：重點整理 → 捲到段落；口試練習 → 跳到該題（大標題 → 篩選該主題） */
function m3Goto(id) {
  if (m3.view !== 'practice') { scrollToM3(id); return; }
  const mob = document.getElementById('m3-toc-mobile');
  if (mob) mob.open = false;
  if (/^t\d+$/.test(id)) { m3.p.filter = id; m3BuildOrder(); }
  else {
    if (!m3.p.order.includes(id)) { m3.p.filter = 'all'; m3BuildOrder(id); }
    else { m3.p.idx = m3.p.order.indexOf(id); m3.p.revealed = false; m3.p.done = false; }
  }
  renderM3Practice();
  m3ScrollToPractice();
}

function m3ScrollToPractice() {
  const sc = document.getElementById('mode3-container');
  const el = document.getElementById('m3-view-tabs');
  if (!sc || !el) return;
  const y = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 8;
  if (sc.scrollTop > y) sc.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
}

function renderM3Practice() {
  const box = document.getElementById('m3-practice');
  if (!box || !m3.sections) return;
  const marks = m3.marks;
  const total = m3.sections.length;
  const okN = m3.sections.filter(x => marks[x.id] === 'ok').length;
  const unN = m3.sections.filter(x => marks[x.id] === 'unsure').length;
  const newN = total - okN - unN;
  const topics = (m3.data.topics || []);
  const f = m3.p.filter;
  const chip = (key, label) => `<button class="m3p-chip${f === key ? ' active' : ''}" onclick="m3SetFilter('${key}')">${label}</button>`;
  const shortTopic = { t1: 'EMS 系統', t2: '大傷／災難', t3: '毒核生化', [M3_SCENARIO_TOPIC]: '📋 情境題' };
  const scenarioN = m3.sections.filter(x => x.topicId === M3_SCENARIO_TOPIC).length;

  let html = `
    <div class="m3p-toolbar">
      <div class="m3p-chips">
        ${chip('all', `全部 ${total}`)}
        ${topics.map(t => chip(t.id, `${shortTopic[t.id] || t.title} ${m3.sections.filter(x => x.topicId === t.id).length}`)).join('')}
        ${scenarioN ? chip(M3_SCENARIO_TOPIC, `${shortTopic[M3_SCENARIO_TOPIC]} ${scenarioN}`) : ''}
        ${chip('unsure', `😵 不熟 ${unN}`)}
        ${chip('new', `⬜ 未練 ${newN}`)}
      </div>
      <div class="m3p-stats">
        <span>✅ 已會 <b>${okN}</b> / ${total} 題</span>
        <button class="m3p-link" onclick="m3ToggleRandom()">${m3.p.random ? '🔀 隨機出題中' : '🔢 依序出題'}</button>
        ${okN + unN ? '<button class="m3p-link m3p-reset" onclick="m3ResetMarks()">重設標記</button>' : ''}
      </div>
    </div>`;

  const n = m3.p.order.length;
  if (!n) {
    html += `<div class="m3p-card m3p-empty">${f === 'unsure' ? '目前沒有標記為「不熟」的題目 👍' : f === 'new' ? '每一題都練過了 🎉' : '沒有題目'}<div class="m3p-empty-actions"><button class="m3p-btn" onclick="m3SetFilter('all')">練習全部題目</button></div></div>`;
  } else if (m3.p.done) {
    const inRun = m3.p.order;
    const runOk = inRun.filter(id => marks[id] === 'ok').length;
    const runUn = inRun.filter(id => marks[id] === 'unsure').length;
    html += `
      <div class="m3p-card m3p-empty">
        <div class="m3p-done-title">🎉 這一輪 ${n} 題練完了！</div>
        <div class="m3p-done-sub">會了 ${runOk} 題 ・ 不熟 ${runUn} 題</div>
        <div class="m3p-empty-actions">
          ${unN ? `<button class="m3p-btn m3p-btn-unsure" onclick="m3RestartUnsure()">😵 再練不熟的 ${unN} 題</button>` : ''}
          <button class="m3p-btn" onclick="m3BuildOrder();renderM3Practice()">🔁 重新開始這一輪</button>
        </div>
      </div>`;
  } else {
    const sec = m3.secById[m3.p.order[m3.p.idx]];
    const mk = marks[sec.id];
    const badge = mk === 'ok' ? '<span class="m3p-badge ok">✅ 會了</span>' : mk === 'unsure' ? '<span class="m3p-badge unsure">😵 不熟</span>' : '';
    html += `
      <div class="m3p-card">
        <div class="m3p-meta">
          <span>第 <b>${m3.p.idx + 1}</b> / ${n} 題</span>
          <span class="m3p-topic">${m3Text(shortTopic[sec.topicId] || sec.topicTitle)}</span>
          <span class="m3p-page">${escapeHtml(sec.chId ? sec.title : m3PageLabel(sec))}</span>
          ${badge}
        </div>
        ${sec.qBlocks
          ? `<div class="m3p-q m3p-q-scenario"><span class="m3p-q-mark">Q</span><div>${sec.qBlocks.map(m3BlockHtml).join('')}</div></div>`
          : `<div class="m3p-q"><span class="m3p-q-mark">Q</span>${m3Text(sec.q)}</div>`}
        ${m3.p.revealed ? `
          <div class="m3p-answer">
            <div class="m3p-ans-title">📌 ${sec.chId ? '情境解答' : m3Text(sec.title)}</div>
            ${sec.blocks.map(m3BlockHtml).join('') || ''}
            ${sec.chId
              ? `<button class="m3p-link" onclick="m3OpenChapterNotes('${sec.chId}')">📖 到 ${escapeHtml(sec.title)} 筆記 →</button>`
              : `<button class="m3p-link" onclick="m3SeeInNotes('${sec.id}')">📖 在重點整理中查看 →</button>`}
          </div>
          <div class="m3p-judge">
            <button class="m3p-btn m3p-btn-unsure" onclick="m3Mark('unsure')">😵 不熟</button>
            <button class="m3p-btn m3p-btn-ok" onclick="m3Mark('ok')">✅ 會了</button>
          </div>` : `
          <p class="m3p-hint">先試著用口頭回答一次，再翻開答案對照。</p>
          <button class="m3p-btn m3p-btn-reveal" onclick="m3Reveal()">👀 顯示答案</button>`}
      </div>`;
  }
  if (n) {
    html += `
      <div class="m3p-nav">
        <button class="m3p-btn m3p-btn-ghost" onclick="m3Step(-1)" ${!m3.p.done && m3.p.idx === 0 ? 'disabled' : ''}>‹ 上一題</button>
        <button class="m3p-btn m3p-btn-ghost" onclick="m3Step(1)" ${m3.p.done ? 'disabled' : ''}>${m3.p.idx === n - 1 ? '完成這一輪 ›' : '跳過 ›'}</button>
      </div>`;
  }
  box.innerHTML = html;

  // 目錄同步標示目前題目
  const curId = !m3.p.done && n ? m3.p.order[m3.p.idx] : null;
  document.querySelectorAll('.m3-toc-item').forEach(el => el.classList.toggle('active', el.dataset.m3 === curId));
}

window.setM3View = setM3View;
window.m3SetFilter = m3SetFilter;
window.m3ToggleRandom = m3ToggleRandom;
window.m3Reveal = m3Reveal;
window.m3Step = m3Step;
window.m3Mark = m3Mark;
window.m3ResetMarks = m3ResetMarks;
window.m3RestartUnsure = m3RestartUnsure;
window.m3SeeInNotes = m3SeeInNotes;
window.m3OpenChapterNotes = m3OpenChapterNotes;
window.m3Goto = m3Goto;
window.m3BuildOrder = m3BuildOrder;
window.renderM3Practice = renderM3Practice;

function scrollToM3(id, smooth = true) {
  const el = document.getElementById('m3-' + id);
  const sc = document.getElementById('mode3-container');
  if (!el || !sc) return;
  // 先收起手機版目錄（它在內容上方，收起會改變段落位置），再計算捲動位置
  const mob = document.getElementById('m3-toc-mobile');
  if (mob) mob.open = false;
  const tabsEl = document.getElementById('m3-view-tabs');
  const tabsOffset = tabsEl ? (tabsEl.offsetHeight + 18) : 70;
  const y = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - tabsOffset;
  sc.scrollTo({ top: Math.max(0, y), behavior: smooth ? 'smooth' : 'auto' });
  el.classList.remove('m3-flash'); void el.offsetWidth; el.classList.add('m3-flash');
}

/** 從模式一（或任何地方）跳到模式三的某個段落 */
function openMode3(target) {
  m3.view = 'notes';
  if (m3.rendered) setM3View('notes', false);
  switchMode(3);
  initMode3(target);
}

/** 模式一被移走的段落 → 指向模式三的連結 */
function renderM3Ref(b) {
  return `
    <button class="m3-ref" onclick="openMode3('${escapeHtml(b.target)}')" title="這段內容與模式二（口試重點）重複，已整併過去">
      <span class="m3-ref-icon">📘</span>
      <span class="m3-ref-text">這段重複內容已整併至 <b>模式二：口試重點</b> › ${escapeHtml(b.text)}${b.page ? `（術科攻略 p.${b.page}）` : ''}</span>
      <span class="m3-ref-go">前往 →</span>
    </button>`;
}

window.openMode3 = openMode3;
window.scrollToM3 = scrollToM3;
