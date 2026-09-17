# 模式二 AI 出題完成醒目彈出視窗實施計畫 (IMPLEMENTATION.md)

## 1. 需求背景與目標
- **需求**：模式二 AI 智慧出題完成後，使用者希望提醒更明顯，「直接出現完成的彈出視窗」。
- **目標**：
  1. 無論使用者停留在模式二出題視窗前、或已縮小視窗切換到模式一閱讀章節筆記，當 AI 題目生成完成時，立即主動彈出醒目的 `#ai-complete-modal` 視窗。
  2. 彈窗內顯示本次出題的範疇、難易度（例如甄試全真強度 4:6 配比）、題數（10 題），並提供：
     - **「🚀 立即開始測驗」**：一鍵切換至模式二並直接進入測驗作答。
     - **「稍後作答（保留於大廳）」**：關閉彈窗，試卷安全保存在大廳，使用者可隨時點擊大廳橫幅或導航紅點進入。
  3. 搭配無外部依賴的輕柔 Web Audio 提示音（`playSuccessBeep`），雙重強化感知。

---

## 2. 涉及檔案路徑清單
1. `c:\Users\a1233\Desktop\AI\複習網頁\index.html` - 新增出題完成彈窗 `#ai-complete-modal` 的 HTML 標記。
2. `c:\Users\a1233\Desktop\AI\複習網頁\style.css` - 新增完成彈窗專屬卡片、高光與按鈕樣式。
3. `c:\Users\a1233\Desktop\AI\複習網頁\app.js` - 新增彈窗控制邏輯與音效函式，更新 `generateAiQuiz()` 串接完成彈窗。

---

## 3. 函式與介面定義變更

### 3.1 新增函式
- **`showAiCompleteModal(title, questions, topicDesc, diff)`** (`app.js`):
  - 填入彈窗內容（主題、難易度標籤、題數）。
  - 移除 `#ai-complete-modal` 的 `hidden` 類別。
  - 播放提示音 `playSuccessBeep()`。
- **`closeAiCompleteModal()`** (`app.js`):
  - 為 `#ai-complete-modal` 加上 `hidden` 類別。
- **`startCompletedAiQuiz()`** (`app.js`):
  - 關閉完成彈窗。
  - 若當前不在模式二，調用 `switchMode(2)`。
  - 清除暫存與小紅點提醒，直接呼叫 `startM2Quiz('ai', title, questions)` 開始作答。
- **`playSuccessBeep()`** (`app.js`):
  - 利用 Web Audio API (`AudioContext`) 產生雙音階短音（D5 -> A5），無需下載任何音訊檔，安全靜默容錯。

### 3.2 修改函式
- **`generateAiQuiz()`** (`app.js`):
  - 生成完成時（約第 1890 行），不管 `modalVisible` 為何：
    - 均關閉 `#m2-ai-modal` (`closeAiQuizModal()`) 與重置 UI (`setAiGenModalUI(false)`)。
    - 保存到 `state.pendingAiQuiz = { title, questions: validatedQuestions };`。
    - 點亮紅點與大廳橫幅 (`showAiReadyNotice()`)。
    - **直接調用 `showAiCompleteModal(title, validatedQuestions, topicDesc, diff)` 彈出完成視窗！**
- **`initMode2()`** (`app.js`):
  - 彈窗點擊背景遮罩關閉陣列中新增 `'ai-complete-modal'`。

---

## 4. 拆解任務清單 (Tasks for Claude)

### Task 1: 修改 `index.html` 新增完成彈出視窗
- **路徑**：`c:\Users\a1233\Desktop\AI\複習網頁\index.html`
- **修改位置**：緊接著 `#m2-ai-modal` 之後（約第 456 行後）
- **具體內容**：
  ```html
  <!-- Modal 3.5: AI Quiz Complete Alert Modal -->
  <div id="ai-complete-modal" class="modal-overlay hidden" style="z-index:9999">
    <div class="modal-box ai-complete-box">
      <div class="modal-header">
        <h3>🎉 AI 智慧試卷已生成完成！</h3>
        <button class="modal-close" onclick="closeAiCompleteModal()">✕</button>
      </div>
      <div class="modal-body">
        <div class="ai-complete-hero">
          <div class="ai-complete-icon">🤖✨</div>
          <h4 id="ai-complete-title" class="ai-complete-title">高階臨床試卷已備妥</h4>
          <p class="ai-complete-desc">醫學教授 AI 已為您完成 10 道結構化臨床情境命題與考點解析！</p>
          <div class="ai-complete-meta-grid">
            <div class="ai-meta-item">
              <span class="ai-meta-lbl">出題範疇</span>
              <span class="ai-meta-val" id="ai-complete-topic">全科綜合</span>
            </div>
            <div class="ai-meta-item">
              <span class="ai-meta-lbl">試卷強度</span>
              <span class="ai-meta-val" id="ai-complete-diff">甄試全真強度 (4中等+6難)</span>
            </div>
            <div class="ai-meta-item">
              <span class="ai-meta-lbl">試卷題數</span>
              <span class="ai-meta-val">精選 10 題</span>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-footer" style="justify-content:space-between">
        <button class="modal-btn" onclick="closeAiCompleteModal()">稍後作答（保留於大廳）</button>
        <button class="modal-btn primary ai-start-btn" onclick="startCompletedAiQuiz()">🚀 立即開始測驗</button>
      </div>
    </div>
  </div>
  ```

