# MCP Reconcile & Add-Server Polish (pre-0.3.0)

Date: 2026-07-22
Status: Approved design, pre-implementation

Five fixes to the MCP servers tab before the 0.3.0 release. All are scoped to
the MCP reconcile ("Discovered") and "Add server" surfaces plus the backend
reconcile pipeline.

## Background

Current behavior and root causes (file references as of `release/0.3.0`):

1. An on-disk entry whose config key differs from its library server's id
   (e.g. key `unityMCP` in Kiro/global vs. a library id like `unity-mcp`)
   never counts as tracked in `mcp_reconcile_impl`
   (`src-tauri/src/backend/commands.rs`). It matches by invocation
   (`matchesLibraryId`) but remains an import candidate forever, with no way
   to resolve or dismiss it.
2. After a successful add, `handleAddCard` (`public/mcp-servers.js`) sets
   `card.added = true`; `renderDraftCard` then hides the entire button row,
   so the "Added to your library." card has no controls and lingers
   indefinitely.
3. `handleImportCandidate` pushes a draft card and calls `renderAdd()` but
   never moves the viewport; the new card can be off-screen and the click
   appears to do nothing.
4. Drift rows (`renderConflictEntry`) offer only "Reapply library" and
   "Adopt into library" (canonical). There is no way to adopt the on-disk
   divergence as a variant for that harness/scope, even though the variant
   model (`McpVariant` with `applies_to {harness, scope}` in
   `src-tauri/src/backend/mcp/spec.rs`) supports exactly this.
5. MCP servers provided by Claude Code plugins (e.g. atlassian) live in
   plugin manifests (`~/.claude/plugins/installed_plugins.json` v2 →
   `installPath` → `<installPath>/.mcp.json` with a standard `mcpServers`
   map) and are invisible to discovery.

## 1. Matched import candidates: Link + Dismiss

Backend — candidates keep `matchesLibraryId` as today. Two new commands:

### Link (`mcp_reconcile_link`)

Input: `{ serverId, harness, scope, key, projectPath? }`.

- Enables the (harness, scope) cell in the library server's activation
  matrix, reusing the same code path as the matrix toggle.
- If `key` differs from the library server id, removes the old `key` entry
  from that harness config (activation writes the entry under the library
  id).
- Result: the entry becomes tracked; the candidate disappears permanently.

### Dismiss (`mcp_reconcile_dismiss`)

Input: `{ key, harness, scope, fingerprint }`.

- Persists the record to `<vault>/mcp/dismissed.json`.
- `fingerprint` is a stable hash of the observed invocation's canonical
  fields (transport, command, args, env, url, headers, enabled, tools — the
  same fields `invocation_eq` compares; `unmapped` excluded).
- `mcp_reconcile_impl` computes each candidate target's fingerprint and
  filters out (key, harness, scope) targets whose stored fingerprint still
  matches. If the on-disk entry later changes meaningfully, the fingerprint
  no longer matches and the candidate resurfaces.
- A candidate group is only suppressed once **all** of its `foundIn` targets
  are dismissed; dismissing removes matching targets from the group first.
- Dismiss is available on **every** import candidate, matched or not.

### UI (`renderImportCandidate`)

- Matched candidates (`matchesLibraryId` set): `Link to <name>` (primary
  button) + `Dismiss` (ghost). No `Import` button — importing a matched
  candidate would create a duplicate.
- Unmatched candidates: `Import` (primary) + `Dismiss` (ghost).
- The reconcile response includes each candidate's per-target fingerprint so
  the frontend can pass it to Dismiss without recomputation.

## 2. Auto-dismiss "Added to your library" cards

After a successful add, the card enters its `added` state (no buttons, as
today) and a ~2.5 s timer removes it from `state.add.cards` and re-renders.

- The removal is preceded by a brief fade-out (CSS class), skipped under
  `prefers-reduced-motion: reduce`.
- The timer is the only removal path post-add — no manual dismiss is added,
  since the card is gone within seconds. Pre-add cards keep their existing
  Dismiss button, unchanged.
- Timers are keyed by `card.key`; a re-render while the timer is pending
  must not duplicate or orphan it, and dismissal must tolerate the card
  already being gone.

## 3. Import scrolls to the new draft card

In `handleImportCandidate`, after `renderAdd()`:

- Scroll the newly created draft card into view (`scrollIntoView`; smooth
  behavior unless `prefers-reduced-motion: reduce`, then instant).
- Apply a short highlight flash (CSS class, also reduced-motion-aware) so
  the eye lands on the card.

