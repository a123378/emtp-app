/* ====================================================================
   sync.js — 跨裝置學習進度同步（Firebase Auth + Cloud Firestore）
   --------------------------------------------------------------------
   同步的資料（localStorage key）：
     readCh              已研讀章節
     chProgress          各章研讀百分比

   設計重點：
   1. 不改動 app.js —— 以攔截 localStorage.setItem 的方式偵測變更。
   2. 合併而非覆蓋 —— 集合類資料取聯集，並用「墓碑」記錄刪除，
      避免 A 裝置重設的進度被 B 裝置的舊資料復活。
   3. 登入牆：必須登入、信箱已驗證，而且信箱在 Firestore 的 allowlist
      （白名單）裡，才會放行；app.js / offline.js 會等 waitForAccess()
      完成才開始載入章節。注意這只是前端擋，靜態檔案本身仍是公開的。
   ==================================================================== */

/* Firebase SDK 採動態載入：沒設定或連不上 CDN 時，
   這個檔案仍會正常執行，網頁功能與原本完全相同。 */
const FB_VER = '10.12.2';
let FB = null;
async function loadFirebase() {
  if (FB) return FB;
  const base = `https://www.gstatic.com/firebasejs/${FB_VER}/`;
  const [a, au, fs] = await Promise.all([
    import(base + 'firebase-app.js'),
    import(base + 'firebase-auth.js'),
    import(base + 'firebase-firestore.js')
  ]);
  FB = { ...a, ...au, ...fs };
  return FB;
}

/* ── 1. Firebase 設定 ────────────────────────────────────────────────
   建立 Firebase 專案後，把「網頁應用程式」的設定貼進下面這個物件。
   （這組值本來就是公開的，安全性由 Firestore 規則 + 登入帳號把關。）
   也可以留空，改在網頁的「☁️ 同步」視窗裡貼上，設定會存在本機。      */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBWRAIzrGo4GHta371qNf18w57KMhH9jEM",
  authDomain: "mytp-ed0f5.firebaseapp.com",
  projectId: "mytp-ed0f5",
  appId: "1:624541117334:web:6d70087c912d71c25dcbb7"
};

/* ── 2. 常數 ───────────────────────────────────────────────────────── */
const K_READ  = 'readCh';
const K_PROG  = 'chProgress';
const SYNCED  = [K_READ, K_PROG];

const L_CFG   = 'sync_fb_config';
const L_TREAD = 'sync_tomb_read';
const L_TPROG = 'sync_tomb_prog';
const L_PEPOCH= 'sync_prog_epoch';
const L_READD = 'sync_readd';
const L_LAST  = 'sync_last_at';

const L_ACCESS = 'access_ok_uid';   // 最近一次通過白名單檢查的帳號（離線時沿用）
const ALLOWLIST = 'allowlist';      // Firestore 白名單集合：文件 ID = 小寫信箱
const GATE_BYPASS_HOSTS = ['127.0.0.1']; // 電腦本機離線版（開啟離線版.bat）：檔案本來就在本機，不擋

const PUSH_DELAY = 400;
const FB_LOAD_TIMEOUT_MS = 10000;

/* ── 3. 小工具 ─────────────────────────────────────────────────────── */
const rawGet = localStorage.getItem.bind(localStorage);
const rawSet = localStorage.setItem.bind(localStorage);

const jget = (k, d) => { try { return JSON.parse(rawGet(k) || JSON.stringify(d)); } catch (e) { return d; } };
const jset = (k, v) => rawSet(k, JSON.stringify(v));
const app  = () => { try { return state; } catch (e) { return null; } };

let fbApp = null, fbAuth = null, fbDb = null;
let user = null;
let applyingRemote = false;
let syncReady = false;      // 首次遠端合併完成前，不把本機清空當成「使用者刪除」
let pushTimer = null;
let unsubDoc = null;
let lastPushedJson = '';

/* ── 3b. 登入牆（白名單）────────────────────────────────────────────
   流程：登入 → 信箱已驗證 → Firestore allowlist/{小寫信箱} 存在 → 放行。
   通過過的帳號會記在本機，下次開啟先放行、背景再確認，離線也能用。   */
