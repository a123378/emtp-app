# 模式二 甄試強度難易度配比調整實施計畫 (IMPLEMENTATION.md)

## 1. 需求背景與目標
- **需求**：模式二（題庫練習）的「甄試強度」出題希望改為 **4 個中等難度 + 6 個中等偏上甚至困難難度** 的精準結構化配比。
- **目標**：
  1. 強化 Gemini AI 出題 Prompt，明確定義 10 題之梯次分佈（前 4 題中等、後 6 題中等偏上/難）。
  2. JSON Schema 結構擴充 `difficulty` 欄位（`"中等"`、`"中等偏上"`、`"困難"`）。
  3. UI 下拉選單文字優化，明確標示「4題中等＋6題中等偏上至難」。
  4. 作答介面（Quiz Runner）與結算檢討介面（Quiz Review）即時顯示題目難度徽章，提供清晰回饋。

---

## 2. 涉及檔案路徑清單
1. `c:\Users\a1233\Desktop\AI\複習網頁\index.html` - 更新 AI 出題彈窗中的難易度下拉選項說明文字。
2. `c:\Users\a1233\Desktop\AI\複習網頁\app.js` - 更新 `generateAiQuiz()` 之 Prompt 規範、JSON 解析驗證，以及 `renderRunnerQuestion()` 和 `renderQuizReviewList()` 的難易度徽章渲染邏輯。
3. `c:\Users\a1233\Desktop\AI\複習網頁\style.css` - 新增難易度徽章樣式（中等、中等偏上、困難之視覺識別色）。

---

## 3. 函式與介面定義變更

### 3.1 題型資料結構 (Question Model) 擴充
```typescript
interface QuizQuestion {
  id: string;
  question: string;
  options: string[];
  answer: number;
  explanation: string;
  chId: string;
  chNum: string;
  chTitle: string;
  difficulty?: '中等' | '中等偏上' | '困難'; // [新增欄位]
  image?: string;
}
```

### 3.2 函式邏輯變更清單
- **`generateAiQuiz()`** (`app.js`):
  - 調整 `diffDesc`：若 `diff === 'high'`，嚴格約束前 4 題為「中等」，後 6 題為「中等偏上至高難度」，並定義各層次考核範疇。
  - Prompt 規則擴充：要求 Gemini 嚴格按照題號順序分配難度，並在回傳的 JSON 物件中輸出 `"difficulty"`。
  - 資料驗證補強：若 API 未回傳 `difficulty`，依索引兜底指派（前 4 題 `中等`，後 6 題 `中等偏上`）。
- **`renderRunnerQuestion(idx)`** (`app.js`):
  - 在上方題號與章節標籤處，動態渲染難度標籤徽章（例如 `<span class="m2-qdiff-badge diff-medium">中等</span>`）。
- **`renderQuizReviewList(questions, userAnswers)`** (`app.js`):
  - 在逐題詳解卡片標題列加入對應難度標籤，讓學員複習時能清楚掌握該題強度。

---

## 4. 拆解任務清單 (Tasks for Claude)

### Task 1: 修改 `index.html` 下拉選單
- **路徑**：`c:\Users\a1233\Desktop\AI\複習網頁\index.html`
- **修改位置**：約第 442 行 `<select id="ai-diff-select">`
- **具體內容**：
  ```html
  <select id="ai-diff-select" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);margin-top:4px">
    <option value="high">甄試全真強度（4題中等 ＋ 6題中等偏上至高難度）</option>
    <option value="expert">教授級地獄挑戰（全卷複合情境、多重陷阱、高階鑑別）</option>
  </select>
  ```

### Task 2: 修改 `style.css` 新增難度徽章樣式
- **路徑**：`c:\Users\a1233\Desktop\AI\複習網頁\style.css`
- **修改位置**：約第 1350 行附近
- **具體內容**：
  ```css
  /* 難易度標籤樣式 */
  .m2-qdiff-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 700;
    margin-left: 6px;
    vertical-align: middle;
  }
  .m2-qdiff-badge.diff-medium {
    background: #e0f2fe;
    color: #0369a1;
    border: 1px solid #bae6fd;
  }
  .m2-qdiff-badge.diff-hard {
    background: #fef3c7;
    color: #b45309;
    border: 1px solid #fde68a;
  }
  .m2-qdiff-badge.diff-expert {
    background: #fee2e2;
    color: #b91c1c;
    border: 1px solid #fecaca;
  }
  ```

