/*
 * 圖解區塊（content 區塊 type: "diagram"）
 *
 * 用 HTML＋CSS 畫流程、分級、比較、分類樹，顏色全部走 CSS 變數，
 * 深色模式與手機寬度由 style.css 處理，不需要另外出圖。
 *
 * 共同欄位：
 *   kind     flow | cycle | levels | compare | tree | figure
 *   title    圖的標題（選填）
 *   note     圖下方的補充一句話（選填）
 *   summary  true 時也放進「重點一覽」的圖解速覽
 *
 * 各 kind 的資料：
 *   flow     steps: [{label, sub?, via?, tone?}]，dir: "row"（預設，手機自動直排）| "col"
 *            via 是「從上一步走到這一步」箭頭上的字（因果機轉用）
 *   cycle    steps 同 flow，center 是圈中央的字；畫成流程＋回到第一步的箭頭
 *   levels   items: [{badge, label, sub?, tone?}]，由上到下排；axis: ["上端意義", "下端意義"]
 *            沒寫 tone 時依 scale 自動配色：danger（紅→綠，預設）| rise（綠→紅）| mono
 *   compare  cols: [{title, sub?, tone?, points: []}]，vs: true 時欄間顯示 VS
 *   tree     root: "根", rootSub?, branches: [{label, sub?, tone?, items: []}]
 *   figure   src, alt：解剖位置等需要真正畫圖的內容（SVG 檔放 images/diagrams/）
 */
'use strict';

const DIAGRAM_TONES = ['red', 'orange', 'amber', 'green', 'teal', 'blue', 'purple', 'gray'];
const DIAGRAM_SCALES = {
  danger: ['red', 'orange', 'amber', 'green', 'blue', 'gray'],
  rise: ['green', 'amber', 'orange', 'red', 'purple', 'gray'],
};
const DIAGRAM_FALLBACK = ['blue', 'orange', 'green', 'purple', 'teal', 'red'];
const TREE_MAX_COLS = 4;
const FLOW_MANY_STEPS = 6;

/** @param {string} t @param {string} fallback @returns {string} */
function dgTone(t, fallback) {
  return DIAGRAM_TONES.includes(t) ? t : fallback;
}

/** 行內格式：沿用 app.js 的 mdInline（**粗體**、<br>） */
function dgText(s) {
  return typeof mdInline === 'function' ? mdInline(s) : String(s == null ? '' : s);
}

