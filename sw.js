// 這個 Service Worker 已不再被 app.js 註冊使用 (2026-09-09 移除離線快取清理機制)。
// 保留此檔案只是避免瀏覽器對 ./sw.js 的請求 404；內容留空即可。
// 若未來想真正支援離線快取，請重新設計快取策略後在 app.js 中呼叫 navigator.serviceWorker.register()。