let gateResolve = null;
const gatePromise = new Promise(resolve => { gateResolve = resolve; });
let accessGranted = false;
window.waitForAccess = () => gatePromise;

const gateEsc = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gateBypassed = () => GATE_BYPASS_HOSTS.includes(location.hostname);

function grantAccess() {
  if (accessGranted) return;
  accessGranted = true;
  document.documentElement.classList.remove('gate-locked');
  const el = document.getElementById('access-gate');
  if (el) el.remove();
  gateResolve();
}

/** 在登入牆顯示內容；data-act 按鈕交給 actions 對應的函式處理 */
function showGate(html, status, kind, actions) {
  if (accessGranted) return null;
  setStatus(status, kind);
  const body = document.getElementById('gate-body');
  if (!body) return null;
  body.innerHTML = html;
  Object.entries(actions || {}).forEach(([act, fn]) => {
    const btn = body.querySelector(`[data-act="${act}"]`);
    if (btn) btn.onclick = fn;
  });
  return body;
}

const gateSignOut = () => FB.signOut(fbAuth);

function showGateLogin() {
  const body = showGate('<p class="sync-note">這個網站只開放給受邀的帳號使用，請先登入。</p><div class="gate-login"></div>',
    '尚未登入', '');
  if (body) renderLoginForm(body.querySelector('.gate-login'), { allowReset: false });
}

function showGateDenied(u) {
  showGate(`
    <p class="sync-note">目前登入的帳號 <b>${gateEsc(u.email || '（沒有信箱）')}</b> 沒有使用權限。<br>
    如果需要使用，請把這個信箱告訴網站管理員。</p>
    <div class="sync-row"><button class="modal-btn primary" data-act="logout">改用其他帳號登入</button></div>`,
    '沒有使用權限', 'bad', { logout: gateSignOut });
}

function showGateVerify(u) {
  showGate(`
    <p class="sync-note">信箱 <b>${gateEsc(u.email || '')}</b> 還沒完成驗證。<br>
    請到信箱點開驗證信裡的連結，再回來按「我已完成驗證」。沒收到的話，先看看垃圾郵件匣，或按「重寄驗證信」。</p>
    <div class="sync-row">
      <button class="modal-btn primary" data-act="recheck">我已完成驗證</button>
      <button class="modal-btn" data-act="resend">重寄驗證信</button>
      <button class="modal-btn ghost" data-act="logout">登出</button>
    </div>`,
    '信箱尚未驗證', 'busy', {
      recheck: async (e) => {
        const btn = e && e.currentTarget;
        if (btn) btn.disabled = true;               // 避免連點造成重複檢查
        setStatus('重新確認中…', 'busy');
        try {
          await u.reload();
          await u.getIdToken(true);   // 換新的登入憑證，Firestore 規則才看得到「已驗證」
          await checkAccess(fbAuth.currentUser);
        } catch (err) { setStatus('確認失敗：' + err.message, 'bad'); }
        finally { if (btn && btn.isConnected) btn.disabled = false; }
      },
      resend: async () => {
        try { await FB.sendEmailVerification(u); setStatus('已重寄驗證信', 'ok'); }
        catch (err) {
          setStatus(err.code === 'auth/too-many-requests' ? '寄送太頻繁，請稍後再試' : '寄送失敗：' + err.message, 'bad');
        }
      },
      logout: gateSignOut
    });
}

function showGateError(message) {
  showGate(`
    <p class="sync-note">${gateEsc(message)}</p>
    <div class="sync-row"><button class="modal-btn primary" data-act="reload">重新整理</button></div>`,
    '無法確認使用權限', 'bad', { reload: () => location.reload() });
}

function admit(u) {
  rawSet(L_ACCESS, u.uid);
  grantAccess();
  startSync(u);
}

