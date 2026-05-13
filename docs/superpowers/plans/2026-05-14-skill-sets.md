# Skill Sets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add saveable, switchable sets of `(skill, target)` pairs to the Agent Skill Manager, with global and project-local scopes, project pinning, and a plan-then-apply UI flow.

**Architecture:** A new `src/sets.js` module owns set persistence (global → `~/.agent-skill-manager/config.json`, project-local → `<project>/.agent-skill-manager/sets.json`) and exposes `listSets / getSet / createSet / updateSet / deleteSet / planApplySet / applySet / snapshotSet / setProjectPinnedSets`. The manager in `src/core.js` re-exports these methods, delegating the apply primitive work to the existing `enableSkill` / `disableSkill` / `discoverSkills` helpers. Server endpoints in `src/server.js` thinly dispatch to the manager. The browser UI gains a "Sets" tab, an apply-preview modal, project-row pinning controls, and a `Applied: <name>` drift pill above the matrix.

**Tech Stack:** Node.js ≥20, `node:test`, dependency-light vanilla browser UI (no build step). All existing patterns continue: atomic JSON writes via `writeJson`, manager methods return updated `state` where the UI needs it.

---

## File Structure

**Create:**
- `agent-skill-manager/src/sets.js` — set storage + plan/apply/snapshot logic.

**Modify:**
- `agent-skill-manager/src/core.js` — wire `createManager` to call into `sets.js`; add `pinnedSetIds` to `normalizeProjectRecords` and `buildProjectRecord`; export the new manager methods.
- `agent-skill-manager/src/server.js` — add HTTP endpoints (`/api/sets*`, `/api/projects/pinned-sets`).
- `agent-skill-manager/public/index.html` — add "Sets" tab nav button, Sets panel markup, apply-preview modal, pinned-sets UI on project rows, drift pill above matrix.
- `agent-skill-manager/public/app.js` — render Sets tab, editor, modal, pinned-sets controls, drift pill; wire to API.
- `agent-skill-manager/public/styles.css` — styling for the above.
- `agent-skill-manager/test/core.test.js` — new tests (see Tasks 1–8).

**Conventions to follow:**
- `targetKey` ≡ the manager's existing `target.id` (e.g. `"claude-global"`, `"codex-project"`, `"custom-abc123"`).
- Set IDs: `set_` + 12 random hex chars (use `crypto.randomBytes`).
- Set objects are stored verbatim; renormalize on load to drop unknown keys.
- **DOM rendering uses `document.createElement` + `textContent` / `appendChild`.** Do not use `innerHTML` for any new code — it's an XSS risk and the existing codebase should be matched-or-better, not worse.
- All manager methods that mutate state return `{ ...result, state: await getState(projectPath) }` so the UI can re-render in one round-trip (same shape as existing methods).

---

### Task 1: Sets module skeleton — load / save / list

**Files:**
- Create: `agent-skill-manager/src/sets.js`
- Test: `agent-skill-manager/test/core.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/core.test.js`:

```js
test("lists global sets from config.json and project-local sets from sets.json", async () => {
  const env = await makeEnv(); // helper defined below
  await fs.writeFile(
    path.join(env.appHome, "config.json"),
    JSON.stringify({
      vaultRoot: env.vault,
      sets: [
        {
          id: "set_g1",
          name: "Global one",
          scope: "global",
          entries: [{ skillName: "alpha", targetKey: "claude-global" }],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    }),
  );
  const projectSetsDir = path.join(env.project, ".agent-skill-manager");
  await fs.mkdir(projectSetsDir, { recursive: true });
  await fs.writeFile(
    path.join(projectSetsDir, "sets.json"),
    JSON.stringify({
      sets: [
        {
          id: "set_p1",
          name: "Project one",
          scope: "project",
          entries: [{ skillName: "beta", targetKey: "claude-project" }],
          createdAt: "2026-01-02T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
      ],
    }),
  );

  const manager = createManager({ appHome: env.appHome });
  const result = await manager.listSets({ projectPath: env.project });
  assert.equal(result.global.length, 1);
  assert.equal(result.global[0].id, "set_g1");
  assert.equal(result.project.length, 1);
  assert.equal(result.project[0].id, "set_p1");
});
```

Also add this helper near the bottom of the test file (reused by later tasks):

```js
async function makeEnv() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-sets-"));
  const appHome = path.join(root, "app");
  const vault = path.join(appHome, "vault");
  const project = path.join(root, "project");
  await fs.mkdir(vault, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  return { root, appHome, vault, project };
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent-skill-manager && npm test -- --test-name-pattern "lists global sets"
```
Expected: FAIL with `manager.listSets is not a function`.

- [ ] **Step 3: Create the sets module**

Create `src/sets.js`:

```js
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const PROJECT_SETS_DIR = ".agent-skill-manager";
const PROJECT_SETS_FILE = "sets.json";

function newSetId() {
  return "set_" + crypto.randomBytes(6).toString("hex");
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const skillName = typeof entry.skillName === "string" ? entry.skillName.trim() : "";
    const targetKey = typeof entry.targetKey === "string" ? entry.targetKey.trim() : "";
    if (!skillName || !targetKey) continue;
    const key = `${skillName} ${targetKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ skillName, targetKey });
  }
  return result;
}

function normalizeSet(raw, scope, projectPath) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && raw.id ? raw.id : newSetId();
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return null;
  const now = new Date().toISOString();
  return {
    id,
    name,
    scope,
    ...(scope === "project" ? { projectPath } : {}),
    entries: normalizeEntries(raw.entries),
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now,
  };
}

function projectSetsPath(projectPath) {
  return path.join(projectPath, PROJECT_SETS_DIR, PROJECT_SETS_FILE);
}

