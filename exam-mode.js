/* ====================================================================
   exam-mode.js — 模式三：歷屆考題
   --------------------------------------------------------------------
   點選作答 → 交卷批改 → 錯題與有疑慮題顯示逐選項詳解（作答檢討）。
   資料：chapters/exam_papers.json（試卷）、chapters/exam_reviews.json（詳解）
   進度：localStorage「emtpExamV1」，格式與 quizzes/作答.html 相同，可互相匯入。
   ==================================================================== */
(function () {
  const STORE_KEY = 'emtpExamV1';
  const LETTERS = ['A', 'B', 'C', 'D', 'E'];
  const EXPORT_TYPE = 'emtp-exam-progress';
  const MARK_LABEL = { '✔': '正解', '○': '敘述正確', '✘': '敘述錯誤' };

  let papers = [];
  let questions = {};
  let reviews = {};
  let loadPromise = null;
  let paper = null;
  let onlyReview = false;

  // ---------- storage ----------
  function emptyStore() { return { paper: null, answers: {}, submitted: {}, flags: {} }; }

  function normalizeStore(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const obj = v => (v && typeof v === 'object' ? v : {});
    return { paper: s.paper || s.year || null, answers: obj(s.answers), submitted: obj(s.submitted), flags: obj(s.flags) };
  }

  function loadStore() {
    try { return normalizeStore(JSON.parse(localStorage.getItem(STORE_KEY) || 'null')); }
    catch (e) { return emptyStore(); }
  }

  let store = loadStore();

  function saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
    catch (e) { toast('瀏覽器無法儲存，關掉頁面後作答會消失'); }
  }

  const answersOf = id => store.answers[id] || {};
  const flagsOf = id => store.flags[id] || {};
  const isSubmitted = id => Boolean(store.submitted[id]);
  const labelOf = id => (papers.find(p => p.id === id) || {}).label || id;
  const flaggedNos = id => (questions[id] || []).filter(q => flagsOf(id)[q.no]).map(q => q.no);
  const reviewOf = no => reviews[`${paper}-${no}`];

  // ---------- grading ----------
  // 答案格式："C"、"C(A)"、"C(A、B、D)"、"ABCD"、"B(送分)"
  function parseKey(raw) {
    const m = /^([A-E]+)(?:\((.*)\))?$/.exec(raw || '');
    if (!m) return { main: [], accepted: [], free: true };
    const main = m[1].split('');
    const extra = m[2] || '';
    const accepted = [...new Set([...main, ...(extra.match(/[A-E]/g) || [])])];
    return { main, accepted, free: extra.includes('送分') };
  }

  function grade(q, chosen) {
    const key = parseKey(q.answer);
    if (key.free) return { status: 'free', key };
    if (!chosen) return { status: 'blank', key };
    if (key.main.includes(chosen)) return { status: 'correct', key };
    if (key.accepted.includes(chosen)) return { status: 'partial', key };
    return { status: 'wrong', key };
  }

  function verdictText(status, key, chosen) {
    const main = key.main.join('、');
    if (status === 'correct') return key.main.length > 1 ? `✓ 正確（${main} 都給分）` : '✓ 正確';
    if (status === 'partial') return `✓ 勉予給分（正解 ${key.main[0]}）`;
    if (status === 'free') return `✓ 本題送分（原答案 ${main}）`;
    if (status === 'blank') return `未作答，正解 ${main}`;
    const extra = key.accepted.filter(l => !key.main.includes(l));
    return `✗ 你選 ${chosen}，正解 ${main}` + (extra.length ? `（${extra.join('、')} 勉予給分）` : '');
  }

  function paperResult(id) {
    const ans = answersOf(id);
    const rows = (questions[id] || []).map(q => ({ no: q.no, ...grade(q, ans[q.no]) }));
    const count = s => rows.filter(r => r.status === s).length;
    return {
      score: count('correct') + count('partial') + count('free'),
      partial: count('partial'),
      free: count('free'),
      wrong: rows.filter(r => r.status === 'wrong').map(r => r.no),
      blank: rows.filter(r => r.status === 'blank').map(r => r.no),
    };
  }

  const needsReview = (no, status) => status === 'wrong' || status === 'blank' || Boolean(flagsOf(paper)[no]);

  // ---------- dom helpers ----------
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      if (k === 'onclick') node.addEventListener('click', v);
      else if (k === 'onchange') node.addEventListener('change', v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node[k] = v;
    });
    children.flat().forEach(c => { if (c !== null && c !== undefined && c !== false) node.append(c); });
    return node;
  }

  function toast(msg) {
    let t = document.getElementById('ex-toast');
    if (!t) { t = el('div', { id: 'ex-toast', className: 'ex-toast' }); document.body.append(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  const container = () => document.getElementById('mode4-container');

  function jumpTo(no) {
    let card = document.getElementById('ex-q' + no);
    if (card && card.classList.contains('hide')) { onlyReview = false; renderAll(); card = document.getElementById('ex-q' + no); }
    const sc = container();
    const head = sc && sc.querySelector('.ex-head');
    if (!card || !sc) return;
    const top = card.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - (head ? head.offsetHeight : 0) - 10;
    sc.scrollTo({ top, behavior: 'smooth' });
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 1200);
  }

  // ---------- rendering ----------
  function renderShell() {
    const sc = container();
    sc.replaceChildren(el('div', { className: 'ex-wrap' },
      el('div', { className: 'ex-head' },
        el('div', { className: 'ex-head-row' },
          el('h2', { className: 'ex-title', textContent: '📝 歷屆考題' }),
          el('select', { id: 'ex-paper', className: 'ex-paper', onchange: e => selectPaper(e.target.value) }),
          el('span', { id: 'ex-progress', className: 'ex-progress' })),
        el('div', { id: 'ex-tools', className: 'ex-tools' })),
      el('div', { id: 'ex-summary' }),
      el('div', { id: 'ex-list' })));
  }

  function renderPaperSelect() {
    const sel = document.getElementById('ex-paper');
    const groups = [...new Set(papers.map(p => p.group))];
    sel.replaceChildren(...groups.map(g => el('optgroup', { label: g },
      papers.filter(p => p.group === g).map(p => el('option', {
        value: p.id, textContent: p.label + (isSubmitted(p.id) ? ' ✓' : ''), selected: p.id === paper,
      })))));
  }

  function renderTools() {
    const btn = (text, onclick, cls) => el('button', { className: 'ex-btn' + (cls ? ' ' + cls : ''), textContent: text, onclick });
    const main = isSubmitted(paper)
      ? [btn(onlyReview ? '顯示全部' : '只看錯題與疑慮', toggleOnlyReview, onlyReview ? 'on' : ''),
         btn('重新作答', resetPaper), btn('複製結果', copyResult, 'primary')]
      : [btn('跳到未作答', jumpBlank), btn('清除作答', resetPaper), btn('交卷批改', submitPaper, 'primary')];
    document.getElementById('ex-tools').replaceChildren(...main,
      el('span', { className: 'ex-tools-gap' }),
      btn('匯入進度', openImport, 'ghost'), btn('匯出進度', exportProgress, 'ghost'));
  }

  function renderProgress() {
    const total = (questions[paper] || []).length;
    const n = Object.keys(answersOf(paper)).length;
    document.getElementById('ex-progress').textContent = isSubmitted(paper)
      ? `已交卷・得分 ${paperResult(paper).score} / ${total}`
      : `已作答 ${n} / ${total} 題`;
  }

  function numberList(nos, cls) {
    return el('div', { className: 'ex-nums' }, nos.map(no => el('button', { className: 'ex-num ' + cls, textContent: no, onclick: () => jumpTo(no) })));
  }

  function renderSummary() {
    const box = document.getElementById('ex-summary');
    if (!isSubmitted(paper)) { box.replaceChildren(); return; }
    const r = paperResult(paper);
    const total = questions[paper].length;
    const notes = [];
    if (r.partial) notes.push(`勉予給分 ${r.partial} 題`);
    if (r.free) notes.push(`送分 ${r.free} 題`);
    const flags = flaggedNos(paper);
    const review = [...new Set([...r.wrong, ...r.blank, ...flags])];
    const missing = review.filter(no => !reviewOf(no));
    box.replaceChildren(el('div', { className: 'ex-summary' },
      el('div', { className: 'ex-score' }, `${r.score} 分`, el('small', { textContent: ` / ${total}（${labelOf(paper)}）` })),
      notes.length ? el('div', { className: 'ex-note', textContent: '含' + notes.join('、') }) : null,
      r.wrong.length ? [el('div', { className: 'ex-note', textContent: `錯 ${r.wrong.length} 題：` }), numberList(r.wrong, 'wrong')] : null,
      r.blank.length ? [el('div', { className: 'ex-note', textContent: `未作答 ${r.blank.length} 題：` }), numberList(r.blank, 'blank')] : null,
      flags.length ? [el('div', { className: 'ex-note', textContent: `有疑慮 ${flags.length} 題：` }), numberList(flags, 'flag')] : null,
      !r.wrong.length && !r.blank.length ? el('div', { className: 'ex-note', textContent: '全對，太強了！' }) : null,
      missing.length
        ? el('div', { className: 'ex-missing', textContent: `有 ${missing.length} 題還沒有逐選項詳解。按「複製結果」貼給 Claude，寫好後會出現在題目下方。` })
        : (review.length ? el('div', { className: 'ex-note ok', textContent: '錯題與有疑慮題都已有逐選項詳解。' }) : null)));
  }

  function reviewTag(status, flagged) {
    if (status === 'blank') return flagged ? '有疑慮・未作答' : '未作答';
    if (status === 'wrong') return flagged ? '有疑慮・答錯' : '答錯';
    return '有疑慮・答對';
  }

  function reviewBlock(q, result, chosen) {
    const flagged = Boolean(flagsOf(paper)[q.no]);
    const rv = reviewOf(q.no);
    const meta = [`答案 ${result.key.main.join('、')}`, chosen ? `你選 ${chosen}` : '未作答'];
    if (rv && rv.kind) meta.push(rv.kind);
    const box = el('div', { className: 'ex-review' },
      el('div', { className: 'ex-rv-head' },
        el('span', { className: 'ex-rv-tag ' + (result.status === 'wrong' || result.status === 'blank' ? 'bad' : 'ok'), textContent: reviewTag(result.status, flagged) }),
        el('span', { className: 'ex-rv-meta', textContent: meta.join('｜') })));
    if (!rv) {
      box.append(el('div', { className: 'ex-rv-missing', textContent: '這題還沒有逐選項詳解。按「複製結果」貼給 Claude，寫好後會出現在這裡。' }));
      return box;
    }
    rv.opts.forEach((o, i) => {
      const letter = LETTERS[i];
      const mine = chosen === letter;
      box.append(el('div', { className: `ex-rv-opt mark-${o.mark === '✔' ? 'right' : o.mark === '✘' ? 'wrong' : 'true'}${mine ? ' mine' : ''}` },
        el('div', { className: 'ex-rv-opt-head' },
          el('b', { textContent: `(${letter})` }),
          el('span', { textContent: (q.options[i] || '').replace(/^[(（][A-E][)）]\s*/, '') || '（見上圖）' }),
          mine ? el('span', { className: 'ex-rv-mine', textContent: '你的答案' }) : null),
        el('div', { className: 'ex-rv-text' }, el('span', { className: 'ex-rv-mark', textContent: `${o.mark} ${MARK_LABEL[o.mark] || ''}` }), ' ', o.text)));
    });
    if (rv.think) box.append(el('div', { className: 'ex-rv-think' }, el('b', { textContent: '這題怎麼想' }), rv.think));
    if (rv.point) box.append(el('div', { className: 'ex-rv-point' }, el('b', { textContent: '考點' }), rv.point));
    return box;
  }

  function questionCard(q) {
    const submitted = isSubmitted(paper);
    const chosen = answersOf(paper)[q.no];
    const result = submitted ? grade(q, chosen) : null;
    const flagged = Boolean(flagsOf(paper)[q.no]);
    const card = el('section', { className: 'ex-q' + (flagged ? ' flagged' : ''), id: 'ex-q' + q.no },
      el('div', { className: 'ex-q-head' },
        el('p', { className: 'ex-stem' }, el('b', { textContent: q.no + '.' }), q.stem),
        el('button', { className: 'ex-flag', textContent: '🤔 有疑慮', title: '標記觀念不清楚，需要詳解', onclick: () => toggleFlag(q.no) })),
      q.figures.map(f => el('img', { className: 'ex-fig', src: f, alt: `${labelOf(paper)}第${q.no}題附圖`, loading: 'lazy' })));
    const opts = el('div', { className: 'ex-opts' });
    q.options.forEach((o, i) => {
      const letter = LETTERS[i];
      const cls = ['ex-opt'];
      if (result) {
        if (result.key.main.includes(letter)) cls.push('right');
        else if (result.key.accepted.includes(letter)) cls.push('accept');
        if (chosen === letter) cls.push(result.status === 'wrong' ? 'wrong' : 'sel');
      } else if (chosen === letter) cls.push('sel');
      opts.append(el('button', { className: cls.join(' '), disabled: submitted, dataset: { letter }, onclick: () => choose(q.no, letter) },
        el('span', { className: 'ex-letter', textContent: letter }),
        el('span', { textContent: o.replace(/^[(（][A-E][)）]\s*/, '') || '（見上圖）' })));
    });
    card.append(opts);
    if (result) {
      card.classList.add('st-' + result.status);
      card.append(el('div', { className: 'ex-verdict ' + result.status, textContent: verdictText(result.status, result.key, chosen) }));
      if (q.source) card.append(el('div', { className: 'ex-src', textContent: '出處：' + q.source }));
      const show = needsReview(q.no, result.status);
      if (show) card.append(reviewBlock(q, result, chosen));
      else if (q.point) card.append(el('div', { className: 'ex-src', textContent: '考點：' + q.point }));
      if (onlyReview && !show) card.classList.add('hide');
    }
    return card;
  }

  function renderList() {
    document.getElementById('ex-list').replaceChildren(...(questions[paper] || []).map(questionCard));
  }

  function renderAll() { renderPaperSelect(); renderTools(); renderProgress(); renderSummary(); renderList(); }

  // ---------- actions ----------
  function selectPaper(id) {
    paper = id;
    onlyReview = false;
    store = { ...store, paper: id };
    saveStore();
    renderAll();
    container().scrollTo(0, 0);
  }

  function choose(no, letter) {
    if (isSubmitted(paper)) return;
    const updated = { ...answersOf(paper) };
    if (updated[no] === letter) delete updated[no]; else updated[no] = letter;
    store = { ...store, answers: { ...store.answers, [paper]: updated } };
    saveStore();
    document.querySelectorAll(`#ex-q${no} .ex-opt`).forEach(b => b.classList.toggle('sel', b.dataset.letter === updated[no]));
    renderProgress();
  }

  function toggleFlag(no) {
    const updated = { ...flagsOf(paper) };
    if (updated[no]) delete updated[no]; else updated[no] = true;
    store = { ...store, flags: { ...store.flags, [paper]: updated } };
    saveStore();
    if (isSubmitted(paper)) { renderSummary(); document.getElementById('ex-q' + no).replaceWith(questionCard(questions[paper].find(q => q.no === no))); }
    else document.getElementById('ex-q' + no).classList.toggle('flagged', Boolean(updated[no]));
  }

  function unanswered() {
    const ans = answersOf(paper);
    return questions[paper].filter(q => !ans[q.no]).map(q => q.no);
  }

  function jumpBlank() {
    const blank = unanswered();
    if (!blank.length) { toast('這份試卷全部作答完了，可以交卷'); return; }
    jumpTo(blank[0]);
  }

  function submitPaper() {
    const blank = unanswered();
    const msg = blank.length ? `還有 ${blank.length} 題未作答，確定要交卷嗎？交卷後就不能再改答案。` : '確定要交卷嗎？交卷後就不能再改答案。';
    if (!window.confirm(msg)) return;
    store = { ...store, submitted: { ...store.submitted, [paper]: true } };
    saveStore();
    renderAll();
    container().scrollTo(0, 0);
  }

  function resetPaper() {
    if (!Object.keys(answersOf(paper)).length && !isSubmitted(paper) && !flaggedNos(paper).length) { toast('這份試卷沒有作答紀錄'); return; }
    if (!window.confirm(`確定清除「${labelOf(paper)}」的作答、疑慮標記與批改結果，重新作答？清除後無法復原。`)) return;
    const drop = obj => { const copy = { ...obj }; delete copy[paper]; return copy; };
    store = { ...store, answers: drop(store.answers), submitted: drop(store.submitted), flags: drop(store.flags) };
    onlyReview = false;
    saveStore();
    renderAll();
    container().scrollTo(0, 0);
  }

  function toggleOnlyReview() {
    onlyReview = !onlyReview;
    renderAll();
    container().scrollTo(0, 0);
  }

  function resultText() {
    const ans = answersOf(paper);
    const r = paperResult(paper);
    const flags = flaggedNos(paper);
    const review = [...new Set([...r.wrong, ...r.blank, ...flags])].sort((a, b) => a - b);
    const missing = review.filter(no => !reviewOf(no));
    const lines = [
      `【模式三】${labelOf(paper)}（代號 ${paper}）作答：` + questions[paper].filter(q => ans[q.no]).map(q => q.no + ans[q.no]).join(' '),
      `得分：${r.score}/${questions[paper].length}`,
      `錯題：${r.wrong.length ? r.wrong.join('、') : '無'}`,
    ];
    if (r.blank.length) lines.push(`未作答：${r.blank.join('、')}`);
    if (flags.length) {
      const ok = flags.filter(no => !r.wrong.includes(no) && !r.blank.includes(no));
      lines.push(`有疑慮：${flags.join('、')}` + (ok.length ? `（其中 ${ok.join('、')} 答對）` : ''));
    }
    lines.push(`需要詳解：${review.length ? review.join('、') : '無'}`);
    lines.push(`尚無詳解：${missing.length ? missing.join('、') : '無'}`);
    return lines.join('\n');
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
      const ta = el('textarea', { value: text });
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  async function copyResult() {
    const text = resultText();
    if (await copyText(text)) toast('已複製，貼給 Claude 就能寫詳解');
    else window.prompt('自動複製失敗，請手動複製下面的文字：', text);
  }

  // ---------- import / export ----------
  async function exportProgress() {
    const text = JSON.stringify({ type: EXPORT_TYPE, v: 1, answers: store.answers, submitted: store.submitted, flags: store.flags });
    if (await copyText(text)) toast('已複製進度，可貼到另一台裝置的「匯入進度」');
    else window.prompt('自動複製失敗，請手動複製下面的文字：', text);
  }

  function applyImport(text) {
    let data;
    try { data = normalizeStore(JSON.parse(text.trim())); } catch (e) { toast('格式不對，請貼上「匯出進度」複製的整段文字'); return false; }
    const known = new Set(papers.map(p => p.id));
    const ids = [...new Set([...Object.keys(data.answers), ...Object.keys(data.submitted), ...Object.keys(data.flags)])].filter(id => known.has(id));
    if (!ids.length) { toast('沒有可以匯入的試卷紀錄'); return false; }
    const hasLocal = id => Object.keys(answersOf(id)).length || isSubmitted(id) || flaggedNos(id).length;
    const conflicts = ids.filter(hasLocal);
    const overwrite = conflicts.length
      ? window.confirm(`以下試卷在模式三已有紀錄：${conflicts.map(labelOf).join('、')}。\n按「確定」用匯入的紀錄覆蓋，按「取消」保留模式三原本的紀錄。`)
      : true;
    const targets = ids.filter(id => overwrite || !conflicts.includes(id));
    const pick = field => {
      const next = { ...store[field] };
      targets.forEach(id => { if (data[field][id]) next[id] = data[field][id]; else delete next[id]; });
      return next;
    };
    store = { ...store, answers: pick('answers'), submitted: pick('submitted'), flags: pick('flags') };
    saveStore();
    renderAll();
    toast(`已匯入 ${targets.length} 份試卷：${targets.map(labelOf).join('、')}`);
    return true;
  }

  function openImport() {
    const ta = el('textarea', { className: 'ex-import-text', placeholder: '把「匯出進度」複製的文字貼在這裡' });
    const overlay = el('div', { className: 'ex-modal' });
    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    overlay.append(el('div', { className: 'ex-modal-box' },
      el('h3', { textContent: '匯入進度' }),
      el('p', { className: 'ex-note', textContent: '在作答頁（作答.html）或另一台裝置按「匯出進度」，再把複製的文字貼到下面。' }),
      ta,
      el('div', { className: 'ex-modal-actions' },
        el('button', { className: 'ex-btn', textContent: '取消', onclick: close }),
        el('button', { className: 'ex-btn primary', textContent: '匯入', onclick: () => { if (applyImport(ta.value)) close(); } }))));
    document.body.append(overlay);
    ta.focus();
  }

  // ---------- init ----------
  async function loadData() {
    const url = p => (typeof dataUrl === 'function' ? dataUrl(p) : p);
    const [pRes, rRes] = await Promise.all([fetch(url('chapters/exam_papers.json')), fetch(url('chapters/exam_reviews.json'))]);
    if (!pRes.ok) throw new Error('試卷資料載入失敗（' + pRes.status + '）');
    const data = await pRes.json();
    papers = data.papers;
    questions = data.questions;
    reviews = rRes.ok ? await rRes.json() : {};
  }

  window.initExamMode = function () {
    const sc = container();
    if (!sc) return Promise.resolve();
    if (!loadPromise) {
      sc.replaceChildren(el('div', { className: 'loading-overlay', style: 'display:flex' },
        el('div', { className: 'spinner' }), el('span', { textContent: '載入歷屆考題中…' })));
      loadPromise = loadData().then(() => {
        const ids = papers.map(p => p.id);
        paper = ids.includes(store.paper) ? store.paper : (ids.includes('114') ? '114' : ids[0]);
        renderShell();
        renderAll();
      }).catch(err => {
        loadPromise = null;
        sc.replaceChildren(el('div', { className: 'ex-error', textContent: '載入失敗：' + err.message + '，請重新整理再試一次。' }));
      });
    }
    return loadPromise;
  };
})();