async function checkAccess(u) {
  if (!u) return;
  if (!u.emailVerified) { showGateVerify(u); return; }
  const cachedOk = rawGet(L_ACCESS) === u.uid;
  if (cachedOk) admit(u);                       // 之前通過過：先放行，背景再確認一次
  else showGate('', '確認使用權限中…', 'busy');

  let allowed;
  try {
    const snap = await FB.getDoc(FB.doc(fbDb, ALLOWLIST, (u.email || '').toLowerCase()));
    allowed = snap.exists();
  } catch (err) {
    if (err.code !== 'permission-denied') {     // 連不上伺服器：有紀錄就照舊使用
      if (!cachedOk) showGateError('連不上伺服器，暫時無法確認使用權限。請確認網路連線後重新整理。');
      return;
    }
    allowed = false;
  }
  if (allowed) { if (!cachedOk) admit(u); return; }
  localStorage.removeItem(L_ACCESS);
  if (accessGranted) { location.reload(); return; }   // 已被移出白名單：重新整理回到登入牆
  showGateDenied(u);
}

function onAuthChanged(u) {
  if (gateBypassed()) { if (u) startSync(u); else stopSync(); return; }
  if (u) { checkAccess(u); return; }
  stopSync();
  localStorage.removeItem(L_ACCESS);
  if (accessGranted) location.reload();         // 登出：重新整理，把已載入的內容清掉
  else showGateLogin();
}

/** Firebase 無法使用時：本機有通過紀錄就放行（離線使用），否則停在登入牆 */
function gateFallback(message) {
  if (rawGet(L_ACCESS)) grantAccess();
  else showGateError(message);
}

function initGate() {
  try { document.documentElement.setAttribute('data-theme', rawGet('theme') || 'light'); } catch (e) { /* 沒有就用預設 */ }
  if (gateBypassed()) grantAccess();
}

/* ── 4. 墓碑（記錄使用者刪除了什麼）───────────────────────────────── */
function updateTombstones(key, beforeRaw, afterRaw) {
  const idsOf = (raw, pick) => {
    try { return new Set((JSON.parse(raw || '[]') || []).map(pick).filter(Boolean)); }
    catch (e) { return new Set(); }
  };
  if (key === K_READ) {
    const pick = x => x;
    const tKey = L_TREAD;
    const before = idsOf(beforeRaw, pick);
    const after  = idsOf(afterRaw, pick);
    const tomb   = new Set(jget(tKey, []));
    const readd = new Set(jget(L_READD, []));
    before.forEach(id => { if (!after.has(id)) { tomb.add(id); readd.delete(id); } });  // 被刪掉 → 記墓碑
    after.forEach(id => { if (tomb.delete(id)) readd.add(id); });                       // 又加回來 → 撤銷墓碑
    jset(tKey, [...tomb]);
    jset(L_READD, [...readd]);
  }
  if (key === K_PROG) {
    try {
      const b = JSON.parse(beforeRaw || '{}');
      const a = JSON.parse(afterRaw  || '{}');
      if (Object.keys(b).length > 0 && Object.keys(a).length === 0) {
        jset(L_PEPOCH, (jget(L_PEPOCH, 0) || 0) + 1);  // 全書進度重設清空 → 換代
        jset(L_TPROG, []);
      } else {
        const tomb = new Set(jget(L_TPROG, []));
        // 若某章從 > 0 變為 0 或被刪除，記錄重設墓碑
        Object.keys(b).forEach(id => {
          if ((b[id] || 0) > 0 && (!a[id] || a[id] === 0)) {
            tomb.add(id);
          }
        });
        // 若某章進度 > 0，撤銷墓碑
        Object.keys(a).forEach(id => {
          if ((a[id] || 0) > 0) {
            tomb.delete(id);
          }
        });
        jset(L_TPROG, [...tomb]);
      }
    } catch (e) { /* ignore */ }
  }
}

/* ── 5. 攔截 localStorage 寫入 ─────────────────────────────────────── */
localStorage.setItem = function (key, value) {
  const before = SYNCED.includes(key) ? rawGet(key) : null;
  rawSet(key, value);
  if (applyingRemote || !SYNCED.includes(key)) return;
  // 啟動流程（例如 red_initialized 重置）會在使用者還沒操作前清空資料，
  // 首次遠端合併完成前一律不記墓碑，避免把它當成使用者的刪除意圖同步出去。
  if (syncReady) updateTombstones(key, before, value);
  schedulePush();
};

