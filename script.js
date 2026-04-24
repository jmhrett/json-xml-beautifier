/* ═══════════════════════════════════════════════════════
   DataLens — JSON & XML Inspector
   ═══════════════════════════════════════════════════════ */

'use strict';

/* ── State ─────────────────────────────────────────── */
const state = {
  parsed:   null,      // parsed JS object
  format:   null,      // 'json' | 'xml'
  view:     'tree',    // 'tree' | 'text'
  indent:   2,
  minified: false,
  searchTerm: '',
};

/* ── DOM refs ──────────────────────────────────────── */
const $ = id => document.getElementById(id);
const inputArea     = $('inputArea');
const parseBtn      = $('parseBtn');
const clearBtn      = $('clearBtn');
const formatBadge   = $('formatBadge');
const charCount     = $('charCount');
const errorBanner   = $('errorBanner');
const treeOutput    = $('treeOutput');
const textOutput    = $('textOutput');
const emptyState    = $('emptyState');
const outputWrap    = $('outputWrap');
const nodeCount     = $('nodeCount');
const copyBtn       = $('copyBtn');
const downloadBtn   = $('downloadBtn');
const expandAllBtn  = $('expandAllBtn');
const collapseAllBtn= $('collapseAllBtn');
const searchInput   = $('searchInput');
const matchCount    = $('matchCount');
const copyToast     = $('copyToast');
const indent2Btn    = $('indent2');
const indent4Btn    = $('indent4');
const viewTreeBtn   = $('viewTree');
const viewTextBtn   = $('viewText');
const toggleMinify  = $('toggleMinify');

/* ══════════════════════════════════════════════════════
   MODULE: Format Detection
   ══════════════════════════════════════════════════════ */
function detectFormat(src) {
  const trimmed = src.trim();
  if (!trimmed) return null;
  if (trimmed[0] === '{' || trimmed[0] === '[') return 'json';
  if (trimmed[0] === '<') return 'xml';
  // fallback: try both
  try { JSON.parse(trimmed); return 'json'; } catch {}
  try {
    const doc = new DOMParser().parseFromString(trimmed, 'text/xml');
    if (!doc.querySelector('parsererror')) return 'xml';
  } catch {}
  return null;
}

/* ══════════════════════════════════════════════════════
   MODULE: JSON Parsing
   ══════════════════════════════════════════════════════ */
function parseJSON(src) {
  return JSON.parse(src.trim());
}

/* ══════════════════════════════════════════════════════
   MODULE: XML Parsing & Conversion
   ══════════════════════════════════════════════════════ */
function parseXML(src) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(src.trim(), 'text/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error(err.textContent.split('\n')[0]);
  return doc;
}

function xmlToJson(node) {
  // Text node
  if (node.nodeType === Node.TEXT_NODE) {
    const val = node.nodeValue.trim();
    return val.length ? val : undefined;
  }

  // CDATA section
  if (node.nodeType === Node.CDATA_SECTION_NODE) {
    return node.nodeValue;
  }

  // Element node
  if (node.nodeType === Node.ELEMENT_NODE) {
    const obj = {};

    // Attributes
    if (node.attributes.length > 0) {
      obj['@attributes'] = {};
      for (const attr of node.attributes) {
        obj['@attributes'][attr.name] = attr.value;
      }
    }

    // Children
    const children = Array.from(node.childNodes);
    const elemChildren = children.filter(n => n.nodeType === Node.ELEMENT_NODE);
    const textChildren = children.filter(n =>
      n.nodeType === Node.TEXT_NODE || n.nodeType === Node.CDATA_SECTION_NODE
    );

    // Pure text node
    if (elemChildren.length === 0 && textChildren.length > 0) {
      const text = textChildren.map(n => n.nodeValue.trim()).join('').trim();
      if (text) {
        if (Object.keys(obj).length > 0) {
          obj['#text'] = text;
        } else {
          return text;
        }
      }
      return Object.keys(obj).length ? obj : undefined;
    }

    // Group repeated tag names into arrays
    const tagCounts = {};
    for (const c of elemChildren) {
      tagCounts[c.tagName] = (tagCounts[c.tagName] || 0) + 1;
    }

    for (const child of elemChildren) {
      const tag = child.tagName;
      const val = xmlToJson(child);
      if (tagCounts[tag] > 1) {
        if (!obj[tag]) obj[tag] = [];
        obj[tag].push(val);
      } else {
        obj[tag] = val;
      }
    }

    return Object.keys(obj).length ? obj : undefined;
  }

  // Document node — recurse into root element
  if (node.nodeType === Node.DOCUMENT_NODE) {
    const root = node.documentElement;
    const result = {};
    result[root.tagName] = xmlToJson(root);
    return result;
  }

  return undefined;
}