async function readProjectSets(projectPath) {
  if (!projectPath) return [];
  try {
    const raw = await fs.readFile(projectSetsPath(projectPath), "utf8");
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed.sets) ? parsed.sets : [];
    return arr.map((s) => normalizeSet(s, "project", projectPath)).filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeProjectSets(projectPath, sets) {
  const filePath = projectSetsPath(projectPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify({ sets }, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

function listGlobalSets(config) {
  const arr = Array.isArray(config.sets) ? config.sets : [];
  return arr.map((s) => normalizeSet(s, "global")).filter(Boolean);
}

module.exports = {
  newSetId,
  normalizeSet,
  normalizeEntries,
  listGlobalSets,
  readProjectSets,
  writeProjectSets,
  projectSetsPath,
};
```

- [ ] **Step 4: Wire `listSets` into the manager**

In `src/core.js`, add the `require` near the top:

```js
const setsModule = require("./sets");
```

Update `readConfig` to surface `sets`. In the returned object inside `readConfig`, add:

```js
sets: Array.isArray(config.sets) ? config.sets : [],
```

Update `writeConfig` so `sets` persists when passed. In the `merged` object inside `writeConfig`, add:

```js
sets: Array.isArray(nextConfig.sets) ? nextConfig.sets : current.sets,
```

Inside `createManager`, before the `return { ... }` at the bottom, add:

```js
async function listSets({ projectPath } = {}) {
  const config = await readConfig();
  const global = setsModule.listGlobalSets({ sets: config.sets });
  const project = projectPath ? await setsModule.readProjectSets(projectPath) : [];
  return { global, project };
}
```

Add `listSets` to the manager's returned object.

- [ ] **Step 5: Run test to verify it passes**

```bash
cd agent-skill-manager && npm test -- --test-name-pattern "lists global sets"
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sets.js src/core.js test/core.test.js
git commit -m "Add sets module skeleton with listSets (Sets Phase 1)"
```

---

### Task 2: createSet + getSet

**Files:**
- Modify: `agent-skill-manager/src/core.js`
- Test: `agent-skill-manager/test/core.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("creates a global set and a project-local set and getSet returns them", async () => {
  const env = await makeEnv();
  const manager = createManager({ appHome: env.appHome });

  const g = await manager.createSet({
    name: "Global mode",
    scope: "global",
    entries: [{ skillName: "alpha", targetKey: "claude-global" }],
  });
  assert.ok(g.set.id.startsWith("set_"));
  assert.equal(g.set.scope, "global");
  assert.equal(g.set.entries.length, 1);

  const p = await manager.createSet({
    name: "Project mode",
    scope: "project",
    projectPath: env.project,
    entries: [
      { skillName: "beta", targetKey: "claude-project" },
      { skillName: "beta", targetKey: "claude-project" }, // duplicate dropped
    ],
  });
  assert.equal(p.set.scope, "project");
  assert.equal(p.set.entries.length, 1);

  const fetchedG = await manager.getSet(g.set.id, { projectPath: env.project });
  assert.equal(fetchedG.name, "Global mode");

  const fetchedP = await manager.getSet(p.set.id, { projectPath: env.project });
  assert.equal(fetchedP.name, "Project mode");

  await assert.rejects(
    () => manager.getSet("set_missing", { projectPath: env.project }),
    /Unknown set/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent-skill-manager && npm test -- --test-name-pattern "creates a global set"
```
Expected: FAIL with `manager.createSet is not a function`.

- [ ] **Step 3: Implement `createSet` and `getSet`**

In `createManager`, add after `listSets`:

```js
async function createSet({ name, scope, projectPath, entries }) {
  if (!name || !name.trim()) throw new Error("Set name is required");
  if (scope !== "global" && scope !== "project") throw new Error("Invalid scope");
  if (scope === "project" && !projectPath) throw new Error("projectPath required for project-scoped set");

  const now = new Date().toISOString();
  const record = {
    id: setsModule.newSetId(),
    name: name.trim(),
    scope,
    ...(scope === "project" ? { projectPath: normalizeProjectPath(projectPath) } : {}),
    entries: setsModule.normalizeEntries(entries),
    createdAt: now,
    updatedAt: now,
  };

  if (scope === "global") {
    const config = await readConfig();
    const nextSets = [...config.sets, record];
    await writeConfig({ ...config, sets: nextSets });
  } else {
    const projectSets = await setsModule.readProjectSets(projectPath);
    await setsModule.writeProjectSets(projectPath, [...projectSets, record]);
  }

  return { set: record, state: await getState(projectPath || process.cwd()) };
}

async function getSet(id, { projectPath } = {}) {
  const { global, project } = await listSets({ projectPath });
  const match = [...global, ...project].find((s) => s.id === id);
  if (!match) throw new Error(`Unknown set: ${id}`);
  return match;
}
```

Add both methods to the manager's returned object.

- [ ] **Step 4: Run test**

```bash
cd agent-skill-manager && npm test -- --test-name-pattern "creates a global set"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core.js test/core.test.js
git commit -m "Add createSet and getSet (Sets Phase 2)"
```

---

### Task 3: updateSet + deleteSet

**Files:**
- Modify: `agent-skill-manager/src/core.js`
- Test: `agent-skill-manager/test/core.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("updates and deletes sets in both scopes", async () => {
  const env = await makeEnv();
  const manager = createManager({ appHome: env.appHome });

  const g = (await manager.createSet({
    name: "G",
    scope: "global",
    entries: [{ skillName: "alpha", targetKey: "claude-global" }],
  })).set;
  const p = (await manager.createSet({
    name: "P",
    scope: "project",
    projectPath: env.project,
    entries: [{ skillName: "beta", targetKey: "claude-project" }],
  })).set;

  const updated = await manager.updateSet(g.id, {
    name: "G renamed",
    entries: [
      { skillName: "alpha", targetKey: "claude-global" },
      { skillName: "gamma", targetKey: "codex-global" },
    ],
  }, { projectPath: env.project });
  assert.equal(updated.set.name, "G renamed");
  assert.equal(updated.set.entries.length, 2);
  assert.notEqual(updated.set.updatedAt, g.updatedAt);
  assert.equal(updated.set.createdAt, g.createdAt);

  await manager.deleteSet(p.id, { projectPath: env.project });
  const after = await manager.listSets({ projectPath: env.project });
  assert.equal(after.project.length, 0);
  assert.equal(after.global.length, 1);
  assert.equal(after.global[0].name, "G renamed");

  await assert.rejects(
    () => manager.updateSet("set_missing", { name: "x" }, { projectPath: env.project }),
    /Unknown set/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent-skill-manager && npm test -- --test-name-pattern "updates and deletes sets"
```
Expected: FAIL with `manager.updateSet is not a function`.

- [ ] **Step 3: Implement `updateSet` and `deleteSet`**

```js
async function updateSet(id, patch, { projectPath } = {}) {
  const config = await readConfig();
  const globalIdx = config.sets.findIndex((s) => s.id === id);
  if (globalIdx !== -1) {
    const existing = config.sets[globalIdx];
    const next = {
      ...existing,
      ...(patch.name !== undefined ? { name: String(patch.name).trim() } : {}),
      ...(patch.entries !== undefined ? { entries: setsModule.normalizeEntries(patch.entries) } : {}),
      updatedAt: new Date().toISOString(),
    };
    const nextSets = [...config.sets];
    nextSets[globalIdx] = next;
    await writeConfig({ ...config, sets: nextSets });
    return { set: next, state: await getState(projectPath || process.cwd()) };
  }

  if (projectPath) {
    const projectSets = await setsModule.readProjectSets(projectPath);
    const idx = projectSets.findIndex((s) => s.id === id);
    if (idx !== -1) {
      const existing = projectSets[idx];
      const next = {
        ...existing,
        ...(patch.name !== undefined ? { name: String(patch.name).trim() } : {}),
        ...(patch.entries !== undefined ? { entries: setsModule.normalizeEntries(patch.entries) } : {}),
        updatedAt: new Date().toISOString(),
      };
      const nextSets = [...projectSets];
      nextSets[idx] = next;
      await setsModule.writeProjectSets(projectPath, nextSets);
      return { set: next, state: await getState(projectPath) };
    }
  }

  throw new Error(`Unknown set: ${id}`);
}

async function deleteSet(id, { projectPath } = {}) {
  const config = await readConfig();
  if (config.sets.some((s) => s.id === id)) {
    const nextSets = config.sets.filter((s) => s.id !== id);
    await writeConfig({ ...config, sets: nextSets });
    return { deletedId: id, state: await getState(projectPath || process.cwd()) };
  }

  if (projectPath) {
    const projectSets = await setsModule.readProjectSets(projectPath);
    if (projectSets.some((s) => s.id === id)) {
      await setsModule.writeProjectSets(projectPath, projectSets.filter((s) => s.id !== id));
      return { deletedId: id, state: await getState(projectPath) };
    }
  }

  throw new Error(`Unknown set: ${id}`);
}
```

Add both to the manager's returned object.

- [ ] **Step 4: Run test**

```bash
cd agent-skill-manager && npm test -- --test-name-pattern "updates and deletes sets"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core.js test/core.test.js
git commit -m "Add updateSet and deleteSet (Sets Phase 3)"
```

---

### Task 4: planApplySet — dry-run with toEnable / toDisable / missing

**Files:**
- Modify: `agent-skill-manager/src/core.js`
- Test: `agent-skill-manager/test/core.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("planApplySet computes toEnable/toDisable/missing per touched target only", async () => {
  const env = await makeEnv();
  await writeSkill(path.join(env.vault, "alpha"), "alpha", "alpha desc");
  await writeSkill(path.join(env.vault, "beta"), "beta", "beta desc");
  await writeSkill(path.join(env.vault, "gamma"), "gamma", "gamma desc");

  const manager = createManager({ appHome: env.appHome, homeDir: env.root });

  await manager.toggleSkill({ projectPath: env.project, targetId: "claude-global", skillId: "alpha", enabled: true });
  await manager.toggleSkill({ projectPath: env.project, targetId: "codex-global", skillId: "gamma", enabled: true });

  const created = await manager.createSet({
    name: "S",
    scope: "global",
    entries: [
      { skillName: "alpha", targetKey: "claude-global" },     // already enabled
      { skillName: "beta",  targetKey: "claude-global" },     // toEnable
      { skillName: "ghost", targetKey: "claude-global" },     // missing
    ],
  });

  const plan = await manager.planApplySet(created.set.id, { projectPath: env.project });
  const claude = plan.targets.find((t) => t.targetId === "claude-global");
  assert.deepEqual(claude.toEnable, ["beta"]);
  assert.deepEqual(claude.toDisable, []);
  assert.deepEqual(claude.missing, ["ghost"]);

  // codex-global is untouched
  assert.equal(plan.targets.find((t) => t.targetId === "codex-global"), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent-skill-manager && npm test -- --test-name-pattern "planApplySet computes"
```
Expected: FAIL with `manager.planApplySet is not a function`.

- [ ] **Step 3: Implement `planApplySet`**

```js
async function planApplySet(id, { projectPath } = {}) {
  const set = await getSet(id, { projectPath });
  const config = await readConfig();
  const skills = await discoverSkills(config.vaultRoot);
  const skillsByName = new Map(skills.map((s) => [s.name, s]));
  const targets = buildTargets(
    normalizeProjectPath(projectPath || process.cwd()),
    homeDir,
    config.customTargets,
  );
  const targetsById = new Map(targets.map((t) => [t.id, t]));

  const byTarget = new Map();
  for (const entry of set.entries) {
    if (!byTarget.has(entry.targetKey)) byTarget.set(entry.targetKey, []);
    byTarget.get(entry.targetKey).push(entry);
  }

  const result = { setId: id, name: set.name, targets: [] };
  for (const [targetKey, entries] of byTarget) {
    const target = targetsById.get(targetKey);
    if (!target) {
      result.targets.push({
        targetId: targetKey,
        targetLabel: targetKey,
        missingTarget: true,
        toEnable: [],
        toDisable: [],
        missing: entries.map((e) => e.skillName),
      });
      continue;
    }
    const manifest = await readManifest(target.path);
    const currentlyEnabledNames = new Set();
    for (const skillId of Object.keys(manifest.managedLinks || {})) {
      const s = skills.find((sk) => sk.id === skillId);
      if (s) currentlyEnabledNames.add(s.name);
    }
    const desiredNames = new Set();
    const missing = [];
    for (const entry of entries) {
      if (!skillsByName.has(entry.skillName)) missing.push(entry.skillName);
      else desiredNames.add(entry.skillName);
    }
    const toEnable = [...desiredNames].filter((n) => !currentlyEnabledNames.has(n));
    const toDisable = [...currentlyEnabledNames].filter((n) => !desiredNames.has(n));
    result.targets.push({
      targetId: target.id,
      targetLabel: target.label,
      toEnable,
      toDisable,
      missing,
    });
  }

  return result;
}
```

`readManifest` is already a top-level function in `core.js`. Add `planApplySet` to the manager's returned object.

- [ ] **Step 4: Run test**

```bash
cd agent-skill-manager && npm test -- --test-name-pattern "planApplySet computes"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core.js test/core.test.js
git commit -m "Add planApplySet dry-run (Sets Phase 4)"
```

---

### Task 5: applySet — execute, replace-within-touched, leave others alone

**Files:**
- Modify: `agent-skill-manager/src/core.js`
- Test: `agent-skill-manager/test/core.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("applySet leaves touched targets matching the set and untouched targets alone", async () => {
  const env = await makeEnv();
  await writeSkill(path.join(env.vault, "alpha"), "alpha", "alpha desc");
  await writeSkill(path.join(env.vault, "beta"), "beta", "beta desc");
  await writeSkill(path.join(env.vault, "gamma"), "gamma", "gamma desc");

  const manager = createManager({ appHome: env.appHome, homeDir: env.root });

  await manager.toggleSkill({ projectPath: env.project, targetId: "claude-global", skillId: "alpha", enabled: true });
  await manager.toggleSkill({ projectPath: env.project, targetId: "claude-global", skillId: "gamma", enabled: true });
  await manager.toggleSkill({ projectPath: env.project, targetId: "codex-global", skillId: "gamma", enabled: true });

  const created = await manager.createSet({
    name: "S",
    scope: "global",
    entries: [
      { skillName: "alpha", targetKey: "claude-global" },
      { skillName: "beta",  targetKey: "claude-global" },
    ],
  });

  const result = await manager.applySet(created.set.id, { projectPath: env.project });

  const stateClaude = result.state.targets.find((t) => t.id === "claude-global");
  const enabledNamesClaude = stateClaude.enabledSkillIds
    .map((sid) => result.state.skills.find((sk) => sk.id === sid)?.name)
    .sort();
  assert.deepEqual(enabledNamesClaude, ["alpha", "beta"]);

  const stateCodex = result.state.targets.find((t) => t.id === "codex-global");
  const enabledNamesCodex = stateCodex.enabledSkillIds
    .map((sid) => result.state.skills.find((sk) => sk.id === sid)?.name);
  assert.deepEqual(enabledNamesCodex, ["gamma"]);
});

test("applySet skips missing skills but applies the rest, surfacing a warning", async () => {
  const env = await makeEnv();
  await writeSkill(path.join(env.vault, "alpha"), "alpha", "alpha desc");

  const manager = createManager({ appHome: env.appHome, homeDir: env.root });
  const created = await manager.createSet({
    name: "S",
    scope: "global",
    entries: [
      { skillName: "alpha", targetKey: "claude-global" },
      { skillName: "ghost", targetKey: "claude-global" },
    ],
  });

  const result = await manager.applySet(created.set.id, { projectPath: env.project });
  assert.equal(result.warnings.some((w) => w.includes("ghost")), true);
  const claudeState = result.state.targets.find((t) => t.id === "claude-global");
  const enabledNames = claudeState.enabledSkillIds.map((sid) => result.state.skills.find((sk) => sk.id === sid)?.name);
  assert.deepEqual(enabledNames, ["alpha"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd agent-skill-manager && npm test -- --test-name-pattern "applySet"
```
Expected: FAIL with `manager.applySet is not a function`.

- [ ] **Step 3: Implement `applySet`**

```js
async function applySet(id, { projectPath } = {}) {
  const plan = await planApplySet(id, { projectPath });
  const config = await readConfig();
  const skills = await discoverSkills(config.vaultRoot);
  const skillsByName = new Map(skills.map((s) => [s.name, s]));
  const targets = buildTargets(
    normalizeProjectPath(projectPath || process.cwd()),
    homeDir,
    config.customTargets,
  );
  const targetsById = new Map(targets.map((t) => [t.id, t]));

  const perTargetResult = [];
  const warnings = [];

  for (const targetPlan of plan.targets) {
    if (targetPlan.missingTarget) {
      perTargetResult.push({ targetId: targetPlan.targetId, status: "skipped", reason: "Unknown target" });
      warnings.push(`Target ${targetPlan.targetId} not found; skipped`);
      continue;
    }
    if (targetPlan.missing.length) {
      warnings.push(`Skipped missing skills in ${targetPlan.targetLabel}: ${targetPlan.missing.join(", ")}`);
    }
    const target = targetsById.get(targetPlan.targetId);
    try {
      for (const skillName of targetPlan.toDisable) {
        const s = skills.find((sk) => sk.name === skillName);
        if (s) await disableSkill(target, s);
      }
      for (const skillName of targetPlan.toEnable) {
        const s = skillsByName.get(skillName);
        if (s) await enableSkill(target, s);
      }
      perTargetResult.push({ targetId: targetPlan.targetId, status: "applied" });
    } catch (error) {
      perTargetResult.push({
        targetId: targetPlan.targetId,
        status: "failed",
        reason: error.message || "Apply failed",
      });
      break; // stop on first failure
    }
  }

  return {
    plan,
    perTargetResult,
    warnings,
    state: await getState(projectPath || process.cwd()),
  };
}
```

Add `applySet` to the manager's returned object.

- [ ] **Step 4: Run tests**

```bash
cd agent-skill-manager && npm test -- --test-name-pattern "applySet"
```
Expected: BOTH PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core.js test/core.test.js
git commit -m "Add applySet with replace-within-touched semantics (Sets Phase 5)"
```

---

### Task 6: applySet stops on mid-apply failure

**Files:**
- Modify: `agent-skill-manager/test/core.test.js`

Pins the partial-failure posture implemented in Task 5.

- [ ] **Step 1: Write the failing test**

```js
test("applySet stops on mid-apply failure, leaving later targets untouched", async () => {
  const env = await makeEnv();
  await writeSkill(path.join(env.vault, "alpha"), "alpha", "alpha desc");

  const manager = createManager({ appHome: env.appHome, homeDir: env.root });

  // Block enable in claude-global by pre-placing a regular file at the link path
  const claudeGlobalDir = path.join(env.root, ".claude", "skills");
  await fs.mkdir(claudeGlobalDir, { recursive: true });
  await fs.writeFile(path.join(claudeGlobalDir, "alpha"), "not a symlink", "utf8");

  const created = await manager.createSet({
    name: "S",
    scope: "global",
    entries: [
      { skillName: "alpha", targetKey: "claude-global" },
      { skillName: "alpha", targetKey: "codex-global" },
    ],
  });

  const result = await manager.applySet(created.set.id, { projectPath: env.project });
  const claude = result.perTargetResult.find((t) => t.targetId === "claude-global");
  const codex = result.perTargetResult.find((t) => t.targetId === "codex-global");
  assert.equal(claude.status, "failed");
  assert.equal(codex, undefined, "codex-global should not have been processed after failure");
});
```

- [ ] **Step 2: Run the test**

```bash
cd agent-skill-manager && npm test -- --test-name-pattern "applySet stops on mid-apply"
```
Expected: PASS (behavior was implemented in Task 5).

- [ ] **Step 3: Commit**

```bash
git add test/core.test.js
git commit -m "Pin applySet stop-on-failure behavior (Sets Phase 6)"
```

---

### Task 7: snapshotSet

**Files:**
- Modify: `agent-skill-manager/src/core.js`
- Test: `agent-skill-manager/test/core.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("snapshotSet captures current managed symlinks and re-applies as a no-op", async () => {
  const env = await makeEnv();
  await writeSkill(path.join(env.vault, "alpha"), "alpha", "alpha desc");
  await writeSkill(path.join(env.vault, "beta"), "beta", "beta desc");

  const manager = createManager({ appHome: env.appHome, homeDir: env.root });
  await manager.toggleSkill({ projectPath: env.project, targetId: "claude-global", skillId: "alpha", enabled: true });
  await manager.toggleSkill({ projectPath: env.project, targetId: "codex-global", skillId: "beta",  enabled: true });

  const snap = await manager.snapshotSet({
    name: "Snapshot",
    scope: "global",
    targetKeys: ["claude-global", "codex-global"],
    projectPath: env.project,
  });
  const names = snap.set.entries.map((e) => `${e.skillName}@${e.targetKey}`).sort();
  assert.deepEqual(names, ["alpha@claude-global", "beta@codex-global"]);

  const re = await manager.applySet(snap.set.id, { projectPath: env.project });
  for (const t of re.perTargetResult) assert.equal(t.status, "applied");
  assert.deepEqual(re.warnings, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent-skill-manager && npm test -- --test-name-pattern "snapshotSet captures"
```
Expected: FAIL with `manager.snapshotSet is not a function`.

- [ ] **Step 3: Implement `snapshotSet`**

```js
async function snapshotSet({ name, scope, projectPath, targetKeys }) {
  if (!Array.isArray(targetKeys) || targetKeys.length === 0) {
    throw new Error("targetKeys must be a non-empty array");
  }
  const config = await readConfig();
  const skills = await discoverSkills(config.vaultRoot);
  const skillsById = new Map(skills.map((s) => [s.id, s]));
  const targets = buildTargets(
    normalizeProjectPath(projectPath || process.cwd()),
    homeDir,
    config.customTargets,
  );
  const targetsById = new Map(targets.map((t) => [t.id, t]));

  const entries = [];
  for (const targetKey of targetKeys) {
    const target = targetsById.get(targetKey);
    if (!target) continue;
    const manifest = await readManifest(target.path);
    for (const skillId of Object.keys(manifest.managedLinks || {})) {
      const s = skillsById.get(skillId);
      if (s) entries.push({ skillName: s.name, targetKey });
    }
  }

  return createSet({ name, scope, projectPath, entries });
}
```

Add `snapshotSet` to the manager's returned object.

- [ ] **Step 4: Run test**

```bash
cd agent-skill-manager && npm test -- --test-name-pattern "snapshotSet captures"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core.js test/core.test.js
git commit -m "Add snapshotSet (Sets Phase 7)"
```

---

### Task 8: Project pinning — store + surface missing

**Files:**
- Modify: `agent-skill-manager/src/core.js`
- Test: `agent-skill-manager/test/core.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("setProjectPinnedSets persists and missing ids are flagged on listSets", async () => {
  const env = await makeEnv();
  const manager = createManager({ appHome: env.appHome });
  const g = (await manager.createSet({
    name: "Pinned",
    scope: "global",
    entries: [{ skillName: "alpha", targetKey: "claude-global" }],
  })).set;

  await manager.addProject(env.project);
  await manager.setProjectPinnedSets(env.project, [g.id, "set_missing"]);

  const result = await manager.listSets({ projectPath: env.project });
  assert.deepEqual(result.pinned.ids, [g.id, "set_missing"]);
  assert.deepEqual(result.pinned.missing, ["set_missing"]);
  assert.equal(result.pinned.resolved.length, 1);
  assert.equal(result.pinned.resolved[0].id, g.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent-skill-manager && npm test -- --test-name-pattern "setProjectPinnedSets persists"
```
Expected: FAIL.

- [ ] **Step 3: Extend project records with `pinnedSetIds`**

In `src/core.js`, replace the pushed object inside `normalizeProjectRecords` with:

```js
normalized.push({
  path: projectPath,
  name: record.name || path.basename(projectPath) || projectPath,
  source: record.source || "manual",
  skillSourceCount: Number(record.skillSourceCount || 0),
  skillSources: Array.isArray(record.skillSources) ? record.skillSources : [],
  lastSeenAt: record.lastSeenAt || "",
  pinnedSetIds: Array.isArray(record.pinnedSetIds) ? record.pinnedSetIds.filter((v) => typeof v === "string") : [],
});
```

Update `buildProjectRecord` to default `pinnedSetIds: []`:

```js
return {
  path: normalized,
  name: options.name || path.basename(normalized) || normalized,
  source: options.source || "manual",
  skillSourceCount: skillSources.length,
  skillSources,
  lastSeenAt: new Date().toISOString(),
  pinnedSetIds: [],
};
```

- [ ] **Step 4: Implement `setProjectPinnedSets` and surface in `listSets`**

In `createManager`, add:

```js
async function setProjectPinnedSets(projectPath, setIds) {
  const normalized = normalizeProjectPath(projectPath);
  const ids = Array.isArray(setIds) ? setIds.filter((v) => typeof v === "string" && v) : [];
  const config = await readConfig();
  const projects = config.projects.slice();
  const idx = projects.findIndex((p) => p.path === normalized);
  if (idx === -1) {
    const record = await buildProjectRecord(normalized);
    projects.push({ ...record, pinnedSetIds: ids });
  } else {
    projects[idx] = { ...projects[idx], pinnedSetIds: ids };
  }
  await writeConfig({ ...config, projects });
  return { state: await getState(normalized) };
}
```

Replace `listSets` with the pinned-aware version:

```js
async function listSets({ projectPath } = {}) {
  const config = await readConfig();
  const global = setsModule.listGlobalSets({ sets: config.sets });
  const project = projectPath ? await setsModule.readProjectSets(projectPath) : [];
  let pinned = { ids: [], resolved: [], missing: [] };
  if (projectPath) {
    const normalized = normalizeProjectPath(projectPath);
    const projectRecord = config.projects.find((p) => p.path === normalized);
    const ids = projectRecord?.pinnedSetIds || [];
    const all = [...global, ...project];
    const resolved = [];
    const missing = [];
    for (const id of ids) {
      const match = all.find((s) => s.id === id);
      if (match) resolved.push(match);
      else missing.push(id);
    }
    pinned = { ids, resolved, missing };
  }
  return { global, project, pinned };
}
```

Add `setProjectPinnedSets` to the manager's returned object.

- [ ] **Step 5: Run test**

```bash
cd agent-skill-manager && npm test -- --test-name-pattern "setProjectPinnedSets persists"
```
Expected: PASS.

- [ ] **Step 6: Run the full test suite**

```bash
cd agent-skill-manager && npm test
```
Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core.js test/core.test.js
git commit -m "Add project pinning for sets with missing-id surfacing (Sets Phase 8)"
```

---

### Task 9: HTTP endpoints in `src/server.js`

**Files:**
- Modify: `agent-skill-manager/src/server.js`

Thin dispatch layer; no automated tests, verified by `curl`.

- [ ] **Step 1: Add the endpoints**

In `src/server.js`, inside `handleApi`, insert these blocks before the final `sendJson(response, 404, ...)` line:

```js
if (request.method === "GET" && url.pathname === "/api/sets") {
  const projectPath = url.searchParams.get("project") || initialProject;
  sendJson(response, 200, await manager.listSets({ projectPath }));
  return;
}

if (request.method === "POST" && url.pathname === "/api/sets") {
  const body = await readJsonBody(request);
  const result = await manager.createSet({
    name: body.name,
    scope: body.scope,
    projectPath: body.projectPath || (body.scope === "project" ? initialProject : undefined),
    entries: body.entries,
  });
  sendJson(response, 200, result);
  return;
}

if (request.method === "PATCH" && url.pathname.startsWith("/api/sets/")) {
  const id = url.pathname.slice("/api/sets/".length);
  const body = await readJsonBody(request);
  const result = await manager.updateSet(id, body, { projectPath: body.projectPath || initialProject });
  sendJson(response, 200, result);
  return;
}

if (request.method === "DELETE" && url.pathname.startsWith("/api/sets/")) {
  const id = url.pathname.slice("/api/sets/".length);
  const projectPath = url.searchParams.get("project") || initialProject;
  const result = await manager.deleteSet(id, { projectPath });
  sendJson(response, 200, result);
  return;
}

if (request.method === "POST" && url.pathname.match(/^\/api\/sets\/[^/]+\/plan$/)) {
  const id = url.pathname.split("/")[3];
  const body = await readJsonBody(request);
  const plan = await manager.planApplySet(id, { projectPath: body.projectPath || initialProject });
  sendJson(response, 200, plan);
  return;
}

if (request.method === "POST" && url.pathname.match(/^\/api\/sets\/[^/]+\/apply$/)) {
  const id = url.pathname.split("/")[3];
  const body = await readJsonBody(request);
  const result = await manager.applySet(id, { projectPath: body.projectPath || initialProject });
  sendJson(response, 200, result);
  return;
}

if (request.method === "POST" && url.pathname === "/api/sets/snapshot") {
  const body = await readJsonBody(request);
  const result = await manager.snapshotSet({
    name: body.name,
    scope: body.scope,
    projectPath: body.projectPath || (body.scope === "project" ? initialProject : undefined),
    targetKeys: body.targetKeys,
  });
  sendJson(response, 200, result);
  return;
}

if (request.method === "POST" && url.pathname === "/api/projects/pinned-sets") {
  const body = await readJsonBody(request);
  const result = await manager.setProjectPinnedSets(body.projectPath || initialProject, body.setIds || []);
  sendJson(response, 200, result);
  return;
}
```

- [ ] **Step 2: Smoke-test from the shell**

Start the server in the background:

```bash
cd agent-skill-manager && node src/server.js --host 127.0.0.1 --port 5179
```

In another shell:

```bash
curl -sS http://127.0.0.1:5179/api/sets | jq .
curl -sS -X POST http://127.0.0.1:5179/api/sets \
  -H 'content-type: application/json' \
  -d '{"name":"smoke","scope":"global","entries":[{"skillName":"x","targetKey":"claude-global"}]}' | jq .
curl -sS http://127.0.0.1:5179/api/sets | jq .
```

Expected: first call returns `{ "global": [], "project": [], "pinned": ... }`; second call returns the created set; third call shows it under `global`. Kill the server.

- [ ] **Step 3: Run the full test suite**

```bash
cd agent-skill-manager && npm test
```
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server.js
git commit -m "Wire HTTP endpoints for skill sets (Sets Phase 9)"
```

---

### Task 10: UI — Sets tab list + editor

**Files:**
- Modify: `agent-skill-manager/public/index.html`
- Modify: `agent-skill-manager/public/app.js`
- Modify: `agent-skill-manager/public/styles.css`

**DOM rule for this task and the next:** use `document.createElement` + `textContent` + `appendChild`. Do not use `innerHTML`. To clear a container, use `while (el.firstChild) el.removeChild(el.firstChild);`.

- [ ] **Step 1: Add the tab + panel markup**

In `index.html`, find the existing tab nav (Install / Manage). Add a new tab button between them:

```html
<button class="tab-btn" data-tab="sets" type="button">Sets</button>
```

Add a new panel after the Install panel, mirroring the `<section class="panel" data-panel="...">` pattern:

```html
<section class="panel" data-panel="sets" hidden>
  <div class="sets-layout">
    <aside class="sets-list">
      <header class="sets-list-header">
        <div class="sets-filter" role="tablist">
          <button type="button" class="chip is-active" data-sets-filter="all">All</button>
          <button type="button" class="chip" data-sets-filter="global">Global</button>
          <button type="button" class="chip" data-sets-filter="project">Project</button>
        </div>
        <div class="sets-actions">
          <button type="button" class="btn" data-action="set-new">New set</button>
          <button type="button" class="btn" data-action="set-snapshot">Snapshot current…</button>
        </div>
      </header>
      <ul class="sets-rows" data-sets-rows></ul>
    </aside>
    <article class="sets-editor" data-sets-editor>
      <p class="muted">Select a set on the left, or create a new one.</p>
    </article>
  </div>
</section>
```

- [ ] **Step 2: Add `setsState` and load helper**

Near other top-level `let` declarations in `app.js`, add:

```js
let setsState = {
  global: [],
  project: [],
  pinned: { ids: [], resolved: [], missing: [] },
  filter: "all",
  selectedId: null,
  draft: null,
};
```

Add:

```js
async function loadSets() {
  const project = encodeURIComponent(state.project?.path || "");
  const result = await fetch(`/api/sets?project=${project}`).then((r) => r.json());
  setsState.global = result.global;
  setsState.project = result.project;
  setsState.pinned = result.pinned;
}
```

Hook the new tab button into the existing tab-switching logic (look for how the other `data-tab` buttons are wired). When the tab activates, call `await loadSets()` then `renderSets()`.

- [ ] **Step 3: Implement `renderSets()` using safe DOM**

```js
function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function makeEl(tag, attrs = {}, text = "") {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "dataset") {
      for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
    } else el.setAttribute(k, v);
  }
  if (text) el.textContent = text;
  return el;
}

function summarizeTargets(entries) {
  return [...new Set(entries.map((e) => e.targetKey))].join(", ");
}

function renderSets() {
  const rowsEl = document.querySelector("[data-sets-rows]");
  const editorEl = document.querySelector("[data-sets-editor]");
  clearChildren(rowsEl);

  const all = [
    ...setsState.global.map((s) => ({ ...s, _scope: "global" })),
    ...setsState.project.map((s) => ({ ...s, _scope: "project" })),
  ];
  const filtered = all.filter((s) => setsState.filter === "all" || s._scope === setsState.filter);

  if (filtered.length === 0) {
    rowsEl.appendChild(makeEl("li", { class: "muted" }, "No sets yet."));
  } else {
    for (const s of filtered) {
      const li = makeEl("li", {
        class: "set-row" + (s.id === setsState.selectedId ? " is-selected" : ""),
        dataset: { setId: s.id },
      });
      li.appendChild(makeEl("div", { class: "set-row-name" }, s.name));
      const meta = makeEl("div", { class: "set-row-meta" });
      meta.appendChild(makeEl("span", { class: `badge badge-${s._scope}` }, s._scope));
      meta.appendChild(makeEl("span", { class: "muted" },
        `${s.entries.length} entr${s.entries.length === 1 ? "y" : "ies"}`));
      meta.appendChild(makeEl("span", { class: "muted" }, summarizeTargets(s.entries)));
      li.appendChild(meta);
      const actions = makeEl("div", { class: "set-row-actions" });
      actions.appendChild(makeEl("button", {
        type: "button", dataset: { action: "set-apply", id: s.id },
      }, "Apply"));
      actions.appendChild(makeEl("button", {
        type: "button", dataset: { action: "set-edit", id: s.id },
      }, "Edit"));
      actions.appendChild(makeEl("button", {
        type: "button", dataset: { action: "set-delete", id: s.id },
      }, "Delete"));
      li.appendChild(actions);
      rowsEl.appendChild(li);
    }
  }

  clearChildren(editorEl);
  if (!setsState.draft && !setsState.selectedId) {
    editorEl.appendChild(makeEl("p", { class: "muted" },
      "Select a set on the left, or create a new one."));
    return;
  }
  renderSetEditor(editorEl);
}
```

- [ ] **Step 4: Implement `renderSetEditor(editorEl)`**

The editor builds a `<form>` with:
- Name `<input type="text">` bound to `setsState.draft.name` via `input` event.
- Scope display (a `<span>` showing `setsState.draft.scope`; not editable when editing an existing set).
- An entries `<table>` where each row is a `<tr>` with:
  - A `<select>` for skill (options from `state.skills`, value = skill name).
  - A `<select>` for target (options from `state.targets`, value = `target.id`).
  - A "Remove" `<button>` that splices the entry out of `setsState.draft.entries` and re-renders.
- A "Add entry" `<button>` that pushes `{ skillName: "", targetKey: "" }` and re-renders.
- Save / Revert buttons in a footer.

Build all of this with `document.createElement` and `textContent` / `appendChild` — no `innerHTML`. On Save:

```js
async function saveDraft() {
  const draft = setsState.draft;
  const payload = {
    name: draft.name,
    scope: draft.scope,
    projectPath: draft.scope === "project" ? state.project.path : undefined,
    entries: draft.entries.filter((e) => e.skillName && e.targetKey),
  };
  const url = draft.id ? `/api/sets/${draft.id}` : "/api/sets";
  const method = draft.id ? "PATCH" : "POST";
  const result = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => r.json());
  setsState.draft = null;
  setsState.selectedId = result.set.id;
  await loadSets();
  renderSets();
}
```

- [ ] **Step 5: Wire filter chips, "New set", "Snapshot current…", and row actions**

Use event delegation on the panel root:

```js
document.querySelector('[data-panel="sets"]').addEventListener("click", async (event) => {
  const t = event.target.closest("[data-action], [data-sets-filter]");
  if (!t) return;
  if (t.dataset.setsFilter) {
    setsState.filter = t.dataset.setsFilter;
    document.querySelectorAll("[data-sets-filter]").forEach((b) => b.classList.toggle("is-active", b === t));
    renderSets();
    return;
  }
  const action = t.dataset.action;
  const id = t.dataset.id;
  if (action === "set-new") {
    setsState.draft = { id: null, name: "", scope: "global", entries: [] };
    setsState.selectedId = null;
    renderSets();
  } else if (action === "set-edit") {
    const s = [...setsState.global, ...setsState.project].find((x) => x.id === id);
    setsState.draft = { id: s.id, name: s.name, scope: s.scope, entries: s.entries.map((e) => ({ ...e })) };
    setsState.selectedId = s.id;
    renderSets();
  } else if (action === "set-delete") {
    if (!confirm("Delete this set?")) return;
    const project = encodeURIComponent(state.project?.path || "");
    await fetch(`/api/sets/${id}?project=${project}`, { method: "DELETE" });
    await loadSets();
    renderSets();
  } else if (action === "set-snapshot") {
    openSnapshotModal();
  }
});
```

Snapshot modal: build a `<dialog>` with `document.createElement` containing a name `<input>`, a `<fieldset>` of checkboxes (one per `state.targets`), and Confirm / Cancel. On Confirm, POST to `/api/sets/snapshot`.

- [ ] **Step 6: Styling**

In `styles.css`, append minimal styling that matches the existing visual language. Reuse existing variables.

- [ ] **Step 7: Manual verification**

```bash
cd agent-skill-manager && node src/server.js --host 127.0.0.1 --port 5179
```

Open `http://127.0.0.1:5179`, click **Sets**, create a set, edit it, delete it, snapshot. Confirm round-trips by also `curl`ing `/api/sets`.

- [ ] **Step 8: Run the full test suite**

```bash
cd agent-skill-manager && npm test
```
Expected: ALL PASS.

- [ ] **Step 9: Commit**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "Add Sets tab UI with list, editor, and snapshot (Sets Phase 10)"
```

---

### Task 11: UI — Apply modal + project pinning + drift pill

**Files:**
- Modify: `agent-skill-manager/public/index.html`
- Modify: `agent-skill-manager/public/app.js`
- Modify: `agent-skill-manager/public/styles.css`

Same DOM rule: `createElement` / `textContent` only, no `innerHTML`.

- [ ] **Step 1: Apply-preview modal markup**

Append in `index.html`, outside the tab panels:

```html
<dialog class="modal" data-modal="apply-set">
  <header class="modal-header">
    <h2 data-apply-title>Apply set</h2>
    <button type="button" class="modal-close" data-action="apply-cancel">×</button>
  </header>
  <div class="modal-body" data-apply-body>
    <p class="muted">Computing plan…</p>
  </div>
  <footer class="modal-footer">
    <button type="button" class="btn" data-action="apply-cancel">Cancel</button>
    <button type="button" class="btn btn-primary" data-action="apply-confirm" disabled>Apply</button>
  </footer>
</dialog>
```

- [ ] **Step 2: Modal logic in `app.js`**

Add top-level state:

```js
let pendingApplySetId = null;
let lastAppliedSet = null; // { id, name, touchedTargets, modified }
```

```js
async function openApplyModal(setId) {
  pendingApplySetId = setId;
  const modal = document.querySelector('[data-modal="apply-set"]');
  const body = modal.querySelector("[data-apply-body]");
  const title = modal.querySelector("[data-apply-title]");
  const confirm = modal.querySelector('[data-action="apply-confirm"]');
  confirm.disabled = true;
  clearChildren(body);
  body.appendChild(makeEl("p", { class: "muted" }, "Computing plan…"));
  modal.showModal();

  const projectPath = state.project?.path || "";
  const plan = await fetch(`/api/sets/${setId}/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectPath }),
  }).then((r) => r.json());

  title.textContent = `Apply set: ${plan.name}`;
  clearChildren(body);

  if (plan.targets.length === 0) {
    body.appendChild(makeEl("p", { class: "muted" }, "This set has no entries — nothing to apply."));
    return;
  }

  for (const t of plan.targets) {
    const section = makeEl("section", { class: "apply-target" });
    section.appendChild(makeEl("h3", {}, t.targetLabel || t.targetId));
    const list = makeEl("ul", { class: "apply-list" });
    for (const n of t.toEnable) list.appendChild(makeEl("li", { class: "apply-add" }, `+ ${n}`));
    for (const n of t.toDisable) list.appendChild(makeEl("li", { class: "apply-rm" }, `− ${n}`));
    for (const n of t.missing) list.appendChild(makeEl("li", { class: "apply-warn" }, `⚠ missing: ${n}`));
    section.appendChild(list);
    body.appendChild(section);
  }
  confirm.disabled = false;
}
```

Global click handler:

```js
document.addEventListener("click", async (event) => {
  const t = event.target.closest("[data-action]");
  if (!t) return;
  const action = t.dataset.action;
  if (action === "apply-cancel") {
    document.querySelector('[data-modal="apply-set"]').close();
    pendingApplySetId = null;
  } else if (action === "apply-confirm" && pendingApplySetId) {
    const setId = pendingApplySetId;
    const projectPath = state.project?.path || "";
    const result = await fetch(`/api/sets/${setId}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectPath }),
    }).then((r) => r.json());
    state = result.state;
    lastAppliedSet = {
      id: setId,
      name: result.plan.name,
      touchedTargets: result.plan.targets.map((tt) => tt.targetId),
      modified: false,
    };
    document.querySelector('[data-modal="apply-set"]').close();
    pendingApplySetId = null;
    render(); // existing top-level render
  } else if (action === "set-apply") {
    openApplyModal(t.dataset.id);
  }
});
```

- [ ] **Step 3: Drift pill above the matrix**

Find the matrix container in `index.html`. Immediately above its opening tag, add:

```html
<div class="drift-pill" data-drift hidden></div>
```

In `app.js`:

```js
function renderDrift() {
  const el = document.querySelector("[data-drift]");
  if (!lastAppliedSet) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = `Applied: ${lastAppliedSet.name}${lastAppliedSet.modified ? " (modified)" : ""}`;
}
```

Call `renderDrift()` from the existing top-level `render()` function (alongside other partial renders).

In the existing matrix `toggleSkill` click handler, after the toggle succeeds, add:

```js
if (lastAppliedSet && lastAppliedSet.touchedTargets.includes(targetId)) {
  lastAppliedSet.modified = true;
  renderDrift();
}
```

- [ ] **Step 4: Project pinned-sets controls in Manage tab**

For each project row in Manage, render (via `createElement`):

- A chip list of pinned sets, sourced from `setsState.pinned.resolved` when that project is the currently loaded project. Each chip is a `<span class="chip">` with the set name and an `×` button (`data-action="unpin-set"`, `data-id="<setId>"`).
- A `<select data-action="pin-set">` with an empty first option ("Pin set…") and options for every available set not already pinned.
- An `<select data-action="apply-pinned-set">` with the pinned sets as options. On change, call `openApplyModal(select.value)` then reset to the empty option.

Handlers (extend the global click/change delegation):

```js
// in the global event delegate
if (action === "unpin-set") {
  const next = setsState.pinned.ids.filter((x) => x !== t.dataset.id);
  await fetch("/api/projects/pinned-sets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectPath: state.project.path, setIds: next }),
  });
  await loadSets();
  render();
}
```

And a `change` listener for the pin/apply selects.

- [ ] **Step 5: Manual verification**

Run the server. Verify:
- Apply on a set with mixed enable/disable/missing entries shows the per-target plan, applying only on Confirm.
- After Apply, the `Applied: <name>` pill appears above the matrix.
- Editing the matrix within a touched target flips the pill to `Applied: <name> (modified)`.
- Pinning a set persists across server restart.
- Applying via the project's Apply-set dropdown opens the same modal.

- [ ] **Step 6: Run the full test suite**

```bash
cd agent-skill-manager && npm test
```
Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "Add apply modal, project pinning UI, and drift pill (Sets Phase 11)"
```

---

### Task 12: README documentation

**Files:**
- Modify: `agent-skill-manager/README.md`

- [ ] **Step 1: Append a new section after "Bulk Actions"**

```markdown
## Sets

Sets are saveable, switchable collections of `(skill, target)` pairs.

Scopes:

- **Global** — stored in `~/.agent-skill-manager/config.json` and shared across projects.
- **Project** — stored in `<project>/.agent-skill-manager/sets.json` and travel with the project.

Apply replaces state only in the targets the set references; targets the set
doesn't mention are left alone. Skills missing from the vault are skipped with
a warning rather than blocking the apply.

The Sets tab supports creating, editing, snapshotting the current state, and
applying. Each project in the Manage tab can pin multiple sets and apply any
of them with one click.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Document Sets in README (Sets Phase 12)"
```

---

## Self-Review

**Spec coverage:**
- Data model (set shape, storage locations, targetKey reuse, pinning by id) — Tasks 1, 2, 8.
- Apply semantics (replace within touched, leave untouched targets alone, missing skips with warning, no rollback) — Tasks 4, 5, 6.
- Snapshot as first-class operation — Task 7.
- HTTP endpoints — Task 9.
- UI Sets tab + editor + snapshot — Task 10.
- UI apply modal, project pinning, drift pill — Task 11.
- Spec tests 1–9 — Tasks 1, 2, 3, 4, 5, 5, 6, 7, 8.
- README — Task 12.

**Placeholder scan:** No TBDs, no "implement appropriate error handling," no unspecified test bodies. Every code-changing step shows the actual code.

**Type consistency:**
- `listSets` returns `{ global, project, pinned }` everywhere (Tasks 1, 8, 10, 11).
- `createSet`/`updateSet` return `{ set, state }` (Tasks 2, 3, 10).
- `applySet` returns `{ plan, perTargetResult, warnings, state }` (Tasks 5, 11).
- `planApplySet` returns `{ setId, name, targets: [{ targetId, targetLabel, toEnable, toDisable, missing }] }` (Tasks 4, 5, 11).
- Scope strings (`"global"` / `"project"`) match across all tasks.
- DOM rule (no `innerHTML`) stated up-front, applied consistently in Tasks 10 and 11.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-skill-sets.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
