# MCP Server Management — Phase D: Frontend UI + Ingestion Hardening

**Status:** Design approved (brainstorm), pending external review (Codex) + user spec gate
**Date:** 2026-07-21
**Scope:** Phase D of the MCP-management feature (roadmap:
`2026-07-20-mcp-management-roadmap.md`). The user-facing "MCP Servers" surface
over the Phase A/B backend, plus the hardening pre-work recorded in the
roadmap. No discovered-entry import (Phase C), no Node agent tools (Phase E),
no MCP sets.

---

## 1. Motivation

Phases A/B shipped a complete MCP backend (library, per-harness engine, URL
ingestion) reachable only over IPC. Phase D makes it a first-class surface in
the desktop app, mirroring how skills are managed, and hardens the URL-fetch
path before it becomes a one-click action.

## 2. Goals / Non-goals

**Goals:**
- Fifth top-tab **"MCP Servers"** (hint: "Connect servers to agents").
  All copy refers to *the user's* servers — never conflatable with Configure's
  "register Skillworks' own MCP server" feature.
- Library list + editable detail pane + activation matrix + full variant
  editor + add-from-URL flow + manual form + read-only discovered panel.
- New backend command `mcp_update_server(spec)`.
- Ingestion hardening: SSRF host guard, redirect cap, bounded fetch,
  `parse.rs` split, variant-aware placeholder warnings, real-README fixtures.

**Non-goals:** import/reconcile discovered entries (C); agent tools (E); MCP
sets; dark theme (app-wide stance); editing `source`/evidence.

## 3. Information architecture & layout

New top-tab beside Manage/Install/Sets/Configure:

```
[Manage] [Install] [Sets] [Configure] [MCP Servers]
┌─ sidebar ────────┬─ detail pane ──────────────────────────┐
│ server rows:     │ ┌ fields form (editable) ┐             │
│  name            │ │ name, description,     │             │
│  transport chip  │ │ transport, command,    │             │
│  active-count    │ │ args, env kv, url,     │             │
│  badge           │ │ headers kv             │             │
│                  │ └────────────────────────┘             │
│ (+ Add server)   │ activation matrix (7 × global/project) │
│                  │ variants (list + full editor)          │
│                  │ evidence (url-sourced only)            │
│                  │ danger: Remove from library            │
├──────────────────┴────────────────────────────────────────┤
│ Add server:  [ URL ............ ] [Parse] | Enter manually│
│ Found in configs (read-only, grouped by harness)          │
└───────────────────────────────────────────────────────────┘
```

Design language: existing tokens only (`var(--surface)`, `var(--ink)`,
`var(--green)`, radii 4/8/14/18); BEM-ish class names (`mcp-*` prefix); the
skill detail pane / bulk action panel are the rhythm models (per CLAUDE.md).
Density with breathing room; plain-language labels.

## 4. Components & behaviors

### 4.1 Library sidebar
- Row: server name, transport chip (`stdio`/`http`/`sse`), badge with active
  target count (derived from `mcp_status` rows where `active`).
- Selection drives the detail pane. Empty state: short plain-English intro +
  "Add your first server" pointing at the add panel.

### 4.2 Detail pane — fields form
- Editable: `name`, `description`, `transport` (select), `command`, `args`
  (ordered token list), `env` (key/value rows, add/remove), `url`, `headers`
  (key/value rows). `id` shown read-only (it keys harness config entries).
- Transport select toggles stdio vs remote field groups (mirrors
  `validate_spec` rules); Save calls `mcp_update_server`, disabled until dirty
  + client-side-valid; server-side `Validation` errors surface as the field
  form's error line + toast (existing toast pattern).
- Placeholder-looking values (same patterns as the backend: `YOUR_*`, `<...>`,
  `${...}`, `xxx`, `REPLACE`, `changeme`, `*_HERE`; plus `$`/`~` commands) get
  an amber inline flag: "looks like a placeholder — fill in before activating".

### 4.3 Activation matrix
- 7 harness rows × 2 columns (Global / Project). Each cell: checkbox bound to
  `mcp_status`; toggling calls `mcp_activate`/`mcp_deactivate` then refreshes
  status (no optimistic state).
