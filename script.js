/* ═══════════════════════════════════════════════════════
   DataLens — JSON & XML Inspector  (resilient multi-block)
   ═══════════════════════════════════════════════════════ */

'use strict';

/* ── State ─────────────────────────────────────────── */
const state = {
  blocks:   [],        // array of { type:'json'|'xml', label, data }
  view:     'tree',
  indent:   2,
  minified: false,
  searchTerm: '',
};

/* ── DOM refs ──────────────────────────────────────── */
const $ = id => document.getElementById(id);
const inputArea      = $('inputArea');
const parseBtn       = $('parseBtn');
const clearBtn       = $('clearBtn');
const formatBadge    = $('formatBadge');
const charCount      = $('charCount');
const errorBanner    = $('errorBanner');
const treeOutput     = $('treeOutput');
const textOutput     = $('textOutput');
const emptyState     = $('emptyState');
const nodeCount      = $('nodeCount');
const copyBtn        = $('copyBtn');
const downloadBtn    = $('downloadBtn');
const expandAllBtn   = $('expandAllBtn');
const collapseAllBtn = $('collapseAllBtn');
const searchInput    = $('searchInput');
const matchCount     = $('matchCount');
const copyToast      = $('copyToast');
const indent2Btn     = $('indent2');
const indent4Btn     = $('indent4');
const viewTreeBtn    = $('viewTree');
const viewTextBtn    = $('viewText');
const toggleMinify   = $('toggleMinify');

/* ══════════════════════════════════════════════════════
   MODULE: Resilient Multi-Block Extractor
   Scans the raw input string and pulls out every
   JSON object/array and XML document it can find,
   regardless of surrounding noise / extra text.
   Returns: { blocks: [{type, label, data}], warnings: [str] }
══════════════════════════════════════════════════════ */
function extractBlocks(src) {
  const blocks   = [];
  const warnings = [];
  let   pos      = 0;
  let   blockIdx = 0;

  while (pos < src.length) {
    // Skip whitespace
    while (pos < src.length && /\s/.test(src[pos])) pos++;
    if (pos >= src.length) break;

    const ch = src[pos];

    /* ── JSON object or array ──────────────────────── */
    if (ch === '{' || ch === '[') {
      const pair = ch === '{' ? ['{','}'] : ['[',']'];
      const { text: rawText, end, error } = extractBalanced(src, pos, pair);
      const rawSlice = src.slice(pos, end);

      if (error) {
        const partial = tryRepairJSON(rawSlice);
        if (partial !== null) {
          blockIdx++;
          blocks.push({ type:'json', label:`JSON #${blockIdx} (repaired)`, data: partial });
          warnings.push(`JSON block at pos ${pos} was incomplete — partially recovered.`);
        } else {
          warnings.push(`Unparseable JSON block at pos ${pos} — skipped.`);
        }
      } else {
        try {
          const parsed = JSON.parse(rawSlice);
          blockIdx++;
          blocks.push({ type:'json', label:`JSON #${blockIdx}`, data: parsed });
        } catch {
          const repaired = tryRepairJSON(rawSlice);
          if (repaired !== null) {
            blockIdx++;
            blocks.push({ type:'json', label:`JSON #${blockIdx} (repaired)`, data: repaired });
            warnings.push(`JSON block at pos ${pos} had minor issues and was auto-repaired.`);
          } else {
            warnings.push(`Invalid JSON at pos ${pos} — skipped.`);
          }
        }
      }
      pos = end;
      continue;
    }

    /* ── XML processing instruction / comment — skip ─ */
    if (src.startsWith('<?', pos)) {
      const ci = src.indexOf('?>', pos + 2);
      pos = ci === -1 ? src.length : ci + 2;
      continue;
    }
    if (src.startsWith('<!--', pos)) {
      const ci = src.indexOf('-->', pos + 4);
      pos = ci === -1 ? src.length : ci + 3;
      continue;
    }

    /* ── XML element ───────────────────────────────── */
    if (ch === '<') {
      const xmlChunk = extractXMLChunk(src, pos);
      if (xmlChunk === null) {
        warnings.push(`Unexpected '<' at pos ${pos} — not a valid XML tag, skipped.`);
        pos++;
        continue;
      }

      try {
        const parser = new DOMParser();
        const doc    = parser.parseFromString(xmlChunk.text, 'text/xml');
        const errEl  = doc.querySelector('parsererror');
        if (errEl) {
          const partial = tryRepairXML(xmlChunk.text);
          if (partial) {
            blockIdx++;
            blocks.push({ type:'xml', label:`XML #${blockIdx} (repaired)`, data: partial });
            warnings.push(`XML block at pos ${pos} had errors — partially recovered.`);
          } else {
            warnings.push(`Invalid XML at pos ${pos}: ${errEl.textContent.split('\n')[0]} — skipped.`);
          }
        } else {
          const converted = xmlToJson(doc);
          blockIdx++;
          blocks.push({ type:'xml', label:`XML #${blockIdx}`, data: converted });
        }
      } catch (e) {
        warnings.push(`XML parse exception at pos ${pos}: ${e.message} — skipped.`);
      }
      pos = xmlChunk.end;
      continue;
    }

    /* ── Non-data characters — skip to next starter ── */
    const next = findNextStarter(src, pos + 1);
    if (next === -1) break;
    pos = next;
  }

  return { blocks, warnings };
}