/* ── 6. 合併 ───────────────────────────────────────────────────────── */
function mergeSet(localArr, remoteArr, tomb) {
  const s = new Set([...(remoteArr || []), ...(localArr || [])]);
  (tomb || []).forEach(id => s.delete(id));
  return [...s];
}
function mergeProgress(local, remote, progTomb, localEpoch, remoteEpoch) {
  const L = local  || {};
  const R = remote || {};
  const lEpoch = localEpoch || 0;
  const rEpoch = remoteEpoch || 0;
  // 全書重設 (Epoch 提升) 時以重設端為準
  if (lEpoch !== rEpoch) return lEpoch > rEpoch ? L : R;

  const tomb = new Set(progTomb || []);
  const merged = { ...R, ...L };
  const allKeys = new Set([...Object.keys(L), ...Object.keys(R)]);

  allKeys.forEach(k => {
    if (tomb.has(k)) {
      merged[k] = 0;
    } else {
      const lVal = typeof L[k] === 'number' ? L[k] : 0;
      const rVal = typeof R[k] === 'number' ? R[k] : 0;
      // 兩端進度取最大值，絕不被新啟動設備的空狀態抹殺
      merged[k] = Math.max(lVal, rVal);
    }
  });
  return merged;
}

/* ── 7. 上傳 ───────────────────────────────────────────────────────── */
function schedulePush() {
  if (!user || !fbDb) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushNow().catch(err => setStatus('上傳失敗：' + err.message, 'bad')); }, PUSH_DELAY);
}

async function pushNow() {
  if (!user || !fbDb) return;
  const payload = {
    read: jget(K_READ, []),
    readTomb: jget(L_TREAD, []),
    progress: jget(K_PROG, {}),
    progTomb: jget(L_TPROG, []),
    progEpoch: jget(L_PEPOCH, 0),
    clientAt: Date.now()
  };
  const json = JSON.stringify(payload);
  if (json === lastPushedJson) return;             // 沒變就不寫，省配額
  // merge：只更新研讀進度欄位，雲端舊有的其他欄位（已停用的題庫練習資料）保持原樣
  await FB.setDoc(FB.doc(fbDb, 'emtp', user.uid), payload, { merge: true });
  lastPushedJson = json;
  jset(L_READD, []);
  rawSet(L_LAST, String(Date.now()));
  setStatus('已同步 · ' + new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }), 'ok');
}

/* ── 8. 套用遠端資料 ───────────────────────────────────────────────── */
async function applyRemote(remote) {
  if (!remote) return;
  const s = app();

  const readd     = jget(L_READD, []);
  const readTomb  = mergeSet(jget(L_TREAD, []),  remote.readTomb,  readd);
  const progTomb  = mergeSet(jget(L_TPROG, []),  remote.progTomb,  []);

  const read  = mergeSet(jget(K_READ, []), remote.read, readTomb);
  const prog  = mergeProgress(jget(K_PROG, {}), remote.progress, progTomb, jget(L_PEPOCH, 0), remote.progEpoch);

  applyingRemote = true;
  try {
    jset(K_READ, read);
    jset(K_PROG, prog);
    jset(L_TREAD,  readTomb);
    jset(L_TPROG,  progTomb);
    jset(L_PEPOCH, Math.max(jget(L_PEPOCH, 0) || 0, remote.progEpoch || 0));

    if (s) {
      s.chapterProgress = prog;
      // 以各章實質百分比為唯一已讀標準，未達 100% 絕不亮綠燈
      s.readChapters = new Set();
      Object.entries(s.chapterProgress).forEach(([id, p]) => {
        if (p >= 100) s.readChapters.add(id);
      });
      jset(K_READ, [...s.readChapters]);
      jset(K_PROG, s.chapterProgress);
    }
  } finally {
    applyingRemote = false;
  }

  // 重繪畫面（函式不存在就跳過）
  try { if (s) (s.chapters || []).forEach(ch => window.updateChapterReadUi && window.updateChapterReadUi(ch.id)); } catch (e) {}
  try {
    const pModal = document.getElementById('progress-modal');
    if (pModal && !pModal.classList.contains('hidden') && typeof window.openProgressModal === 'function') {
      window.openProgressModal();
    }
  } catch (e) {}

  rawSet(L_LAST, String(Date.now()));
}

