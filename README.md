# DataLens — JSON & XML Inspector

**Version:** v1.0.3  
**Type:** Pure frontend — no build step, no server, no dependencies  
**Files:** `index.html` · `styles.css` · `script.js`

---

## What is DataLens?

DataLens is a developer tool for inspecting, navigating, and comparing JSON and XML data directly in your browser. Open `index.html` locally — no internet connection required after the Google Fonts request.

It was built for QA engineers, backend developers, and anyone who regularly deals with raw API responses, config files, or data exports and wants something faster and clearer than a plain text editor.

---

## Quick Start

1. Download the three files (`index.html`, `styles.css`, `script.js`) into the same folder
2. Open `index.html` in Chrome, Firefox, Edge, or Safari
3. Paste JSON or XML into the input panel on the left
4. Click **Parse** (or press `Cmd ↵` / `Ctrl ↵`)
5. The formatted, collapsible tree appears on the right

No npm. No build. No server.

---

## Features

### Input & Parsing

| Feature | Detail |
|---|---|
| **Auto-detect format** | Detects JSON (`{` / `[`) or XML (`<`) automatically |
| **Mixed input** | Paste JSON and XML together in one box — both are parsed and rendered |
| **Prose preservation** | Any plain text before a JSON/XML block is kept as a caption above it |
| **Resilient parsing** | Trailing commas, single quotes, incomplete blocks — repaired where possible |
| **Error display** | Clear amber/red banners; never crashes the UI |

### Tree View (default)

The tree renders your data as a fully expanded, collapsible hierarchy.

- **JSON** — objects, arrays, nested keys, all value types (string, number, boolean, null) colour-coded
- **XML** — real XML tree: `<tagName attr="val">` rows with inline attributes, text nodes, CDATA, closing tags
- Click any `−` button (or the row itself) to collapse a node; click `+` to expand
- **Expand All / Collapse All** buttons in the output header

### Text View

Switches the output to a pretty-printed, syntax-highlighted text representation.

- **JSON** — indented JSON with colour-coded keys, strings, numbers, booleans, nulls
- **XML** — beautified XML with tag names, attributes, and text nodes highlighted
- Toggle between **2-space** and **4-space** indentation
- **Minify / Beautify** toggle for compact or readable output

### Search

Works in both Tree and Text view.

| Control | Action |
|---|---|
| Type in the search box | Highlights all matches inline with a yellow `<mark>` |
| `Enter` | Jump to next match |
| `Shift + Enter` | Jump to previous match |
| `Escape` | Clear search |
| `‹` / `›` buttons | Prev / Next (same as keyboard shortcuts) |
| Counter | Shows `2 / 7` style position |

In Tree view, matching rows are highlighted amber; the active match turns blue. Collapsed ancestor nodes are automatically expanded to reveal matches.

In Text view, the TreeWalker walks raw text nodes inside the `<pre>` and wraps matches with `<mark>` — safe and fast even on large outputs.

### Copy & Download

| Button | Action |
|---|---|
| **Copy** | Copies the current output to clipboard with a "Copied!" toast |
| **Download** | Downloads the parsed output as a `.json` file |

### Fullscreen Output

Click the ⤢ expand button in the output panel header (or press `F`) to take the output full-screen. The input panel hides. Press `Escape` or the ⤡ button to exit.

The Tree / Text view toggle and search bar remain accessible in fullscreen.

### Dark / Light Mode

The **☀ Light / ☾ Dark** button in the top-right of the header toggles the output area between a white browser-viewer aesthetic (Light) and a dark developer-tool aesthetic (Dark). Your preference is saved to `localStorage` and restored on next open.

The header/controls always stay dark — only the output area switches.

---

## Compare Mode

Switch to **⇄ Compare** in the header to open two independent input slots side by side.

### How to use

1. Paste your first JSON or XML into the **A** textarea and click **Parse A**
2. Paste your second document into the **B** textarea and click **Parse B**
3. Click the **Diff** button between them

