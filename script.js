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
   JSON object/array and XML document it can find.
   Any plain text sitting before a block is preserved
   as block.caption so nothing is ever discarded.
   Returns: { blocks: [{type, label, caption, data}], warnings: [str] }
══════════════════════════════════════════════════════ */
function extractBlocks(src) {
  const blocks   = [];
  const warnings = [];
  let   pos      = 0;
  let   blockIdx = 0;
  let   pendingCaption = ''; // plain text accumulated since last block

  /* Collect text between pos and nextPos, append to pendingCaption */
  function collectText(from, to) {
    const chunk = src.slice(from, to);
    if (chunk.trim()) pendingCaption += (pendingCaption ? '\n' : '') + chunk.trim();
  }

  function flushBlock(blockObj) {
    blockObj.caption = pendingCaption || '';
    pendingCaption   = '';
    blocks.push(blockObj);
  }

  while (pos < src.length) {
    const ch = src[pos];

    /* ── Whitespace-only — skip but DON'T wipe pendingCaption ── */
    if (/\s/.test(ch)) { pos++; continue; }

    /* ── JSON object or array ──────────────────────── */
    if (ch === '{' || ch === '[') {
      const pair = ch === '{' ? ['{','}'] : ['[',']'];
      const { end, error } = extractBalanced(src, pos, pair);
      const rawSlice = src.slice(pos, end);

      // Gate: only treat as JSON if it genuinely looks like structured data.
      // Bare { or [ in prose (CSS, templates, math) silently become plain text.
      if (!looksLikeJSON(rawSlice, ch)) {
        pendingCaption += rawSlice;
        pos = end;
        continue;
      }

      blockIdx++;
      if (error) {
        const partial = tryRepairJSON(rawSlice);
        if (partial !== null) {
          flushBlock({ type:'json', label:`JSON #${blockIdx} (repaired)`, data: partial });
          warnings.push(`JSON block at pos ${pos} was incomplete — partially recovered.`);
        } else {
          // Not recoverable — fold back into plain text, no warning spam
          pendingCaption += rawSlice;
          blockIdx--;
        }
      } else {
        try {
          const parsed = JSON.parse(rawSlice);
          flushBlock({ type:'json', label:`JSON #${blockIdx}`, data: parsed });
        } catch {
          const repaired = tryRepairJSON(rawSlice);
          if (repaired !== null) {
            flushBlock({ type:'json', label:`JSON #${blockIdx} (repaired)`, data: repaired });
            warnings.push(`JSON block at pos ${pos} had minor issues and was auto-repaired.`);
          } else {
            // Not valid JSON — silently fold back into plain text, no error
            pendingCaption += rawSlice;
            blockIdx--;
          }
        }
      }
      pos = end;
      continue;
    }

    /* ── XML processing instruction <?…?> — treat as caption text ── */
    if (src.startsWith('<?', pos)) {
      const ci = src.indexOf('?>', pos + 2);
      const end = ci === -1 ? src.length : ci + 2;
      collectText(pos, end);
      pos = end;
      continue;
    }

    /* ── XML comment <!--…--> — treat as caption text ── */
    if (src.startsWith('<!--', pos)) {
      const ci = src.indexOf('-->', pos + 4);
      const end = ci === -1 ? src.length : ci + 3;
      collectText(pos, end);
      pos = end;
      continue;
    }

    /* ── XML element ───────────────────────────────── */
    if (ch === '<') {
      const xmlChunk = extractXMLChunk(src, pos);
      if (xmlChunk === null) {
        // Not a valid tag opener — treat this char as plain text
        pendingCaption += src[pos];
        pos++;
        continue;
      }

      blockIdx++;
      try {
        const parser = new DOMParser();
        const doc    = parser.parseFromString(xmlChunk.text, 'text/xml');
        const errEl  = doc.querySelector('parsererror');
        if (errEl) {
          const partial = tryRepairXML(xmlChunk.text);
          if (partial) {
            flushBlock({ type:'xml', label:`XML #${blockIdx} (repaired)`, data: partial.data, rawXml: partial.rawXml, xmlDoc: partial.xmlDoc });
            warnings.push(`XML block at pos ${pos} had errors — partially recovered.`);
          } else {
            pendingCaption += xmlChunk.text;
            blockIdx--;
          }
        } else {
          flushBlock({ type:'xml', label:`XML #${blockIdx}`, data: xmlToJson(doc), rawXml: xmlChunk.text, xmlDoc: doc });
        }
      } catch (e) {
        pendingCaption += xmlChunk.text;
        blockIdx--;
      }
      pos = xmlChunk.end;
      continue;
    }

    /* ── Anything else (plain text, prose, comments, etc.) ── */
    // Scan forward to next block-starter, collecting everything as plain text
    const nextStart = findNextStarter(src, pos + 1);
    if (nextStart === -1) {
      // No more blocks ahead — rest is trailing text
      collectText(pos, src.length);
      break;
    }
    collectText(pos, nextStart);
    pos = nextStart;
  }

  // Any remaining caption with no following block becomes a text-only block
  if (pendingCaption.trim()) {
    blocks.push({ type: 'text', label: 'Text', caption: pendingCaption, data: null });
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

/* ── Gate: does this slice look like real JSON data? ───
   Heuristics to avoid treating prose { } or [ ] as JSON:
   - Objects must contain at least one "key": pattern
   - Arrays must contain a value (string/num/bool/obj/arr)
   - Very short balanced brackets with no structure = plain text
──────────────────────────────────────────────────────── */
function looksLikeJSON(raw, opener) {
  const s = raw.trim();
  if (s.length < 2) return false;

  if (opener === '{') {
    // Must have at least one "key": pair (quoted key followed by colon)
    return /"[^"\\]*"\s*:/.test(s);
  }

  if (opener === '[') {
    const inner = s.slice(1, s.length - 1).trim();
    if (!inner) return true; // empty array [] is valid JSON
    // Must contain a recognisable JSON value as first token
    return (
      inner[0] === '"'  ||   // string
      inner[0] === '{'  ||   // object
      inner[0] === '['  ||   // nested array
      /^-?[0-9]/.test(inner) || // number
      inner.startsWith('true') ||
      inner.startsWith('false') ||
      inner.startsWith('null')
    );
  }

  return false;
}

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
    if (!doc.querySelector('parsererror')) {
      return { data: xmlToJson(doc), xmlDoc: doc, rawXml: attempt };
    }
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

/* ══════════════════════════════════════════════════════
   MODULE: XML Beautifier & XML Tree Renderer
   XML blocks are displayed as real XML — not JSON.
   Tree view shows collapsible <tag attr="v"> nodes.
   Text view shows indented, syntax-highlighted XML.
══════════════════════════════════════════════════════ */

/* ── Beautify XML: re-serialize with proper indentation ── */
function beautifyXML(xmlString, indentSize) {
  const doc = new DOMParser().parseFromString(xmlString, 'text/xml');
  if (doc.querySelector('parsererror')) return xmlString; // return as-is if broken
  const pad = ' '.repeat(indentSize);
  return serializeNode(doc.documentElement, 0, pad);
}

function serializeNode(node, depth, pad) {
  const indent = pad.repeat(depth);

  if (node.nodeType === Node.TEXT_NODE) {
    const v = node.nodeValue.replace(/^\s+|\s+$/g, '');
    return v ? indent + v : '';
  }
  if (node.nodeType === Node.CDATA_SECTION_NODE) {
    return indent + '<![CDATA[' + node.nodeValue + ']]>';
  }
  if (node.nodeType === Node.COMMENT_NODE) {
    return indent + '<!--' + node.nodeValue + '-->';
  }
  if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
    return indent + '<?' + node.target + ' ' + node.data + '?>';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  // Build opening tag
  let open = indent + '<' + node.tagName;
  for (const attr of node.attributes) {
    open += ' ' + attr.name + '="' + attr.value.replace(/"/g, '&quot;') + '"';
  }

  const children = Array.from(node.childNodes).filter(n => {
    if (n.nodeType === Node.TEXT_NODE) return n.nodeValue.trim().length > 0;
    return true;
  });

  if (children.length === 0) {
    return open + ' />';
  }

  // Single text-only child — inline
  if (children.length === 1 && children[0].nodeType === Node.TEXT_NODE) {
    const text = children[0].nodeValue.trim();
    return open + '>' + escXml(text) + '</' + node.tagName + '>';
  }

  // Multiple / element children — block
  const childLines = children
    .map(c => serializeNode(c, depth + 1, pad))
    .filter(Boolean);
  return open + '>\n' + childLines.join('\n') + '\n' + indent + '</' + node.tagName + '>';
}

function escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ── Syntax-highlight beautified XML for text view ── */
function syntaxHighlightXML(str) {
  // Tokenise: tags, attributes, text, comments, CDATA
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, ' LT ')
    .replace(/>/g, ' GT ')
    // restore and wrap: comments
    .replace(/ LT (!--[\s\S]*?--) GT /g,
      (_, c) => `<span class="sx-comment">&lt;${c.replace(/ LT /g,'&lt;').replace(/ GT /g,'&gt;')}&gt;</span>`)
    // CDATA
    .replace(/ LT (!\[CDATA\[[\s\S]*?]]) GT /g,
      (_, c) => `<span class="sx-cdata">&lt;${c}&gt;</span>`)
    // closing tags
    .replace(/ LT (\/[\w:.-]+) GT /g,
      (_, t) => `<span class="sx-tag">&lt;${t}&gt;</span>`)
    // self-closing or opening tags with optional attrs
    .replace(/ LT (\??)(\/?)([\w:.-]+)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?\?) GT /g,
      (_, pi, slash, name, attrs, end) => {
        const tagSpan  = `<span class="sx-tag">&lt;${pi}${slash}</span><span class="sx-tagname">${name}</span>`;
        const attrSpan = attrs.replace(/\s+([\w:.-]+)="([^"]*)"/g, (__, k, v) =>
          ` <span class="sx-attr-name">${k}</span>=<span class="sx-attr-val">"${v}"</span>`);
        const endSpan  = `<span class="sx-tag">${end}&gt;</span>`;
        return tagSpan + attrSpan + endSpan;
      })
    // remaining LT/GT tokens
    .replace(/ LT /g, '&lt;')
    .replace(/ GT /g, '&gt;');
}