Link (§1) does not create a card and is unaffected.

## 4. "Add as variant" on drift rows

New button on each conflict row alongside Reapply/Adopt:

- Target **not** variant-controlled (`adoptable !== false`):
  `Add as variant` — creates a variant on the library server with:
  - `label` defaulting to `"<harness> (<scope>)"` (uniquified with a numeric
    suffix if a variant with that label already exists),
  - `applies_to: { harness, scope }`,
  - only the fields that actually diverge (per the row's `diff`) set as
    overrides; non-divergent fields stay unset so they keep following the
    canonical spec.
- Target **already** variant-controlled (`adoptable === false`): the
  disabled "Adopt into library" stays disabled; the new button reads
  `Update variant "<label>"` and writes the observed divergent values into
  that existing variant (merging over its current overrides).

The frontend constructs the variant (mirroring the existing variant-editor
flow) and both actions go through the existing spec-with-variants save path
(PATCH `/api/mcp/servers`) followed by `refreshAll()`. Drift resolves
because `expected_observed` now selects the variant for that target.

The reconcile response must carry enough data for the frontend to build the
variant: the observed invocation (it already carries `observedSpec` and
`diff`) and the controlling variant's label when one exists
(`variantLabel`, already present).

## 5. Claude Code plugin MCPs: import-only discovery

Reconcile gains a plugin scan for the `claude` harness:

- Read `~/.claude/plugins/installed_plugins.json` (schema version 2). For
  each installed plugin entry, read `<installPath>/.mcp.json`; if present,
  parse its `mcpServers` map with the existing claude adapter entry parser.
- Missing/unreadable manifest files are skipped silently (a plugin without
  MCP servers is normal); a malformed `.mcp.json` adds a reconcile warning.
- Entries become import candidates with `foundIn` labeled
  `Claude Code / plugin: <plugin name>` and a hint: "Managed by a Claude
  Code plugin — Skillworks won't modify it."
- Plugin entries are **never** drift-checked and never reapply targets.
  Link is not offered for them (there is nothing to rewrite). If a library
  server already exists whose id matches the key **or** whose expected
  invocation equals the observed one, the candidate is suppressed entirely.
- Import copies the spec into the library as usual (source kind
  `discovered`). Dismiss (§1) applies, with a pseudo-scope identifying the
  plugin (e.g. scope `plugin:<name>`), so dismissals are per-plugin.

## Data & types

- `McpImportCandidate` gains per-target fingerprints and an optional
  `managedNote` (plugin candidates).
- `ReconcileTargetRef` gains the plugin pseudo-scope or an optional
  `pluginName` field (implementation's choice; keep serialization
  camelCase-consistent with existing types).
- New vault file: `<vault>/mcp/dismissed.json` — array of
  `{ key, harness, scope, fingerprint }`. Written atomically like other
  vault files (`fs_atomic`).

## Error handling

- Link: if the activation toggle fails, the old key is left untouched
  (no partial rewrite); surface the error toast as existing matrix toggles
  do. If key removal fails after activation succeeded, surface a warning —
  the next reconcile will show the stale key as a fresh candidate.
- Dismiss: failures surface as a toast; candidate stays visible.
- Variant adopt/update: reuses existing PATCH error handling on the card.
- Plugin scan: never fails the whole reconcile; degrades to warnings.

## Testing

- Rust unit tests:
  - dismiss filtering — fingerprint match suppresses, mismatch resurfaces,
    partial-target dismissal keeps the group with remaining targets;
  - link — key rewrite when key ≠ id, no rewrite when equal;
  - variant-adopt construction is frontend logic — cover
    divergent-fields-only overrides, label uniquification, and update-merge
    for existing variants in the Playwright suite instead;
  - plugin manifest parsing against a fixture directory (installed_plugins
    v2 + `.mcp.json`), including suppression of already-in-library entries
    and malformed-file warnings.
- Playwright UI tests (`test/ui/mcp-servers.spec.js` pattern, mocked
  `/api/**`):
  - matched candidate shows Link + Dismiss, unmatched shows Import +
    Dismiss;
  - added card disappears after the auto-dismiss delay;
  - import scrolls the new card into view (assert scroll target/highlight
    class presence);
  - drift row shows `Add as variant` vs `Update variant "<label>"` per
    `adoptable`;
  - plugin candidate renders managed note and no Link.

## Out of scope

- Writing to or reconciling plugin-owned config files.
- Any redesign of the reconcile grouping model.
- Built-in/plugin MCP support for harnesses other than Claude Code.