/* ── Helper: extract balanced {…} or […] ────────────── */
function extractBalanced(src, start, [open, close]) {
  let depth = 0, inStr = false, i = start;
  while (i < src.length) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (c === '"')  inStr = false;
    } else {
      if (c === '"')        inStr = true;
      else if (c === open)  depth++;
      else if (c === close) { depth--; if (depth === 0) return { end: i+1, error: false }; }
    }
    i++;
  }
  return { end: i, error: true };
}

/* ── Helper: find next { [ < ────────────────────────── */
function findNextStarter(src, from) {
  for (let i = from; i < src.length; i++) {
    if (src[i] === '{' || src[i] === '[' || src[i] === '<') return i;
  }
  return -1;
}

/* ── Helper: extract XML chunk starting at pos ──────── */
function extractXMLChunk(src, pos) {
  const tagMatch = src.slice(pos).match(/^<([A-Za-z_][\w:.-]*)/);
  if (!tagMatch) return null;
  const rootTag = tagMatch[1];

  // Self-closing?
  const selfClose = src.slice(pos).match(/^<[^>]*\/>/);
  if (selfClose) return { text: selfClose[0], end: pos + selfClose[0].length };

  // Walk to find matching close tag
  const closeStr = `</${rootTag}`;
  const openRe   = new RegExp(`<${escapeRe(rootTag)}(?:[\\s>])`, 'g');
  const closeRe  = new RegExp(`</${escapeRe(rootTag)}\\s*>`, 'g');
  const seg      = src.slice(pos);
  let depth      = 0, cursor = 0;

  while (cursor < seg.length) {
    openRe.lastIndex  = cursor;
    closeRe.lastIndex = cursor;
    const om = openRe.exec(seg);
    const cm = closeRe.exec(seg);

    if (!cm) return { text: seg, end: src.length };

    if (!om || cm.index < om.index) {
      depth--;
      cursor = cm.index + cm[0].length;
      if (depth <= 0) return { text: seg.slice(0, cursor), end: pos + cursor };
    } else {
      depth++;
      cursor = om.index + om[0].length;
    }
  }
  return { text: seg, end: src.length };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ── JSON repair: trailing commas, single quotes ────── */
function tryRepairJSON(str) {
  let s = str.trim();
  s = s.replace(/,\s*([}\]])/g, '$1');          // trailing commas
  s = s.replace(/'([^'\\]*(\\.[^'\\]*)*)'/g,   // single → double quotes
    (_, inner) => `"${inner}"`);
  try { return JSON.parse(s); } catch { return null; }
}

/* ── XML repair: walk back line by line ─────────────── */
function tryRepairXML(str) {
  const lines = str.split('\n');
  for (let i = lines.length - 1; i > 0; i--) {
    const attempt = lines.slice(0, i).join('\n').trim();
    if (!attempt) continue;
    const doc = new DOMParser().parseFromString(attempt, 'text/xml');
    if (!doc.querySelector('parsererror')) return xmlToJson(doc);
  }
  return null;
}