### Diff Popup

A full-screen popup opens showing both parsed trees side by side with all differences highlighted inline.

| Colour | Meaning |
|---|---|
| 🟢 Green left border + `+` | Field exists in B but not in A (added) |
| 🔴 Red left border + `−` | Field exists in A but not in B (removed) |
| 🟡 Amber left border + `~` | Field exists in both but value changed |
| 🟣 Pink left border + `⊕` | Field exists in both but type changed |

**Synchronized scrolling** — both panes scroll together, pixel-for-pixel. If A and B have the same structure the corresponding rows stay aligned as you scroll.

Press `Escape` or click outside the popup to close.

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd ↵` / `Ctrl ↵` | Parse input |
| `F` | Toggle fullscreen output |
| `Escape` | Exit fullscreen · Close diff popup · Clear search |
| `Enter` (in search) | Next match |
| `Shift + Enter` (in search) | Previous match |

---

## File Structure

```
datalens/
├── index.html      # Markup: single/compare mode panels, diff popup
├── styles.css      # All styles: dark chrome, white output, diff highlights
├── script.js       # All logic: parser, tree builder, search, compare, diff
└── README.md       # This file

versions/           # Snapshot archive
├── CHANGELOG.md
├── VERSION
├── index.v1.0.0.html
├── script.v1.0.0.js
├── styles.v1.0.0.css
└── … (one set per version)
```

---

## Architecture

### Parser (`extractBlocks`)

Walks the raw input string character by character looking for block starters (`{`, `[`, `<`). Each block is independently parsed and repaired. Plain text between blocks becomes a `caption` attached to the next block — nothing is ever discarded.

```
raw input
  → extractBlocks()           character-by-character scanner
    → JSON.parse()            native, C-level speed
    → DOMParser (XML)         native XML parser
    → xmlToJson()             DOM → JS object (used for diff/search paths)
  → blocks[]                  [{type, label, caption, data, rawXml, xmlDoc}]
```

### Tree Renderer (`buildBlockTree`)

Fully eager — every node is a real DOM element on first render. No virtual/lazy tricks. Performance comes from `content-visibility: auto` which skips painting off-screen nodes.

```
blocks[]
  → buildBlockTree()
    → buildXMLNode()          recursive, real XML elements
    → buildNode()             recursive, JSON key/value rows
  → attachToggleDelegate()    ONE click listener per container (event delegation)
```

### Diff Engine

Flattens both parsed structures to dot-path maps (`store.books.0.title → {val, type}`), then compares every path. Results are stamped directly onto the corresponding DOM rows as CSS classes — no separate diff tree is built.

```
flatA, flatB (dot-path maps)
  → allPaths union
    → added / removed / changed / same
  → buildRowPathMap()         data-path attr → row element (O(n) single pass)
  → stampRow()                adds CSS class + gutter mark to row
```

### Versioning

Every release increments `APP_VERSION` in `script.js`. The badge in the UI header reads from this constant at load time. Snapshot copies of all three files are saved to `versions/` and `CHANGELOG.md` is updated with what changed and why.

---

## Browser Support

Requires a modern browser with:
- `DOMParser` (XML parsing)
- `CSS content-visibility` (Chrome 85+, Firefox 125+, Safari 18+)
- `navigator.clipboard` (copy to clipboard)
- `localStorage` (theme persistence)

Works offline after initial load (fonts are the only external resource).

---

## Version History

See [`versions/CHANGELOG.md`](versions/CHANGELOG.md) for full release notes.

| Version | Summary |
|---|---|
| v1.0.3 | Fix: tree view fully expanded on load; removed broken lazy renderer |
| v1.0.2 | Fix: version badge in UI; restored from v1.0.0 baseline |
| v1.0.1 | Fix: attempted lazy renderer fixes (superseded by v1.0.3) |
| v1.0.0 | Initial release: full feature set, dark/light mode, compare/diff |

---

*DataLens — built for developers who work with data every day.*