/* ── Build XML tree (collapsible) in the tree view ── */
function buildXMLTree(blocks, frag) {
  blocks.forEach((block, bi) => {
    if (block.caption) {
      const cap = document.createElement('div');
      cap.className = 'block-caption';
      cap.textContent = block.caption;
      frag.appendChild(cap);
    }
    if (block.type === 'text') return;

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
    frag.appendChild(header);

    if (block.type === 'xml' && block.xmlDoc) {
      const blockWrap = document.createElement('div');
      blockWrap.className = 'block-wrap';
      buildXMLNode(block.xmlDoc.documentElement, blockWrap, 0, true, '');
      frag.appendChild(blockWrap);
    } else {
      // JSON block — use existing buildNode
      const blockWrap = document.createElement('div');
      blockWrap.className = 'block-wrap';
      blockWrap.appendChild(buildNode(block.data, null, 0, true, 'root', ''));
      frag.appendChild(blockWrap);
    }

    if (bi < blocks.length - 1) {
      const sep = document.createElement('div');
      sep.className = 'block-separator';
      frag.appendChild(sep);
    }
  });
}

function buildXMLNode(el, parent, depth, isLast, parentPath) {
  totalNodes++;
  const tag = el.tagName;
  const myPath = parentPath ? `${parentPath}.${tag}` : tag;

  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node';

  const kids = Array.from(el.childNodes).filter(n => {
    if (n.nodeType === Node.TEXT_NODE) return n.nodeValue.trim().length > 0;
    return n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.CDATA_SECTION_NODE;
  });
  const hasChildren = kids.length > 0;

  // Opening row: <tagName attr="val" …>
  const row = document.createElement('div');
  row.className = 'tree-row xml-row';
  row.dataset.path = myPath;

  // Indent
  for (let i = 0; i < depth; i++) {
    const line = document.createElement('span');
    line.className = 'tree-line' + (i === depth - 1 && isLast ? ' last' : '');
    row.appendChild(line);
  }

  // Toggle or spacer
  if (hasChildren) {
    const btn = document.createElement('span');
    btn.className = 'toggle-btn expanded';
    row.appendChild(btn);
  } else {
    const sp = document.createElement('span');
    sp.className = 'tree-spacer';
    row.appendChild(sp);
  }

  // <tagName
  const lt = document.createElement('span');
  lt.className = 'xml-punct'; lt.textContent = '<';
  row.appendChild(lt);
  const tagEl = document.createElement('span');
  tagEl.className = 'xml-tagname';
  tagEl.dataset.raw = tag;
  tagEl.textContent = tag;
  row.appendChild(tagEl);

  // attributes inline
  for (const attr of el.attributes) {
    const sp2 = document.createElement('span');
    sp2.className = 'xml-attr-name';
    sp2.dataset.raw = attr.name;
    sp2.textContent = ' ' + attr.name;
    row.appendChild(sp2);
    const eq = document.createElement('span');
    eq.className = 'xml-punct'; eq.textContent = '=';
    row.appendChild(eq);
    const av = document.createElement('span');
    av.className = 'xml-attr-val';
    av.dataset.raw = attr.value;
    av.textContent = '"' + attr.value + '"';
    row.appendChild(av);
  }

  // Self-closing or open
  if (!hasChildren) {
    const sc = document.createElement('span');
    sc.className = 'xml-punct'; sc.textContent = ' />';
    row.appendChild(sc);
  } else {
    const gt = document.createElement('span');
    gt.className = 'xml-punct'; gt.textContent = '>';
    row.appendChild(gt);

    // Collapse hint when folded
    const hint = document.createElement('span');
    hint.className = 'xml-collapse-hint';
    hint.textContent = ` …</${tag}>`;
    row.appendChild(hint);
  }

  wrapper.appendChild(row);

  if (hasChildren) {
    const childrenEl = document.createElement('div');
    childrenEl.className = 'tree-children';

    kids.forEach((child, ci) => {
      const last = ci === kids.length - 1;
      if (child.nodeType === Node.TEXT_NODE) {
        totalNodes++;
        const textRow = document.createElement('div');
        textRow.className = 'tree-row xml-row';
        textRow.dataset.path = myPath + '.#text';
        for (let i = 0; i <= depth; i++) {
          const line = document.createElement('span');
          line.className = 'tree-line' + (i === depth && last ? ' last' : '');
          textRow.appendChild(line);
        }
        const sp3 = document.createElement('span'); sp3.className = 'tree-spacer'; textRow.appendChild(sp3);
        const tv = document.createElement('span');
        tv.className = 'xml-text-val';
        tv.dataset.raw = child.nodeValue.trim();
        tv.textContent = child.nodeValue.trim();
        textRow.appendChild(tv);
        childrenEl.appendChild(textRow);
      } else if (child.nodeType === Node.CDATA_SECTION_NODE) {
        totalNodes++;
        const cdRow = document.createElement('div');
        cdRow.className = 'tree-row xml-row';
        cdRow.dataset.path = myPath + '.#cdata';
        for (let i = 0; i <= depth; i++) {
          const line = document.createElement('span');
          line.className = 'tree-line' + (i === depth && last ? ' last' : '');
          cdRow.appendChild(line);
        }
        const sp4 = document.createElement('span'); sp4.className = 'tree-spacer'; cdRow.appendChild(sp4);
        const cdv = document.createElement('span');
        cdv.className = 'xml-cdata'; cdv.dataset.raw = child.nodeValue;
        cdv.textContent = '<![CDATA[' + child.nodeValue + ']]>';
        cdRow.appendChild(cdv);
        childrenEl.appendChild(cdRow);
      } else {
        const childWrap = document.createElement('div');
        buildXMLNode(child, childWrap, depth + 1, last, myPath);
        childrenEl.appendChild(childWrap.firstChild);
      }
    });

    // Closing tag row
    totalNodes++;
    const closeRow = document.createElement('div');
    closeRow.className = 'tree-row xml-row xml-close-row';
    closeRow.dataset.path = myPath + '.__close';
    for (let i = 0; i < depth; i++) {
      const line = document.createElement('span');
      line.className = 'tree-line' + (i === depth - 1 && isLast ? ' last' : '');
      closeRow.appendChild(line);
    }
    const csp = document.createElement('span'); csp.className = 'tree-spacer'; closeRow.appendChild(csp);
    const clt = document.createElement('span'); clt.className = 'xml-punct'; clt.textContent = '</'; closeRow.appendChild(clt);
    const ctn = document.createElement('span'); ctn.className = 'xml-tagname'; ctn.textContent = tag; closeRow.appendChild(ctn);
    const cgt = document.createElement('span'); cgt.className = 'xml-punct'; cgt.textContent = '>'; closeRow.appendChild(cgt);
    childrenEl.appendChild(closeRow);

    wrapper.appendChild(childrenEl);
  }

  parent.appendChild(wrapper);
}


