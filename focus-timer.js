/*
 * focus-timer.js — 電腦版右上角的「專注工作階段」計時器（番茄鐘）
 *
 * - 頂部列的計時按鈕開／關面板；面板收合後計時照常進行，按鈕上會顯示剩餘分鐘。
 * - 圓形刻度環：剩餘時間的刻度保持亮藍，已經過的刻度從 12 點鐘方向順時針變暗。
 * - 「⋯」選單可改時間長度（預設 15／25／45／60 分鐘或自訂）。
 * - 時間到：播放提示音、跳出系統通知（使用者有允許時），並在頁面中央彈出「該休息了」視窗。
 * - 狀態存在 localStorage，重新整理頁面後計時仍會接續。
 * - 依作息表自動計時（study-schedule.js）：每堂自習開始時自動開始倒數到下課並打開面板；
 *   中途才打開網頁就從剩餘時間開始。每堂只自動開始一次，手動暫停或重設後不會再被拉起來。
 *   「⋯」選單可關閉這個功能。
 */
(function () {
  'use strict';

  const STORE_KEY = 'focusTimer';
  const TICK_COUNT = 30;
  const PRESET_MINUTES = [15, 25, 45, 60];
  const DEFAULT_MINUTES = 25;
  const MIN_MINUTES = 1;
  const MAX_MINUTES = 180;
  const MS_PER_MIN = 60 * 1000;
  const TICK_INTERVAL_MS = 250;
  const RING = { center: 110, inner: 84, outer: 98 };
  const MINI_R = 15;
  const VIEW_KEY = 'focusTimerView';
  const STATUSES = ['idle', 'running', 'paused', 'done'];
  const AUTO_KEY = 'focusAutoSchedule';
  const HANDLED_KEY = 'focusScheduleSlot';
  const SCHEDULE_CHECK_MS = 15 * 1000;
  const MIN_AUTO_MS = MS_PER_MIN;
  const DESKTOP_QUERY = '(min-width: 901px)';
  const Sched = window.StudySchedule || null;

  const ICONS = {
    play: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l10.6-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z"/></svg>',
    pause: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
    reset: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
    more: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
    collapse: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>'
  };

  let timer = loadState();
  let intervalId = null;
  let endTimeoutId = null;
  let view = 'closed';
  let audioCtx = null;
  const ui = {};

  // ── 狀態 ───────────────────────────────────────────────

  function makeIdle(minutes) {
    const durationMs = minutes * MS_PER_MIN;
    return { durationMs, status: 'idle', endAt: 0, remainingMs: durationMs };
  }

  function isValidState(s) {
    return Boolean(s) && STATUSES.includes(s.status) &&
      Number.isFinite(s.durationMs) && s.durationMs >= MIN_MINUTES * MS_PER_MIN &&
      s.durationMs <= MAX_MINUTES * MS_PER_MIN &&
      Number.isFinite(s.remainingMs) && Number.isFinite(s.endAt);
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!isValidState(saved)) return makeIdle(DEFAULT_MINUTES);
      // 關掉網頁期間已經到時間：直接顯示「時間到」，不補播提示音
      if (saved.status === 'running' && saved.endAt <= Date.now()) {
        return { ...saved, status: 'done', endAt: 0, remainingMs: 0 };
      }
      return saved;
    } catch (err) {
      return makeIdle(DEFAULT_MINUTES);
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(timer));
    } catch (err) {
      // 無痕模式或儲存空間被封鎖時，計時器照常運作，只是重新整理後不會接續
    }
  }

  function setTimer(next) {
    timer = next;
    saveState();
    syncTicking();
    render();
  }

  function remainingMs() {
    if (timer.status === 'running') return Math.max(0, timer.endAt - Date.now());
    return timer.remainingMs;
  }

  // ── 操作 ───────────────────────────────────────────────

  // 從「時間到」再來一輪就變成一般計時，不再屬於作息表的某一堂
  function start() {
    unlockAudio();
    askNotificationPermission();
    const again = timer.status === 'done';
    const fromMs = again ? timer.durationMs : remainingMs();
    setTimer({ ...timer, slot: again ? null : timer.slot, status: 'running', endAt: Date.now() + fromMs, remainingMs: fromMs });
  }

  function pause() {
    setTimer({ ...timer, status: 'paused', endAt: 0, remainingMs: remainingMs() });
  }

  function reset() {
    setTimer(makeIdle(timer.durationMs / MS_PER_MIN));
  }

  function setDuration(minutes) {
    setTimer(makeIdle(minutes));
    closeMenu();
  }

  function toggleRun() {
    if (timer.status === 'running') pause();
    else start();
  }

  function finish() {
    setTimer({ ...timer, status: 'done', endAt: 0, remainingMs: 0 });
    playChime();
    showNotification();
    showRestModal();
  }

  // 畫面每 250ms 更新；另排一個單次 timeout 在結束時間點觸發，
  // 因為分頁在背景太久時 Chrome 會把 setInterval 降到每分鐘一次，單次 timeout 較不受影響
  function syncTicking() {
    const shouldTick = timer.status === 'running';
    clearTimeout(endTimeoutId);
    endTimeoutId = shouldTick ? setTimeout(onTick, remainingMs() + 50) : null;
    if (shouldTick && intervalId === null) {
      intervalId = setInterval(onTick, TICK_INTERVAL_MS);
    } else if (!shouldTick && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function onTick() {
    if (timer.status !== 'running') return;
    if (remainingMs() <= 0) finish();
    else render();
  }

  // ── 依作息表自動計時 ───────────────────────────────────

  function readStore(key) {
    try { return localStorage.getItem(key); } catch (err) { return null; }
  }

  function writeStore(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      // 儲存失敗時自動計時照常運作，只是重新整理後同一堂可能再自動開始一次
    }
  }

  function autoEnabled() { return Boolean(Sched) && readStore(AUTO_KEY) !== 'off'; }

  function setAutoEnabled(on) {
    writeStore(AUTO_KEY, on ? 'on' : 'off');
    if (on) checkSchedule();
  }

  // 計時器只在電腦版顯示；窄螢幕不自動開始，免得在看不到的地方響鈴
  function isDesktop() { return window.matchMedia(DESKTOP_QUERY).matches; }

  function currentSlotBlock() { return Sched && timer.slot ? Sched.blockFromSlot(timer.slot) : null; }

  // 每堂自習只處理一次：進入新的一堂就記下來，已經在計時（含手動計時）就不打擾
  function checkSchedule() {
    if (!autoEnabled() || !isDesktop()) return;
    const now = new Date();
    const block = Sched.blockAt(now);
    if (block && block.type === 'study') startSlotIfNew(now, block);
    if (view !== 'closed') renderSlot();
  }

  function startSlotIfNew(now, block) {
    const key = Sched.slotKey(now, block);
    if (readStore(HANDLED_KEY) === key) return;
    writeStore(HANDLED_KEY, key);
    const endAt = Sched.endDate(now, block).getTime();
    const leftMs = endAt - Date.now();
    if (isActive() || leftMs < MIN_AUTO_MS) return;
    setTimer({ durationMs: block.dur * MS_PER_MIN, status: 'running', endAt, remainingMs: leftMs, slot: key });
    closeRestModal('keep');
    openPanel();
  }

  // 自動開始時沒有使用者操作，瀏覽器不讓播音效；在第一次點擊或按鍵時先解鎖
  function unlockAudioOnFirstGesture() {
    const unlock = () => {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
      unlockAudio();
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
  }

  // ── 提示音與通知 ───────────────────────────────────────

  // 瀏覽器要求音效必須由使用者操作啟動，所以在按「開始」時先建立 AudioContext
  function unlockAudio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (err) {
      audioCtx = null;
    }
  }

  function playTone(freq, at) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.7);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(at);
    osc.stop(at + 0.75);
  }

  function playChime() {
    unlockAudio();
    if (!audioCtx) return;
    const notes = [880, 1174.66, 1567.98];
    const now = audioCtx.currentTime;
    for (let round = 0; round < 3; round++) {
      notes.forEach((freq, i) => playTone(freq, now + round * 1.1 + i * 0.16));
    }
  }

  function askNotificationPermission() {
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    try {
      const pending = Notification.requestPermission();
      if (pending && pending.catch) pending.catch(() => {});
    } catch (err) {
      // 不支援時略過，仍有提示音與面板提醒
    }
  }

  function showNotification() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const note = new Notification('專注工作階段結束', {
        body: restMessage(),
        icon: 'icons/icon-192.png',
        tag: 'focus-timer'
      });
      note.onclick = () => { window.focus(); note.close(); };
    } catch (err) {
      // 部分瀏覽器只允許由 service worker 發通知；失敗時仍有提示音與面板提醒
    }
  }

  // ── 休息提醒視窗 ───────────────────────────────────────

  // 沿用全站 .modal-overlay 樣式；app.js 偵測到開啟中的 .modal-overlay 會暫停鍵盤快捷鍵
  function buildRestModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay focus-rest-overlay hidden';
    overlay.innerHTML = `
      <div class="modal-box focus-rest-box" role="alertdialog" aria-modal="true"
           aria-labelledby="focus-rest-title" aria-describedby="focus-rest-text">
        <div class="focus-rest-icon" aria-hidden="true">☕</div>
        <h3 id="focus-rest-title" class="focus-rest-title">該休息了</h3>
        <p id="focus-rest-text" class="focus-rest-text"></p>
        <div class="focus-rest-actions">
          <button type="button" class="modal-btn ghost" data-rest="again">再專注一輪</button>
          <button type="button" class="modal-btn focus-rest-ok" data-rest="ok">好，去休息</button>
        </div>
      </div>`;
    overlay.addEventListener('click', e => {
      const btn = e.target.closest('[data-rest]');
      if (btn) closeRestModal(btn.dataset.rest);
      else if (e.target === overlay) closeRestModal('ok');
    });
    overlay.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeRestModal('ok');
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function restMessage() {
    const block = currentSlotBlock();
    if (block) return Sched.afterStudyText(block);
    const minutes = Math.round(timer.durationMs / MS_PER_MIN);
    return `已經專注 ${minutes} 分鐘了，起來動一動、喝口水，讓眼睛休息一下吧！`;
  }

  function showRestModal() {
    if (!ui.rest) return;
    ui.rest.querySelector('.focus-rest-text').textContent = restMessage();
    ui.restReturnFocus = document.activeElement;
    ui.rest.classList.remove('hidden');
    ui.rest.querySelector('.focus-rest-ok').focus();
  }

  // 'ok'：結束這輪、回到待命；'again'：立刻再開始一輪；'keep'：只關視窗（下一堂已自動開始）
  function closeRestModal(choice) {
    if (!ui.rest || ui.rest.classList.contains('hidden')) return;
    ui.rest.classList.add('hidden');
    if (choice === 'again') start();
    else if (choice === 'ok' && timer.status === 'done') reset();
    const back = ui.restReturnFocus;
    ui.restReturnFocus = null;
    if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
  }

  // ── 畫面 ───────────────────────────────────────────────

  function buildTicks({ inner, outer }) {
    const lines = [];
    for (let i = 0; i < TICK_COUNT; i++) {
      const angle = (i / TICK_COUNT) * Math.PI * 2;
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);
      const x1 = (RING.center + sin * inner).toFixed(2);
      const y1 = (RING.center - cos * inner).toFixed(2);
      const x2 = (RING.center + sin * outer).toFixed(2);
      const y2 = (RING.center - cos * outer).toFixed(2);
      lines.push(`<line class="focus-tick" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
    }
    return lines.join('');
  }

  // 縮小後的迷你列：只剩小刻度環與剩餘時間，點一下展開
  function miniMarkup() {
    return `
      <div class="focus-mini">
        <button class="focus-mini-main" type="button" data-act="expand" title="展開專注工作階段" aria-label="展開專注工作階段">
          <svg class="focus-mini-ring" viewBox="0 0 36 36" aria-hidden="true">
            <circle class="focus-mini-track" cx="18" cy="18" r="${MINI_R}"/>
            <circle class="focus-mini-arc" cx="18" cy="18" r="${MINI_R}" pathLength="100" stroke-dasharray="100 100"/>
          </svg>
          <span class="focus-mini-time"></span>
        </button>
        <button class="focus-mini-close" type="button" data-act="hide" title="隱藏（計時會繼續，頂部按鈕會顯示剩餘分鐘）" aria-label="隱藏迷你計時器">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>`;
  }

  function menuMarkup() {
    const presets = PRESET_MINUTES
      .map(m => `<button type="button" class="focus-preset" data-min="${m}">${m} 分</button>`)
      .join('');
    return `
      <div class="focus-menu" hidden>
        <div class="focus-menu-label">時間長度</div>
        <div class="focus-presets">${presets}</div>
        <form class="focus-custom">
          <input type="number" class="focus-custom-input" min="${MIN_MINUTES}" max="${MAX_MINUTES}" step="1" placeholder="自訂" aria-label="自訂分鐘數">
          <span class="focus-custom-unit">分鐘</span>
          <button type="submit" class="focus-custom-apply">套用</button>
        </form>
        <div class="focus-menu-hint">更改時間會重新開始計時</div>
        ${Sched ? `
        <label class="focus-auto" for="focus-auto-input">
          <input type="checkbox" id="focus-auto-input" class="focus-auto-input">
          <span>依作息表自動開始自習計時</span>
        </label>` : ''}
      </div>`;
  }

  function buildPanel() {
    const panel = document.createElement('section');
    panel.id = 'focus-panel';
    panel.className = 'focus-panel';
    panel.setAttribute('aria-label', '專注工作階段');
    panel.hidden = true;
    panel.innerHTML = `
      ${miniMarkup()}
      <div class="focus-head">
        <h2 class="focus-title">專注工作階段</h2>
        <button class="focus-ghost-btn" type="button" data-act="collapse" title="縮小（只顯示剩餘時間，計時會繼續）" aria-label="縮小面板">${ICONS.collapse}</button>
      </div>
      ${Sched ? `
      <div class="focus-slot">
        <span class="focus-slot-text"></span>
        <button class="focus-slot-link" type="button" data-act="schedule">作息表</button>
      </div>` : ''}
      <div class="focus-dial">
        <svg class="focus-ring" viewBox="0 0 220 220" aria-hidden="true">
          <circle class="focus-disc" cx="110" cy="110" r="106"/>
          ${buildTicks(RING)}
        </svg>
        <div class="focus-readout" role="timer">
          <div class="focus-big"><span class="focus-num"></span><span class="focus-unit"></span></div>
          <div class="focus-sub"></div>
        </div>
      </div>
      <div class="focus-controls">
        <button class="focus-round-btn focus-reset" type="button" data-act="reset" title="重設" aria-label="重設">${ICONS.reset}</button>
        <button class="focus-play" type="button" data-act="toggle"></button>
        <button class="focus-round-btn" type="button" data-act="menu" title="設定時間長度" aria-label="設定時間長度" aria-haspopup="true" aria-expanded="false">${ICONS.more}</button>
      </div>
      ${menuMarkup()}`;
    document.body.appendChild(panel);
    return panel;
  }

  function splitReadout(ms) {
    if (timer.status === 'done') return { num: '時間到', unit: '' };
    if (ms < MS_PER_MIN && timer.status !== 'idle') return { num: String(Math.ceil(ms / 1000)), unit: '秒' };
    return { num: String(Math.ceil(ms / MS_PER_MIN)), unit: '分鐘' };
  }

  function formatClock(ms) {
    const total = Math.ceil(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function subText(ms) {
    switch (timer.status) {
      case 'running': return formatClock(ms);
      case 'paused': return `已暫停 · ${formatClock(ms)}`;
      case 'done': return '休息一下吧';
      default: return '按下 ▶ 開始專注';
    }
  }

  function render() {
    const ms = remainingMs();
    const lit = timer.status === 'done' ? 0 : Math.ceil((ms / timer.durationMs) * TICK_COUNT);
    ui.ticks.forEach((tick, i) => tick.classList.toggle('lit', i >= TICK_COUNT - lit));
    const remainPct = timer.status === 'done' ? 0 : Math.min(100, (ms / timer.durationMs) * 100);
    ui.miniArc.setAttribute('stroke-dasharray', `${remainPct.toFixed(2)} 100`);
    ui.miniTime.textContent = timer.status === 'done' ? '時間到' : formatClock(ms);

    const { num, unit } = splitReadout(ms);
    ui.num.textContent = num;
    ui.unit.textContent = unit;
    ui.big.classList.toggle('is-text', timer.status === 'done');
    ui.sub.textContent = subText(ms);

    const running = timer.status === 'running';
    const playLabel = running ? '暫停' : (timer.status === 'done' ? '再來一輪' : '開始');
    ui.play.innerHTML = running ? ICONS.pause : ICONS.play;
    ui.play.title = playLabel;
    ui.play.setAttribute('aria-label', playLabel);
    ui.reset.disabled = timer.status === 'idle';
    ui.panel.dataset.status = timer.status;

    const durMin = timer.durationMs / MS_PER_MIN;
    ui.presets.forEach(b => b.classList.toggle('active', Number(b.dataset.min) === durMin));

    renderSlot();
    renderButton(ms);
  }

  function renderSlot() {
    if (!ui.slotText) return;
    ui.slotText.textContent = Sched.statusText(new Date());
    ui.slotText.parentElement.classList.toggle('is-auto', Boolean(currentSlotBlock()) && isActive());
    ui.autoInput.checked = autoEnabled();
  }

  function renderButton(ms) {
    const active = timer.status === 'running' || timer.status === 'paused';
    ui.btn.classList.toggle('is-running', timer.status === 'running');
    ui.btn.classList.toggle('is-paused', timer.status === 'paused');
    ui.btn.classList.toggle('is-done', timer.status === 'done');
    ui.badge.hidden = !active || view === 'mini';
    ui.badge.textContent = ms < MS_PER_MIN ? `${Math.ceil(ms / 1000)}s` : String(Math.ceil(ms / MS_PER_MIN));
    ui.btn.title = active
      ? `專注工作階段：剩 ${formatClock(ms)}${timer.status === 'paused' ? '（已暫停）' : ''}`
      : '專注工作階段（番茄鐘）';
  }

  // ── 面板開關 ───────────────────────────────────────────

  // view：'full' 完整面板／'mini' 只剩小刻度環與剩餘時間／'closed' 全部隱藏（頂部按鈕仍顯示剩餘分鐘）
  function isActive() { return timer.status === 'running' || timer.status === 'paused'; }

  function saveView() {
    try {
      localStorage.setItem(VIEW_KEY, view === 'mini' ? 'mini' : 'closed');
    } catch (err) {
      // 儲存失敗只影響重新整理後是否還原迷你列
    }
  }

  function setView(next) {
    view = next;
    if (next !== 'full') closeMenu();
    ui.panel.hidden = next === 'closed';
    ui.panel.classList.toggle('is-mini', next === 'mini');
    ui.btn.setAttribute('aria-expanded', String(next === 'full'));
    saveView();
    // 看過「時間到」並收合後，回到待命狀態，按鈕不再一直提示
    if (next !== 'full' && timer.status === 'done') reset();
    else render();
  }

  function openPanel() { setView('full'); }

  // 縮小：計時中或暫停中 → 迷你列；沒在計時 → 直接隱藏
  function collapse() { setView(isActive() ? 'mini' : 'closed'); }

  function openMenu() {
    ui.menu.hidden = false;
    ui.menuBtn.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    ui.menu.hidden = true;
    ui.menuBtn.setAttribute('aria-expanded', 'false');
  }

  function onPanelClick(e) {
    const btn = e.target.closest('button');
    if (!btn || btn.type === 'submit') return;
    if (btn.dataset.min) { setDuration(Number(btn.dataset.min)); return; }
    switch (btn.dataset.act) {
      case 'toggle': toggleRun(); break;
      case 'reset': reset(); break;
      case 'collapse': collapse(); break;
      case 'expand': openPanel(); break;
      case 'hide': setView('closed'); break;
      case 'schedule': Sched.openModal(); break;
      case 'menu': if (ui.menu.hidden) openMenu(); else closeMenu(); break;
      default: break;
    }
  }

  function onCustomSubmit(e) {
    e.preventDefault();
    const minutes = Math.round(Number(ui.customInput.value));
    if (!ui.customInput.value || !Number.isFinite(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
      ui.customInput.setCustomValidity(`請輸入 ${MIN_MINUTES}–${MAX_MINUTES} 分鐘`);
      ui.customInput.reportValidity();
      return;
    }
    ui.customInput.setCustomValidity('');
    ui.customInput.value = '';
    setDuration(minutes);
  }

  function onDocumentPointer(e) {
    if (view !== 'full') return;
    const insidePanel = ui.panel.contains(e.target) || ui.btn.contains(e.target);
    if (!insidePanel) { collapse(); return; }
    const insideMenu = ui.menu.contains(e.target) || ui.menuBtn.contains(e.target);
    if (!ui.menu.hidden && !insideMenu) closeMenu();
  }

  function onKeydown(e) {
    if (e.key !== 'Escape' || view !== 'full') return;
    if (!ui.menu.hidden) closeMenu();
    else collapse();
  }

  function restoreView() {
    let saved = null;
    try { saved = localStorage.getItem(VIEW_KEY); } catch (err) { saved = null; }
    if (saved === 'mini' && isActive()) setView('mini');
  }

  // ── 初始化 ─────────────────────────────────────────────

  function init() {
    ui.btn = document.getElementById('focus-btn');
    ui.badge = document.getElementById('focus-badge');
    if (!ui.btn || !ui.badge) return;
    ui.panel = buildPanel();
    const q = sel => ui.panel.querySelector(sel);
    ui.ticks = Array.from(ui.panel.querySelectorAll('.focus-ring .focus-tick'));
    ui.miniArc = q('.focus-mini-arc');
    ui.miniTime = q('.focus-mini-time');
    ui.big = q('.focus-big');
    ui.num = q('.focus-num');
    ui.unit = q('.focus-unit');
    ui.sub = q('.focus-sub');
    ui.play = q('.focus-play');
    ui.reset = q('.focus-reset');
    ui.menu = q('.focus-menu');
    ui.menuBtn = q('[data-act="menu"]');
    ui.presets = Array.from(ui.panel.querySelectorAll('.focus-preset'));
    ui.customInput = q('.focus-custom-input');
    ui.slotText = q('.focus-slot-text');
    ui.autoInput = q('.focus-auto-input');
    ui.rest = buildRestModal();

    ui.btn.addEventListener('click', () => (view === 'full' ? collapse() : openPanel()));
    ui.panel.addEventListener('click', onPanelClick);
    q('.focus-custom').addEventListener('submit', onCustomSubmit);
    ui.customInput.addEventListener('input', () => ui.customInput.setCustomValidity(''));
    document.addEventListener('pointerdown', onDocumentPointer);
    document.addEventListener('keydown', onKeydown);
    // 分頁在背景時計時器會被瀏覽器降頻；回到前景立刻校正
    document.addEventListener('visibilitychange', onTick);

    syncTicking();
    render();
    restoreView();
    initSchedule();
  }

  function initSchedule() {
    if (!Sched) return;
    ui.autoInput.addEventListener('change', () => setAutoEnabled(ui.autoInput.checked));
    unlockAudioOnFirstGesture();
    document.addEventListener('visibilitychange', checkSchedule);
    setInterval(checkSchedule, SCHEDULE_CHECK_MS);
    checkSchedule();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