/* ══════════════════════════════════════════════════════
   MODULE: XML → JSON
══════════════════════════════════════════════════════ */
function xmlToJson(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const v = node.nodeValue.trim();
    return v.length ? v : undefined;
  }
  if (node.nodeType === Node.CDATA_SECTION_NODE) return node.nodeValue;

  if (node.nodeType === Node.ELEMENT_NODE) {
    const obj = {};
    if (node.attributes.length > 0) {
      obj['@attributes'] = {};
      for (const a of node.attributes) obj['@attributes'][a.name] = a.value;
    }
    const kids     = Array.from(node.childNodes);
    const elemKids = kids.filter(n => n.nodeType === Node.ELEMENT_NODE);
    const textKids = kids.filter(n => n.nodeType === Node.TEXT_NODE || n.nodeType === Node.CDATA_SECTION_NODE);

    if (elemKids.length === 0 && textKids.length > 0) {
      const text = textKids.map(n => n.nodeValue.trim()).join('').trim();
      if (text) {
        if (Object.keys(obj).length > 0) { obj['#text'] = text; }
        else return text;
      }
      return Object.keys(obj).length ? obj : undefined;
    }

    const tagCounts = {};
    for (const c of elemKids) tagCounts[c.tagName] = (tagCounts[c.tagName] || 0) + 1;
    for (const c of elemKids) {
      const tag = c.tagName, val = xmlToJson(c);
      if (tagCounts[tag] > 1) { if (!obj[tag]) obj[tag] = []; obj[tag].push(val); }
      else obj[tag] = val;
    }
    return Object.keys(obj).length ? obj : undefined;
  }

  if (node.nodeType === Node.DOCUMENT_NODE) {
    const root = node.documentElement;
    return { [root.tagName]: xmlToJson(root) };
  }
  return undefined;
}

/* ══════════════════════════════════════════════════════
   MODULE: Tree Renderer
══════════════════════════════════════════════════════ */
let totalNodes = 0;

function renderTree(blocks, container) {
  totalNodes = 0;
  container.innerHTML = '';

  blocks.forEach((block, bi) => {
    const header  = document.createElement('div');
    header.className = 'block-header';
    const typeTag = document.createElement('span');
    typeTag.className = `block-type-tag ${block.type}`;
    typeTag.textContent = block.type.toUpperCase();
    const labelEl = document.createElement('span');
    labelEl.className = 'block-label';
    labelEl.textContent = block.label;
    header.appendChild(typeTag);
    header.appendChild(labelEl);
    container.appendChild(header);

    const blockWrap = document.createElement('div');
    blockWrap.className = 'block-wrap';
    blockWrap.appendChild(buildNode(block.data, null, 0, true, 'root'));
    container.appendChild(blockWrap);

    if (bi < blocks.length - 1) {
      const sep = document.createElement('div');
      sep.className = 'block-separator';
      container.appendChild(sep);
    }
  });

  nodeCount.textContent = `${totalNodes.toLocaleString()} node${totalNodes !== 1 ? 's' : ''}`;
}