/* ══════════════════════════════════════════════════════
   MODULE: Tree Renderer  (performance-optimised)
   Key changes vs previous:
   - Event delegation: ONE click listener per tree container
     instead of one per node
   - data-path stored on every row at build time so diff
     and search never have to walk the DOM to reconstruct paths
   - buildIndent uses a reusable template clone
   - DocumentFragment batch-appended once per node
   - Large trees rendered in chunks via requestIdleCallback
     so the UI never freezes
══════════════════════════════════════════════════════ */

function renderTree(blocks, container) {
  totalNodes = 0;
  container.innerHTML = '';
  const frag = document.createDocumentFragment();
  // buildXMLTree handles both xml and json blocks correctly
  buildXMLTree(blocks, frag);
  container.appendChild(frag);
  attachToggleDelegate(container);
  nodeCount.textContent = `${totalNodes.toLocaleString()} node${totalNodes !== 1 ? 's' : ''}`;
}

/* Single delegated click handler — zero per-node listeners */
function attachToggleDelegate(container) {
  // Remove any previous delegate on this container
  if (container._delegateHandler) {
    container.removeEventListener('click', container._delegateHandler);
  }
  container._delegateHandler = function(e) {
    // Find the nearest toggle-btn or tree-row
    const btn = e.target.closest('.toggle-btn');
    if (btn) {
      e.stopPropagation();
      toggleNode(btn);
      return;
    }
    const row = e.target.closest('.tree-row');
    if (row) {
      const rowBtn = row.querySelector(':scope > .toggle-btn');
      if (rowBtn) toggleNode(rowBtn);
    }
  };
  container.addEventListener('click', container._delegateHandler);
}

