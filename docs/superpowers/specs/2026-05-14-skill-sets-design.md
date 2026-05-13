# Skill Sets — Design

Status: Approved (brainstorm)
Date: 2026-05-14

## Problem

The Agent Skill Manager activates skills by symlinking them into per-agent target
directories. Today, the only way to swap a working configuration is to toggle
individual skills in the matrix. Two real workflows are awkward as a result:

1. **Task-mode swapping** — you want to flip between coherent skill mixes
   (e.g. "frontend mode" vs. "writing mode") without clicking dozens of cells.
2. **Per-project loadout** — a project has a canonical configuration; loading
   the project should make it easy to put that configuration in place.

This spec introduces *Sets*: named, saveable collections of (skill, target)
pairs that can be applied on demand.

## Goals

- Capture a named (skill, target) configuration and re-apply it later.
- Support both global sets (cross-project) and project-local sets (live with
  the project, shareable through the project's own files).
- Let a project pin multiple sets and pick one at apply time.
- Make applying predictable: a set replaces state only in the targets it
  references; untouched targets are left alone.
- Reuse the existing enable/disable primitives — no new symlink logic.

## Non-goals

- No auto-apply on project load. Switching is always explicit.
- No multi-set merging or layering. Apply is one set at a time.
- No automatic rollback on partial failure. Same posture as current bulk
  actions: report what succeeded, leave the rest untouched.
- No team-sharing infrastructure beyond JSON export/import and the natural
  shareability of project-local set files.

## Data model

### Set

```jsonc
{
  "id": "set_<uuid>",                 // stable, generated on create
  "name": "Frontend mode",
  "scope": "global" | "project",
  "projectPath": "/abs/path",         // present iff scope == "project"
  "entries": [
    { "skillName": "frontend-design", "targetKey": "claude-global" },
    { "skillName": "frontend-design", "targetKey": "codex-global" }
  ],
  "createdAt": "2026-05-14T...",
  "updatedAt": "2026-05-14T..."
}
```

- `targetKey` reuses the existing target identifiers from the matrix
  (`claude-global`, `codex-global`, `agents-global`, `claude-project`,
  `codex-project`, `agents-project`, and `custom:<path>` from Phase 1).
- `entries` is an unordered list; duplicates are deduped on save (by
  `(skillName, targetKey)`).
- Sets are referenced by `id`. Names are free-form and may collide across
  scopes.

### Storage

- **Global sets** live in `~/.agent-skill-manager/config.json` under a new
  top-level `sets: []`.
- **Project-local sets** live in
  `<projectPath>/.agent-skill-manager/sets.json` (new file, created on first
  save). Same shape as a global set minus `projectPath` (implicit from the
  file location).
- **Project pinning** is added to each saved-project entry in `config.json`:
  ```jsonc
  { "path": "/abs/project", "pinnedSetIds": ["set_a", "set_b"] }
  ```
  A pinned id may reference either a global set or a set in that project's
  own `sets.json`.
- A pinned id that no longer resolves to an existing set is surfaced in the
  UI as "missing" rather than silently dropped from the pin list.
- All writes use the existing atomic-write helper.

## Behavior

### Apply (the core operation)

Apply runs in two phases.

**Plan phase** (always runs; also exposed as a dry-run endpoint):

1. Compute `touchedTargets` = unique `targetKey`s in the set's entries.
2. For each touched target, read its current managed symlinks from that
   target's `.agent-skill-manager.json` manifest.
3. Diff:
   - `toEnable` — entries in the set that are not currently linked.
   - `toDisable` — currently-linked managed skills not present in the set
     for that target.
   - `missing` — entries whose `skillName` is not in the vault.
4. Targets not in `touchedTargets` do not appear in the plan at all.

**Execute phase:**

- For each touched target, in order:
  - Disable everything in `toDisable` for that target.
  - Enable everything in `toEnable` for that target.
  - Skip everything in `missing`; collect a warning.
- All enable/disable calls delegate to existing `src/core.js` primitives.
- If any step throws (e.g. permission error), execution stops. Targets
  already processed remain applied; the failing target and any later
  targets are left untouched. The response reports per-target status
  (`applied`, `failed`, `skipped`) and the collected warnings.

### Snapshot

`snapshotSet({ name, scope, projectPath?, targetKeys[] })` is the inverse
of apply:

1. For each `targetKey` in the input, read its managed symlinks.
2. Build `entries` as the union of `(skillName, targetKey)` pairs.
3. Persist as a new set with the given name and scope.

Snapshot is the primary path for creating the first sets without typing.

### Missing skills

A set entry whose skill is missing from the vault produces a non-blocking
warning at plan time and is skipped at apply time. The entry remains in the
set; if the skill is re-imported later, the next apply picks it up
automatically.

### Drift indicator

After a successful apply, the UI tracks "last applied set" in memory (not
persisted). Any subsequent matrix edit that affects a touched target marks
the indicator as `(modified)`. The relationship is purely informational —
no two-way binding, no auto-update of the set.

## UI

### New top-level "Sets" tab

Placed between *Install* and *Manage*. Two-column layout.

**Left column — set list**
- Filter chips: All / Global / Project (Project chip only enabled when a
  project is loaded).
- Each row: name, scope badge, entry count, summary of targets touched
  (e.g. "Claude global, Codex global"), kebab menu with: Apply, Edit,
  Duplicate, Delete, Export JSON.
- Top buttons: **New set**, **Snapshot current…**, **Import JSON**.

**Right column — editor** (when a set is selected)
- Name input.
- Scope toggle: Global / This project (disabled when no project is loaded).
- Entries grid: each row is `(skill ▾, target ▾, remove)`. Skill dropdown
  lists vault skills; target dropdown lists the same identifiers the matrix
  uses (including custom paths).
- **Add entry** row at the bottom.
- **Add from current state…** button opens a picker over targets and
  harvests their current managed symlinks as new entries.
- Save / Revert in the footer.

### Apply modal (shared)

- Per-target table with three columns: `+ enable`, `− disable`,
  `⚠ missing`.
- Confirm / Cancel.
- Used from both the Sets tab and the Manage tab's project rows.

### Manage tab additions

- Each project row gains:
  - A **Pinned sets** chip list with × to unpin and a `+ Pin set…` picker.
  - An **Apply set ▾** dropdown listing the project's pinned sets.

### Matrix indicator

Above the matrix: `Applied: <set name>` pill after a successful apply.
Becomes `Applied: <set name> (modified)` once the user changes any cell
in a touched target. Disappears when the user applies a different set or
clears it explicitly.

No other UI changes; Install, Import, and existing bulk actions are
untouched.

## HTTP API

Added to `src/server.js`:

```
GET    /sets?projectPath=<abs>           list global + project-local sets
POST   /sets                              create
PATCH  /sets/:id                          update (name, entries)
DELETE /sets/:id

POST   /sets/:id/plan                     dry-run: returns per-target
                                          {toEnable, toDisable, missing}
POST   /sets/:id/apply                    execute; returns plan +
                                          perTargetResult

POST   /sets/snapshot                     body: {name, scope, projectPath?,
                                          targetKeys[]} → created set
POST   /projects/pinned-sets              body: {projectPath, setIds[]}
                                          (replace the pin list)
```

All write endpoints persist through the existing atomic-write helper.

## Core module additions

New exports from `src/core.js`:

- `listSets({ projectPath? })`
- `getSet(id, { projectPath? })`
- `createSet({ name, scope, projectPath?, entries })`
- `updateSet(id, patch, { projectPath? })`
- `deleteSet(id, { projectPath? })`
- `planApplySet(id, { projectPath? })`
- `applySet(id, { projectPath? })`
- `snapshotSet({ name, scope, projectPath?, targetKeys[] })`
- `setProjectPinnedSets(projectPath, setIds[])`

`planApplySet` and `applySet` delegate to the existing enable/disable
primitives. No new symlink code.

## Tests

Added to `test/core.test.js`:

1. Create / update / delete a global set; round-trips through
   `config.json`.
2. Project-local set persists in
   `<project>/.agent-skill-manager/sets.json` and is returned only when
   `listSets` is called with that `projectPath`.
3. `planApplySet` returns correct `toEnable`, `toDisable`, and `missing`
   for the touched targets, and does not include untouched targets in the
   result.
4. `applySet` leaves each touched target's managed symlinks exactly
   matching the set's entries.
5. `applySet` does not touch the symlinks of targets the set does not
   reference.
6. A set entry whose skill is missing from the vault produces a warning
   but does not block the rest of the apply.
7. Mid-apply failure (simulated permission error on one target) stops
   execution; earlier targets remain applied, later targets remain
   untouched, response reports per-target status.
8. `snapshotSet` captures current managed symlinks for the chosen targets
   and the resulting set, when re-applied, is a no-op.
9. `setProjectPinnedSets` round-trips through `config.json`; ids
   referencing a deleted set are returned by `listSets` flagged as
   missing rather than dropped.

Browser code in `public/app.js` continues to be exercised manually, same
as the rest of the UI today.

## Out of scope (future work)

- Auto-apply on project load.
- Multi-set composition / layering.
- Importing remote shared sets over HTTP.
- Set-level versioning or history.