/* ══════════════════════════════════════════════════════
   MODULE: Tree Renderer
   ══════════════════════════════════════════════════════ */

let totalNodes = 0;

function renderTree(data, container) {
  totalNodes = 0;
  container.innerHTML = '';
  const rootNode = buildNode(data, null, 0, true, 'root');
  container.appendChild(rootNode);
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

  // Indent lines
  const indent = buildIndent(depth, isLast);
  row.appendChild(indent);

  // Toggle button (only for non-empty objects/arrays)
  let childrenEl = null;
  let toggleBtn  = null;
  if (isObject && !isEmpty) {
    toggleBtn = document.createElement('span');
    toggleBtn.className = 'toggle-btn expanded';
    row.appendChild(toggleBtn);
  } else {
    const spacer = document.createElement('span');
    spacer.style.display = 'inline-block';
    spacer.style.width = '22px';
    row.appendChild(spacer);
  }

  // Key label
  if (key !== null) {
    const keyEl = document.createElement('span');
    keyEl.className = 'tree-key';
    if (keyType === 'attr')  keyEl.classList.add('attr-key');
    if (keyType === 'text')  keyEl.classList.add('text-key');
    if (keyType === 'index') keyEl.classList.add('index-key');
    keyEl.dataset.raw = key;

    if (keyType === 'attr')  keyEl.textContent = `@${key}`;
    else if (keyType === 'text') keyEl.textContent = '#text';
    else keyEl.textContent = isArray ? `[${key}]` : (keyType === 'index' ? `[${key}]` : key);

    row.appendChild(keyEl);

    const colon = document.createElement('span');
    colon.className = 'tree-colon';
    colon.textContent = ':';
    row.appendChild(colon);
  }

  // Value or summary
  if (isObject && !isEmpty) {
    const meta = document.createElement('span');
    meta.className = 'tree-meta';
    const keys = Object.keys(value);
    const count = keys.length;
    if (isArray) {
      meta.textContent = `Array(${count})`;
    } else {
      meta.textContent = `{${count} key${count !== 1 ? 's' : ''}}`;
    }
    row.appendChild(meta);
  } else if (isObject && isEmpty) {
    const meta = document.createElement('span');
    meta.className = 'tree-meta';
    meta.textContent = isArray ? '[]' : '{}';
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

  // Children
  if (isObject && !isEmpty) {
    childrenEl = document.createElement('div');
    childrenEl.className = 'tree-children expanding';

    const entries = Object.entries(value);
    const parentIsArray = isArray;

    entries.forEach(([k, v], i) => {
      const last = i === entries.length - 1;
      let kType = parentIsArray ? 'index' : 'normal';
      if (k === '@attributes') kType = 'attrGroup';
      else if (k === '#text')  kType = 'text';
      // Detect attr keys inside @attributes
      let childNode;
      if (k === '@attributes' && v !== null && typeof v === 'object') {
        // render attrs inline as children
        const attrWrapper = document.createElement('div');
        attrWrapper.className = 'tree-node';
        const attrRow = document.createElement('div');
        attrRow.className = 'tree-row';
        const attrIndent = buildIndent(depth + 1, last);
        attrRow.appendChild(attrIndent);
        const spacer = document.createElement('span');
        spacer.style.display = 'inline-block'; spacer.style.width = '22px';
        attrRow.appendChild(spacer);
        const attrKeyEl = document.createElement('span');
        attrKeyEl.className = 'tree-key attr-key';
        attrKeyEl.textContent = '@attributes';
        attrRow.appendChild(attrKeyEl);
        const colon2 = document.createElement('span');
        colon2.className = 'tree-colon'; colon2.textContent = ':';
        attrRow.appendChild(colon2);
        const meta2 = document.createElement('span');
        meta2.className = 'tree-meta';
        meta2.textContent = `{${Object.keys(v).length} attr${Object.keys(v).length !== 1 ? 's' : ''}}`;
        attrRow.appendChild(meta2);
        attrWrapper.appendChild(attrRow);

        const attrChildren = document.createElement('div');
        attrChildren.className = 'tree-children';
        Object.entries(v).forEach(([ak, av], ai) => {
          attrChildren.appendChild(buildNode(av, ak, depth + 2, ai === Object.keys(v).length - 1, 'attr'));
        });
        attrWrapper.appendChild(attrChildren);

        // Toggle for @attributes group
        const attrToggle = document.createElement('span');
        attrToggle.className = 'toggle-btn expanded';
        attrRow.insertBefore(attrToggle, attrKeyEl);
        attrRow.removeChild(spacer);
        setupToggle(attrToggle, attrChildren);

        childrenEl.appendChild(attrWrapper);
        return;
      }
      childNode = buildNode(v, k, depth + 1, last, kType);
      childrenEl.appendChild(childNode);
    });

    wrapper.appendChild(childrenEl);
    requestAnimationFrame(() => childrenEl.classList.remove('expanding'));

    if (toggleBtn) {
      setupToggle(toggleBtn, childrenEl);
      row.style.cursor = 'pointer';
      row.addEventListener('click', e => {
        if (!e.target.classList.contains('toggle-btn')) {
          toggleBtn.click();
        }
      });
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
    const isExpanded = btn.classList.contains('expanded');
    if (isExpanded) {
      btn.classList.replace('expanded', 'collapsed');
      childrenEl.classList.add('collapsed');
    } else {
      btn.classList.replace('collapsed', 'expanded');
      childrenEl.classList.remove('collapsed');
      childrenEl.classList.add('expanding');
      requestAnimationFrame(() => childrenEl.classList.remove('expanding'));
    }
  });
}

function formatPrimitive(value) {
  if (value === null)      return { cls: 'v-null', display: 'null' };
  if (value === undefined) return { cls: 'v-null', display: 'undefined' };
  const t = typeof value;
  if (t === 'boolean') return { cls: 'v-bool', display: String(value) };
  if (t === 'number')  return { cls: 'v-num',  display: String(value) };
  // String — truncate if very long
  const str = String(value);
  const display = str.length > 120 ? `"${str.slice(0, 120)}…"` : `"${str}"`;
  return { cls: 'v-str', display };
}

/* ══════════════════════════════════════════════════════
   MODULE: Formatted Text View
   ══════════════════════════════════════════════════════ */
function formatOutput(data, format, indent, minified) {
  if (minified) {
    return JSON.stringify(data);
  }
  const str = JSON.stringify(data, null, indent);
  return syntaxHighlightJSON(str);
}

function syntaxHighlightJSON(str) {
  // Token-based syntax highlighting
  let out = '';
  let i = 0;
  const n = str.length;

  while (i < n) {
    const ch = str[i];

    // String
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (str[j] === '\\') { j += 2; continue; }
        if (str[j] === '"') { j++; break; }
        j++;
      }
      const raw = str.slice(i, j);
      // Is this a key? Look ahead for colon
      let k = j;
      while (k < n && (str[k] === ' ' || str[k] === '\n' || str[k] === '\r')) k++;
      if (str[k] === ':') {
        out += `<span class="s-key">${esc(raw)}</span>`;
      } else {
        out += `<span class="s-str">${esc(raw)}</span>`;
      }
      i = j;
      continue;
    }

    // Number
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      while (j < n && '0123456789.-+eE'.includes(str[j])) j++;
      out += `<span class="s-num">${esc(str.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    // Boolean / null
    if (str.startsWith('true', i))  { out += `<span class="s-bool">true</span>`;   i += 4; continue; }
    if (str.startsWith('false', i)) { out += `<span class="s-bool">false</span>`;  i += 5; continue; }
    if (str.startsWith('null', i))  { out += `<span class="s-null">null</span>`;   i += 4; continue; }

    // Punctuation
    if ('{}[],:'.includes(ch)) {
      out += `<span class="s-punc">${esc(ch)}</span>`;
      i++;
      continue;
    }

    // Whitespace / other
    out += esc(ch);
    i++;
  }

  return out;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ══════════════════════════════════════════════════════
   MODULE: Search / Filter
   ══════════════════════════════════════════════════════ */
function applySearch(term) {
  state.searchTerm = term.toLowerCase().trim();
  const rows = treeOutput.querySelectorAll('.tree-row');
  let hits = 0;

  rows.forEach(row => {
    row.classList.remove('highlighted');
    if (!state.searchTerm) return;

    const keyEls = row.querySelectorAll('.tree-key');
    const valEls = row.querySelectorAll('.tree-val');
    let match = false;

    keyEls.forEach(el => {
      if (el.dataset.raw && el.dataset.raw.toLowerCase().includes(state.searchTerm)) match = true;
    });
    valEls.forEach(el => {
      if (el.dataset.raw && el.dataset.raw.toLowerCase().includes(state.searchTerm)) match = true;
    });

    if (match) {
      row.classList.add('highlighted');
      hits++;
      // Ensure parent nodes are expanded
      let p = row.parentElement;
      while (p) {
        if (p.classList.contains('tree-children') && p.classList.contains('collapsed')) {
          p.classList.remove('collapsed');
          const btn = p.previousElementSibling?.querySelector('.toggle-btn');
          if (btn) btn.classList.replace('collapsed', 'expanded');
        }
        p = p.parentElement;
      }
    }
  });

  matchCount.textContent = state.searchTerm ? `${hits}` : '';
}

/* ══════════════════════════════════════════════════════
   MODULE: Core Parse & Render Pipeline
   ══════════════════════════════════════════════════════ */
function runParse() {
  const src = inputArea.value;
  hideError();

  if (!src.trim()) {
    showEmpty();
    return;
  }

  const fmt = detectFormat(src);

  if (!fmt) {
    showError('Could not detect format. Input must start with { / [ (JSON) or < (XML).');
    return;
  }

  try {
    let parsed;
    if (fmt === 'json') {
      parsed = parseJSON(src);
    } else {
      const xmlDoc = parseXML(src);
      parsed = xmlToJson(xmlDoc);
    }
    state.parsed = parsed;
    state.format = fmt;

    updateBadge(fmt);
    renderOutput();
    if (state.searchTerm) applySearch(state.searchTerm);

  } catch (err) {
    showError(err.message || String(err));
  }
}

function renderOutput() {
  emptyState.style.display = 'none';

  if (state.view === 'tree') {
    treeOutput.style.display = 'block';
    textOutput.style.display = 'none';
    renderTree(state.parsed, treeOutput);
    treeOutput.style.paddingLeft = '12px';
  } else {
    treeOutput.style.display = 'none';
    textOutput.style.display = 'block';
    if (state.minified) {
      textOutput.innerHTML = esc(JSON.stringify(state.parsed));
    } else {
      textOutput.innerHTML = formatOutput(state.parsed, state.format, state.indent);
    }
    const total = countNodes(state.parsed);
    nodeCount.textContent = `${total.toLocaleString()} node${total !== 1 ? 's' : ''}`;
  }
}

function countNodes(v) {
  if (v === null || typeof v !== 'object') return 1;
  return 1 + Object.values(v).reduce((s, c) => s + countNodes(c), 0);
}

/* ── UI helpers ────────────────────────────────────── */
function showError(msg) {
  errorBanner.textContent = '⚠ ' + msg;
  errorBanner.style.display = 'block';
  inputArea.style.outline = '1px solid var(--red)';
}

function hideError() {
  errorBanner.style.display = 'none';
  inputArea.style.outline = '';
}

function showEmpty() {
  emptyState.style.display = 'flex';
  treeOutput.style.display = 'none';
  textOutput.style.display = 'none';
  formatBadge.textContent = '—';
  formatBadge.className = 'format-badge';
  nodeCount.textContent = '';
  state.parsed = null;
  state.format = null;
}

function updateBadge(fmt) {
  formatBadge.textContent = fmt.toUpperCase();
  formatBadge.className = 'format-badge ' + fmt;
}

function expandAll() {
  treeOutput.querySelectorAll('.tree-children').forEach(el => {
    el.classList.remove('collapsed');
  });
  treeOutput.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.classList.replace('collapsed', 'expanded');
  });
}

function collapseAll() {
  treeOutput.querySelectorAll('.tree-children').forEach(el => {
    el.classList.add('collapsed');
  });
  treeOutput.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.classList.replace('expanded', 'collapsed');
  });
}

function copyOutput() {
  const text = state.parsed
    ? (state.minified
        ? JSON.stringify(state.parsed)
        : JSON.stringify(state.parsed, null, state.indent))
    : '';
  navigator.clipboard.writeText(text).then(() => {
    copyToast.classList.add('show');
    setTimeout(() => copyToast.classList.remove('show'), 1800);
  }).catch(() => {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    copyToast.classList.add('show');
    setTimeout(() => copyToast.classList.remove('show'), 1800);
  });
}

function downloadOutput() {
  if (!state.parsed) return;
  const text = state.minified
    ? JSON.stringify(state.parsed)
    : JSON.stringify(state.parsed, null, state.indent);
  const ext = 'json';
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `parsed-output.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ══════════════════════════════════════════════════════
   Event Wiring
   ══════════════════════════════════════════════════════ */

// Auto-parse on paste
inputArea.addEventListener('input', () => {
  charCount.textContent = `${inputArea.value.length.toLocaleString()} chars`;
  hideError();
  // Live badge preview
  const fmt = detectFormat(inputArea.value);
  if (fmt) updateBadge(fmt);
  else { formatBadge.textContent = '—'; formatBadge.className = 'format-badge'; }
});

// Parse on button click
parseBtn.addEventListener('click', runParse);

// Keyboard shortcut: Cmd+Enter / Ctrl+Enter
inputArea.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    runParse();
  }
});

