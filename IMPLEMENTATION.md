# EMT-P 複習網頁功能優化實施計畫 (IMPLEMENTATION.md)

本文件由架構規劃師 (Gemini) 制定，詳細拆解「電腦端快捷鍵」與「歷屆全真題庫純淨化」兩大需求的技術架構與實作步驟，供資深代碼實作者 (Claude) 嚴格依序執行。

---

## 涉及檔案路徑清單
1. `c:\Users\a1233\Desktop\AI\複習網頁\app.js`（核心互動與快捷鍵邏輯、題庫篩選）
2. `c:\Users\a1233\Desktop\AI\複習網頁\index.html`（快捷鍵提示 UI 與歷屆全真題庫說明文案）

---

## 需求與架構設計

### 需求一：電腦端快捷鍵 (Desktop Keyboard Shortcuts)
- **觸發防護 (Guard Clause)**：
  - 若使用者焦點處於輸入框、文字區、下拉選單或可編輯元素（`INPUT`, `TEXTAREA`, `SELECT`, `isContentEditable`），一律不觸發快捷鍵。
  - 若當前有浮動彈窗處於開啟狀態（如 `.modal-overlay:not(.hidden)`），不觸發常規快捷鍵（保留 `Escape` 關閉彈窗）。
- **模式一（重點整理閱讀模式）**：
  - `ArrowUp` (↑)：`#main-content` 向上平滑捲動（`scrollBy({ top: -160, behavior: 'smooth' })`），阻止預設事件。
  - `ArrowDown` (↓)：`#main-content` 向下平滑捲動（`scrollBy({ top: 160, behavior: 'smooth' })`），阻止預設事件。
  - `ArrowLeft` (←)：切換上一章（呼叫 `prevChapter()`），阻止預設事件。
  - `ArrowRight` (→)：切換下一章（呼叫 `nextChapter()`），阻止預設事件。
- **模式二（題庫測驗模式）**：
  - 僅在測驗進行中（`state.currentMode === 2` 且 `#m2-quiz-runner` 不具 `hidden`，且 `state.m2Runner?.questions?.length > 0`）時生效：
  - `ArrowLeft` (←)：上一題（呼叫 `prevRunnerQ()`），阻止預設事件。
  - `ArrowRight` (→)：下一題（呼叫 `nextRunnerQ()`），阻止預設事件。
  - `1`, `2`, `3`, `4` (含主鍵盤與九宮格數字鍵)：
    - 對應選項 A (0)、B (1)、C (2)、D (3)。
    - 呼叫 `selectRunnerOption(state.m2Runner.currentIndex, optIdx)`，阻止預設事件。

### 需求二：歷屆全真抽測題庫純淨化 (Pure Past Exam Pool)
- **題庫現況**：
  - `state.allQuizzes` 目前包含 `chapters/all_quizzes.json`（616 題 108~113 年甄試與新北小考）以及歷史儲存之 AI 題目（`isAiGenerated: true`）。
- **調整方針**：
  - **歷屆全真抽測 (`startPastExamQuiz`)**：在隨機取樣前，嚴格過濾題庫 `state.allQuizzes.filter(q => !q.isAiGenerated && !String(q.id).startsWith('ai-'))`，確保只有新北小考與甄試題目，絕對無 AI 題。
  - **章節專項抽測 (`startSelectedChapterQuiz`)**：維持使用 `state.allQuizzes`，AI 題目**保留並僅出現在章節專項**中。
  - **文案與提示同步**：更新 `index.html` 相關卡片與彈窗說明，明確標註純真題（不含 AI 題）。

---

## 任務拆解 (Tasks)

### Task 1: 模式二歷屆全真抽測題庫排除 AI 題
- **目標檔案**：`app.js`
- **修改位置**：約 line 1724 `startPastExamQuiz`
- **具體變更**：
  ```javascript
  // ── 變更前 ──
  function startPastExamQuiz(count = 10) {
    if (!state.allQuizzes || state.allQuizzes.length === 0) {
      alert('正在載入歷屆試題庫，請稍候重試…');
      return;
    }
    const shuffled = [...state.allQuizzes].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, count);
    startM2Quiz('past', `🎲 歷屆全真抽測 (${selected.length}題)`, selected);
  }

  // ── 變更後 ──
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
  ```

