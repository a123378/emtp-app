/* ====================================================================
   sync.js — 跨裝置學習進度同步（Firebase Auth + Cloud Firestore）
   --------------------------------------------------------------------
   同步的四項資料（localStorage key）：
     m2_wrong_questions  錯題本
     readCh              已研讀章節
     m2_stats            模式二累計統計
     m2_ai_chapter_quizzes  AI 出題歸檔

   設計重點：
   1. 不改動 app.js —— 以攔截 localStorage.setItem 的方式偵測變更。
   2. 合併而非覆蓋 —— 集合類資料取聯集，並用「墓碑」記錄刪除，
      避免 A 裝置刪掉的題目被 B 裝置的舊資料復活。
   3. 未設定 / 未登入 / 離線時，網頁行為與原本完全相同。
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
  apiKey: '',
  authDomain: '',
  projectId: '',
  appId: ''
};

/* ── 2. 常數 ───────────────────────────────────────────────────────── */
const K_WRONG = 'm2_wrong_questions';
const K_READ  = 'readCh';
const K_STATS = 'm2_stats';
const K_AI    = 'm2_ai_chapter_quizzes';
const SYNCED  = [K_WRONG, K_READ, K_STATS, K_AI];

const L_CFG   = 'sync_fb_config';
const L_TWRONG= 'sync_tomb_wrong';
const L_TREAD = 'sync_tomb_read';
const L_EPOCH = 'sync_stats_epoch';
const L_READD = 'sync_readd';
const L_LAST  = 'sync_last_at';

const PUSH_DELAY = 1500;

/* ── 3. 小工具 ─────────────────────────────────────────────────────── */
const rawGet = localStorage.getItem.bind(localStorage);
const rawSet = localStorage.setItem.bind(localStorage);

const jget = (k, d) => { try { return JSON.parse(rawGet(k) || JSON.stringify(d)); } catch (e) { return d; } };
const jset = (k, v) => rawSet(k, JSON.stringify(v));
const app  = () => { try { return state; } catch (e) { return null; } };

let fbApp = null, fbAuth = null, fbDb = null;
let user = null;
let applyingRemote = false;
let pushTimer = null;
let unsubDoc = null;
let lastPushedJson = '';

/* ── 4. 墓碑（記錄使用者刪除了什麼）───────────────────────────────── */
function updateTombstones(key, beforeRaw, afterRaw) {
  const idsOf = (raw, pick) => {
    try { return new Set((JSON.parse(raw || '[]') || []).map(pick).filter(Boolean)); }
    catch (e) { return new Set(); }
  };
  if (key === K_WRONG || key === K_READ) {
    const pick = key === K_WRONG ? (q => q && q.id) : (x => x);
    const tKey = key === K_WRONG ? L_TWRONG : L_TREAD;
    const before = idsOf(beforeRaw, pick);
    const after  = idsOf(afterRaw, pick);
    const tomb   = new Set(jget(tKey, []));
    const readd = new Set(jget(L_READD, []));
    before.forEach(id => { if (!after.has(id)) { tomb.add(id); readd.delete(id); } });  // 被刪掉 → 記墓碑
    after.forEach(id => { if (tomb.delete(id)) readd.add(id); });                       // 又加回來 → 撤銷墓碑
    jset(tKey, [...tomb]);
    jset(L_READD, [...readd]);
  }
  if (key === K_STATS) {
    try {
      const b = JSON.parse(beforeRaw || '{"total":0}');
      const a = JSON.parse(afterRaw  || '{"total":0}');
      if ((a.total || 0) < (b.total || 0)) jset(L_EPOCH, (jget(L_EPOCH, 0) || 0) + 1);  // 被清空 → 換代
    } catch (e) { /* ignore */ }
  }
}

/* ── 5. 攔截 localStorage 寫入 ─────────────────────────────────────── */
localStorage.setItem = function (key, value) {
  const before = SYNCED.includes(key) ? rawGet(key) : null;
  rawSet(key, value);
  if (applyingRemote || !SYNCED.includes(key)) return;
  updateTombstones(key, before, value);
  schedulePush();
};

/* ── 6. 錯題本壓縮／還原（避免 Firestore 單筆 1MB 上限）────────────── */
let bankPromise = null;
function officialBank() {
  if (bankPromise) return bankPromise;
  bankPromise = new Promise(resolve => {
    const started = Date.now();
    const tick = () => {
      const s = app();
      const arr = s && Array.isArray(s.allQuizzes) ? s.allQuizzes : [];
      if (arr.length) return resolve(new Map(arr.map(q => [q.id, q])));
      if (Date.now() - started > 20000) return resolve(new Map());   // 放棄等待
      setTimeout(tick, 300);
    };
    tick();
  });
  return bankPromise;
}

