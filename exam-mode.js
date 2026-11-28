/* ====================================================================
   exam-mode.js — 模式三：歷屆考題
   --------------------------------------------------------------------
   點選作答 → 交卷批改 → 錯題與有疑慮題顯示逐選項詳解（作答檢討）。
   資料：chapters/exam_papers.json（試卷）、chapters/exam_reviews.json（詳解）
   進度：localStorage「emtpExamV1」，登入後同步到 Firestore emtp/{uid}.exam；也可用「匯出／匯入進度」在裝置間搬移。
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
  // struck：作答時劃掉（刪去）的選項，{ 試卷: { 題號: ['A', 'C'] } }
  const FIELDS = ['answers', 'submitted', 'flags', 'struck'];

  function emptyStore() { return { paper: null, answers: {}, submitted: {}, flags: {}, struck: {} }; }

  function normalizeStore(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const obj = v => (v && typeof v === 'object' ? v : {});
    return { paper: s.paper || s.year || null, answers: obj(s.answers), submitted: obj(s.submitted), flags: obj(s.flags), struck: obj(s.struck), updated: obj(s.updated) };
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

  // ---------- cloud sync（sync.js 提供 window.examCloud；登入後才有）----------
  const CLOUD_DELAY = 1500;
  let cloudTimer = null;

  // 記錄這份試卷剛被修改，雲端合併時以較新的一方為準
  function touch(ids) {
    const now = Date.now();
    const updated = { ...store.updated };
    ids.forEach(id => { updated[id] = now; });
    store = { ...store, updated };
  }

  function scheduleCloudSave() {
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(() => {
      const cloud = window.examCloud;
      if (!cloud || !cloud.ready()) return;
      const { answers, submitted, flags, struck, updated } = store;
      cloud.save({ answers, submitted, flags, struck, updated }).catch(() => toast('雲端同步失敗，作答已存在這台裝置'));
    }, CLOUD_DELAY);
  }

  function commit(ids) {
    touch(ids);
    saveStore();
    scheduleCloudSave();
  }

  // 合併雲端資料：每份試卷取修改時間較新的一方；本機較新或雲端沒有的，就上傳
  function applyRemote(remote) {
    const r = normalizeStore(remote || {});
    const ids = new Set(FIELDS.flatMap(f => [...Object.keys(store[f]), ...Object.keys(r[f])]));
    const next = { answers: { ...store.answers }, submitted: { ...store.submitted }, flags: { ...store.flags }, struck: { ...store.struck }, updated: { ...store.updated } };
    let changedLocal = false;
    let needUpload = false;
    ids.forEach(id => {
      const lt = store.updated[id] || 0;
      const rt = r.updated[id] || 0;
      const remoteHas = FIELDS.some(f => id in r[f]);
      if (rt > lt) {
        FIELDS.forEach(f => { if (r[f][id]) next[f][id] = r[f][id]; else delete next[f][id]; });
        next.updated[id] = rt;
        changedLocal = true;
      } else if (lt > rt || !remoteHas) {
        needUpload = true;
      }
    });
    if (changedLocal) {
      store = { ...store, ...next };
      saveStore();
      if (paper && document.getElementById('ex-list')) renderAll();
    }
    if (needUpload) scheduleCloudSave();
  }

  window.examMode = { applyRemote };

  const answersOf = id => store.answers[id] || {};
  const flagsOf = id => store.flags[id] || {};
  const struckOf = id => store.struck[id] || {};
  const struckNos = id => (questions[id] || []).filter(q => (struckOf(id)[q.no] || []).length).map(q => q.no);
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
    if (!card) { onlyReview = false; renderAll(); card = document.getElementById('ex-q' + no); }
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
      ? [btn(onlyReview ? '顯示全部題目' : '作答檢討', toggleOnlyReview, onlyReview ? 'on' : ''),
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

  // 逐選項詳解直接接在各選項下方：只留題目、選項與各選項說明
  function optionExplain(o) {
    const kind = o.mark === '✔' ? 'right' : o.mark === '✘' ? 'wrong' : 'true';
    return el('div', { className: 'ex-opt-exp mark-' + kind },
      el('span', { className: 'ex-rv-mark', textContent: `${o.mark} ${MARK_LABEL[o.mark] || ''}` }), ' ', o.text);
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
    const show = result ? needsReview(q.no, result.status) : false;
    const rv = show ? reviewOf(q.no) : null;
    const struck = struckOf(paper)[q.no] || [];
    const opts = el('div', { className: 'ex-opts' });
    q.options.forEach((o, i) => {
      const letter = LETTERS[i];
      const isStruck = struck.includes(letter);
      const cls = ['ex-opt'];
      if (result) {
        if (result.key.main.includes(letter)) cls.push('right');
        else if (result.key.accepted.includes(letter)) cls.push('accept');
        if (chosen === letter) cls.push(result.status === 'wrong' ? 'wrong' : 'sel');
      } else if (chosen === letter) cls.push('sel');
      if (isStruck) cls.push('struck');
      const struckRight = isStruck && result && result.key.accepted.includes(letter);
      opts.append(el('div', { className: 'ex-opt-row' },
        el('button', { className: cls.join(' '), disabled: submitted, dataset: { letter }, onclick: () => choose(q.no, letter) },
          el('span', { className: 'ex-letter', textContent: letter }),
          el('span', { className: 'ex-opt-text', textContent: o.replace(/^[(（][A-E][)）]\s*/, '') || '（見上圖）' }),
          struckRight ? el('span', { className: 'ex-struck-right', textContent: '⚠ 你劃掉了正解' }) : null),
        submitted ? null : el('button', {
          className: 'ex-strike' + (isStruck ? ' on' : ''), textContent: isStruck ? '↺' : '✕',
          title: isStruck ? '恢復這個選項' : '劃掉這個選項（刪去法）',
          ariaLabel: (isStruck ? '恢復選項 ' : '劃掉選項 ') + letter,
          onclick: () => toggleStrike(q.no, letter),
        })));
      const exp = rv && rv.opts[i];
      if (exp) opts.append(optionExplain(exp));
    });
    card.append(opts);
    if (result) {
      card.classList.add('st-' + result.status);
      card.append(el('div', { className: 'ex-verdict ' + result.status, textContent: verdictText(result.status, result.key, chosen) }));
      if (q.source) card.append(el('div', { className: 'ex-src', textContent: '出處：' + q.source }));
      if (rv && rv.note) card.append(el('div', { className: 'ex-rv-note' }, el('b', { textContent: '⚠ 版本差異' }), rv.note));
      if (rv && rv.point) card.append(el('div', { className: 'ex-rv-point' }, el('b', { textContent: '考點' }), rv.point));
      if (show && !rv) card.append(el('div', { className: 'ex-rv-missing', textContent: '這題還沒有逐選項詳解。按「複製結果」貼給 Claude，寫好後會出現在這裡。' }));
      if (!show && q.point) card.append(el('div', { className: 'ex-src', textContent: '考點：' + q.point }));
    }
    return card;
  }

  // 作答檢討：一、錯題（答錯與未作答，含有疑慮但答錯）優先；二、有疑慮但答對
  function reviewSections() {
    const ans = answersOf(paper);
    const flags = flagsOf(paper);
    const graded = (questions[paper] || []).map(q => ({ q, status: grade(q, ans[q.no]).status }));
    const wrong = graded.filter(g => g.status === 'wrong' || g.status === 'blank').map(g => g.q);
    const doubt = graded.filter(g => g.status !== 'wrong' && g.status !== 'blank' && flags[g.q.no]).map(g => g.q);
    const section = (title, desc, qs) => [
      el('h3', { className: 'ex-sec' }, title, el('small', { textContent: `　${qs.length} 題` })),
      el('p', { className: 'ex-sec-desc', textContent: qs.length ? desc : '沒有題目。' }),
      ...qs.map(questionCard),
    ];
    return [
      ...section('一、錯題', '答錯與未作答的題目（有疑慮但答錯的也在這裡），請優先看。', wrong),
      ...section('二、有疑慮', '標了有疑慮但答對的題目，確認觀念是不是真的清楚。', doubt),
    ];
  }

  function renderList() {
    const list = document.getElementById('ex-list');
    if (onlyReview && isSubmitted(paper)) list.replaceChildren(...reviewSections());
    else list.replaceChildren(...(questions[paper] || []).map(questionCard));
  }

  function renderAll() { renderPaperSelect(); renderTools(); renderProgress(); renderSummary(); renderList(); }

  // ---------- actions ----------
  function selectPaper(id) {
    paper = id;
    onlyReview = isSubmitted(id);
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
    // 選了劃掉的選項，就把它的刪除線拿掉
    const wasStruck = (struckOf(paper)[no] || []).includes(letter) && updated[no] === letter;
    if (wasStruck) store = { ...store, struck: withStruck(no, (struckOf(paper)[no] || []).filter(l => l !== letter)) };
    commit([paper]);
    if (wasStruck) rerenderCard(no);
    else document.querySelectorAll(`#ex-q${no} .ex-opt`).forEach(b => b.classList.toggle('sel', b.dataset.letter === updated[no]));
    renderProgress();
  }

  // 回傳換掉某題劃掉清單後的 struck（清單為空就刪掉這題）
  function withStruck(no, letters) {
    const forPaper = { ...struckOf(paper) };
    if (letters.length) forPaper[no] = letters; else delete forPaper[no];
    const next = { ...store.struck };
    if (Object.keys(forPaper).length) next[paper] = forPaper; else delete next[paper];
    return next;
  }

  function rerenderCard(no) {
    const card = document.getElementById('ex-q' + no);
    const q = (questions[paper] || []).find(x => x.no === no);
    if (card && q) card.replaceWith(questionCard(q));
  }

  function toggleStrike(no, letter) {
    if (isSubmitted(paper)) return;
    const cur = struckOf(paper)[no] || [];
    const letters = cur.includes(letter) ? cur.filter(l => l !== letter) : [...cur, letter].sort();
    store = { ...store, struck: withStruck(no, letters) };
    // 劃掉目前選的答案，就取消這題的作答
    if (letters.includes(letter) && answersOf(paper)[no] === letter) {
      const ans = { ...answersOf(paper) };
      delete ans[no];
      store = { ...store, answers: { ...store.answers, [paper]: ans } };
      renderProgress();
    }
    commit([paper]);
    rerenderCard(no);
  }

  function toggleFlag(no) {
    const updated = { ...flagsOf(paper) };
    if (updated[no]) delete updated[no]; else updated[no] = true;
    store = { ...store, flags: { ...store.flags, [paper]: updated } };
    commit([paper]);
    if (isSubmitted(paper) && onlyReview) { renderSummary(); renderList(); }
    else if (isSubmitted(paper)) { renderSummary(); document.getElementById('ex-q' + no).replaceWith(questionCard(questions[paper].find(q => q.no === no))); }
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
    onlyReview = true;
    commit([paper]);
    renderAll();
    container().scrollTo(0, 0);
  }

  function resetPaper() {
    if (!Object.keys(answersOf(paper)).length && !isSubmitted(paper) && !flaggedNos(paper).length && !struckNos(paper).length) { toast('這份試卷沒有作答紀錄'); return; }
    if (!window.confirm(`確定清除「${labelOf(paper)}」的作答、劃掉的選項、疑慮標記與批改結果，重新作答？清除後無法復原。`)) return;
    const drop = obj => { const copy = { ...obj }; delete copy[paper]; return copy; };
    store = { ...store, answers: drop(store.answers), submitted: drop(store.submitted), flags: drop(store.flags), struck: drop(store.struck) };
    onlyReview = false;
    commit([paper]);
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
    const wrongAll = [...r.wrong, ...r.blank].sort((a, b) => a - b);
    const doubtOnly = flags.filter(no => !wrongAll.includes(no));
    const struck = struckOf(paper);
    const struckReview = review.filter(no => (struck[no] || []).length);
    if (struckReview.length) lines.push('刪去：' + struckReview.map(no => `${no}（${struck[no].join('、')}）`).join('、'));
    const keyOf = no => parseKey((questions[paper].find(q => q.no === no) || {}).answer);
    const struckRight = struckReview.filter(no => struck[no].some(l => keyOf(no).accepted.includes(l)));
    if (struckRight.length) lines.push(`劃掉了正解：${struckRight.join('、')}`);
    lines.push(`錯題詳解：${wrongAll.length ? wrongAll.join('、') : '無'}`);
    lines.push(`疑慮詳解：${doubtOnly.length ? doubtOnly.join('、') : '無'}`);
    const missWrong = missing.filter(no => wrongAll.includes(no));
    const missDoubt = missing.filter(no => !wrongAll.includes(no));
    lines.push(`尚無詳解：${missing.length ? `錯題 ${missWrong.join('、') || '無'}；疑慮 ${missDoubt.join('、') || '無'}` : '無'}`);
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
    const text = JSON.stringify({ type: EXPORT_TYPE, v: 1, answers: store.answers, submitted: store.submitted, flags: store.flags, struck: store.struck });
    if (await copyText(text)) toast('已複製進度，可貼到另一台裝置的「匯入進度」');
    else window.prompt('自動複製失敗，請手動複製下面的文字：', text);
  }

  function applyImport(text) {
    let data;
    try { data = normalizeStore(JSON.parse(text.trim())); } catch (e) { toast('格式不對，請貼上「匯出進度」複製的整段文字'); return false; }
    const known = new Set(papers.map(p => p.id));
    const ids = [...new Set(FIELDS.flatMap(f => Object.keys(data[f])))].filter(id => known.has(id));
    if (!ids.length) { toast('沒有可以匯入的試卷紀錄'); return false; }
    const hasLocal = id => Object.keys(answersOf(id)).length || isSubmitted(id) || flaggedNos(id).length || struckNos(id).length;
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
    store = { ...store, answers: pick('answers'), submitted: pick('submitted'), flags: pick('flags'), struck: pick('struck') };
    commit(targets);
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
      el('p', { className: 'ex-note', textContent: '在另一台裝置按「匯出進度」，再把複製的文字貼到下面。' }),
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
    // 詳解會陸續補寫：不帶版號，Service Worker 會先抓網路（離線才用快取），重新整理就看得到新詳解
    const [pRes, rRes] = await Promise.all([fetch(url('chapters/exam_papers.json')), fetch('chapters/exam_reviews.json')]);
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
        onlyReview = isSubmitted(paper);
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
