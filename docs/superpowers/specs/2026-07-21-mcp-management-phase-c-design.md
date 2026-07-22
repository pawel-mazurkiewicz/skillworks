# MCP Server Management — Phase C: Discovery Reconciliation

**Status:** Design approved (brainstorm), ready for implementation plan
**Date:** 2026-07-21
**Scope:** Phase C of the MCP-management feature (roadmap:
`2026-07-20-mcp-management-roadmap.md`). Promotes Phase A's read-only
`mcp_discover` into full reconciliation: invocation-aware matching of harness
config entries against library specs, importing unmanaged entries into the
library (review-card flow), and surfacing + fixing drift where a managed entry
diverges from its spec. Builds on Phase A (library, adapters, engine), Phase B
(reverse dialect mapping, placeholder detection), and Phase D (frontend tab,
review card, editor). Ships one new command plus engine helpers; the three
mutating actions reuse existing commands.

---

## 1. Motivation

Phase A shipped `mcp_discover`: it reads every v1 target and lists entries whose
config **key** does not exactly equal a library **id**. Phase D renders those in
a read-only panel with a "future update" footer. Two real cases fall through
this exact-key-name test:

1. **A config entry that IS one of your library servers, under a different key**
   — e.g. you hand-added `context7` (key `ctx7`) before curating it in the
   library as `context7`. Exact-key matching calls it unmanaged forever.
2. **A managed entry that drifted on disk** — key matches a library id, but
   someone hand-edited the args/env in the harness config. Exact-key matching
   calls it *managed* and hides it, even though the live config no longer
   matches the spec Skillworks would write.

Phase C closes both by comparing **invocations**, not just key names, and gives
the user one-click reconciliation for each case.

## 2. Goals / Non-goals

**Goals:**
- A per-adapter **reverse mapping** (`parse_entry`): the deterministic inverse
  of Phase A's `render_entry`, turning an on-disk config `Value` back into
  canonical invocation fields (transport, command, args, env, url, headers) plus
  a list of ignored/unmapped keys.
- `mcp_reconcile` command: one classification pass over all v1 targets returning
  two buckets — **import candidates** (unmanaged entries) and **conflicts**
  (managed-but-drifted entries) — with evidence and warnings.
- **Invocation-aware matching:** an unmanaged entry whose invocation equals an
  existing library spec is flagged as "already in your library as `<name>`".
- **Import flow** (decision: review card): reverse-map an unmanaged entry to a
  prefilled draft (`source.kind = "discovered"`) surfaced in Phase D's existing
  add/review card; the user reviews/edits and confirms → persists via the
  existing `mcp_add_manual`.
- **Drift/conflict handling** (decision: surface + both fixes): each drifted
  entry shows a field-level diff and offers two one-click actions —
  **Reapply library → overwrite config** (reuses `mcp_activate`) and
  **Adopt config → update library** (reuses `mcp_update_server`).
- **Dedup across targets:** an identical invocation found under the same key in
  several targets collapses into one import candidate that lists every target it
  was found in.

**Non-goals:**
- New mutating commands. Import = `mcp_add_manual`; reapply = `mcp_activate`;
  adopt = `mcp_update_server`. Only the read-side `mcp_reconcile` is new.
- Fuzzy/semantic matching. Matching is exact invocation-field equality only
  (after canonicalization) — no edit-distance, no arg-order tolerance.
- Auto-import or bulk "import all". Each candidate is imported individually via
  the review card (bulk import is a possible later follow-up).
- Merging distinct invocations of one key into `variants`. Two different
  invocations under the same key become two separate candidates (a
  documented v1 limitation; variant-merge is a follow-up).
- Managing out-of-band enable/disable state (unchanged from Phase A).
- Touching Phase B's URL path or the adapter set.

## 3. Reverse mapping — `parse_entry` (engine.rs)

`parse_entry(adapter: &McpAdapter, value: &serde_json::Value) ->
BackendResult<ObservedInvocation>` is the deterministic inverse of
`render_entry`. Because the harness (adapter) is known, this is exact, not
heuristic (contrast Phase B, which guesses dialect from README prose).

```rust
pub struct ObservedInvocation {
    pub transport: String,              // "stdio" | "http" | "sse"
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub url: Option<String>,
    pub headers: BTreeMap<String, String>,
    pub unmapped: Vec<String>,          // keys we ignored, e.g. "timeout", "disabled"
}
```

Per-adapter inversion applies the same flags `render_entry` uses, backwards:
- **command style:** `SeparateArgs` → `command` + `args`; `ArgvArray` (opencode)
  → first element = `command`, rest = `args`.
- **env field:** read `env` / `environment` / TOML subtable per `env_field`.
- **transport discriminator:** explicit `type`/`transport` field mapped via
  {`stdio`,`local` → stdio; `http`,`streamable-http`,`remote` → http;
  `sse` → sse}; implicit adapters infer stdio when `command` present, else http
  when a url field present.