function buildNode(value, key, depth, isLast, keyType) {
  totalNodes++;
  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node';

  const isObject = value !== null && typeof value === 'object';
  const isArray  = Array.isArray(value);
  const isEmpty  = isObject && Object.keys(value).length === 0;

  const row = document.createElement('div');
  row.className = 'tree-row';
  row.appendChild(buildIndent(depth, isLast));

  let childrenEl = null, toggleBtn = null;
  if (isObject && !isEmpty) {
    toggleBtn = document.createElement('span');
    toggleBtn.className = 'toggle-btn expanded';
    row.appendChild(toggleBtn);
  } else {
    const sp = document.createElement('span');
    sp.style.cssText = 'display:inline-block;width:22px;flex-shrink:0';
    row.appendChild(sp);
  }

  if (key !== null) {
    const keyEl = document.createElement('span');
    keyEl.className = 'tree-key';
    if (keyType === 'attr')  keyEl.classList.add('attr-key');
    if (keyType === 'text')  keyEl.classList.add('text-key');
    if (keyType === 'index') keyEl.classList.add('index-key');
    keyEl.dataset.raw = key;
    keyEl.textContent = keyType === 'attr' ? `@${key}`
                      : keyType === 'text'  ? '#text'
                      : keyType === 'index' ? `[${key}]`
                      : key;
    row.appendChild(keyEl);
    const colon = document.createElement('span');
    colon.className = 'tree-colon'; colon.textContent = ':';
    row.appendChild(colon);
  }

  if (isObject && !isEmpty) {
    const count = Object.keys(value).length;
    const meta  = document.createElement('span');
    meta.className = 'tree-meta';
    meta.textContent = isArray ? `Array(${count})` : `{${count} key${count !== 1 ? 's' : ''}}`;
    row.appendChild(meta);
  } else if (isObject && isEmpty) {
    const meta = document.createElement('span');
    meta.className = 'tree-meta';
    meta.textContent = isArray ? '[ ]' : '{ }';
    row.appendChild(meta);
  } else {
    const valEl = document.createElement('span');
    valEl.className = 'tree-val';
    const { cls, display } = formatPrimitive(value);
    valEl.classList.add(cls);
    valEl.dataset.raw = String(value);
    valEl.textContent = display;
    row.appendChild(valEl);
  }

  wrapper.appendChild(row);

  if (isObject && !isEmpty) {
    childrenEl = document.createElement('div');
    childrenEl.className = 'tree-children';

    Object.entries(value).forEach(([k, v], i, arr) => {
      const last  = i === arr.length - 1;
      const kType = k === '#text' ? 'text' : isArray ? 'index' : 'normal';

      if (k === '@attributes' && v !== null && typeof v === 'object') {
        const attrW   = document.createElement('div');
        attrW.className = 'tree-node';
        const attrRow = document.createElement('div');
        attrRow.className = 'tree-row';
        attrRow.appendChild(buildIndent(depth + 1, last));
        const attrToggle = document.createElement('span');
        attrToggle.className = 'toggle-btn expanded';
        attrRow.appendChild(attrToggle);
        const attrKey = document.createElement('span');
        attrKey.className = 'tree-key attr-key'; attrKey.textContent = '@attributes';
        attrRow.appendChild(attrKey);
        const attrColon = document.createElement('span');
        attrColon.className = 'tree-colon'; attrColon.textContent = ':';
        attrRow.appendChild(attrColon);
        const ac = Object.keys(v).length;
        const attrMeta = document.createElement('span');
        attrMeta.className = 'tree-meta';
        attrMeta.textContent = `{${ac} attr${ac !== 1 ? 's' : ''}}`;
        attrRow.appendChild(attrMeta);
        attrW.appendChild(attrRow);

        const attrKids = document.createElement('div');
        attrKids.className = 'tree-children';
        Object.entries(v).forEach(([ak, av], ai, aa) =>
          attrKids.appendChild(buildNode(av, ak, depth + 2, ai === aa.length - 1, 'attr'))
        );
        attrW.appendChild(attrKids);
        setupToggle(attrToggle, attrKids);
        attrRow.style.cursor = 'pointer';
        attrRow.addEventListener('click', e => { if (!e.target.classList.contains('toggle-btn')) attrToggle.click(); });
        childrenEl.appendChild(attrW);
        return;
      }

      childrenEl.appendChild(buildNode(v, k, depth + 1, last, kType));
    });

    wrapper.appendChild(childrenEl);
    if (toggleBtn) {
      setupToggle(toggleBtn, childrenEl);
      row.style.cursor = 'pointer';
      row.addEventListener('click', e => { if (!e.target.classList.contains('toggle-btn')) toggleBtn.click(); });
    }
  }

  return wrapper;
}

function buildIndent(depth, isLast) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < depth; i++) {
    const line = document.createElement('span');
    line.className = 'tree-line' + (i === depth - 1 && isLast ? ' last' : '');
    frag.appendChild(line);
  }
  return frag;
}

function setupToggle(btn, childrenEl) {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (btn.classList.contains('expanded')) {
      btn.classList.replace('expanded','collapsed');
      childrenEl.classList.add('collapsed');
    } else {
      btn.classList.replace('collapsed','expanded');
      childrenEl.classList.remove('collapsed');
    }
  });
}

