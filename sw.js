/*
 * sw.js — 離線快取 Service Worker（2026-11-05 重新啟用）
 *
 * 2026-09 舊版因「手機一直卡在舊版」被移除。這版的原則：
 *   1. 網頁本體與章節資料一律「網路優先」：有網路就拿最新版，斷網或網路太慢才用快取。
 *      網址帶 ?v= 版號時，快取版號不同就不會因為網路慢而改用快取（避免新 HTML 配舊 JS）。
 *   2. 圖片「先用快取、背景更新」：圖片多、很少改，這樣比較快。
 *   3. 「離線包」：使用者按下載後，依 offline-files.json 一次抓齊全部章節與圖片；
 *      每個檔案帶內容雜湊，重新部署後只補抓有變動的檔案。
 *   4. 快取鍵一律去掉查詢字串，換版號不會讓快取越積越多。
 */
'use strict';

const CACHE = 'emtp-offline-v1';
const FONT_CACHE = 'emtp-fonts-v1';
const KEEP_CACHES = [CACHE, FONT_CACHE];

const NETWORK_TIMEOUT_MS = 4000;   // 網路超過這個時間沒回應，就先用快取
const POOL_SIZE = 6;               // 同時下載／比對的檔案數
const HASH_HEADER = 'x-offline-hash';
const VERSION_HEADER = 'x-asset-version';
const MANIFEST_URL = 'offline-files.json';
const SCOPE = new URL(self.registration.scope);
const META_KEY = new URL('__offline-manifest__', SCOPE).href;

// 安裝時先存網頁本體，確保至少能離線打開首頁
const SHELL = ['index.html', 'app.js', 'style.css', 'sync.js', 'offline.js', 'manifest.json',
  'icons/favicon.png', 'icons/icon-192.png'];

// 不經過快取、直接走網路的路徑
const BYPASS_PREFIXES = ['sw.js', MANIFEST_URL, '__/', 'audio/'];
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

let currentSync = null;

// ── 工具 ───────────────────────────────────────────────

/** 同源網址 → 快取鍵（去掉查詢字串，資料夾路徑視為 index.html） */
function cacheKey(url) {
  const u = new URL(url, SCOPE);
  const pathname = u.pathname.endsWith('/') ? `${u.pathname}index.html` : u.pathname;
  return u.origin + pathname;
}

function scopeRelative(url) {
  const u = new URL(url);
  return u.origin === SCOPE.origin && u.pathname.startsWith(SCOPE.pathname)
    ? u.pathname.slice(SCOPE.pathname.length)
    : null;
}

function isCacheable(res) {
  return Boolean(res) && res.status === 200 && (res.type === 'basic' || res.type === 'cors');
}

/** 複製回應並加上自訂標頭。body 已被解壓，所以拿掉 content-encoding / content-length。 */
function withHeaders(res, extra) {
  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  Object.entries(extra).forEach(([k, v]) => headers.set(k, v));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); }
    );
  });
}

/** 以固定併發數處理清單，回傳每一項的結果（順序同輸入） */
async function runPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function broadcast(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  clients.forEach(c => c.postMessage(message));
}

// ── 快取策略 ───────────────────────────────────────────

/**
 * 網路優先；網路失敗才回快取。
 * 若快取的版號（?v=）與這次請求相同，網路超過 NETWORK_TIMEOUT_MS 也先回快取；
 * 版號不同就一定等網路，避免新舊檔案混用。網路晚到的回應仍會寫回快取。
 */