/* ── 9. 登入後開始同步 ────────────────────────────────────────────── */
async function startSync(u) {
  user = u;
  if (unsubDoc) { unsubDoc(); unsubDoc = null; }
  setStatus('同步中…', 'busy');
  const ref = FB.doc(fbDb, 'emtp', u.uid);
  try {
    const snap = await FB.getDoc(ref);
    if (snap.exists()) await applyRemote(snap.data());
    await pushNow();                                  // 把本機獨有的資料補上去
    syncReady = true;                                 // 從這一刻起，刪除才算使用者意圖
    unsubDoc = FB.onSnapshot(ref, s => {                 // 之後另一台裝置改動就即時拉下來
      if (s.exists() && !s.metadata.hasPendingWrites) applyRemote(s.data());
    }, err => setStatus('連線中斷：' + err.message, 'bad'));
  } catch (err) {
    setStatus('同步失敗：' + err.message, 'bad');
  }
  renderSyncModal();
}

function stopSync() {
  if (unsubDoc) { unsubDoc(); unsubDoc = null; }
  user = null;
  syncReady = false;
  lastPushedJson = '';
  setStatus('未登入', '');
  renderSyncModal();
}

/* ── 10. 介面 ──────────────────────────────────────────────────────── */
function setStatus(text, kind) {
  const el = document.getElementById('sync-status-line');
  if (el) { el.textContent = text; el.className = 'sync-status ' + (kind || ''); }
  const gateEl = document.getElementById('gate-status');
  if (gateEl) { gateEl.textContent = text; gateEl.className = 'sync-status ' + (kind || ''); }
  const dot = document.getElementById('sync-dot');
  if (dot) dot.className = 'sync-dot ' + (kind || (user ? 'ok' : ''));
}

function getConfig() {
  const saved = jget(L_CFG, null);
  if (saved && saved.apiKey) return saved;
  return FIREBASE_CONFIG.apiKey ? FIREBASE_CONFIG : null;
}

function renderSyncModal() {
  const body = document.getElementById('sync-modal-body');
  if (!body) return;
  const cfg = getConfig();
  const last = rawGet(L_LAST);
  const lastTxt = last ? new Date(Number(last)).toLocaleString('zh-TW') : '尚未同步過';

  if (!cfg) {
    body.innerHTML = `
      <p class="sync-note">還沒設定 Firebase。請依照 <b>README 的「跨裝置同步設定」</b>建立免費專案，
      再把網頁應用程式的設定（<code>firebaseConfig</code>）整段貼在下面。設定只會存在這台裝置的瀏覽器裡。</p>
      <textarea id="sync-cfg-input" rows="7" placeholder='{ "apiKey": "...", "authDomain": "...", "projectId": "...", "appId": "..." }'></textarea>
      <div class="sync-row"><button class="modal-btn primary" id="sync-save-cfg">儲存設定</button></div>`;
    document.getElementById('sync-save-cfg').onclick = saveConfig;
    return;
  }
  if (!user) {
    body.innerHTML = '<p class="sync-note">在手機和電腦登入同一個帳號，研讀進度就會自動雙向同步。</p><div class="sync-login"></div>';
    renderLoginForm(body.querySelector('.sync-login'), { allowReset: true });
    return;
  }
  body.innerHTML = `
    <p class="sync-note">已登入：<b>${gateEsc(user.email || '(匿名)')}</b><br>最後同步：${lastTxt}</p>
    <div class="sync-row">
      <button class="modal-btn primary" id="sync-now">立即同步</button>
      <button class="modal-btn" id="sync-logout">登出這台裝置</button>
    </div>
    <p class="sync-note" style="margin-top:10px">
      已讀 ${jget(K_READ, []).length} 章
    </p>`;
  document.getElementById('sync-now').onclick = async () => {
    setStatus('同步中…', 'busy');
    try { const s = await FB.getDoc(FB.doc(fbDb, 'emtp', user.uid)); if (s.exists()) await applyRemote(s.data()); lastPushedJson = ''; await pushNow(); renderSyncModal(); }
    catch (err) { setStatus('同步失敗：' + err.message, 'bad'); }
  };
  document.getElementById('sync-logout').onclick = async () => { await FB.signOut(fbAuth); };
}