function formatPrimitive(value) {
  if (value === null || value === undefined) return { cls:'v-null', display: String(value) };
  const t = typeof value;
  if (t === 'boolean') return { cls:'v-bool', display: String(value) };
  if (t === 'number')  return { cls:'v-num',  display: String(value) };
  const s = String(value);
  return { cls:'v-str', display: s.length > 120 ? `"${s.slice(0,120)}…"` : `"${s}"` };
}

/* ══════════════════════════════════════════════════════
   MODULE: Text View + Syntax Highlighting
══════════════════════════════════════════════════════ */
function renderTextView(blocks) {
  textOutput.innerHTML = blocks.map(b =>
    `<span class="block-hdr-text ${b.type}">${esc(b.label)}</span>\n` +
    (state.minified
      ? esc(JSON.stringify(b.data))
      : syntaxHighlightJSON(JSON.stringify(b.data, null, state.indent)))
  ).join('\n\n');
}

function syntaxHighlightJSON(str) {
  let out = '', i = 0;
  const n = str.length;
  while (i < n) {
    const ch = str[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (str[j] === '\\') { j += 2; continue; }
        if (str[j] === '"')  { j++; break; }
        j++;
      }
      const raw = str.slice(i, j);
      let k = j;
      while (k < n && /[ \n\r]/.test(str[k])) k++;
      out += str[k] === ':' ? `<span class="s-key">${esc(raw)}</span>` : `<span class="s-str">${esc(raw)}</span>`;
      i = j; continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      while (j < n && /[0-9.\-+eE]/.test(str[j])) j++;
      out += `<span class="s-num">${esc(str.slice(i,j))}</span>`;
      i = j; continue;
    }
    if (str.startsWith('true',  i)) { out += `<span class="s-bool">true</span>`;  i += 4; continue; }
    if (str.startsWith('false', i)) { out += `<span class="s-bool">false</span>`; i += 5; continue; }
    if (str.startsWith('null',  i)) { out += `<span class="s-null">null</span>`;  i += 4; continue; }
    if ('{}[],:'.includes(ch))      { out += `<span class="s-punc">${esc(ch)}</span>`; i++; continue; }
    out += esc(ch); i++;
  }
  return out;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ══════════════════════════════════════════════════════
   MODULE: Search  (inline highlights + prev/next + scroll)
══════════════════════════════════════════════════════ */
const search = {
  hits:   [],   // matched .tree-row elements in DOM order
  cursor: -1,
};