function dgEscape(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function dgSub(s) {
  return s ? `<span class="dg-sub">${dgText(s)}</span>` : '';
}

function dgPoints(points) {
  if (!Array.isArray(points) || !points.length) return '';
  return `<ul class="dg-points">${points.map(p => `<li>${dgText(p)}</li>`).join('')}</ul>`;
}

function dgFlow(b) {
  const steps = Array.isArray(b.steps) ? b.steps : [];
  const dir = b.dir === 'col' ? 'dg-col' : 'dg-row';
  const items = steps.map((s, i) => {
    const tone = dgTone(s.tone, dgTone(b.tone, 'blue'));
    const arrow = i === 0 ? '' :
      `<li class="dg-arrow" aria-hidden="true">${s.via ? `<span class="dg-via">${dgText(s.via)}</span>` : ''}</li>`;
    const num = b.numbered === false ? '' : `<span class="dg-num">${i + 1}</span>`;
    return `${arrow}<li class="dg-step dg-t-${tone}">${num}` +
      `<span class="dg-label">${dgText(s.label)}</span>${dgSub(s.sub)}</li>`;
  }).join('');
  // 步驟多的橫排流程在中等寬度（平板、窄筆電）就改直排，避免每格太窄
  // 箭頭上有字（via）時箭頭較寬，4 步就算多
  const hasVia = steps.some(s => s.via);
  const many = steps.length >= (hasVia ? FLOW_MANY_STEPS - 2 : FLOW_MANY_STEPS) ? ' dg-many' : '';
  return `<ol class="dg-flow ${dir}${many}" style="--dg-n:${Math.max(steps.length, 1)}">${items}</ol>`;
}

function dgCycle(b) {
  const first = (b.steps && b.steps[0] && b.steps[0].label) || '';
  const plain = String(first).replace(/\*\*/g, '').replace(/<[^>]+>/g, '');
  const center = b.center ? `<div class="dg-cycle-center">${dgText(b.center)}</div>` : '';
  return `${center}${dgFlow(b)}<div class="dg-loop" aria-hidden="true"><span>↺ 回到「${dgEscape(plain)}」，周而復始</span></div>`;
}

function dgLevels(b) {
  const items = Array.isArray(b.items) ? b.items : [];
  const scale = b.scale === 'mono' ? null : (DIAGRAM_SCALES[b.scale] || DIAGRAM_SCALES.danger);
  const rows = items.map((it, i) => {
    const auto = scale ? scale[Math.min(i, scale.length - 1)] : dgTone(b.tone, 'blue');
    const tone = dgTone(it.tone, auto);
    const badge = it.badge == null ? i + 1 : it.badge;
    return `<li class="dg-level dg-t-${tone}"><span class="dg-badge">${dgText(badge)}</span>` +
      `<span class="dg-level-body"><span class="dg-label">${dgText(it.label)}</span>${dgSub(it.sub)}</span></li>`;
  }).join('');
  const axis = Array.isArray(b.axis) && b.axis.length === 2
    ? `<div class="dg-axis" aria-hidden="true"><span>${dgText(b.axis[0])}</span><i></i><span>${dgText(b.axis[1])}</span></div>`
    : '';
  return `<div class="dg-levels-wrap">${axis}<ol class="dg-levels">${rows}</ol></div>`;
}

function dgCompare(b) {
  const cols = Array.isArray(b.cols) ? b.cols : [];
  const html = cols.map((c, i) => {
    const tone = dgTone(c.tone, DIAGRAM_FALLBACK[i % DIAGRAM_FALLBACK.length]);
    const vs = b.vs && i > 0 ? '<div class="dg-vs" aria-hidden="true">VS</div>' : '';
    return `${vs}<div class="dg-card dg-t-${tone}"><div class="dg-card-head">` +
      `<span class="dg-label">${dgText(c.title)}</span>${dgSub(c.sub)}</div>${dgPoints(c.points)}</div>`;
  }).join('');
  return `<div class="dg-compare${b.vs ? ' dg-has-vs' : ''}" style="--dg-n:${Math.max(cols.length, 1)}">${html}</div>`;
}

function dgTree(b) {
  const branches = Array.isArray(b.branches) ? b.branches : [];
  const kids = branches.map((br, i) => {
    const tone = dgTone(br.tone, DIAGRAM_FALLBACK[i % DIAGRAM_FALLBACK.length]);
    return `<li class="dg-card dg-t-${tone}"><div class="dg-card-head">` +
      `<span class="dg-label">${dgText(br.label)}</span>${dgSub(br.sub)}</div>${dgPoints(br.items)}</li>`;
  }).join('');
  // 超過 4 支時分兩列，避免每欄太窄；分兩列時改用框線把分支圈在一起，不畫逐支連接線
  const n = Math.max(branches.length, 1);
  const wrap = n > TREE_MAX_COLS;
  const cols = wrap ? Math.ceil(n / 2) : n;
  return `<div class="dg-root"><span class="dg-label">${dgText(b.root || '')}</span>${dgSub(b.rootSub)}</div>` +
    `<ul class="dg-branches${wrap ? ' dg-wrap' : ''}" style="--dg-n:${cols}">${kids}</ul>`;
}

function dgFigure(b) {
  const src = typeof dataUrl === 'function' ? dataUrl(b.src) : b.src;
  return `<img class="dg-img" src="${dgEscape(src || '')}" alt="${dgEscape(b.alt || b.title || '')}" loading="lazy"` +
    ` onclick="openImageModal(this.src)"><div class="dg-zoom-tip">🔍 點圖放大</div>`;
}

const DIAGRAM_KINDS = {
  flow: dgFlow, cycle: dgCycle, levels: dgLevels, compare: dgCompare, tree: dgTree, figure: dgFigure,
};

/**
 * @param {{kind: string, title?: string, note?: string}} b
 * @returns {string} HTML；不認得的 kind 回傳空字串
 */
function diagramHtml(b) {
  const draw = DIAGRAM_KINDS[b && b.kind];
  if (!draw) return '';
  const title = b.title ? `<figcaption class="dg-title">${dgText(b.title)}</figcaption>` : '';
  const note = b.note ? `<div class="dg-note">${dgText(b.note)}</div>` : '';
  return `<figure class="diagram-block dg-k-${b.kind}">${title}<div class="dg-body">${draw(b)}</div>${note}</figure>`;
}

/**
 * 重點一覽的「圖解速覽」：收集重點筆記中標了 summary 的圖解；
 * 已經在「重點比較圖表」裡代替原表出現的圖（summary.tables 的 diagram）不重複放。
 */
function renderSummaryDiagrams(cd) {
  const shown = new Set(((cd && cd.summary && cd.summary.tables) || []).map(t => t.diagram).filter(Boolean));
  const list = ((cd && cd.content) || []).filter(x => x && x.type === 'diagram' && x.summary && !shown.has(x.id));
  return list.map(diagramHtml).join('');
}