- Project column disabled with hint when no project is selected (reuses the
  app's existing project-selection state).
- Claude/Codex project cells render the backend's trust note as small print.
- A status row carrying `error` (unreadable config) renders the cell as an
  ⚠ marker with the error text in a tooltip + the row's config path; the
  checkbox is disabled for that cell.
- When a server has variants, an "Activate as…" select beside the matrix
  chooses the variant label passed to `mcp_activate` (default: automatic —
  omit the label, letting `resolve_effective` pick).

### 4.4 Variants — full editor
- List: label, applies_to summary ("codex · project", "any"), overridden-field
  chips; actions: edit, delete.
- Edit/new opens the same field form as 4.2 scoped to the variant (all fields
  optional-override semantics: empty = inherit canonical) plus `label` (text,
  required, unique per server) and `applies_to` (harness select incl. "any",
  scope select incl. "any").
- All variant mutations go through `mcp_update_server` with the full modified
  spec (no per-variant backend endpoints).

### 4.5 Add server
- URL path: input + Parse button → `mcp_add_from_url` → per-draft review
  cards: prefilled 4.2-style form + evidence list + warnings (placeholders
  highlighted on their fields) → "Add to library" per card →
  `mcp_add_manual`. Duplicate-id `Validation` from the backend surfaces on the
  card with an inline id-edit affordance.
- Empty drafts: render the guidance warning + "Enter manually" shortcut.
- Manual path: same form, blank, with id auto-slugged from name (editable
  until saved).

### 4.6 Found in configs (read-only)
- `mcp_discover` results grouped by harness; row = entry key, scope,
  config path (monospace, Berkeley Mono), one-line summary (command or url).
- Footer note: "Importing these into your library arrives in a future
  update." No actions in Phase D.

### 4.7 Refresh model
- Tab activation triggers `mcp_list_library` + `mcp_status` + `mcp_discover`
  in parallel; any mutation refreshes the affected slices. No polling.

## 5. Backend changes

### 5.1 `mcp_update_server`
`mcp_update_server(spec: McpServerSpec) -> McpLibraryResponse` +
testable `_impl`: `validate_spec`, require existing id (`NotFound`
otherwise), replace in place, save, return library. Variant labels checked
unique (new `Validation`). Registered in `lib.rs`.

### 5.2 Ingestion hardening (roadmap pre-work)
- **SSRF guard:** before fetching, resolve the URL host; reject loopback,
  link-local, RFC1918/ULA ranges, and literal non-global IPs with a
  `Validation` error. Applies to both fetch_url and retry_url. Redirect cap:
  a dedicated reqwest client for this path with `redirect::Policy::limited(3)`
  and the same host check re-applied on redirects via the policy's attempt
  hook (or by disabling redirects and following manually up to 3).
- **Bounded fetch:** honor `Content-Length` when present (reject > 1 MiB
  early); always cap the read at 1 MiB + 1 via a streamed/`take`d body read in
  a new `HttpClient::get_capped` (default impl on the trait delegating to
  `get` for the mock; real client streams). Post-cap behavior unchanged
  (`Validation` error).
- **parse.rs split:** `backend/mcp/parse/` directory module: `mod.rs`
  (public API re-exports: `source_for_url`, `extract_drafts`, types),
  `url.rs`, `fences.rs` (scan + jsonc), `heuristics.rs` (H1/H2/H3 +
  Candidate), `assembly.rs` (fold + drafts + placeholders). Pure move — no
  behavior change; all existing tests keep passing (paths updated).
- **Variant-aware placeholder warnings:** `placeholder_warnings` also walks
  each variant's env/headers/args/url/command with the variant label in the
  warning text.
- **Fixtures:** two verbatim real-world README excerpts (a Context7-style
  single-server page; a modelcontextprotocol/servers-style monorepo page) as
  `const` fixtures with assertions on draft counts/ids; include CRLF line
  endings in one and a unicode server name in one.

## 6. Frontend architecture

- New `public/mcp.js` (BEM-ish DOM module in the app.js style — the app is
  DOM-driven with React only for the editor modal (`skill-editor.jsx`);
  follow app.js's patterns: state slice, render functions, event delegation.
  React is NOT introduced for this surface). Registered from `app.js` with a small
  hook (tab switch + state wiring), keeping the app.js diff minimal.
- `public/index.html`: fifth top-tab button + the tab's section markup.
- `public/styles.css`: `mcp-*` component styles from existing tokens only.
- `public/api-shim.js`: entries mapping the 9 MCP commands
  (`mcp_list_library`, `mcp_add_manual`, `mcp_update_server`,
  `mcp_remove_server`, `mcp_activate`, `mcp_deactivate`, `mcp_status`,
  `mcp_discover`, `mcp_add_from_url`) to `invoke`.
- Accessibility floor (CLAUDE.md): AA contrast from tokens; every control
  keyboard-reachable with visible focus; matrix checkboxes labeled
  "<server> on <harness> (<scope>)"; `prefers-reduced-motion` respected; no
  icon-only actions.

## 7. Error handling (UI)

- Backend `Validation`/`NotFound` → toast (existing pattern) + inline field
  error where a field is identifiable.
- Activation failure leaves the checkbox in its refreshed (true) state — no
  stuck optimistic UI.
- `mcp_add_from_url` fetch errors render in the add panel (not a toast) with
  the fallback guidance text from the backend.
- Per-target status `error` handled per 4.3 (⚠ cell, disabled checkbox).

## 8. Testing & verification

- Backend: cargo tests for `mcp_update_server` (round-trip, unknown id,
  duplicate variant labels), SSRF guard (table of rejected hosts), bounded
  fetch (Content-Length reject + capped stream), parse split (existing 38
  module tests keep passing), variant-aware warnings, fixture tests.
- Frontend: `npm test` (Node side untouched — stays 46), `npm run build`.
- UI verification via local Playwright (per repo convention): tab renders,
  add-URL flow against a mocked command layer where feasible, activation
  matrix toggles, keyboard walk of the detail pane; screenshots for the
  final review. I cannot hand-verify a browser beyond this — stated
  explicitly per house rules.

## 9. Open questions carried forward

- Cursor's ~40-active-tools ceiling: warn in the matrix when many servers are
  active for Cursor? (Deferred; needs tool-count data we don't collect.)
- Draft evidence byte offsets for source highlighting (deferred from B).
- Discovered-panel import affordance design belongs to Phase C.