/* Wrap every occurrence of `term` inside el's text with <mark class="sh"> */
function injectHighlight(el, term) {
  const raw = el.dataset.raw;
  if (!raw) return false;
  const lo = raw.toLowerCase();
  if (!lo.includes(term)) return false;

  // Build display text the same way formatPrimitive / buildNode would
  const display = el.classList.contains('tree-val')
    ? el.textContent          // already formatted (quoted string / number etc.)
    : el.textContent;         // key label as shown

  // Find and wrap all case-insensitive matches in the display text
  // We match against the lowercased display text
  const loDisplay = display.toLowerCase();
  let result = '', last = 0, i;
  let idx = loDisplay.indexOf(term, 0);
  while (idx !== -1) {
    result += escHtml(display.slice(last, idx));
    result += `<mark class="sh">${escHtml(display.slice(idx, idx + term.length))}</mark>`;
    last = idx + term.length;
    idx  = loDisplay.indexOf(term, last);
  }
  result += escHtml(display.slice(last));
  el.innerHTML = result;
  return true;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* Restore plain text from dataset.raw */
function clearHighlight(el) {
  if (!el.dataset.raw) return;
  // Re-derive display text
  if (el.classList.contains('tree-val')) {
    el.textContent = el.textContent; // already plain after innerHTML reset
    // Reconstruct from raw
    const raw = el.dataset.raw;
    if (el.classList.contains('v-str')) {
      el.textContent = raw.length > 120 ? `"${raw.slice(0,120)}…"` : `"${raw}"`;
    } else {
      el.textContent = raw;
    }
  } else {
    // key — textContent was set during buildNode; restore from the mark-stripped version
    el.textContent = el.textContent; // marks are inline so strip via textContent read
    // Actually innerHTML = textContent after a marks-only change is fine, but
    // just set textContent from the current (marks stripped) textContent:
    el.textContent = el.innerText || el.textContent;
  }
}

function clearAllHighlights() {
  treeOutput.querySelectorAll('.tree-row').forEach(row => {
    row.classList.remove('highlighted', 'search-active');
    row.querySelectorAll('.tree-key, .tree-val').forEach(el => {
      // Strip any <mark> tags by restoring from dataset.raw
      if (!el.dataset.raw) return;
      const raw = el.dataset.raw;
      if (el.classList.contains('v-str')) {
        el.textContent = raw.length > 120 ? `"${raw.slice(0,120)}…"` : `"${raw}"`;
      } else if (el.classList.contains('tree-key')) {
        // Restore key label
        const kt = el.dataset.keytype || '';
        if (el.classList.contains('attr-key') && raw !== '@attributes') el.textContent = `@${raw}`;
        else if (el.classList.contains('text-key'))  el.textContent = '#text';
        else if (el.classList.contains('index-key')) el.textContent = `[${raw}]`;
        else el.textContent = raw;
      } else {
        el.textContent = raw;
      }
    });
  });
}

function applySearch(term) {
  state.searchTerm = term.toLowerCase().trim();

  // Always clear previous highlights first
  clearAllHighlights();
  search.hits   = [];
  search.cursor = -1;

  const searchNav = $('searchNav');

  if (!state.searchTerm) {
    matchCount.textContent  = '';
    searchNav.style.display = 'none';
    return;
  }

  // Scan every row, inject highlights, collect hits
  treeOutput.querySelectorAll('.tree-row').forEach(row => {
    let matched = false;
    row.querySelectorAll('.tree-key, .tree-val').forEach(el => {
      if (injectHighlight(el, state.searchTerm)) matched = true;
    });
    if (!matched) return;

    // Expand collapsed ancestors
    let p = row.parentElement;
    while (p) {
      if (p.classList.contains('tree-children') && p.classList.contains('collapsed')) {
        p.classList.remove('collapsed');
        const btn = p.previousElementSibling?.querySelector?.('.toggle-btn');
        if (btn) btn.classList.replace('collapsed', 'expanded');
      }
      p = p.parentElement;
    }

    row.classList.add('highlighted');
    search.hits.push(row);
  });

  const total = search.hits.length;
  searchNav.style.display = total > 0 ? 'flex' : 'none';

  if (total > 0) {
    navigateSearch(0);
  } else {
    matchCount.textContent = '0 results';
  }
}

function navigateSearch(idx) {
  if (!search.hits.length) return;
  idx = ((idx % search.hits.length) + search.hits.length) % search.hits.length;

  // De-activate previous
  if (search.cursor >= 0 && search.hits[search.cursor]) {
    search.hits[search.cursor].classList.remove('search-active');
  }

  search.cursor = idx;
  const activeRow = search.hits[idx];
  activeRow.classList.add('search-active');

  // Scroll: use getBoundingClientRect relative to outputWrap
  const wrap = document.getElementById('outputWrap');
  const rowRect  = activeRow.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const offset   = rowRect.top - wrapRect.top - (wrap.clientHeight / 2) + (rowRect.height / 2);
  wrap.scrollBy({ top: offset, behavior: 'smooth' });

  matchCount.textContent = `${idx + 1} / ${search.hits.length}`;
}

function searchNext() { navigateSearch(search.cursor + 1); }
function searchPrev() { navigateSearch(search.cursor - 1); }

/* ══════════════════════════════════════════════════════
   CORE: Parse & Render Pipeline
══════════════════════════════════════════════════════ */
function runParse() {
  const src = inputArea.value;
  hideError();
  if (!src.trim()) { showEmpty(); return; }

  const { blocks, warnings } = extractBlocks(src);

  if (blocks.length === 0) {
    showError('No parseable JSON or XML found.' + (warnings.length ? ' ' + warnings[0] : ''));
    return;
  }

  state.blocks = blocks;

  // Badge
  const types = [...new Set(blocks.map(b => b.type))];
  if (types.length === 1) updateBadge(types[0]);
  else { formatBadge.textContent = 'JSON+XML'; formatBadge.className = 'format-badge mixed'; }

  if (warnings.length) showWarning(warnings.join(' · '));

  renderOutput();
  if (state.searchTerm) applySearch(state.searchTerm);
}

function renderOutput() {
  emptyState.style.display = 'none';
  // Reset search state on every render
  search.hits = []; search.cursor = -1;
  $('searchNav').style.display = 'none';
  matchCount.textContent = '';
  if (state.view === 'tree') {
    treeOutput.style.display = 'block';
    textOutput.style.display = 'none';
    renderTree(state.blocks, treeOutput);
  } else {
    treeOutput.style.display = 'none';
    textOutput.style.display = 'block';
    renderTextView(state.blocks);
    const total = state.blocks.reduce((s, b) => s + countNodes(b.data), 0);
    nodeCount.textContent = `${total.toLocaleString()} node${total !== 1 ? 's' : ''}`;
  }
}

function countNodes(v) {
  if (v === null || typeof v !== 'object') return 1;
  return 1 + Object.values(v).reduce((s,c) => s + countNodes(c), 0);
}

/* ── UI helpers ─────────────────────────────────────── */
function showError(msg) {
  errorBanner.style.cssText = 'display:block;background:rgba(247,92,92,0.12);border-top:1px solid rgba(247,92,92,0.4);color:var(--red)';
  errorBanner.textContent = '⚠ ' + msg;
  inputArea.style.outline = '1px solid var(--red)';
}

function showWarning(msg) {
  errorBanner.style.cssText = 'display:block;background:rgba(246,166,35,0.08);border-top:1px solid rgba(246,166,35,0.35);color:var(--amber)';
  errorBanner.textContent = '⚡ ' + msg;
  inputArea.style.outline = '1px solid rgba(246,166,35,0.4)';
}

function hideError() {
  errorBanner.style.display = 'none';
  inputArea.style.outline = '';
}

function showEmpty() {
  emptyState.style.display  = 'flex';
  treeOutput.style.display  = 'none';
  textOutput.style.display  = 'none';
  formatBadge.textContent   = '—';
  formatBadge.className     = 'format-badge';
  nodeCount.textContent     = '';
  state.blocks = [];
}

function updateBadge(fmt) {
  formatBadge.textContent = fmt.toUpperCase();
  formatBadge.className   = 'format-badge ' + fmt;
}

function expandAll() {
  treeOutput.querySelectorAll('.tree-children').forEach(el => el.classList.remove('collapsed'));
  treeOutput.querySelectorAll('.toggle-btn').forEach(btn => btn.classList.replace('collapsed','expanded'));
}

function collapseAll() {
  treeOutput.querySelectorAll('.tree-children').forEach(el => el.classList.add('collapsed'));
  treeOutput.querySelectorAll('.toggle-btn').forEach(btn => btn.classList.replace('expanded','collapsed'));
}

function copyOutput() {
  const text = state.blocks.map(b =>
    `// ${b.label}\n` + (state.minified ? JSON.stringify(b.data) : JSON.stringify(b.data, null, state.indent))
  ).join('\n\n');
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  });
  copyToast.classList.add('show');
  setTimeout(() => copyToast.classList.remove('show'), 1800);
}