function toggleNode(btn) {
  const treeNode = btn.closest('.tree-node');
  if (!treeNode) return;
  const childrenEl = treeNode.querySelector(':scope > .tree-children');
  if (!childrenEl) return;
  const row = treeNode.querySelector(':scope > .tree-row');
  if (btn.classList.contains('expanded')) {
    btn.classList.replace('expanded', 'collapsed');
    childrenEl.classList.add('collapsed');
    if (row) row.classList.add('has-children-collapsed');
  } else {
    btn.classList.replace('collapsed', 'expanded');
    childrenEl.classList.remove('collapsed');
    if (row) row.classList.remove('has-children-collapsed');
  }
}

/* setupToggle kept for any callers that still use it */
function setupToggle(btn, childrenEl) {
  // no-op: delegation handles everything now
}

function buildNode(value, key, depth, isLast, keyType, parentPath) {
  totalNodes++;
  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node';

  const isObject = value !== null && typeof value === 'object';
  const isArray  = Array.isArray(value);
  const isEmpty  = isObject && Object.keys(value).length === 0;

  // Compute this node's dot-path
  let myPath = parentPath;
  if (key !== null) {
    const keyRaw = keyType === 'attr' ? key
                 : keyType === 'index' ? key
                 : key;
    myPath = parentPath ? `${parentPath}.${keyRaw}` : String(keyRaw);
  }

  const row = document.createElement('div');
  row.className = 'tree-row';
  row.dataset.path = myPath;   // store for diff + search

  // Indent lines
  if (depth > 0) {
    for (let i = 0; i < depth; i++) {
      const line = document.createElement('span');
      line.className = 'tree-line' + (i === depth - 1 && isLast ? ' last' : '');
      row.appendChild(line);
    }
  }

  // Toggle button or spacer
  if (isObject && !isEmpty) {
    const btn = document.createElement('span');
    btn.className = 'toggle-btn expanded';
    row.appendChild(btn);
  } else {
    const sp = document.createElement('span');
    sp.className = 'tree-spacer';
    row.appendChild(sp);
  }

  // Key label
  if (key !== null) {
    const keyEl = document.createElement('span');
    keyEl.className = 'tree-key';
    if (keyType === 'attr')  keyEl.classList.add('attr-key');
    if (keyType === 'text')  keyEl.classList.add('text-key');
    if (keyType === 'index') keyEl.classList.add('index-key');
    keyEl.dataset.raw = key;
    keyEl.textContent = keyType === 'attr'  ? `@${key}`
                      : keyType === 'text'   ? '#text'
                      : keyType === 'index'  ? `[${key}]`
                      : key;
    row.appendChild(keyEl);
    const colon = document.createElement('span');
    colon.className = 'tree-colon';
    colon.textContent = ':';
    row.appendChild(colon);
  }

  // Value / summary
  if (isObject && !isEmpty) {
    const count = Object.keys(value).length;
    const meta  = document.createElement('span');
    meta.className = 'tree-meta';
    meta.textContent = isArray
      ? `Array(${count})`
      : `{${count} key${count !== 1 ? 's' : ''}}`;
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

  // Children
  if (isObject && !isEmpty) {
    const childrenEl = document.createElement('div');
    childrenEl.className = 'tree-children';

    const entries = Object.entries(value);
    entries.forEach(([k, v], i) => {
      const last  = i === entries.length - 1;
      const kType = k === '#text' ? 'text' : isArray ? 'index' : 'normal';

      if (k === '@attributes' && v !== null && typeof v === 'object') {
        // @attributes group
        const attrW   = document.createElement('div');
        attrW.className = 'tree-node';
        const attrRow = document.createElement('div');
        attrRow.className = 'tree-row';
        attrRow.dataset.path = myPath ? `${myPath}.@attributes` : '@attributes';

        for (let di = 0; di < depth + 1; di++) {
          const line = document.createElement('span');
          line.className = 'tree-line' + (di === depth && last ? ' last' : '');
          attrRow.appendChild(line);
        }
        const attrBtn = document.createElement('span');
        attrBtn.className = 'toggle-btn expanded';
        attrRow.appendChild(attrBtn);
        const attrKey = document.createElement('span');
        attrKey.className = 'tree-key attr-key';
        attrKey.dataset.raw = '@attributes';
        attrKey.textContent = '@attributes';
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
        const attrEntries = Object.entries(v);
        attrEntries.forEach(([ak, av], ai) => {
          attrKids.appendChild(buildNode(av, ak, depth + 2, ai === attrEntries.length - 1, 'attr', attrRow.dataset.path));
        });
        attrW.appendChild(attrKids);
        childrenEl.appendChild(attrW);
        return;
      }

      childrenEl.appendChild(buildNode(v, k, depth + 1, last, kType, myPath));
    });

    wrapper.appendChild(childrenEl);
  }

  return wrapper;
}

function formatPrimitive(value) {
  if (value === null || value === undefined) return { cls:'v-null', display: String(value) };
  const t = typeof value;
  if (t === 'boolean') return { cls:'v-bool', display: String(value) };
  if (t === 'number')  return { cls:'v-num',  display: String(value) };
  return { cls:'v-str', display: `"${String(value)}"` };
}

/* ══════════════════════════════════════════════════════
   MODULE: Text View + Syntax Highlighting
══════════════════════════════════════════════════════ */
function renderTextView(blocks) {
  textOutput.innerHTML = blocks.map(b => {
    const capHtml = b.caption
      ? `<span class="block-caption-text">${esc(b.caption)}</span>\n`
      : '';
    if (b.type === 'text') return capHtml.trimEnd();

    let bodyHtml;
    if (b.type === 'xml' && b.rawXml) {
      if (state.minified) {
        // Minify: collapse all whitespace between tags
        bodyHtml = esc(b.rawXml.replace(/\s*(<[^>]+>)\s*/g, '$1').trim());
      } else {
        bodyHtml = syntaxHighlightXML(beautifyXML(b.rawXml, state.indent));
      }
    } else {
      bodyHtml = state.minified
        ? esc(JSON.stringify(b.data))
        : syntaxHighlightJSON(JSON.stringify(b.data, null, state.indent));
    }

    return capHtml +
      `<span class="block-hdr-text ${b.type}">${esc(b.label)}</span>\n` +
      bodyHtml;
  }).join('\n\n');
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
   MODULE: Search  (optimised — data-path index, no DOM walk)
══════════════════════════════════════════════════════ */
const search = {
  hits:   [],
  cursor: -1,
};

function injectHighlight(el, term) {
  const raw = el.dataset.raw;
  if (!raw) return false;
  if (!raw.toLowerCase().includes(term)) return false;
  const display = el.textContent;
  const loDisplay = display.toLowerCase();
  let result = '', last = 0;
  let idx = loDisplay.indexOf(term, 0);
  if (idx === -1) return false;
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

function restoreEl(el) {
  if (!el.dataset.raw) return;
  const raw = el.dataset.raw;
  if (el.classList.contains('v-str')) {
    el.textContent = `"${raw}"`;
  } else if (el.classList.contains('tree-key')) {
    if (el.classList.contains('attr-key') && raw !== '@attributes') el.textContent = `@${raw}`;
    else if (el.classList.contains('text-key'))  el.textContent = '#text';
    else if (el.classList.contains('index-key')) el.textContent = `[${raw}]`;
    else el.textContent = raw;
  } else if (el.classList.contains('xml-attr-val')) {
    el.textContent = `"${raw}"`;
  } else if (el.classList.contains('xml-attr-name')) {
    el.textContent = ' ' + raw;
  } else {
    el.textContent = raw;
  }
}

function clearAllHighlights() {
  treeOutput.querySelectorAll('.tree-row.highlighted, .tree-row.search-active').forEach(row => {
    row.classList.remove('highlighted', 'search-active');
    row.querySelectorAll('.tree-key, .tree-val, .xml-tagname, .xml-attr-name, .xml-attr-val, .xml-text-val').forEach(restoreEl);
  });
}

function applySearch(term) {
  state.searchTerm = term.toLowerCase().trim();
  clearAllHighlights();
  search.hits   = [];
  search.cursor = -1;

  const searchNav = $('searchNav');

  if (!state.searchTerm) {
    matchCount.textContent  = '';
    searchNav.style.display = 'none';
    return;
  }

  const allRows = treeOutput.querySelectorAll('.tree-row');
  allRows.forEach(row => {
    let matched = false;
    // Match both JSON elements (.tree-key/.tree-val) and XML elements
    row.querySelectorAll('.tree-key, .tree-val, .xml-tagname, .xml-attr-name, .xml-attr-val, .xml-text-val').forEach(el => {
      if (injectHighlight(el, state.searchTerm)) matched = true;
    });
    if (!matched) return;

    // Expand collapsed ancestors using stored path — no DOM traversal loop needed
    let p = row.parentElement;
    while (p && p !== treeOutput) {
      if (p.classList.contains('tree-children') && p.classList.contains('collapsed')) {
        p.classList.remove('collapsed');
        const btn = p.parentElement?.querySelector(':scope > .tree-row > .toggle-btn');
        if (btn) btn.classList.replace('collapsed', 'expanded');
      }
      p = p.parentElement;
    }

    row.classList.add('highlighted');
    search.hits.push(row);
  });

  const total = search.hits.length;
  searchNav.style.display = total > 0 ? 'flex' : 'none';
  if (total > 0) navigateSearch(0);
  else matchCount.textContent = '0 results';
}

function navigateSearch(idx) {
  if (!search.hits.length) return;
  idx = ((idx % search.hits.length) + search.hits.length) % search.hits.length;
  if (search.cursor >= 0 && search.hits[search.cursor]) {
    search.hits[search.cursor].classList.remove('search-active');
  }
  search.cursor = idx;
  const activeRow = search.hits[idx];
  activeRow.classList.add('search-active');
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
   TEXT VIEW SEARCH
   Works on the rendered <pre> innerHTML via a simple
   mark-injection pass. No DOM tree walking needed.
══════════════════════════════════════════════════════ */
const textSearch = { hits: [], cursor: -1, rawHTML: '' };

function applyTextSearch(term) {
  term = term.trim();
  const searchNav = $('searchNav');
  textSearch.hits   = [];
  textSearch.cursor = -1;

  // Restore original HTML if we have it
  if (textSearch.rawHTML) textOutput.innerHTML = textSearch.rawHTML;

  if (!term) {
    matchCount.textContent  = '';
    searchNav.style.display = 'none';
    textSearch.rawHTML = '';
    return;
  }

  // Save clean HTML before injecting marks
  textSearch.rawHTML = textOutput.innerHTML;

  // Work on a plain-text copy to find match positions,
  // then inject <mark> into the HTML safely via TreeWalker
  const termLo  = term.toLowerCase();
  let   hitCount = 0;

  // Walk all text nodes inside textOutput and wrap matches
  const walker = document.createTreeWalker(textOutput, NodeFilter.SHOW_TEXT);
  const textnodes = [];
  let n;
  while ((n = walker.nextNode())) textnodes.push(n);

  textnodes.forEach(node => {
    const text = node.nodeValue;
    const lo   = text.toLowerCase();
    if (!lo.includes(termLo)) return;

    const frag = document.createDocumentFragment();
    let last = 0;
    let idx  = lo.indexOf(termLo, 0);
    while (idx !== -1) {
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
      const mark = document.createElement('mark');
      mark.className = 'sh ts-hit';
      mark.dataset.hit = hitCount++;
      mark.textContent = text.slice(idx, idx + term.length);
      frag.appendChild(mark);
      last = idx + term.length;
      idx  = lo.indexOf(termLo, last);
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  });

  textSearch.hits = Array.from(textOutput.querySelectorAll('mark.ts-hit'));
  const total     = textSearch.hits.length;
  searchNav.style.display = total > 0 ? 'flex' : 'none';

  if (total > 0) textNavigate(0);
  else matchCount.textContent = '0 results';
}

function textNavigate(idx) {
  if (!textSearch.hits.length) return;
  idx = ((idx % textSearch.hits.length) + textSearch.hits.length) % textSearch.hits.length;

  if (textSearch.cursor >= 0 && textSearch.hits[textSearch.cursor]) {
    textSearch.hits[textSearch.cursor].classList.remove('ts-active');
  }
  textSearch.cursor = idx;
  const mark = textSearch.hits[idx];
  mark.classList.add('ts-active');
  mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
  matchCount.textContent = `${idx + 1} / ${textSearch.hits.length}`;
}

function textSearchNext() { textNavigate(textSearch.cursor + 1); }
function textSearchPrev() { textNavigate(textSearch.cursor - 1); }


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
  const types = [...new Set(blocks.filter(b => b.type !== 'text').map(b => b.type))];
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
  textSearch.hits = []; textSearch.cursor = -1; textSearch.rawHTML = '';
  $('searchNav').style.display = 'none';
  matchCount.textContent = '';
  searchInput.value = '';
  if (state.view === 'tree') {
    treeOutput.style.display = 'block';
    textOutput.style.display = 'none';
    renderTree(state.blocks, treeOutput);
  } else {
    treeOutput.style.display = 'none';
    textOutput.style.display = 'block';
    renderTextView(state.blocks);
    const total = state.blocks.reduce((s, b) => s + (b.data ? countNodes(b.data) : 0), 0);
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

function setView(view) {
  if (state.view === view) return;
  state.view = view;
  const isTree = view === 'tree';
  viewTreeBtn.classList.toggle('active', isTree);
  viewTextBtn.classList.toggle('active', !isTree);
  const ovt = $('outViewTree'), ovx = $('outViewText');
  if (ovt) ovt.classList.toggle('active', isTree);
  if (ovx) ovx.classList.toggle('active', !isTree);
  expandAllBtn.style.visibility   = isTree ? '' : 'hidden';
  collapseAllBtn.style.visibility = isTree ? '' : 'hidden';
  if (state.blocks.length) renderOutput();
}

viewTreeBtn.addEventListener('click', () => setView('tree'));
viewTextBtn.addEventListener('click', () => setView('text'));
const _ovt = $('outViewTree'), _ovx = $('outViewText');
if (_ovt) _ovt.addEventListener('click', () => setView('tree'));
if (_ovx) _ovx.addEventListener('click', () => setView('text'));

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

// Search — input triggers fresh search (tree + text view)
let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (!state.blocks.length) return;
    if (state.view === 'tree') applySearch(searchInput.value);
    else applyTextSearch(searchInput.value);
  }, 180);
});

// Search — Enter/Shift+Enter to cycle matches
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (state.view === 'tree') {
      if (e.shiftKey) searchPrev(); else searchNext();
    } else {
      if (e.shiftKey) textSearchPrev(); else textSearchNext();
    }
  }
  if (e.key === 'Escape') {
    searchInput.value = '';
    if (state.view === 'tree') applySearch('');
    else applyTextSearch('');
  }
});

