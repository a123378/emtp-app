/*
 * study-schedule.js — 每日自習作息表
 *
 * - 提供作息資料與查詢函式給 focus-timer.js：每堂自習開始時自動開啟專注計時器。
 * - 「每日作息」視窗：分上午／下午／晚上三欄，標出現在進行到哪一段。
 * - 也能在 Node 載入，供 scripts/test-study-schedule.js 測試純函式。
 */
(function (root) {
  'use strict';

  // [開始, 結束, 名稱]，時間為 HHMM；結束 0000 代表午夜
  const SCHEDULE = [
    ['0830', '0915', '自習1'], ['0915', '0930', '休息'],
    ['0930', '1015', '自習2'], ['1015', '1030', '休息'],
    ['1030', '1115', '自習3'], ['1115', '1130', '休息'],
    ['1130', '1215', '自習4'], ['1215', '1345', '午餐'],
    ['1345', '1430', '自習5'], ['1430', '1445', '休息'],
    ['1445', '1530', '自習6'], ['1530', '1545', '休息'],
    ['1545', '1630', '自習7'], ['1630', '1645', '休息'],
    ['1645', '1730', '自習8'], ['1730', '1900', '晚餐'],
    ['1900', '1945', '自習9'], ['1945', '2000', '休息'],
    ['2000', '2045', '自習10'], ['2045', '2100', '休息'],
    ['2100', '2145', '自習11'], ['2145', '0000', '盥洗']
  ];
  const MIN_PER_DAY = 24 * 60;
  const PERIOD_NAMES = ['上午', '下午', '晚上'];
  const MODAL_REFRESH_MS = 30 * 1000;

  // ── 純函式 ─────────────────────────────────────────────

  const pad = n => String(n).padStart(2, '0');
  const toMin = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2));
  const formatMin = m => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
  const minutesOf = date => date.getHours() * 60 + date.getMinutes();

  function typeOf(name) {
    if (name.startsWith('自習')) return 'study';
    if (name === '休息') return 'rest';
    if (name === '盥洗') return 'wash';
    return 'meal';
  }

  function durationText(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (!h) return `${m} 分鐘`;
    return m ? `${h} 小時 ${m} 分鐘` : `${h} 小時`;
  }

  const BLOCKS = Object.freeze(SCHEDULE.map(([from, to, name], index) => {
    const start = toMin(from);
    const rawEnd = toMin(to);
    const end = rawEnd <= start ? rawEnd + MIN_PER_DAY : rawEnd;
    const type = typeOf(name);
    const num = type === 'study' ? name.slice(2) : '';
    return Object.freeze({ index, start, end, dur: end - start, type, name, num, label: num ? `自習 ${num}` : name });
  }));

  function blockAt(date) {
    const m = minutesOf(date);
    return BLOCKS.find(b => m >= b.start && m < b.end) || null;
  }

  function nextStudy(date) {
    const m = minutesOf(date);
    return BLOCKS.find(b => b.type === 'study' && b.start > m) || null;
  }

  // 該段在 date 這一天的結束時刻；盥洗的 24:00 會自動進位成隔天 00:00
  function endDate(date, block) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setMinutes(block.end);
    return d;
  }

  function slotKey(date, block) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}#${block.index}`;
  }

  function blockFromSlot(key) {
    const index = Number(String(key || '').split('#')[1]);
    return Number.isInteger(index) ? BLOCKS[index] || null : null;
  }

  function afterStudyText(block) {
    const after = BLOCKS[block.index + 1];
    const next = BLOCKS.slice(block.index + 1).find(b => b.type === 'study');
    if (!next) return `${block.label} 結束了，今天的自習全部完成，去盥洗準備休息吧！`;
    const what = after.type === 'rest'
      ? `休息 ${durationText(after.dur)}`
      : `${after.name}時間 ${durationText(after.dur)}`;
    return `${block.label} 結束了，${what}，${formatMin(next.start)} 開始${next.label}。`;
  }

  // 計時器面板上的一行狀態
  function statusText(date) {
    const cur = blockAt(date);
    if (cur && cur.type === 'study') return `${cur.label} · ${formatMin(cur.start)}–${formatMin(cur.end)}`;
    const next = nextStudy(date);
    if (!next) return '今天的自習已全部完成';
    const prefix = cur ? `${cur.name}中 · ` : '';
    return `${prefix}${formatMin(next.start)} 開始${next.label}`;
  }

  // ── 每日作息視窗（只在瀏覽器使用） ─────────────────────

  const modal = { el: null, rows: [], now: null, timerId: null, returnFocus: null };

  function makeEl(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderRow(b) {
    const row = makeEl('div', `sched-row ${b.type}`);
    if (b.type === 'rest') {
      row.append(makeEl('span', 'sched-time', formatMin(b.start)), makeEl('span', 'sched-rule'),
        makeEl('span', null, `休息 ${b.dur} 分`));
      return row;
    }
    const name = makeEl('span', 'sched-name');
    if (b.type === 'study') name.append('自習', makeEl('b', 'sched-num', b.num));
    else name.textContent = b.name;
    row.append(name, makeEl('span', 'sched-time', `${formatMin(b.start)} – ${formatMin(b.end)}`));
    return row;
  }

  // 每遇到用餐或盥洗就換下一欄：上午接午餐、下午接晚餐、晚上接盥洗
  function groupByPeriod() {
    const groups = [[]];
    BLOCKS.forEach(b => {
      groups[groups.length - 1].push(b);
      if (b.type !== 'study' && b.type !== 'rest' && groups.length < PERIOD_NAMES.length) groups.push([]);
    });
    return groups;
  }

  function renderPeriods(host) {
    groupByPeriod().forEach((group, idx) => {
      const studies = group.filter(b => b.type === 'study');
      const col = makeEl('section', 'sched-period');
      const head = makeEl('div', 'sched-period-head');
      head.append(makeEl('h4', null, PERIOD_NAMES[idx]),
        makeEl('span', null, `自習 ${studies[0].num}–${studies[studies.length - 1].num}`));
      const rows = group.map(renderRow);
      modal.rows.push(...rows);
      col.append(head, ...rows);
      host.append(col);
    });
  }

  function buildModal() {
    const studies = BLOCKS.filter(b => b.type === 'study');
    const studyMin = studies.reduce((sum, b) => sum + b.dur, 0);
    const overlay = makeEl('div', 'modal-overlay sched-overlay hidden');
    overlay.innerHTML = `
      <div class="modal-box large sched-box" role="dialog" aria-modal="true" aria-labelledby="sched-title">
        <div class="modal-header">
          <h3 id="sched-title">每日作息</h3>
          <button type="button" class="modal-close" data-sched-close aria-label="關閉">✕</button>
        </div>
        <div class="modal-body">
          <div class="sched-top">
            <div class="sched-now" aria-live="polite"></div>
            <div class="sched-summary"></div>
          </div>
          <div class="sched-periods"></div>
        </div>
      </div>`;
    overlay.querySelector('.sched-summary').textContent =
      `自習 ${studies.length} 堂，共 ${durationText(studyMin)}`;
    modal.now = overlay.querySelector('.sched-now');
    renderPeriods(overlay.querySelector('.sched-periods'));
    overlay.addEventListener('click', e => {
      if (e.target === overlay || e.target.closest('[data-sched-close]')) closeModal();
    });
    overlay.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeModal();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function refreshModal() {
    const now = new Date();
    const cur = blockAt(now);
    const m = minutesOf(now);
    modal.now.textContent = cur
      ? `現在 ${formatMin(m)} · ${cur.label}，還剩 ${cur.end - m} 分鐘`
      : `現在 ${formatMin(m)} · ${statusText(now)}`;
    modal.rows.forEach((row, i) => {
      row.classList.toggle('is-now', BLOCKS[i] === cur);
      row.classList.toggle('is-past', m >= BLOCKS[0].start && m >= BLOCKS[i].end);
    });
  }

  function openModal() {
    if (!modal.el) modal.el = buildModal();
    modal.returnFocus = document.activeElement;
    refreshModal();
    modal.el.classList.remove('hidden');
    modal.el.querySelector('[data-sched-close]').focus();
    clearInterval(modal.timerId);
    modal.timerId = setInterval(refreshModal, MODAL_REFRESH_MS);
  }

  function closeModal() {
    if (!modal.el || modal.el.classList.contains('hidden')) return;
    modal.el.classList.add('hidden');
    clearInterval(modal.timerId);
    modal.timerId = null;
    const back = modal.returnFocus;
    modal.returnFocus = null;
    if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
  }

  const api = {
    BLOCKS, blockAt, nextStudy, endDate, slotKey, blockFromSlot,
    afterStudyText, statusText, formatMin, openModal, closeModal
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StudySchedule = api;
})(typeof window !== 'undefined' ? window : globalThis);