### Task 3: 修改 `app.js` 中的 `generateAiQuiz()`
- **路徑**：`c:\Users\a1233\Desktop\AI\複習網頁\app.js`
- **修改位置**：約第 1827 行起
- **具體內容**：
  1. 更新 `diffDesc`：
     ```javascript
     const diffDesc = (diff === 'expert')
       ? '教授級地獄挑戰：全卷10題皆為極高難度，包含複合臨床情境、雙重陷阱、生理數值邊緣變動與處置邏輯先後抉擇。'
       : '甄試全真強度（結構化 4:6 配比）：\n' +
         '  - 第 1～4 題【中等難度】：評量核心法規、標準作業程序(SOP)、常規藥物劑量與基礎急救評估機轉。\n' +
         '  - 第 5～10 題【中等偏上甚至困難】：評量進階臨床決策、非典型症狀鑑別、高難度心電圖判讀、矛盾生命徵象的急救優先順序抉擇、特殊族群處置陷阱。';
     ```
  2. 在 Prompt 的【嚴格規則】中增列：
     ```javascript
     `6. 難易度配比嚴格要求：
        - 若難易度為「甄試全真強度」，第 1～4 題必須為「中等」，第 5～10 題必須為「中等偏上」或「困難」。
        - 每題 JSON 必須包含 "difficulty" 欄位，值為 "中等"、"中等偏上" 或 "困難"。`
     ```
  3. 更新 Prompt 範例 JSON：
     ```json
     {
       "question": "題目情境敘述...",
       "options": ["選項A", "選項B", "選項C", "選項D"],
       "answer": 0,
       "explanation": "詳細解析...",
       "difficulty": "中等",
       "chId": "ch21",
       "chNum": "CH21",
       "chTitle": "心律不整之判讀與處置"
     }
     ```
  4. 在 `validatedQuestions` 映射時提取並保護 `difficulty`：
     ```javascript
     difficulty: item.difficulty || (diff === 'expert' ? '困難' : (idx < 4 ? '中等' : '中等偏上')),
     ```

### Task 4: 修改 `app.js` 中的題目與檢討渲染函式
- **路徑**：`c:\Users\a1233\Desktop\AI\複習網頁\app.js`
- **修改位置**：
  1. `renderRunnerQuestion(idx)`（約第 1194 行）：
     在 `tagMeta` 題號文字旁渲染難度徽章：
     ```javascript
     let diffBadgeHtml = '';
     if (q.difficulty) {
       const diffClass = q.difficulty === '中等' ? 'diff-medium' : (q.difficulty === '困難' ? 'diff-expert' : 'diff-hard');
       diffBadgeHtml = `<span class="m2-qdiff-badge ${diffClass}">${escapeHtml(q.difficulty)}</span>`;
     }
     if (tagMeta) tagMeta.innerHTML = `第 ${idx + 1} / ${total} 題 ${diffBadgeHtml}`;
     ```
  2. `renderQuizReviewList(questions, userAnswers)`（約第 1560 行）：
     在每道檢討題目的章節與題號標籤旁，一併渲染 `q.difficulty` 徽章。

### Task 5: 驗證與測試
1. 語法檢查：確保 `app.js`、`index.html`、`style.css` 無語法錯誤。
2. 啟動本機預覽或透過 Node 驗證 JS 語法結構。
3. 測試點擊「模式二」→「AI 智慧出題」→ 難易度選單是否正確顯示「4題中等＋6題中等偏上至高難度」。
4. 測試 API 出題時 Prompt 結構是否如期傳送。

---

## 5. 完成標記與交付
本計畫由架構規劃師（Gemini）產出。代碼編寫請由資深代碼實作者（Claude）依照上述 Tasks 依序執行。