async function networkFirst(event, key) {
  const cache = await caches.open(CACHE);
  const reqVersion = new URL(event.request.url).searchParams.get('v') || '';
  const network = fetch(event.request).then(res => {
    if (isCacheable(res)) {
      const copy = withHeaders(res.clone(), { [VERSION_HEADER]: reqVersion });
      event.waitUntil(cache.put(key, copy).catch(() => {}));
    }
    return res;
  });
  event.waitUntil(network.then(() => {}, () => {}));

  const cached = await cache.match(key);
  if (!cached) {
    try {
      return await network;
    } catch (err) {
      if (event.request.mode === 'navigate') {
        const shell = await cache.match(cacheKey('index.html'));
        if (shell) return shell;
      }
      throw err;
    }
  }

  const sameVersion = !reqVersion || cached.headers.get(VERSION_HEADER) === reqVersion;
  try {
    return sameVersion ? await withTimeout(network, NETWORK_TIMEOUT_MS) : await network;
  } catch (err) {
    return cached;
  }
}

/** 先回快取，同時在背景更新；沒有快取就等網路。 */
async function staleWhileRevalidate(event, cacheName, key) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(key);
  // 自家圖片略過瀏覽器 HTTP 快取（Firebase 預設圖片 max-age=3600），換圖後能馬上更新
  const init = cacheName === CACHE ? { cache: 'no-cache' } : undefined;
  const network = fetch(event.request, init).then(res => {
    const fontOk = cacheName === FONT_CACHE && res.type === 'opaque';
    if (isCacheable(res) || fontOk) {
      const copy = res.clone();
      event.waitUntil(cache.put(key, copy).catch(() => {}));
    }
    return res;
  });
  if (cached) {
    event.waitUntil(network.then(() => {}, () => {}));
    return cached;
  }
  return network;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;

  const url = new URL(req.url);
  if (FONT_HOSTS.has(url.hostname)) {
    event.respondWith(staleWhileRevalidate(event, FONT_CACHE, req.url));
    return;
  }

  const rel = scopeRelative(req.url);
  if (rel === null) return; // 其他網域（Gemini API、Firebase SDK 等）不碰
  if (BYPASS_PREFIXES.some(p => rel.startsWith(p))) return;

  const key = cacheKey(req.url);
  if (rel.startsWith('images/') || rel.startsWith('icons/')) {
    event.respondWith(staleWhileRevalidate(event, CACHE, key));
  } else {
    event.respondWith(networkFirst(event, key));
  }
});