function downloadOutput() {
  if (!state.blocks.length) return;
  const text = state.blocks.map(b =>
    `// ${b.label}\n` + (state.minified ? JSON.stringify(b.data) : JSON.stringify(b.data, null, state.indent))
  ).join('\n\n');
  const blob = new Blob([text], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'parsed-output.json'; a.click();
  URL.revokeObjectURL(url);
}

/* ══════════════════════════════════════════════════════
   Event Wiring
══════════════════════════════════════════════════════ */
inputArea.addEventListener('input', () => {
  charCount.textContent = `${inputArea.value.length.toLocaleString()} chars`;
  hideError();
});

parseBtn.addEventListener('click', runParse);

inputArea.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runParse(); }
});

clearBtn.addEventListener('click', () => {
  inputArea.value = ''; charCount.textContent = '0 chars';
  hideError(); showEmpty(); searchInput.value = ''; matchCount.textContent = '';
});

viewTreeBtn.addEventListener('click', () => {
  if (state.view === 'tree') return;
  state.view = 'tree'; viewTreeBtn.classList.add('active'); viewTextBtn.classList.remove('active');
  if (state.blocks.length) renderOutput();
});

viewTextBtn.addEventListener('click', () => {
  if (state.view === 'text') return;
  state.view = 'text'; viewTextBtn.classList.add('active'); viewTreeBtn.classList.remove('active');
  if (state.blocks.length) renderOutput();
});