async function compactWrong(arr) {
  const bank = await officialBank();
  return (arr || []).map(q => (q && bank.has(q.id)) ? { id: q.id, r: 1 } : q).filter(Boolean);
}
async function expandWrong(arr) {
  const bank = await officialBank();
  return (arr || []).map(q => {
    if (!q) return null;
    if (q.r) return bank.get(q.id) || null;      // 題庫題只存 id，讀回時還原
    return q;
  }).filter(Boolean);
}

/* ── 7. 合併 ───────────────────────────────────────────────────────── */
function mergeById(localArr, remoteArr, tomb) {
  const map = new Map();
  (remoteArr || []).forEach(q => { if (q && q.id) map.set(q.id, q); });
  (localArr  || []).forEach(q => { if (q && q.id) map.set(q.id, q); });   // 本機版本優先
  (tomb || []).forEach(id => map.delete(id));
  return [...map.values()];
}
function mergeSet(localArr, remoteArr, tomb) {
  const s = new Set([...(remoteArr || []), ...(localArr || [])]);
  (tomb || []).forEach(id => s.delete(id));
  return [...s];
}
function mergeStats(local, remote, localEpoch, remoteEpoch) {
  const L = local  || { total: 0, correct: 0 };
  const R = remote || { total: 0, correct: 0 };
  if ((localEpoch || 0) !== (remoteEpoch || 0)) return (localEpoch || 0) > (remoteEpoch || 0) ? L : R;
  return (L.total || 0) >= (R.total || 0) ? L : R;   // 同一代取較多者，避免統計倒退
}

/* ── 8. 上傳 ───────────────────────────────────────────────────────── */
function schedulePush() {
  if (!user || !fbDb) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushNow().catch(err => setStatus('上傳失敗：' + err.message, 'bad')); }, PUSH_DELAY);
}

async function pushNow() {
  if (!user || !fbDb) return;
  const payload = {
    wrong: await compactWrong(jget(K_WRONG, [])),
    wrongTomb: jget(L_TWRONG, []),
    read: jget(K_READ, []),
    readTomb: jget(L_TREAD, []),
    stats: jget(K_STATS, { total: 0, correct: 0 }),
    statsEpoch: jget(L_EPOCH, 0),
    ai: jget(K_AI, []),
    clientAt: Date.now()
  };
  const json = JSON.stringify(payload);
  if (json === lastPushedJson) return;             // 沒變就不寫，省配額
  await FB.setDoc(FB.doc(fbDb, 'emtp', user.uid), payload);
  lastPushedJson = json;
  jset(L_READD, []);
  rawSet(L_LAST, String(Date.now()));
  setStatus('已同步 · ' + new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }), 'ok');
}

/* ── 9. 套用遠端資料 ───────────────────────────────────────────────── */
async function applyRemote(remote) {
  if (!remote) return;
  const s = app();

  const readd     = jget(L_READD, []);
  const wrongTomb = mergeSet(jget(L_TWRONG, []), remote.wrongTomb, readd);
  const readTomb  = mergeSet(jget(L_TREAD, []),  remote.readTomb,  readd);

  const wrong = mergeById(jget(K_WRONG, []), await expandWrong(remote.wrong), wrongTomb);
  const read  = mergeSet(jget(K_READ, []), remote.read, readTomb);
  const stats = mergeStats(jget(K_STATS, null), remote.stats, jget(L_EPOCH, 0), remote.statsEpoch);
  const ai    = mergeById(jget(K_AI, []), remote.ai, []);

  applyingRemote = true;
  try {
    jset(K_WRONG, wrong);
    jset(K_READ, read);
    jset(K_STATS, stats);
    jset(K_AI, ai);
    jset(L_TWRONG, wrongTomb);
    jset(L_TREAD,  readTomb);
    jset(L_EPOCH, Math.max(jget(L_EPOCH, 0) || 0, remote.statsEpoch || 0));

    if (s) {
      s.wrongQuestions = wrong;
      s.readChapters = new Set(read);
      s.m2Stats = stats;
      if (Array.isArray(s.allQuizzes)) {
        const known = new Set(s.allQuizzes.map(q => q.id));
        ai.forEach(q => { if (q && q.id && !known.has(q.id)) s.allQuizzes.push(q); });
      }
    }
  } finally {
    applyingRemote = false;
  }

  // 重繪畫面（函式不存在就跳過）
  try { if (s) (s.chapters || []).forEach(ch => window.updateChapterReadUi && window.updateChapterReadUi(ch.id)); } catch (e) {}
  try { window.renderWrongBookContent && window.renderWrongBookContent(); } catch (e) {}
  try { window.updateM2LobbyStats && window.updateM2LobbyStats(); } catch (e) {}

  rawSet(L_LAST, String(Date.now()));
}

