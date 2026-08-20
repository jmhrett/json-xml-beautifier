# DataLens — Changelog

## v1.0.0 — Baseline (current)
**Date:** 2026-08-13

Full-featured JSON & XML inspector with:
- Resilient multi-block parser (JSON + XML in one paste, prose text preserved as captions)
- Lazy / virtual tree renderer (children built on demand — no freeze on large files)
- XML rendered as real XML tree (`<tag attr="val">`) not JSON
- XML text view beautified and syntax-highlighted as XML
- Dark / Light mode toggle with localStorage persistence
- Search in tree view (JSON + XML elements) with prev/next navigation and inline `<mark>` highlights
- Search in text view via TreeWalker with prev/next navigation
- Compare mode: two slots (A/B), diff popup with synchronized scroll and inline diff highlights
- Fullscreen output with Tree/Text toggle inside the panel header
- Indent 2/4, Minify/Beautify, Copy, Download
- Text view capped at 200k chars for syntax highlighting to prevent OOM

- Version badge visible in UI header (synced from `APP_VERSION` constant in script.js)

## v1.0.1 — Bug Fix (2026-08-13)

### Fixed
- **Tree view completely broken** — `toggleNode` was finding the empty lazy-placeholder
  `div.tree-children` and showing it directly instead of triggering `lazyBuildChildren`.
  Fix: detect `.tree-lazy-placeholder` class, remove it, then call `lazyBuildChildren`.
- **Compare mode broken** — both slots A and B shared a single global `lazyStore`.
  When slot B parsed, it overwrote slot A's lazy data, so expanding any node in A
  read garbage from B's store. Fix: each container gets its own `container._lazyStore`
  array; `lazyStore` is a pointer that `renderTree` and `lazyBuildChildren` redirect
  per-container so builds never cross-contaminate.

## v1.0.2 — Bug Fix (2026-08-13)

### Fixed
- **Tree view always collapsed / XML invisible** — restored from v1.0.0 baseline then
  applied three surgical fixes:
  1. `buildXMLNode`, `buildNode`, `appendAttrGroup` now start buttons as `expanded`
     (were accidentally set to `collapsed`, so every node appeared shut and clicking
     opened nothing because the lazy check never fired correctly)
  2. `toggleNode` now queries `:scope > .tree-children:not(.tree-lazy-placeholder)`
     so it ignores the empty placeholder div and correctly detects unbuilt children
  3. Placeholder is explicitly removed before `lazyBuildChildren` runs so the real
     children div is cleanly appended with no duplicate
- **Compare mode broken** — `lazyStore` was a single global array shared across all
  tree containers. Slot B's `renderTree` call reset it, wiping Slot A's lazy data.
  Fix: each container gets `container._lazyStore = []`; `renderTree` redirects the
  `lazyStore` pointer; `lazyBuildChildren` always reads from `container._lazyStore`.
- **Version badge** added to UI header (v1.0.2 visible in top-left).

## v1.0.3 — Bug Fix (2026-08-13)

### Fixed
- **Tree view always collapsed / requires manual clicking** — completely removed the
  lazy/virtual rendering machinery which was the root cause. The design was: render
  nodes as expanded buttons but with empty placeholder divs as children, then build
  real children on first click. This made every node look expanded but actually empty.
  Replaced with straightforward eager rendering: `buildBlockTree` → `buildXMLNode`
  / `buildNode` recursively build the full tree immediately, all nodes visible and
  expanded on load. Collapse/expand works via CSS `display:none` on `.tree-children`.
- **Removed**: `lazyStore`, `lazyBuildChildren`, `tree-lazy-placeholder` — all gone.
- `expandAll` / `collapseAll` simplified — just toggle CSS class on all `.tree-children`.
- Search ancestor-expand no longer references removed lazy functions.

---
<!-- New entries go above this line, newest first -->