[indent2Btn, indent4Btn].forEach(btn => {
  btn.addEventListener('click', () => {
    indent2Btn.classList.remove('active'); indent4Btn.classList.remove('active');
    btn.classList.add('active'); state.indent = parseInt(btn.dataset.indent, 10);
    if (state.blocks.length && state.view === 'text') renderOutput();
  });
});

toggleMinify.addEventListener('click', () => {
  state.minified = !state.minified;
  toggleMinify.textContent = state.minified ? 'Beautify' : 'Minify';
  toggleMinify.classList.toggle('active', state.minified);
  if (state.blocks.length) renderOutput();
});

expandAllBtn.addEventListener('click',   expandAll);
collapseAllBtn.addEventListener('click', collapseAll);
copyBtn.addEventListener('click',        copyOutput);
downloadBtn.addEventListener('click',    downloadOutput);

// Search — input triggers fresh search
let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (state.view === 'tree' && state.blocks.length) applySearch(searchInput.value);
  }, 180);
});

// Search — Enter/Shift+Enter to cycle matches
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) searchPrev(); else searchNext();
  }
  if (e.key === 'Escape') {
    searchInput.value = '';
    applySearch('');
  }
});

$('searchNextBtn').addEventListener('click', searchNext);
$('searchPrevBtn').addEventListener('click', searchPrev);

// Fullscreen output panel
const outputPanel   = document.querySelector('.panel-output');
const fsIconExpand  = $('fsIconExpand');
const fsIconCollapse= $('fsIconCollapse');
let   isFullscreen  = false;

function toggleFullscreen() {
  isFullscreen = !isFullscreen;
  outputPanel.classList.toggle('panel-fullscreen', isFullscreen);
  document.querySelector('.panel-input').classList.toggle('panel-hidden', isFullscreen);
  document.querySelector('.divider').classList.toggle('panel-hidden', isFullscreen);
  fsIconExpand.style.display   = isFullscreen ? 'none'  : '';
  fsIconCollapse.style.display = isFullscreen ? ''      : 'none';
}

$('fullscreenBtn').addEventListener('click', toggleFullscreen);

// Keyboard shortcut: F to toggle fullscreen (when not typing in textarea/input)
document.addEventListener('keydown', e => {
  if (e.key === 'f' || e.key === 'F') {
    const tag = document.activeElement?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    toggleFullscreen();
  }
  if (e.key === 'Escape' && isFullscreen) toggleFullscreen();
});

/* ══════════════════════════════════════════════════════
   Demo seed — mixed JSON + XML in one paste
══════════════════════════════════════════════════════ */
const DEMO = `Here is some store data:

{
  "store": {
    "name": "DataLens Books",
    "open": true,
    "rating": 4.9,
    "genres": ["Fiction", "Science", "Technology"],
    "books": [
      { "id": 1, "title": "The JSON Chronicles", "price": 19.99, "inStock": true },
      { "id": 2, "title": "XML: The Forgotten Tome", "price": 14.50, "inStock": false }
    ]
  }
}

And here is the catalogue in XML:

<catalogue version="2025">
  <section name="Featured">
    <book id="101" featured="true">
      <title>Parsing at the Edge</title>
      <author>Ada Syntax</author>
      <price currency="USD">24.99</price>
      <tags>
        <tag>algorithms</tag>
        <tag>compilers</tag>
      </tags>
    </book>
    <book id="102">
      <title>The Recursive Mind</title>
      <author>Tim Markup</author>
      <price currency="EUR">18.00</price>
    </book>
  </section>
</catalogue>`;

inputArea.value = DEMO;
charCount.textContent = `${DEMO.length.toLocaleString()} chars`;
runParse();
