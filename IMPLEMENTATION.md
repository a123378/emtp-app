# 刪除模式一各章節前方名詞解釋實施計畫 (IMPLEMENTATION.md)

## 1. 需求背景與目標
- **需求**：刪除模式一各章節前面的名詞解釋。
- **目標**：
  - 模式一各章節在渲染筆記時，移除原「關鍵詞句及定義」（含中文術語、English、定義與核心精神）表格。
  - 將後續的標籤序號自動順調，使版面直接接續「歷屆試題」與「內文重點整理」。

---

## 2. 涉及檔案路徑清單
1. `c:\Users\a1233\Desktop\AI\複習網頁\app.js`

---

## 3. 函式與介面定義變更

### `renderNotes(cd, chId)` (`app.js`)
- 引入動態序號計數器 `let secNum = 1;`。
- 歷屆試題標籤序號改為 `${secNum++}`。
- **刪除** 原「關鍵詞句及定義」區塊（即 `if (cd.keywords && cd.keywords.length)` 相關代碼）。
- 內文重點整理標籤序號改為 `${secNum++}`（通常為 2）。
- 重點一覽標籤序號改為 `${secNum++}`（通常為 3）。

---

## 4. 拆解任務清單 (Tasks for Claude)

### Task 1: 修改 `app.js` 中的 `renderNotes` 函式
- **路徑**：`c:\Users\a1233\Desktop\AI\複習網頁\app.js`
- **修改位置**：約第 300～355 行
- **具體修改**：
  1. 在歷屆試題渲染前加入序號計數器：
     ```javascript
     let secNum = 1;
     ```
  2. 歷屆試題標籤使用動態序號：
     ```javascript
     if (cd.quizzes && cd.quizzes.length) {
       html += `<div class="section-label"><span class="s-num">${secNum++}</span> 歷屆試題（共 ${cd.quizzes.length} 題）</div>`;
       // ... 保留其餘 score-bar 與 quiz-container 邏輯
     }
     ```
  3. **完全移除** 以下關鍵詞句代碼：
     ```javascript
     // 移除此整段：
     // ③ 關鍵詞句
     if (cd.keywords && cd.keywords.length) {
       html += `<div class="section-label"><span class="s-num">2</span> 關鍵詞句及定義</div>`;
       html += `
         <div class="table-responsive">
           <table class="keyword-table">
             <thead><tr>
               <th style="min-width:110px">中文術語</th>
               <th style="min-width:110px">English</th>
               <th style="min-width:180px">定義與核心精神</th>
             </tr></thead>
             <tbody>
               ${cd.keywords.map(kw => `
                 <tr>
                   <td><span class="keyword-zh">${kw.zh}</span></td>
                   <td><span class="keyword-en">${kw.en || '—'}</span></td>
                   <td>${kw.def}</td>
                 </tr>`).join('')}
             </tbody>
           </table>
         </div>`;
     }
     ```
  4. 將內文重點整理與重點一覽標籤序號改為動態：
     ```javascript
     // 內文重點
     if (cd.content && cd.content.length) {
       html += `<div class="section-label"><span class="s-num">${secNum++}</span> 內文重點整理</div>`;
       html += renderContentBlocks(cd.content);
     }

     // 重點一覽入口
     html += `
       <div class="section-label"><span class="s-num">${secNum++}</span> 重點一覽</div>
       <div class="summary-entry-card" onclick="switchTab('summary')">
     ...
     ```

### Task 2: 驗證與測試
1. 執行 `node -c app.js` 確保 JavaScript 語法正確。
2. 開啟瀏覽器確認模式一各章節（如 CH01、CH12、CH21 等）開頭已無「關鍵詞句及定義」名詞解釋表格，內文重點整理直接接續在後。

---

## 5. 完成標記與交付提示
本實施計畫已由架構規劃師（Gemini）完成規劃。請切換至 Claude 開始執行代碼實作。
