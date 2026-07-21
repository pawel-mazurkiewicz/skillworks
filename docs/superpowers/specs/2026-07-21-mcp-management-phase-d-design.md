# MCP Server Management — Phase D: Frontend UI + Ingestion Hardening

**Status:** Design approved (brainstorm + Codex external review folded in), pending user spec gate
**Date:** 2026-07-21 (rev 2 after Codex review)
**Scope:** Phase D of the MCP-management feature (roadmap:
`2026-07-20-mcp-management-roadmap.md`). The user-facing "MCP Servers" surface
over the Phase A/B backend, plus hardening pre-work. No discovered-entry
import (Phase C), no Node agent tools (Phase E), no MCP sets.

---

## 1. Motivation

Phases A/B shipped a complete MCP backend (library, per-harness engine, URL
ingestion) reachable only over IPC. Phase D makes it a first-class surface in
the desktop app and hardens the URL-fetch path before it becomes a one-click
action.

## 2. Goals / Non-goals

**Goals:**
- **Seventh top-tab "MCP Servers"** (hint: "Connect servers to agents"); the
  **existing** self-registration tab (`data-top-tab="mcp"`, currently
  "MCP server") is **renamed to "Connector"** (hint: "Let agents drive
  Skillworks") and otherwise untouched. New frontend namespace:
  `state.mcpServers` + `mcp-servers` DOM ids/classes (`state.mcp` stays with
  the Connector surface).
- Library list + editable detail pane + activation matrix + full variant
  editor (tri-state overrides) + add-from-URL flow + manual form + read-only
  discovered panel.
- Backend: `mcp_update_server`, variant-aware centralized validation,
  reapply-after-edit workflow, serialized library mutations, project-aware
  tolerant removal warnings.
- Ingestion hardening: SSRF-safe manual-redirect fetch with pinned DNS,
  timeouts, bounded body reads; `parse.rs` split; variant-aware placeholder
  warnings; real-README fixtures.

**Non-goals:** import/reconcile discovered entries (C); agent tools (E); MCP
sets; dark theme; persisting draft evidence past save (evidence is a pre-save
review aid only — deliberate decision, not an oversight).

## 3. Information architecture & layout

```
[Manage] [Install] [Sets] [Configure] [Cleanup] [Connector] [MCP Servers]
┌─ sidebar ────────┬─ detail pane ──────────────────────────┐
│ server rows:     │ fields form (editable)                 │
│  name, transport │ activation matrix (7 × global/project) │
│  chip, active-   │  + staleness banner + Reapply button   │
│  count badge     │ variants (list + tri-state editor)     │
│ (+ Add server)   │ danger: Remove from library            │
├──────────────────┴────────────────────────────────────────┤
│ Add server:  [ URL ............ ] [Parse] | Enter manually│
│   → per-draft review cards (fields + evidence + warnings) │
│ Found in configs (read-only, grouped by harness)          │
└───────────────────────────────────────────────────────────┘
```

Design language: existing tokens only; BEM-ish `mcp-servers-*` classes; the
skill detail pane / bulk action panel are the rhythm models. Plain-language
labels; AA floor.

## 4. Components & behaviors

### 4.1 Library sidebar
As rev 1: row = name, transport chip, active-count badge (from `mcp_status`);
selection drives detail; plain-English empty state.

### 4.2 Detail pane — fields form
- Editable: `name`, `description`, `transport` (select), `command`, `args`,
  `env` kv rows, `url`, `headers` kv rows. `id` read-only.
- **Secret masking:** env/header values render masked with a reveal toggle.
- Save → `mcp_update_server`; disabled until dirty + client-valid; backend
  `Validation` → inline field error + toast.
- Placeholder-looking values (backend patterns + `$`/`~` commands) flagged
  amber inline.
- **Staleness rule:** after a successful save, any currently-active target
  still runs the previously-activated snapshot. The matrix header shows a
  banner: "Saved changes aren't live yet on N active target(s)" with a
  **Reapply** button (see 4.3). The UI never implies active configs
  auto-sync.

### 4.3 Activation matrix
- 7 harness rows × Global/Project checkbox cells from `mcp_status`; toggle →
  `mcp_activate`/`mcp_deactivate` → refresh. After any failure the checkbox
  is refreshed to the **backend-authoritative state**.
- Project column disabled with hint when no project selected.
- Claude/Codex project cells show the trust note as small print.
- Status rows carrying `error`: ⚠ marker replaces the checkbox (disabled),
  error text + config path exposed via a **focusable** disclosure control
  wired with `aria-describedby` (no hover-only tooltip).
- Variant picker ("Activate as…": automatic | explicit label) passed to
  `mcp_activate`.
- **Reapply:** re-runs `mcp_activate` (current variant selection) for every
  target where the server is active; reports per-target results (mirrors
  `applySet`'s partial-result pattern).

### 4.4 Variants — tri-state editor
- List: label, applies_to summary, overridden-field chips; edit/delete/new.
- **Per-field Override toggles:** each field row has an "Override" switch —
  OFF = inherit canonical (`None`), ON = override with the entered value,
  **including an explicitly empty value** (`Some(vec![])`/`Some({})` clears).
  The form thus represents all three states the data model supports.
- `label` required + unique per server; `applies_to` harness/scope selects
  incl. "any".
- All mutations go through `mcp_update_server` with the full spec.

### 4.5 Add server
- URL path: input + Parse → `mcp_add_from_url` → per-draft review cards
  (prefilled form + **evidence** + warnings; placeholders highlighted) →
  "Add to library" → `mcp_add_manual`. Duplicate-id error surfaces inline
  with an id-edit affordance. Evidence is displayed here ONLY — it is not
  persisted with the saved spec.
- Empty drafts → guidance warning + manual shortcut. Manual path: blank form,
  id auto-slugged from name (editable until saved).
- Fetch errors render in the add panel (silent shim call — no toast).

### 4.6 Found in configs (read-only)
As rev 1; entry summaries rendered via the escaping rule (§6), monospace
paths.

### 4.7 Refresh model
- Tab activation → `mcp_list_library` + `mcp_status` + `mcp_discover` in
  parallel; mutations refresh affected slices.
- **Project-change and the global Refresh button notify the MCP controller**
  (hook into the existing `loadState()` flow).
- **Request generations:** every fetch cycle carries a generation counter;
  stale responses (older generation) are dropped so they can never overwrite
  newer state.

## 5. Backend changes

### 5.1 Library commands
- **`mcp_update_server(spec) -> McpLibraryResponse`** (+ `_impl`):
  centralized validation (below), require existing id (`NotFound`), replace,
  save, return library.
- **Centralized variant-aware validation** in `spec.rs::validate_spec`
  (called by BOTH `mcp_add_manual` and `mcp_update_server`): existing rules
  + variant labels non-empty and unique; `applies_to` harness must be a
  known adapter id (or absent), scope ∈ {global, project} (or absent); every
  variant's **effective invocation** (canonical ⊕ variant overlay) must
  satisfy the transport/field rules — a variant may not produce an
  unusable spec that only fails at activation.
- **Serialized mutations:** all library load-modify-save sequences
  (add/update/remove) go through a process-wide `tokio::sync::Mutex` so
  overlapping IPC calls cannot lose updates. Frontend always adopts the
  returned authoritative library.
- **`mcp_remove_server`**: gains `project_path: Option<String>`; warning scan
  covers global + (when given) project targets; per-target read failures
  become warnings ("couldn't check X") instead of aborting; removal still
  never deactivates.

### 5.2 Ingestion hardening (revised per external review)
- **SSRF-safe fetch (manual redirects, pinned DNS):** no reliance on
  reqwest's redirect policy. A dedicated fetch routine: for each hop
  (initial + up to 3 redirects): require `https`; resolve the host
  explicitly (`tokio::net::lookup_host`); reject unless ALL resolved
  addresses are global (reject loopback, unspecified, link-local, RFC1918,
  ULA, multicast, reserved, IPv4-mapped-IPv6 of the same); issue the request
  on a per-fetch client built with redirects **disabled**,
  `resolve_to_addrs(host, validated_addrs)` (pins the connection to the
  addresses that passed the check — closes the lookup TOCTOU gap),
  `no_proxy()`, and explicit **timeouts** (connect 10 s, total 30 s);
  on 3xx, extract `Location`, count the hop, repeat. Redirect overflow →
  `Validation`.
- **Bounded body read:** reject early when `Content-Length` > 1 MiB; always
  enforce the cap while reading via a `Response::chunk()` loop (the reqwest
  `stream` feature is NOT enabled and is not added). New trait method
  `HttpClient::get_capped(url, headers, max_bytes)` with a default impl
  delegating to `get` + post-check (keeps the existing mock unchanged);
  `ReqwestHttpClient` overrides it with the real streamed cap. The SSRF/
  redirect logic lives above the trait (in the fetch routine), so mocks keep
  working for command tests; the SSRF unit tests target the validation
  functions directly (pure: host-classification table) plus one integration
  test with redirects disabled asserting the hop loop's behavior against the
  mock.
- **parse.rs split:** `backend/mcp/parse/` = `mod.rs` (public re-exports
  only), `url.rs` (pure, network-free), `fences.rs`, `heuristics.rs`
  (`Candidate` + all extraction incl. `candidate_from_json`, `pub(super)`),
  `assembly.rs`. Pure move; the 38 tests colocate with their modules.
- **Variant-aware placeholder warnings:** walk variants' env/headers/args/
  url/command with the variant label in the warning text.
- **Fixtures:** two verbatim real-world README excerpts (single-server;
  monorepo) — one with CRLF endings, one with a unicode server name.

## 6. Frontend architecture

- New `public/mcp-servers.js` DOM module in the app.js style (state slice,
  render fns, event delegation; React not introduced — it exists only for
  the editor modal). Registered from `app.js` with a small hook (tab switch,
  project-change, refresh wiring).
- `public/index.html`: seventh top-tab + section markup; existing mcp tab
  relabeled "Connector" (hint "Let agents drive Skillworks") — markup ids
  and `state.mcp` slice untouched.
- `public/styles.css`: `mcp-servers-*` styles from existing tokens.
- **`public/api-shim.js` contract (explicit):** thrown errors carry
  `{ kind, message }` (a custom `ApiError extends Error` preserving the
  Rust envelope's `kind`); routes accept an options flag `silent: true`
  suppressing the automatic toast (used by the add panel; default behavior
  unchanged for existing routes). New routes, one per command, with
  camelCase arg builders and response adapters documented in the plan:
  `mcp_list_library`, `mcp_add_manual`, `mcp_update_server`,
  `mcp_remove_server` (+projectPath), `mcp_activate`, `mcp_deactivate`,
  `mcp_status` (+projectPath), `mcp_discover` (+projectPath),
  `mcp_add_from_url`.
- **Safe rendering rule:** all backend/URL-derived strings (names, evidence,
  warnings, paths, entry summaries) render via `textContent` or the shared
  escape helper (extracted so `mcp-servers.js` can import it — no
  module-local duplication). Env/header values masked by default (4.2).
- Accessibility floor as rev 1; the 4.3 disclosure pattern replaces
  tooltips.

## 7. Error handling (UI)

- Backend errors carry `kind`: `Validation` → inline + toast (unless the
  call was `silent`); `NotFound` → toast + list refresh.
- After any activation/deactivation failure the matrix refreshes to
  backend-authoritative state.
- `mcp_add_from_url` errors: add panel only (silent call).
- Per-target status `error`: §4.3 disclosure.

## 8. Testing & verification

- **Backend (cargo):** `mcp_update_server` (round-trip, unknown id, variant
  validation matrix: dup labels, bad harness/scope, invalid effective
  invocation — from both add and update); mutation serialization (concurrent
  add+update); tolerant remove warnings (incl. project scope + unreadable
  config); SSRF host-classification table (pure) + redirect-hop integration
  test; capped-read tests (Content-Length reject, oversize stream);
  parse-split regression (38 tests relocated, still green); variant-aware
  placeholder warnings; fixtures.
- **Frontend logic under `node --test`** (existing runner): pure modules for
  route/arg builders, response adapters, `ApiError` mapping, escape helper,
  placeholder detection, request-generation guard — extracted precisely so
  they are testable without a DOM.
- **Playwright smoke** (added as a devDependency — the CLAUDE.md note about
  local availability is stale; correcting it is in scope): app boots, both
  MCP tabs render, add-URL flow with mocked shim, matrix toggle, keyboard
  walk of detail pane, screenshots for review.
- `npm test` (46 existing + new logic tests) + `npm run build`.
- Limits stated plainly: full desktop-webview interaction beyond the
  Playwright smoke cannot be hand-verified by the implementer.

## 9. Open questions carried forward

- Cursor ~40-tool ceiling warning (needs tool-count data; deferred).
- Draft evidence byte offsets (deferred; evidence itself is pre-save only by
  decision).
- Discovered-panel import affordance (Phase C).
- Connector-tab deeper redesign (only relabeled here).