// ── 生命週期 ───────────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(SHELL.map(async path => {
      const res = await fetch(path, { cache: 'no-cache' });
      if (isCacheable(res)) await cache.put(cacheKey(path), res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => !KEEP_CACHES.includes(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// ── 離線包 ─────────────────────────────────────────────

/** 清單裡的路徑必須是本站範圍內的普通相對路徑 */
function isSafePath(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || /[\\?#%]/.test(p) || p.includes('..')) return false;
  try {
    const u = new URL(p, SCOPE);
    return u.origin === SCOPE.origin && u.pathname.startsWith(SCOPE.pathname);
  } catch (e) {
    return false;
  }
}

function isValidManifest(m) {
  return Boolean(m) && typeof m.version === 'string' && Boolean(m.files) && typeof m.files === 'object'
    && Object.entries(m.files).every(([p, h]) => isSafePath(p) && typeof h === 'string' && /^[0-9a-f]{16}$/.test(h));
}

async function readStoredManifest(cache) {
  const res = await cache.match(META_KEY);
  if (!res) return null;
  try { return await res.json(); } catch (e) { return null; }
}

/** 與 scripts/build-offline-list.js 相同的雜湊：SHA-256 前 16 個十六進位字元 */
async function hashBuffer(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * 快取裡的檔案是否已是清單上的版本。
 * 平常瀏覽寫入的回應沒有雜湊標記，這時直接算內容雜湊比對，避免重複下載。
 */
async function isUpToDate(cache, path, hash) {
  const cached = await cache.match(cacheKey(path));
  if (!cached) return false;
  const tagged = cached.headers.get(HASH_HEADER);
  if (tagged) return tagged === hash;
  try { return (await hashBuffer(await cached.arrayBuffer())) === hash; } catch (e) { return false; }
}

async function downloadOne(cache, path, hash) {
  const res = await fetch(`${path}?h=${hash}`, { cache: 'no-store' });
  if (!isCacheable(res)) throw new Error(`${path}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if ((await hashBuffer(buf)) !== hash) throw new Error(`${path}: 內容與清單不符`);
  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.set(HASH_HEADER, hash);
  await cache.put(cacheKey(path), new Response(buf, { status: 200, statusText: 'OK', headers }));
}

async function runSync() {
  const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`無法取得檔案清單（HTTP ${res.status}）`);
  const manifest = await res.json();
  if (!isValidManifest(manifest)) throw new Error('檔案清單格式錯誤');

  const cache = await caches.open(CACHE);
  const entries = Object.entries(manifest.files);
  const fresh = await runPool(entries, POOL_SIZE, ([path, hash]) => isUpToDate(cache, path, hash));
  const queue = entries.filter((_, i) => !fresh[i]);

  const total = queue.length;
  let done = 0;
  const failed = [];
  await broadcast({ type: 'offline:progress', done, total });

  await runPool(queue, POOL_SIZE, async ([path, hash]) => {
    try {
      await downloadOne(cache, path, hash);
    } catch (err) {
      failed.push(path);
    }
    done += 1;
    await broadcast({ type: 'offline:progress', done, total });
  });

  if (failed.length) {
    throw new Error(`${failed.length} 個檔案下載失敗`);
  }

  // 刪掉舊清單有、新清單已移除的檔案
  const previous = await readStoredManifest(cache);
  if (previous && previous.files) {
    const removed = Object.keys(previous.files).filter(p => !(p in manifest.files) && isSafePath(p));
    await Promise.all(removed.map(p => cache.delete(cacheKey(p))));
  }

  const meta = {
    version: manifest.version,
    totalBytes: manifest.totalBytes,
    fileCount: entries.length,
    syncedAt: new Date().toISOString(),
    files: manifest.files
  };
  await cache.put(META_KEY, new Response(JSON.stringify(meta), {
    headers: { 'content-type': 'application/json' }
  }));
  return { version: meta.version, fileCount: meta.fileCount, totalBytes: meta.totalBytes, downloaded: total };
}

function syncPack() {
  if (!currentSync) {
    currentSync = runSync()
      .then(result => broadcast({ type: 'offline:done', ...result }))
      .catch(err => broadcast({ type: 'offline:error', message: (err && err.message) || String(err) }))
      .finally(() => { currentSync = null; });
  }
  return currentSync;
}

async function reportStatus() {
  const cache = await caches.open(CACHE);
  const meta = await readStoredManifest(cache);
  await broadcast({
    type: 'offline:status',
    syncing: Boolean(currentSync),
    version: meta ? meta.version : null,
    fileCount: meta ? meta.fileCount : 0,
    totalBytes: meta ? meta.totalBytes : 0,
    syncedAt: meta ? meta.syncedAt : null
  });
}

/** 「強制更新」用：只重抓網頁本體，不動已下載的離線包 */
async function refreshShell() {
  const cache = await caches.open(CACHE);
  await Promise.all(SHELL.map(async path => {
    try {
      const res = await fetch(path, { cache: 'no-store' });
      if (isCacheable(res)) await cache.put(cacheKey(path), res);
    } catch (e) { /* 斷網時保留原本的快取 */ }
  }));
  await broadcast({ type: 'offline:shell-refreshed' });
}

async function clearPack() {
  await Promise.all(KEEP_CACHES.map(n => caches.delete(n)));
  await broadcast({ type: 'offline:cleared' });
}

const MESSAGE_HANDLERS = {
  'offline:sync': syncPack,
  'offline:status': reportStatus,
  'offline:refresh-shell': refreshShell,
  'offline:clear': clearPack
};

self.addEventListener('message', event => {
  const handler = event.data && MESSAGE_HANDLERS[event.data.type];
  if (handler) event.waitUntil(handler());
});