- **remote url field:** read `url` / `httpUrl` / `serverUrl` per
  `remote_url_field`.
- every other key (timeout, disabled, autoApprove, cwd, oauth, tool filters…)
  is recorded in `unmapped` and dropped from the invocation, never silently
  lost from the user's view (the reconcile response lists them).
- Malformed entry (e.g. stdio-shaped but no command, or argv array empty) →
  `Validation` error for that entry; the reconcile pass records it as a
  warning and skips the entry rather than aborting.

**Round-trip invariant (tested):** for every adapter and a canonical spec,
`parse_entry(adapter, render_entry(adapter, spec))` reproduces the spec's
invocation fields exactly.

### 3.1 Invocation comparison

`invocation_eq(a: &ObservedInvocation, b: &ObservedInvocation) -> bool` compares
only the canonical fields — transport, command, args (order-sensitive), env,
url, headers — and **ignores `unmapped`**. This prevents harmless extra config
keys (a user's `timeout`) from reading as drift. The library side is compared by
first resolving its **effective spec** for the (harness, scope) target (canonical
variant selection, same as activation) and projecting it through `render_entry`
→ `parse_entry`, so both sides are normalized identically before comparison.

`diff_invocation(expected, observed) -> Vec<FieldDiff>` produces a
human-readable, field-level diff for the UI:

```rust
pub struct FieldDiff {
    pub field: String,          // "args", "env.API_KEY", "command", "url", …
    pub expected: Option<String>,
    pub observed: Option<String>,
}
```

## 4. Classification — `mcp_reconcile`

`mcp_reconcile(project_path: Option<String>) -> McpReconcileResponse`
(+ `_impl` with app-home/home-dir overrides, per the codebase's test
convention). Algorithm, over every v1 (harness, scope) target the same way
`mcp_status`/`mcp_discover` enumerate them:

For each config entry `(key, value)`:
1. `observed = parse_entry(adapter, value)` — on parse error, push a warning and
   skip.
2. If `key` equals a library id `L`:
   - `expected = parse_entry(adapter, render_entry(adapter, effective(L, target)))`.
   - `invocation_eq(expected, observed)` → **in-sync**, emit nothing.
   - else → **conflict** (`DriftEntry` with `diff_invocation(expected, observed)`).
3. Else (`key` matches no id):
   - if some library spec `S`'s effective invocation for this target
     `invocation_eq`s `observed` → **import candidate** with
     `matchesLibraryId = Some(S.id)` (hint: "already in your library as …").
   - else → **import candidate** with `matchesLibraryId = None`.

**Dedup:** import candidates are grouped by `(slug(key), observed-invocation)`.
Identical invocation under the same key across N targets collapses to one
candidate whose `foundIn` lists all N targets. Distinct invocations under the
same key remain separate candidates (documented limitation).

**Suggested spec:** each candidate carries a ready-to-review `McpServerSpec`
built from `observed`: `id = slug(key)` (Phase A/B slug rules; empty → skip with
warning), `name = key`, `source = { kind: "discovered", url: None }`, transport
+ invocation fields from `observed`, no variants. It passes Phase A
`validate_spec`; a candidate that cannot form a valid spec is dropped to
`warnings`.

**Placeholder / shell-ref warnings** (reuse Phase B `looks_like_placeholder` /
shell-ref detection) run over the suggested spec's env/headers/args/url and
attach per-candidate warnings, so an imported `${YOUR_TOKEN}` is flagged before
the user activates it elsewhere.

### 4.1 IPC types (types.rs)

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileTargetRef {
    pub harness: String,
    pub scope: String,
    pub config_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpImportCandidate {
    pub key: String,
    pub suggested_spec: McpServerSpec,   // source.kind = "discovered"
    pub found_in: Vec<ReconcileTargetRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matches_library_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,           // placeholders, "ignored: timeout", …
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDriftEntry {
    pub server_id: String,               // library id (== key)
    pub harness: String,
    pub scope: String,
    pub config_path: String,
    pub diff: Vec<FieldDiff>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trust_note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpReconcileResponse {
    pub imports: Vec<McpImportCandidate>,
    pub conflicts: Vec<McpDriftEntry>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,           // per-target read/parse failures
}
```

`FieldDiff` also derives `Serialize` (camelCase). `mcp_discover` and
`DiscoveredMcpEntry` remain in place (still unit-tested) but the Phase D panel
switches its data source to `mcp_reconcile`.

## 5. Mutating actions — all reuse existing commands

- **Import a candidate:** frontend opens the review card seeded with
  `suggestedSpec`; on confirm it calls the existing add-manual route
  (`mcp_add_manual`). Duplicate-id at save is already rejected by
  `mcp_add_manual` (the user edits the id in the card). No new command.
- **Reapply library → overwrite config** (drift): calls existing
  `mcp_activate(server_id, harness, scope)`, which writes the library's
  effective spec into the entry (backup-then-atomic, touches only that key).
- **Adopt config → update library** (drift): reverse-map is already in the
  drift row's `observed`; the frontend builds the updated spec (canonical
  invocation ← observed, preserving id/name/description/variants) and calls the
  existing `mcp_update_server(spec)`.

Every mutating action re-runs `mcp_reconcile` (and the status refresh the tab
already does) afterward, so buckets update live.

## 6. Frontend (Phase D panel evolved) — `mcp-servers.js` + `mcp-logic.js`

The read-only discovered panel becomes a two-section **Reconcile** surface. Pure
classification/formatting helpers land in `mcp-logic.js` (unit-tested with
`node --test`); DOM wiring in `mcp-servers.js`, following the established
state-slice / render / event-delegation pattern. No React.

**Section A — "Unmanaged servers" (import candidates):** per candidate: `key`,
a "found in: claude / global · cursor / global" line, any warnings (amber), and
an **Import** button that opens the existing add/review card prefilled from
`suggestedSpec`. If `matchesLibraryId` is set, show an inline hint ("looks like
**<name>**, already in your library") instead of implying it's brand new.

**Section B — "Needs attention" (drift):** per drift entry: server name +
harness/scope chip, a compact `diff` table (field · expected · on-disk), and two
buttons — **Reapply library** and **Adopt into library** — each behind a
confirm (both mutate real config/library). Trust-note surfaced where present.

Per-target read/parse `warnings` render as a muted footer note. The "future
update" footer is removed. Empty state: "Everything in your harness configs
matches your library." Load failure gets a distinct in-tab error state (picks up
the Phase D follow-up).

`buildMcpRoutes` (in `mcp-logic.js`) gains the `GET /api/mcp/reconcile` → 
`mcp_reconcile` route (project-scoped like discover/status); the mutating
actions reuse the add/activate/update routes already in the table.

## 7. Error handling

- Unreadable/malformed target config → that target contributes a `warnings`
  entry; the pass continues (matches `mcp_discover`'s per-target tolerance).
- Un-parseable individual entry → per-entry warning, entry skipped.
- Candidate that can't form a valid spec (e.g. slug empty, stdio w/o command) →
  dropped into `warnings`, never a broken review card.
- `scope == project` with no active project → project targets are simply
  omitted (global still reconciles), consistent with status/discover.
- Mutating actions surface backend `Validation` errors through the existing
  api-shim toast path; a failed action leaves both config and library untouched
  (each underlying command is already backup-then-atomic).

## 8. Testing

**Rust (engine + command, tempdir + tokio):**
- `parse_entry` per adapter: round-trip `parse(render(spec)) == spec`
  invocation, for stdio + remote, incl. opencode argv array, codex TOML
  subtable env, gemini `httpUrl`/`url` split, explicit vs implicit transport.
- `parse_entry` records `unmapped` keys; malformed entry → error.
- `invocation_eq` / `diff_invocation`: equal ignores `unmapped`; arg-order and
  env differences produce expected `FieldDiff`s.
- `mcp_reconcile_impl`: fixtures producing (a) in-sync managed entry → emitted
  nowhere; (b) drifted managed entry → one conflict with correct diff;
  (c) unmanaged unknown → import candidate; (d) unmanaged matching a library
  spec → candidate with `matchesLibraryId`; (e) same invocation across two
  targets → one deduped candidate with two `foundIn`; (f) malformed target →
  warning + continue; (g) placeholder env → candidate warning.

**Frontend (`node --test`, pure helpers in `mcp-logic.js`):**
- classification/grouping of a reconcile response into the two sections;
  dedup `foundIn` formatting; diff-row formatting; slug of suggested id.

**Playwright smoke (`test/ui/`, mocked `/api/mcp/**`):**
- reconcile response with one import + one drift renders both sections;
  clicking **Import** opens the review card prefilled; clicking **Reapply** /
  **Adopt** fires the mocked activate / update route and re-fetches reconcile.

**Full gate before PR:** `cargo test`, `npm test`, `npm run build`,
`npm run test:ui` all green.

## 9. Open questions / follow-ups

- Merging distinct invocations under one key into `variants` (deferred; v1 keeps
  them as separate candidates).
- Bulk "import all unmanaged" / "reapply all drift" actions (deferred).
- Invocation matching is exact-field; if real configs prove noisy (e.g. an env
  var the harness injects), a small allow-list of ignorable keys may be needed —
  revisit after dogfooding.
- Should `mcp_discover` be retired once the panel moves to `mcp_reconcile`?
  Kept for now (tested, and a simpler read for the Node/agent mirror in Phase E).