/* ── 10. 登入後開始同步 ────────────────────────────────────────────── */
async function startSync(u) {
  user = u;
  if (unsubDoc) { unsubDoc(); unsubDoc = null; }
  setStatus('同步中…', 'busy');
  const ref = FB.doc(fbDb, 'emtp', u.uid);
  try {
    const snap = await FB.getDoc(ref);
    if (snap.exists()) await applyRemote(snap.data());
    await pushNow();                                  // 把本機獨有的資料補上去
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
  lastPushedJson = '';
  setStatus('未登入', '');
  renderSyncModal();
}

/* ── 11. 介面 ──────────────────────────────────────────────────────── */
function setStatus(text, kind) {
  const el = document.getElementById('sync-status-line');
  if (el) { el.textContent = text; el.className = 'sync-status ' + (kind || ''); }
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
    body.innerHTML = `
      <p class="sync-note">用同一組帳號在手機和電腦登入，錯題本、已讀進度、統計與 AI 題庫就會自動同步。
      第一次使用請先「註冊」，之後在另一台裝置用同一組帳密「登入」即可。</p>
      <div class="sync-row"><input type="email" id="sync-email" placeholder="電子郵件" autocomplete="username"></div>
      <div class="sync-row"><input type="password" id="sync-pass" placeholder="密碼（至少 6 碼）" autocomplete="current-password"></div>
      <div class="sync-row">
        <button class="modal-btn primary" id="sync-login">登入</button>
        <button class="modal-btn" id="sync-register">註冊新帳號</button>
      </div>
      <div class="sync-row"><button class="modal-btn ghost" id="sync-reset-cfg">重新設定 Firebase</button></div>`;
    document.getElementById('sync-login').onclick = () => doAuth('login');
    document.getElementById('sync-register').onclick = () => doAuth('register');
    document.getElementById('sync-reset-cfg').onclick = () => { localStorage.removeItem(L_CFG); location.reload(); };
    return;
  }
  body.innerHTML = `
    <p class="sync-note">已登入：<b>${user.email || '(匿名)'}</b><br>最後同步：${lastTxt}</p>
    <div class="sync-row">
      <button class="modal-btn primary" id="sync-now">立即同步</button>
      <button class="modal-btn" id="sync-logout">登出這台裝置</button>
    </div>
    <p class="sync-note" style="margin-top:10px">
      錯題本 ${jget(K_WRONG, []).length} 題 ‧ 已讀 ${jget(K_READ, []).length} 章 ‧ AI 題庫 ${jget(K_AI, []).length} 題
    </p>`;
  document.getElementById('sync-now').onclick = async () => {
    setStatus('同步中…', 'busy');
    try { const s = await FB.getDoc(FB.doc(fbDb, 'emtp', user.uid)); if (s.exists()) await applyRemote(s.data()); lastPushedJson = ''; await pushNow(); renderSyncModal(); }
    catch (err) { setStatus('同步失敗：' + err.message, 'bad'); }
  };
  document.getElementById('sync-logout').onclick = async () => { await FB.signOut(fbAuth); };
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

async function doAuth(mode) {
  const email = (document.getElementById('sync-email').value || '').trim();
  const pass  = document.getElementById('sync-pass').value || '';
  if (!email || pass.length < 6) return setStatus('請輸入電子郵件與至少 6 碼密碼', 'bad');
  setStatus(mode === 'login' ? '登入中…' : '註冊中…', 'busy');
  try {
    await FB.setPersistence(fbAuth, FB.browserLocalPersistence);
    if (mode === 'login') await FB.signInWithEmailAndPassword(fbAuth, email, pass);
    else await FB.createUserWithEmailAndPassword(fbAuth, email, pass);
  } catch (err) {
    const msg = { 'auth/invalid-credential': '帳號或密碼錯誤', 'auth/email-already-in-use': '這個信箱已註冊過，請改用「登入」',
                  'auth/weak-password': '密碼太短（至少 6 碼）', 'auth/invalid-email': '信箱格式不正確',
                  'auth/operation-not-allowed': 'Firebase 尚未啟用「電子郵件/密碼」登入方式',
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

/* ── 12. 啟動 ──────────────────────────────────────────────────────── */
async function boot() {
  const cfg = getConfig();
  if (!cfg) { setStatus('未設定', ''); return; }
  setStatus('連線中…', 'busy');
  try {
    await loadFirebase();
  } catch (err) {
    setStatus('無法載入 Firebase（請確認網路連線）', 'bad');
    return;
  }
  try {
    fbApp = FB.initializeApp(cfg);
    fbAuth = FB.getAuth(fbApp);
    fbDb = FB.getFirestore(fbApp);
    FB.onAuthStateChanged(fbAuth, u => { if (u) startSync(u); else stopSync(); });
  } catch (err) {
    setStatus('Firebase 初始化失敗：' + err.message, 'bad');
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