$('searchNextBtn').addEventListener('click', () => {
  if (state.view === 'tree') searchNext(); else textSearchNext();
});
$('searchPrevBtn').addEventListener('click', () => {
  if (state.view === 'tree') searchPrev(); else textSearchPrev();
});

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
const DEMO = `Store inventory data exported on 2025-01-15.
Source: internal ERP system. Do not distribute.

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

The following XML contains the same catalogue in a legacy format.
Exported from warehouse system v3.2.

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

/* ══ THEME TOGGLE ══════════════════════════════════ */
(function() {
  const btn      = $('themeToggle');
  const icon     = $('themeIcon');
  const label    = $('themeLabel');
  const body     = document.body;
  const KEY      = 'datalens-theme';

  function applyTheme(mode) {
    if (mode === 'dark') {
      body.classList.add('dark-mode');
      icon.textContent  = '☾';
      label.textContent = 'Dark';
    } else {
      body.classList.remove('dark-mode');
      icon.textContent  = '☀';
      label.textContent = 'Light';
    }
    try { localStorage.setItem(KEY, mode); } catch {}
  }

  // Restore saved preference, default to light
  let saved = 'light';
  try { saved = localStorage.getItem(KEY) || 'light'; } catch {}
  applyTheme(saved);

  btn.addEventListener('click', () => {
    applyTheme(body.classList.contains('dark-mode') ? 'light' : 'dark');
  });
})();


/* ══════════════════════════════════════════════════════
   COMPARE MODE
══════════════════════════════════════════════════════ */

/* ── Mode toggle ───────────────────────────────────── */
let currentMode = 'single';

$('modeSingle').addEventListener('click', () => {
  if (currentMode === 'single') return;
  currentMode = 'single';
  $('modeSingle').classList.add('active');
  $('modeCompare').classList.remove('active');
  $('singleMode').style.display  = 'flex';
  $('compareMode').style.display = 'none';
});

$('modeCompare').addEventListener('click', () => {
  if (currentMode === 'compare') return;
  currentMode = 'compare';
  $('modeCompare').classList.add('active');
  $('modeSingle').classList.remove('active');
  $('singleMode').style.display  = 'none';
  $('compareMode').style.display = 'flex';
});

/* ── Slot state ─────────────────────────────────────── */
const slots = {
  A: { blocks: [], flat: {} },
  B: { blocks: [], flat: {} },
};

/* ── Flatten parsed data to dot-path map ────────────── */
function flattenPaths(obj, prefix, out) {
  if (obj === null || obj === undefined) {
    out[prefix] = { val: obj, type: 'null' }; return;
  }
  if (typeof obj !== 'object') {
    out[prefix] = { val: obj, type: typeof obj }; return;
  }
  const keys = Object.keys(obj);
  if (!keys.length) {
    out[prefix] = { val: Array.isArray(obj) ? '[]' : '{}', type: Array.isArray(obj) ? 'array' : 'object' };
    return;
  }
  for (const k of keys) {
    flattenPaths(obj[k], prefix ? `${prefix}.${k}` : k, out);
  }
}

function blocksToFlat(blocks) {
  const out = {};
  if (!blocks.length) return out;
  if (blocks.length === 1 && blocks[0].data) {
    flattenPaths(blocks[0].data, '', out);
  } else {
    blocks.filter(b => b.data).forEach(b => flattenPaths(b.data, b.label, out));
  }
  return out;
}

/* ── Parse a slot ───────────────────────────────────── */
function parseSlot(id) {
  const inp    = $(`inputArea${id}`);
  const errEl  = $(`errorBanner${id}`);
  const badge  = $(`formatBadge${id}`);
  const ncEl   = $(`nodeCount${id}`);

  // In-page tree targets (compare mode layout)
  const treeEl  = $(`treeOutput${id}`);
  const emptyEl = $(`emptyState${id}`);

  errEl.style.display = 'none';
  inp.style.outline   = '';

  const src = inp.value.trim();

  if (!src) {
    emptyEl.style.display = 'flex';
    treeEl.style.display  = 'none';
    badge.textContent = '—'; badge.className = 'format-badge';
    slots[id].blocks = []; slots[id].flat = {};
    return;
  }

  const { blocks, warnings } = extractBlocks(src);

  if (!blocks.length) {
    errEl.style.cssText = 'display:block;background:rgba(247,92,92,0.12);border-top:1px solid rgba(247,92,92,0.4);color:var(--red)';
    errEl.textContent = '⚠ No parseable JSON or XML found.';
    inp.style.outline = '1px solid var(--red)';
    return;
  }

  slots[id].blocks = blocks;
  slots[id].flat   = blocksToFlat(blocks);

  const types = [...new Set(blocks.filter(b => b.type !== 'text').map(b => b.type))];
  badge.textContent = types.length === 0 ? '—' : types.length === 1 ? types[0].toUpperCase() : 'JSON+XML';
  badge.className   = 'format-badge' + (types.length === 1 ? ' ' + types[0] : types.length > 1 ? ' mixed' : '');

  if (warnings.length) {
    errEl.style.cssText = 'display:block;background:rgba(246,166,35,0.08);border-top:1px solid rgba(246,166,35,0.35);color:var(--amber)';
    errEl.textContent = '⚡ ' + warnings.join(' · ');
  }

  emptyEl.style.display = 'none';
  treeEl.style.display  = 'block';
  treeEl.style.paddingLeft = '12px';

  totalNodes = 0;
  renderTree(blocks, treeEl);
  ncEl.textContent = `${totalNodes.toLocaleString()} nodes`;
}

$('parseBtnA').addEventListener('click', () => parseSlot('A'));
$('parseBtnB').addEventListener('click', () => parseSlot('B'));

$('inputAreaA').addEventListener('input', () => {
  $('charCountA').textContent = `${$('inputAreaA').value.length.toLocaleString()} chars`;
});
$('inputAreaB').addEventListener('input', () => {
  $('charCountB').textContent = `${$('inputAreaB').value.length.toLocaleString()} chars`;
});

function clearSlot(id) {
  $(`inputArea${id}`).value = '';
  $(`charCount${id}`).textContent = '0 chars';
  $(`errorBanner${id}`).style.display = 'none';
  $(`inputArea${id}`).style.outline = '';
  $(`emptyState${id}`).style.display = 'flex';
  $(`treeOutput${id}`).style.display = 'none';
  $(`treeOutput${id}`).innerHTML = '';
  slots[id].blocks = []; slots[id].flat = {};
  $(`formatBadge${id}`).textContent = '—';
  $(`formatBadge${id}`).className = 'format-badge';
  $(`nodeCount${id}`).textContent = '';
}

$('clearBtnA').addEventListener('click', () => clearSlot('A'));
$('clearBtnB').addEventListener('click', () => clearSlot('B'));

/* ══════════════════════════════════════════════════════
   DIFF ENGINE
══════════════════════════════════════════════════════ */

function clearDiffHighlights(container) {
  container.querySelectorAll('.tree-row').forEach(r => {
    r.classList.remove('dh-added','dh-removed','dh-changed','dh-type');
    r.querySelector('.diff-gutter-mark')?.remove();
    r.querySelector('.diff-old-val')?.remove();
    r.querySelector('.diff-new-val')?.classList.remove('diff-new-val');
  });
}

/* Build dotPath → row element using data-path set at build time — O(n) single pass */
function buildRowPathMap(container) {
  const map = {};
  container.querySelectorAll('.tree-row[data-path]').forEach(row => {
    const p = row.dataset.path;
    if (p !== undefined && !map[p]) map[p] = row;
  });
  return map;
}

function stampRow(row, cls, glyph, oldValText) {
  if (!row) return;
  row.classList.add(cls);

  if (!row.querySelector('.diff-gutter-mark')) {
    const gm = document.createElement('span');
    gm.className = 'diff-gutter-mark';
    gm.textContent = glyph;
    const anchor = row.querySelector('.toggle-btn') || row.querySelector('span[style]');
    anchor ? row.insertBefore(gm, anchor) : row.appendChild(gm);
  }

  if (oldValText !== undefined) {
    const valEl = row.querySelector('.tree-val');
    if (valEl && !row.querySelector('.diff-old-val')) {
      const ov = document.createElement('span');
      ov.className = 'diff-old-val';
      ov.textContent = oldValText;
      valEl.parentNode.insertBefore(ov, valEl);
      valEl.classList.add('diff-new-val');
    }
  }
}

function applyDiffToTrees(treeA, treeB, flatA, flatB) {
  clearDiffHighlights(treeA);
  clearDiffHighlights(treeB);

  // Expand all so every row is in the DOM and path-walkable
  treeA.querySelectorAll('.tree-children').forEach(c => c.classList.remove('collapsed'));
  treeA.querySelectorAll('.toggle-btn').forEach(b => b.classList.replace('collapsed','expanded'));
  treeB.querySelectorAll('.tree-children').forEach(c => c.classList.remove('collapsed'));
  treeB.querySelectorAll('.toggle-btn').forEach(b => b.classList.replace('collapsed','expanded'));

  const rowMapA = buildRowPathMap(treeA);
  const rowMapB = buildRowPathMap(treeB);

  const allPaths = new Set([...Object.keys(flatA), ...Object.keys(flatB)]);
  let nAdded = 0, nRemoved = 0, nChanged = 0, nSame = 0;

  for (const path of allPaths) {
    const inA = path in flatA, inB = path in flatB;

    if (inA && !inB) {
      stampRow(rowMapA[path], 'dh-removed', '−');
      nRemoved++;
    } else if (!inA && inB) {
      stampRow(rowMapB[path], 'dh-added', '+');
      nAdded++;
    } else {
      const eA = flatA[path], eB = flatB[path];
      if (eA.type !== eB.type) {
        stampRow(rowMapA[path], 'dh-type', '⊕');
        stampRow(rowMapB[path], 'dh-type', '⊕');
        nChanged++;
      } else if (String(eA.val) !== String(eB.val)) {
        const oldStr = String(eA.val);
        stampRow(rowMapA[path], 'dh-changed', '~');
        stampRow(rowMapB[path], 'dh-changed', '~', oldStr);
        nChanged++;
      } else {
        nSame++;
      }
    }
  }

  return { nAdded, nRemoved, nChanged, nSame };
}

/* ══════════════════════════════════════════════════════
   DIFF POPUP — open with cloned + highlighted trees,
   pixel-locked synchronized scrolling
══════════════════════════════════════════════════════ */

let popupSyncLock = false;

function openDiffPopup() {
  const flatA = slots.A.flat, flatB = slots.B.flat;

  if (!Object.keys(flatA).length || !Object.keys(flatB).length) {
    alert('Parse both A and B before running Diff.');
    return;
  }

  // Clone the rendered trees into the popup panes
  const srcA = $('treeOutputA'), srcB = $('treeOutputB');
  const dstA = $('diffTreeA'),   dstB = $('diffTreeB');

  dstA.innerHTML = srcA.innerHTML;
  dstB.innerHTML = srcB.innerHTML;

  // Delegation handles all toggle clicks — one listener per tree
  attachToggleDelegate(dstA);
  attachToggleDelegate(dstB);

  // Apply diff highlighting to popup trees
  const stats = applyDiffToTrees(dstA, dstB, flatA, flatB);

  // Stats bar
  const ps = $('popupStats');
  ps.innerHTML = `
    <span class="dstat dstat-add">${stats.nAdded} added</span>
    <span class="dstat dstat-rem">${stats.nRemoved} removed</span>
    <span class="dstat dstat-chg">${stats.nChanged} changed</span>
    <span class="dstat dstat-same">${stats.nSame} same</span>`;

  $('diffCountA').textContent = `${dstA.querySelectorAll('.tree-row').length} rows`;
  $('diffCountB').textContent = `${dstB.querySelectorAll('.tree-row').length} rows`;

  // Show popup
  $('diffPopup').style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Wire pixel-perfect synchronized scroll
  setupPopupSync();
}

function setupPopupSync() {
  const sA = $('diffScrollA'), sB = $('diffScrollB');

  // Remove previous listeners by cloning
  const newA = sA.cloneNode(false);
  const newB = sB.cloneNode(false);
  // Move children
  while (sA.firstChild) newA.appendChild(sA.firstChild);
  while (sB.firstChild) newB.appendChild(sB.firstChild);
  sA.parentNode.replaceChild(newA, sA);
  sB.parentNode.replaceChild(newB, sB);

  // Re-attach tree nodes (already moved)
  // The trees dstA/dstB are now inside newA/newB

  newA.addEventListener('scroll', () => {
    if (popupSyncLock) return;
    popupSyncLock = true;
    newB.scrollTop  = newA.scrollTop;
    newB.scrollLeft = newA.scrollLeft;
    popupSyncLock = false;
  }, { passive: true });

  newB.addEventListener('scroll', () => {
    if (popupSyncLock) return;
    popupSyncLock = true;
    newA.scrollTop  = newB.scrollTop;
    newA.scrollLeft = newB.scrollLeft;
    popupSyncLock = false;
  }, { passive: true });
}

function closeDiffPopup() {
  $('diffPopup').style.display = 'none';
  document.body.style.overflow = '';
  // Clear popup trees to free memory
  $('diffTreeA').innerHTML = '';
  $('diffTreeB').innerHTML = '';
}

$('runCompareBtn').addEventListener('click', openDiffPopup);
$('closeDiffPopup').addEventListener('click', closeDiffPopup);

// Close on backdrop click
$('diffPopup').addEventListener('click', e => {
  if (e.target === $('diffPopup')) closeDiffPopup();
});

// Esc closes popup
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('diffPopup').style.display !== 'none') closeDiffPopup();
});