// Clear
clearBtn.addEventListener('click', () => {
  inputArea.value = '';
  charCount.textContent = '0 chars';
  hideError();
  showEmpty();
  searchInput.value = '';
  matchCount.textContent = '';
});

// View toggle
viewTreeBtn.addEventListener('click', () => {
  if (state.view === 'tree') return;
  state.view = 'tree';
  viewTreeBtn.classList.add('active');
  viewTextBtn.classList.remove('active');
  if (state.parsed) renderOutput();
});

viewTextBtn.addEventListener('click', () => {
  if (state.view === 'text') return;
  state.view = 'text';
  viewTextBtn.classList.add('active');
  viewTreeBtn.classList.remove('active');
  if (state.parsed) renderOutput();
});

// Indent toggle
[indent2Btn, indent4Btn].forEach(btn => {
  btn.addEventListener('click', () => {
    indent2Btn.classList.remove('active');
    indent4Btn.classList.remove('active');
    btn.classList.add('active');
    state.indent = parseInt(btn.dataset.indent, 10);
    if (state.parsed && state.view === 'text') renderOutput();
  });
});

// Minify toggle
toggleMinify.addEventListener('click', () => {
  state.minified = !state.minified;
  toggleMinify.textContent = state.minified ? 'Beautify' : 'Minify';
  toggleMinify.classList.toggle('active', state.minified);
  if (state.parsed) renderOutput();
});