### Task 2: 修改 `style.css` 新增出題完成彈窗樣式
- **路徑**：`c:\Users\a1233\Desktop\AI\複習網頁\style.css`
- **修改位置**：在難易度標籤樣式後或模式二彈窗區塊
- **具體內容**：
  ```css
  /* ── AI 出題完成彈出視窗專屬樣式 ── */
  .ai-complete-box {
    max-width: 520px;
    border: 2px solid var(--primary, #3b82f6);
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.25);
    animation: scaleUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .ai-complete-hero {
    text-align: center;
    padding: 10px 0 6px;
  }
  .ai-complete-icon {
    font-size: 3.2rem;
    margin-bottom: 8px;
    animation: bounce 1s ease infinite alternate;
  }
  @keyframes bounce {
    from { transform: translateY(0); }
    to { transform: translateY(-6px); }
  }
  .ai-complete-title {
    font-size: 1.25rem;
    font-weight: 800;
    color: var(--text);
    margin-bottom: 6px;
  }
  .ai-complete-desc {
    font-size: 0.9rem;
    color: var(--text-muted);
    margin-bottom: 16px;
    line-height: 1.4;
  }
  .ai-complete-meta-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 8px;
    background: var(--surface-2, rgba(0,0,0,0.03));
    padding: 12px;
    border-radius: 10px;
    border: 1px solid var(--border);
    margin-bottom: 10px;
  }
  .ai-meta-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .ai-meta-lbl {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-bottom: 4px;
    font-weight: 600;
  }
  .ai-meta-val {
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--text);
  }
  .ai-start-btn {
    font-size: 0.95rem;
    font-weight: 700;
    padding: 10px 20px;
    background: linear-gradient(135deg, #2563eb, #1d4ed8);
    box-shadow: 0 4px 12px rgba(37, 99, 235, 0.35);
  }
  ```

### Task 3: 修改 `app.js` 新增完成彈窗與音效控制函式
- **路徑**：`c:\Users\a1233\Desktop\AI\複習網頁\app.js`
- **修改位置**：約在 `openPendingAiQuiz()` 附近
- **具體內容**：
  ```javascript
  // ── Web Audio 提示音（安全零依賴） ──
  function playSuccessBeep() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      const now = ctx.currentTime;
      osc.frequency.setValueAtTime(587.33, now); // D5
      osc.frequency.setValueAtTime(880, now + 0.12); // A5
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.35);
    } catch (e) {
      // 瀏覽器未互動時可能限制音訊，靜默容錯
    }
  }

  // ── AI 出題完成彈出視窗控制 ──
  function showAiCompleteModal(title, questions, topicDesc, diff) {
    const titleEl = $('#ai-complete-title');
    const topicEl = $('#ai-complete-topic');
    const diffEl = $('#ai-complete-diff');
    if (titleEl) titleEl.textContent = title;
    if (topicEl) {
      const cleanTopic = topicDesc.split('（')[0].replace('高級救護技術員(EMT-P)', '').trim();
      topicEl.textContent = cleanTopic.length > 12 ? cleanTopic.slice(0, 12) + '…' : cleanTopic;
    }
    if (diffEl) {
      diffEl.textContent = diff === 'expert' ? '教授級地獄挑戰' : '甄試全真 (4中+6難)';
    }
    $('#ai-complete-modal')?.classList.remove('hidden');
    playSuccessBeep();
  }

  function closeAiCompleteModal() {
    $('#ai-complete-modal')?.classList.add('hidden');
  }

  function startCompletedAiQuiz() {
    closeAiCompleteModal();
    if (!state.pendingAiQuiz) return;
    const { title, questions } = state.pendingAiQuiz;
    state.pendingAiQuiz = null;
    clearAiReadyNotice();
    if (state.currentMode !== 2) switchMode(2);
    startM2Quiz('ai', title, questions);
  }
  ```

### Task 4: 修改 `app.js` 中的 `generateAiQuiz()` 與 `initMode2()`
- **路徑**：`c:\Users\a1233\Desktop\AI\複習網頁\app.js`
- **修改位置**：
  1. `generateAiQuiz()` 尾端（約第 1890 行）：
     ```javascript
     state.aiGenInProgress = false;
     const title = `🤖 AI 智慧出題 (${diff === 'expert' ? '地獄挑戰級' : '甄試全真強度'})`;

     // 關閉等待視窗並重置按鈕
     closeAiQuizModal();
     setAiGenModalUI(false);

     // 保存待測資料並點亮紅點/大廳橫幅
     state.pendingAiQuiz = { title, questions: validatedQuestions };
     showAiReadyNotice();

     // 直接彈出醒目的「完成彈出視窗」！
     showAiCompleteModal(title, validatedQuestions, topicDesc, diff);
     ```
  2. `initMode2()`（約第 905 行）：
     點擊遮罩關閉陣列中加入 `'ai-complete-modal'`：
     `['gemini-api-modal', 'm2-ch-modal', 'm2-ai-modal', 'manual-add-modal', 'ai-complete-modal'].forEach(...)`

### Task 5: 驗證與測試
1. 執行 `node -c app.js` 確認 JS 語法正常。
2. 驗證不管在哪個視窗/分頁，AI 生成完畢時立即彈出完成對話框與播放短音。
3. 測試「🚀 立即開始測驗」與「稍後作答（保留於大廳）」兩個按鈕行為正確。

---

## 5. 交付提示
本實施計畫已由架構規劃師（Gemini）完成規劃。請切換至 Claude 開始執行代碼實作。
