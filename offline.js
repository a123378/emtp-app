/*
 * offline.js — 離線版控制（註冊 sw.js、側欄「下載離線版」按鈕、進度顯示）
 *
 * - 第一次按側欄按鈕：下載全部章節與圖片（離線包）。
 * - 下載過之後：連網開啟網頁時會在背景只補抓有變動的檔案（省流量模式下不做）。
 * - 斷網時：網頁、章節、題庫、心智圖都從裝置裡的快取讀取。
 */
(function () {
  'use strict';

  const PACK_FLAG = 'offlinePack';
  const SHELL_REFRESH_TIMEOUT_MS = 6000;
  const WATCHDOG_MS = 20000;            // 這麼久沒收到進度，就向 sw.js 確認是否還在下載
  const AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000;

  const view = {
    supported: 'serviceWorker' in navigator && location.protocol !== 'file:',
    version: null,
    fileCount: 0,
    syncedAt: null,
    expectedBytes: 0,
    syncing: false,
    done: 0,
    total: 0,
    error: null
  };

  let manualSync = false;
  let lastAutoSync = 0;
  let watchdogTimer = null;
  let shellRefreshResolver = null;

  // ── 小工具 ─────────────────────────────────────────

  const $ = id => document.getElementById(id);

  function readFlag() {
    try { return localStorage.getItem(PACK_FLAG) === '1'; } catch (e) { return false; }
  }

  function writeFlag() {
    try { localStorage.setItem(PACK_FLAG, '1'); } catch (e) { /* 私密瀏覽等情況，略過 */ }
  }

  function saveDataOn() {
    return Boolean(navigator.connection && navigator.connection.saveData);
  }

  function formatMB(bytes) {
    return bytes > 0 ? `${(bytes / 1048576).toFixed(1)} MB` : '';
  }

  function toast(text, ms = 2600) {
    const el = document.createElement('div');
    el.className = 'offline-toast';
    el.setAttribute('role', 'status');
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  async function postToWorker(message) {
    if (!view.supported) return false;
    try {
      const reg = await navigator.serviceWorker.ready;
      if (!reg.active) return false;
      reg.active.postMessage(message);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ── 看門狗：sw.js 在下載途中被系統關掉時，不會再有任何訊息 ──

  function armWatchdog() {
    clearTimeout(watchdogTimer);
    watchdogTimer = view.syncing ? setTimeout(() => postToWorker({ type: 'offline:status' }), WATCHDOG_MS) : null;
  }

  // ── 側欄按鈕 ───────────────────────────────────────

  function bannerText() {
    if (view.syncing) {
      const pct = view.total ? Math.floor((view.done / view.total) * 100) : 0;
      return { title: `⏬ 下載離線版中… ${pct}%`, tag: view.total ? `${view.done}/${view.total}` : '準備中' };
    }
    if (view.error && !view.version) {
      return { title: '⚠️ 離線版下載未完成', tag: '點此重試' };
    }
    if (view.version) {
      return { title: '✅ 已可離線使用', tag: navigator.onLine ? '已下載' : '離線中' };
    }
    return { title: '📥 下載離線版', tag: formatMB(view.expectedBytes) || (navigator.onLine ? '全部內容' : '需連網') };
  }

  function render() {
    const banner = $('offline-banner');
    if (!banner) return;
    banner.classList.toggle('hidden', !view.supported);
    const { title, tag } = bannerText();
    $('offline-banner-title').textContent = title;
    $('offline-banner-tag').textContent = tag;
    banner.classList.toggle('is-ready', Boolean(view.version) && !view.syncing);
  }

  async function startSync({ manual }) {
    if (!navigator.onLine) {
      if (manual) alert('目前沒有網路，請連上網路（建議 Wi-Fi）後再下載離線版。');
      return;
    }
    if (manual) {
      manualSync = true;
      writeFlag();
      try {
        if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
      } catch (e) { /* 不支援就算了，快取一樣能用 */ }
    }
    view.error = null;
    if (manual) {
      // 自動補抓時先不顯示進度，等 sw.js 回報真的有檔案要下載再顯示
      view.syncing = true;
      view.done = 0;
      view.total = 0;
      render();
      armWatchdog();
    }
    const sent = await postToWorker({ type: 'offline:sync' });
    if (!sent) {
      view.syncing = false;
      view.error = '離線功能尚未啟動，請重新整理網頁後再試一次。';
      armWatchdog();
      render();
      if (manual) alert(view.error);
    }
  }

  /** 只有「已經下載過離線包」的裝置才自動補抓更新，且有節流、省流量模式下不做 */
  function maybeAutoSync() {
    const due = Date.now() - lastAutoSync > AUTO_SYNC_INTERVAL_MS;
    if (!readFlag() || !view.version || view.syncing || !navigator.onLine || saveDataOn() || !due) return;
    lastAutoSync = Date.now();
    startSync({ manual: false });
  }

  function onBannerClick() {
    if (view.syncing) {
      toast(view.total ? `正在下載離線版：${view.done}/${view.total} 個檔案` : '正在檢查要下載的檔案…');
      return;
    }
    if (view.version) {
      const when = view.syncedAt ? new Date(view.syncedAt).toLocaleString('zh-TW') : '—';
      const size = formatMB(view.expectedBytes);
      const ok = confirm(`✅ 已可離線使用\n\n共 ${view.fileCount} 個檔案${size ? `，${size}` : ''}\n最後更新：${when}\n\n按「確定」立即檢查並下載更新。`);
      if (ok) startSync({ manual: true });
      return;
    }
    const size = formatMB(view.expectedBytes);
    const ok = confirm(`要把全部章節、題庫與圖片下載到這台裝置${size ? `（約 ${size}）` : ''}嗎？\n\n下載後沒有網路也能讀筆記、做題目。建議使用 Wi-Fi。\n（AI 出題、跨裝置同步仍需網路）`);
    if (ok) startSync({ manual: true });
  }

  // ── 接收 sw.js 的訊息 ──────────────────────────────

  function onStatus(msg) {
    const wasSyncing = view.syncing;
    view.version = msg.version;
    view.fileCount = msg.fileCount;
    view.syncedAt = msg.syncedAt;
    if (msg.totalBytes) view.expectedBytes = msg.totalBytes;
    view.syncing = msg.syncing;
    if (wasSyncing && !msg.syncing) {
      // 下載途中 sw.js 被系統中止；已下載的檔案都保留，重試只會補抓剩下的
      view.error = '下載中斷';
      if (manualSync || !view.version) toast('⚠️ 離線版下載中斷，再按一次會從中斷處繼續', 4000);
      manualSync = false;
    } else if (!msg.version && readFlag() && !msg.syncing) {
      view.error = '上次下載未完成'; // 不自動重抓，避免在行動網路下默默下載
    }
    maybeAutoSync();
  }

  function onDone(msg) {
    const firstTime = !view.version;
    view.syncing = false;
    view.error = null;
    view.version = msg.version;
    view.fileCount = msg.fileCount;
    view.expectedBytes = msg.totalBytes || view.expectedBytes;
    view.syncedAt = new Date().toISOString();
    if (firstTime) toast('✅ 離線版下載完成，沒有網路也能使用了');
    else if (msg.downloaded > 0) toast(`🔄 離線版已更新（${msg.downloaded} 個檔案）`);
    else if (manualSync) toast('✅ 離線版已是最新內容');
    manualSync = false;
  }

  function onWorkerMessage(event) {
    const msg = event.data || {};
    switch (msg.type) {
      case 'offline:status':
        onStatus(msg);
        break;
      case 'offline:progress':
        // 背景檢查發現沒有要補抓的檔案（total 0）時不顯示進度，避免按鈕閃一下
        view.syncing = msg.total > 0 || manualSync;
        view.done = msg.done;
        view.total = msg.total;
        break;
      case 'offline:done':
        onDone(msg);
        break;
      case 'offline:error':
        view.syncing = false;
        view.error = msg.message;
        if (manualSync || !view.version) toast(`⚠️ 離線版下載失敗：${msg.message}，稍後可再按一次重試`, 4000);
        manualSync = false;
        break;
      case 'offline:shell-refreshed':
        if (shellRefreshResolver) shellRefreshResolver();
        return;
      default:
        return;
    }
    armWatchdog();
    render();
  }

  async function fetchExpectedSize() {
    if (!navigator.onLine) return;
    try {
      const res = await fetch('offline-files.json', { cache: 'no-store' });
      if (!res.ok) return;
      const m = await res.json();
      if (typeof m.totalBytes === 'number' && !view.version) {
        view.expectedBytes = m.totalBytes;
        render();
      }
    } catch (e) { /* 拿不到大小就不顯示 */ }
  }

  // ── 給 app.js「強制更新」用 ────────────────────────

  /** 重抓網頁本體（不刪離線包）。沒有 Service Worker 時直接結束。 */
  async function refreshShell() {
    const waitForAck = new Promise(resolve => {
      shellRefreshResolver = resolve;
      setTimeout(resolve, SHELL_REFRESH_TIMEOUT_MS);
    });
    const sent = await postToWorker({ type: 'offline:refresh-shell' });
    if (sent) await waitForAck;
    shellRefreshResolver = null;
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update();
    } catch (e) { /* 斷網時更新不了，照舊 */ }
  }

  // ── 電腦本機版（開啟離線版.bat）：讓伺服器知道網頁還開著，全部關掉後它會自動停止 ──

  const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];
  const LOCAL_HEARTBEAT_MS = 20000;

  function startLocalPresence() {
    if (!LOCAL_HOSTS.includes(location.hostname)) return;
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const url = kind => `/__/local-${kind}?id=${id}`;
    let timer = null;
    const ping = () => fetch(url('heartbeat'), { cache: 'no-store' })
      .then(res => { if (res.status === 404) clearInterval(timer); }) // 不是本機版伺服器（例如一般測試伺服器）
      .catch(() => {});
    ping();
    timer = setInterval(ping, LOCAL_HEARTBEAT_MS);
    window.addEventListener('pagehide', () => {
      if (navigator.sendBeacon) navigator.sendBeacon(url('bye'));
    });
    window.addEventListener('pageshow', e => { if (e.persisted) ping(); });
  }

  // ── 啟動 ───────────────────────────────────────────

  function bindEnvironmentEvents() {
    navigator.serviceWorker.addEventListener('message', onWorkerMessage);
    window.addEventListener('online', () => { render(); maybeAutoSync(); });
    window.addEventListener('offline', () => {
      render();
      toast(view.version ? '📴 目前離線，使用已下載的內容' : '📴 目前離線，尚未下載離線版的內容可能打不開', 3500);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      // 回到前景：確認下載是否還在進行（手機鎖屏時 sw.js 可能被關掉），並視需要補抓更新
      postToWorker({ type: 'offline:status' });
    });
  }

  async function init() {
    render();
    startLocalPresence();
    if (!view.supported) return;
    bindEnvironmentEvents();

    try {
      await navigator.serviceWorker.register('sw.js');
    } catch (err) {
      console.warn('[offline] Service Worker 註冊失敗：', err);
      view.supported = false;
      render();
      return;
    }

    await postToWorker({ type: 'offline:status' }); // 回覆後會在 onStatus 視需要自動補抓
    fetchExpectedSize();
  }

  window.OfflineCache = { onBannerClick, refreshShell };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