/** 登入表單（登入牆與同步視窗共用）；按鈕用 data-act 綁定，避免兩處 ID 重複 */
function renderLoginForm(container, { allowReset }) {
  if (!container) return;
  container.innerHTML = `
      <div class="sync-row" style="margin-bottom:12px">
        <button class="modal-btn" data-act="google" style="width:100%;display:flex;align-items:center;justify-content:center;gap:10px;padding:11px 16px;background:var(--surface);border:1.5px solid var(--border);border-radius:8px;font-weight:700;font-size:0.92rem;cursor:pointer;color:var(--text)">
          <svg width="18" height="18" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"/>
            <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.26v3.15C3.25 21.37 7.33 24 12 24z"/>
            <path fill="#FBBC05" d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.26C.46 8.17 0 9.99 0 12s.46 3.83 1.26 5.42l4.02-3.15z"/>
            <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.25 2.63 1.26 6.58l4.02 3.15c.95-2.83 3.6-4.98 6.72-4.98z"/>
          </svg>
          使用 Google 帳號快速登入
        </button>
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin:12px 0;color:var(--text-muted);font-size:0.8rem">
        <div style="flex:1;height:1px;background:var(--border)"></div>
        <span>或使用 Email 帳密</span>
        <div style="flex:1;height:1px;background:var(--border)"></div>
      </div>
      <div class="sync-row"><input type="email" data-field="email" placeholder="電子郵件" autocomplete="username" aria-label="電子郵件"></div>
      <div class="sync-row"><input type="password" data-field="pass" placeholder="密碼（至少 6 碼）" autocomplete="current-password" aria-label="密碼"></div>
      <div class="sync-row">
        <button class="modal-btn primary" data-act="login">登入</button>
        <button class="modal-btn" data-act="register">註冊新帳號</button>
      </div>
      ${allowReset ? '<div class="sync-row"><button class="modal-btn ghost" data-act="reset">重新設定 Firebase</button></div>' : ''}`;
  const on = (act, fn) => { const b = container.querySelector(`[data-act="${act}"]`); if (b) b.onclick = fn; };
  on('google', doGoogleAuth);
  on('login', () => doAuth('login', container));
  on('register', () => doAuth('register', container));
  on('reset', () => { localStorage.removeItem(L_CFG); location.reload(); });
}

function saveConfig() {
  const raw = (document.getElementById('sync-cfg-input').value || '').trim();
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const cfg = JSON.parse((m ? m[0] : raw).replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":').replace(/'/g, '"'));
    if (!cfg.apiKey || !cfg.projectId) throw new Error('缺少 apiKey 或 projectId');
    jset(L_CFG, cfg);
    boot().then(renderSyncModal);
  } catch (err) {
    setStatus('設定格式有誤：' + err.message, 'bad');
  }
}

async function doGoogleAuth() {
  setStatus('Google 登入中…', 'busy');
  try {
    await FB.setPersistence(fbAuth, FB.browserLocalPersistence);
    const provider = new FB.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await FB.signInWithPopup(fbAuth, provider);
  } catch (err) {
    if (err.code === 'auth/popup-closed-by-user') {
      setStatus('已取消 Google 登入', '');
      return;
    }
    const msg = {
      'auth/operation-not-allowed': 'Firebase 尚未啟用「Google」登入（請至 Firebase Authentication ➔ 登入方式 啟用 Google）',
      'auth/unauthorized-domain': '目前網域尚未授權（請至 Firebase Authentication ➔ 設定 ➔ 已授權網域 新增目前網址）',
      'auth/popup-blocked': '瀏覽器封鎖了彈出視窗，請在網址列允許彈出視窗後重試'
    }[err.code] || err.message;
    setStatus('Google 登入失敗：' + msg, 'bad');
  }
}