// Expand / Collapse All
expandAllBtn.addEventListener('click',   expandAll);
collapseAllBtn.addEventListener('click', collapseAll);

// Copy
copyBtn.addEventListener('click', copyOutput);

// Download
downloadBtn.addEventListener('click', downloadOutput);

// Search — debounced
let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (state.view === 'tree' && state.parsed) {
      applySearch(searchInput.value);
    }
  }, 200);
});

/* ══════════════════════════════════════════════════════
   Demo seed on load
   ══════════════════════════════════════════════════════ */
const DEMO_JSON = `{
  "store": {
    "name": "DataLens Books",
    "open": true,
    "rating": 4.9,
    "address": {
      "street": "42 Parser Lane",
      "city": "Syntatown",
      "zip": "10101"
    },
    "genres": ["Fiction", "Science", "Technology", "Art"],
    "books": [
      {
        "id": 1,
        "title": "The JSON Chronicles",
        "author": "Ada Syntax",
        "price": 19.99,
        "inStock": true,
        "tags": ["bestseller", "coding"]
      },
      {
        "id": 2,
        "title": "XML: The Forgotten Tome",
        "author": "Tim Markup",
        "price": 14.50,
        "inStock": false,
        "tags": ["classic", "web"]
      },
      {
        "id": 3,
        "title": "Parsing at the Edge",
        "author": "null",
        "price": null,
        "inStock": true,
        "tags": []
      }
    ]
  }
}`;

inputArea.value = DEMO_JSON;
charCount.textContent = `${DEMO_JSON.length.toLocaleString()} chars`;
runParse();