---

### Task 2: 註冊電腦端全域快捷鍵監聽
- **目標檔案**：`app.js`
- **修改位置**：約 line 908 `bindEvents()` 內的鍵盤監聽區塊
- **具體變更**：
  將現有的 `document.addEventListener('keydown', ...)` 擴充為支援模式一與模式二的快捷鍵處理：
  ```javascript
  // ── 鍵盤快捷鍵 (電腦端友善操作) ──
  document.addEventListener('keydown', (e) => {
    // 1. 若處於輸入框、文字區域、下拉選單或富文本中，不攔截方向鍵與數字鍵
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    const isEditing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || document.activeElement?.isContentEditable;

    // 快捷鍵: / 聚焦搜尋框
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
      return;
    }

    // 若使用者正在輸入，不執行後續快捷鍵
    if (isEditing) return;

    // 若有非 runner 的浮動彈窗開啟，不觸發模式一/二快捷鍵
    const openModal = document.querySelector('.modal-overlay:not(.hidden)');
    if (openModal) return;

    // ── 模式一快捷鍵 ──
    if (state.currentMode === 1) {
      const scrollEl = els.mainContent || window;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        scrollEl.scrollBy({ top: -160, behavior: 'smooth' });
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        scrollEl.scrollBy({ top: 160, behavior: 'smooth' });
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prevChapter();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        nextChapter();
      }
      return;
    }

    // ── 模式二快捷鍵 (僅在測驗進行中生效) ──
    if (state.currentMode === 2) {
      const runnerEl = document.getElementById('m2-quiz-runner');
      const isRunnerActive = runnerEl && !runnerEl.classList.contains('hidden') && state.m2Runner?.questions?.length > 0;
      if (!isRunnerActive) return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prevRunnerQ();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        nextRunnerQ();
      } else if (['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        const optIdx = parseInt(e.key, 10) - 1;
        const curQ = state.m2Runner.questions[state.m2Runner.currentIndex];
        if (curQ && curQ.options && curQ.options[optIdx] !== undefined) {
          selectRunnerOption(state.m2Runner.currentIndex, optIdx);
        }
      }
    }
  });
  ```

---

### Task 3: 介面標籤與提示優化
- **目標檔案**：`index.html`
- **具體變更**：
  1. **歷屆全真抽測卡片與彈窗說明更新**：
     - 修改 `index.html` 內的卡片描述：
       `從 108～113 年衛福部甄試與新北小考題庫隨機抽測（純歷屆真題，不含 AI 題），可自選 10～80 題全真模擬實戰。`
     - 修改 `#m2-past-modal` 內的說明文字：
       `💡 題庫涵蓋 108～113 年衛福部甄試與新北小考共 616 題純歷屆真題（保證不含 AI 題）。`
  2. **測驗作答視圖底部添加快捷鍵提示**：
     - 在 `#m2-quiz-runner .m2-runner-footer` 區域添加電腦端快捷鍵小提示：
       `<div class="m2-desktop-shortcut-hint" style="font-size:0.8rem;color:var(--text-muted);text-align:center;margin-top:8px">💡 電腦端快捷鍵：[← / →] 上下題 ‧ [1~4] 選擇選項</div>`

---

## 驗證計畫 (Verification Plan)
1. **語法與相依性檢驗**：
   - 執行 `node -c app.js` 驗證 JavaScript 語法無誤。
2. **題庫隔離測試**：
   - 執行腳本檢驗 `startPastExamQuiz` 篩選後的試題池，確認包含 `108~113年甄試` 與 `小考1~5`，且 `isAiGenerated` 為 `false`，題數合計 616。
   - 確認 `startSelectedChapterQuiz` 仍正確包含 AI 題目。
3. **快捷鍵功能手動/模擬驗證**：
   - 模擬模式一 `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`。
   - 模擬模式二作答狀態 `ArrowLeft`, `ArrowRight`, `1`, `2`, `3`, `4`。
   - 驗證在 `INPUT` 欄位輸入時不會意外觸發切換章節或作答。