async function doAuth(mode, container) {
  const field = name => container.querySelector(`[data-field="${name}"]`);
  const email = (field('email').value || '').trim();
  const pass  = field('pass').value || '';
  if (!email || pass.length < 6) return setStatus('請輸入電子郵件與至少 6 碼密碼', 'bad');
  setStatus(mode === 'login' ? '登入中…' : '註冊中…', 'busy');
  try {
    await FB.setPersistence(fbAuth, FB.browserLocalPersistence);
    if (mode === 'login') {
      await FB.signInWithEmailAndPassword(fbAuth, email, pass);
    } else {
      const cred = await FB.createUserWithEmailAndPassword(fbAuth, email, pass);
      // 白名單只認已驗證的信箱，避免冒用別人的信箱註冊
      try { await FB.sendEmailVerification(cred.user); }
      catch (err) { setStatus('帳號已建立，但驗證信沒寄出去，請稍後按「重寄驗證信」', 'bad'); }
    }
  } catch (err) {
    const msg = { 'auth/invalid-credential': '帳號或密碼錯誤', 'auth/email-already-in-use': '這個信箱已註冊過，請改用「登入」',
                  'auth/weak-password': '密碼太短（至少 6 碼）', 'auth/invalid-email': '信箱格式不正確',
                  'auth/operation-not-allowed': 'Firebase 尚未啟用「電子郵件/密碼」登入方式',
                  'auth/too-many-requests': '嘗試太多次，請稍後再試',
                  'auth/network-request-failed': '網路連線失敗' }[err.code] || err.message;
    setStatus(msg, 'bad');
  }
}

window.openSyncModal = function () {
  const m = document.getElementById('sync-modal');
  if (m) { m.classList.remove('hidden'); renderSyncModal(); }
};
window.closeSyncModal = function () {
  const m = document.getElementById('sync-modal');
  if (m) m.classList.add('hidden');
};

/* ── 11. 啟動 ──────────────────────────────────────────────────────── */
async function boot() {
  const cfg = getConfig();
  if (!cfg) { setStatus('未設定', ''); gateFallback('網站尚未設定登入服務，請聯絡網站管理員。'); return; }
  setStatus('連線中…', 'busy');
  try {
    // 網路很慢或連不上時 import() 可能一直等不到回應，逾時就改走離線放行
    await Promise.race([
      loadFirebase(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), FB_LOAD_TIMEOUT_MS))
    ]);
  } catch (err) {
    setStatus('無法載入 Firebase（請確認網路連線）', 'bad');
    gateFallback('需要連上網路才能登入，請確認網路連線後重新整理。');
    return;
  }
  try {
    fbApp = FB.initializeApp(cfg);
    fbAuth = FB.getAuth(fbApp);
    fbDb = FB.getFirestore(fbApp);
    FB.onAuthStateChanged(fbAuth, onAuthChanged);
  } catch (err) {
    setStatus('Firebase 初始化失敗：' + err.message, 'bad');
    gateFallback('登入服務啟動失敗，請重新整理再試一次。');
  }
}

initGate();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

/* ── 12. 雙向跨裝置生命週期防護（電腦 ⇄ 手機 通用）─────────────────── */
let _pulling = false;
async function pullNow() {
  if (!user || !fbDb || _pulling) return;
  _pulling = true;
  try {
    const ref = FB.doc(fbDb, 'emtp', user.uid);
    const snap = await FB.getDoc(ref);
    if (snap.exists()) {
      await applyRemote(snap.data());
    }
  } catch (err) {
    console.warn('pullNow failed:', err);
  } finally {
    _pulling = false;
  }
}

// 離場保護：關閉視窗、分頁切換、手機滑回桌面或切換 App 時立即強制推送
function onSyncLeave() {
  if (typeof window.saveChapterProgressToStorage === 'function') {
    window.saveChapterProgressToStorage();
  }
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  pushNow();
}

// 進場保護：視窗聚焦、切回分頁、手機喚醒或開 App 時立即自雲端拉取
function onSyncEnter() {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
    pushNow();
    return;
  }
  pullNow();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    onSyncLeave();
  } else if (document.visibilityState === 'visible') {
    onSyncEnter();
  }
});
window.addEventListener('pagehide', onSyncLeave);
window.addEventListener('beforeunload', onSyncLeave);
window.addEventListener('focus', onSyncEnter);

window.pushSyncNow = pushNow;
window.pullSyncNow = pullNow;
