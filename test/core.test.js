const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createManager,
  discoverSkills,
  discoverSources,
  findImportCandidates,
  parseFrontmatter,
  safeSegment,
} = require("../src/core");

test("parses simple skill frontmatter", () => {
  const metadata = parseFrontmatter(`---\nname: Swift Tools\ndescription: Use for Swift apps\n---\n\n# Body\n`);
  assert.deepEqual(metadata, {
    name: "Swift Tools",
    description: "Use for Swift apps",
  });
});

test("creates portable link names", () => {
  assert.equal(safeSegment("build-ios-apps:swiftui-ui-patterns"), "build-ios-apps-swiftui-ui-patterns");
  assert.equal(safeSegment("  ///  "), "skill");
});

test("discovers skills inside a vault", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-discover-"));
  const vault = path.join(root, "vault");
  await writeSkill(path.join(vault, "ios", "swiftui"), "SwiftUI Patterns", "Use for SwiftUI iOS views.");

  const skills = await discoverSkills(vault);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].id, "ios/swiftui");
  assert.equal(skills[0].name, "SwiftUI Patterns");
  assert.deepEqual(skills[0].tags, ["iOS"]);
});

test("discovers global directories, plugin caches, single-file configs, and project skill folders", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-source-discovery-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const appHome = path.join(home, ".agent-skill-manager");
  const vaultRoot = path.join(appHome, "vault");

  await writeSkill(path.join(home, ".codex", "skills", "global-web"), "Global Web", "Use for frontend work.");
  await writeSkill(path.join(home, ".codex", "plugins", "cache", "plugin-a", "skills", "plugin-ios"), "Plugin iOS", "Use for SwiftUI.");
  await writeSkill(path.join(project, ".agents", "skills", "project-api"), "Project API", "Use for backend APIs.");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "AGENTS.md"), "Project instructions", "utf8");

  const discovery = await discoverSources(project, { homeDir: home, appHome, vaultRoot });
  const byId = new Map(discovery.sources.map((source) => [source.id, source]));

  assert.equal(byId.get("codex-global-skills").skillCount, 1);
  assert.equal(byId.get("codex-global-skills").importable, true);
  assert.equal(byId.get("codex-plugin-cache").skillCount, 1);
  assert.equal(byId.get("codex-plugin-cache").importable, false);
  assert.equal(byId.get("project-agents-skills").skillCount, 1);
  assert.equal(byId.get("project-config-agents.md").configFileCount, 1);
  assert.equal(discovery.summary.skillCount, 3);
  assert.equal(discovery.summary.configFileCount, 1);

  const manager = createManager({ homeDir: home, appHome });
  const state = await manager.getState(project);
  assert.ok(state.suggestedImports.includes(path.join(home, ".codex", "skills")));
  assert.ok(state.suggestedImports.includes(path.join(project, ".agents", "skills")));
  assert.ok(!state.suggestedImports.includes(path.join(home, ".codex", "plugins", "cache")));
  assert.ok(!state.suggestedImports.includes(path.join(project, "AGENTS.md")));
});

test("adds projects manually and scans project roots with skill directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-project-scan-"));
  const home = path.join(root, "home");
  const appHome = path.join(home, ".agent-skill-manager");
  const projectA = path.join(root, "workspace", "app-a");
  const projectB = path.join(root, "workspace", "app-b");
  const globalSkills = path.join(home, ".agents", "skills");
  const pluginCache = path.join(home, ".codex", "plugins", "cache", "plugin-a", "skills");

  await writeSkill(path.join(projectA, ".agents", "skills", "agent-skill"), "Agent Skill", "Use in app A.");
  await writeSkill(path.join(projectB, "skills", "plain-skill"), "Plain Skill", "Use in app B.");
  await fs.mkdir(path.join(projectB, ".git"), { recursive: true });
  await writeSkill(path.join(globalSkills, "global-skill"), "Global Skill", "Global only.");
  await writeSkill(path.join(pluginCache, "plugin-skill"), "Plugin Skill", "Plugin owned.");

  const manager = createManager({ homeDir: home, appHome });
  await manager.addProject(projectA);
  let state = await manager.getState(projectA);
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0].path, projectA);
  assert.equal(state.projects[0].source, "manual");

  const result = await manager.scanProjects({
    roots: [root],
    maxDepth: 8,
    projectPath: projectA,
  });

  const projectPaths = result.state.projects.map((project) => project.path).sort();
  assert.deepEqual(projectPaths, [projectA, projectB].sort());
  assert.ok(!projectPaths.includes(home));
  assert.ok(!projectPaths.includes(path.dirname(path.dirname(pluginCache))));
  assert.equal(result.state.projects.find((project) => project.path === projectA).source, "manual");
  assert.equal(result.state.projects.find((project) => project.path === projectB).source, "scan");
});

test("enables and disables a project skill through a managed symlink", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-toggle-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const project = path.join(root, "project");

  await manager.writeConfig({ vaultRoot: vault, recentProjects: [] });
  await writeSkill(path.join(vault, "swiftui-patterns"), "SwiftUI Patterns", "Use for SwiftUI iOS views.");
  await fs.mkdir(project, { recursive: true });

  let state = await manager.getState(project);
  const skill = state.skills[0];
  await manager.toggleSkill({
    projectPath: project,
    targetId: "agents-project",
    skillId: skill.id,
    enabled: true,
  });

  const linkPath = path.join(project, ".agents", "skills", skill.linkName);
  const linkStat = await fs.lstat(linkPath);
  assert.equal(linkStat.isSymbolicLink(), true);

  state = await manager.getState(project);
  assert.equal(state.targets.find((target) => target.id === "agents-project").skillStatuses[skill.id].enabled, true);

  await manager.toggleSkill({
    projectPath: project,
    targetId: "agents-project",
    skillId: skill.id,
    enabled: false,
  });
  await assert.rejects(fs.lstat(linkPath), /ENOENT/);
});

test("refuses to replace unmanaged target directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-conflict-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const project = path.join(root, "project");

  await manager.writeConfig({ vaultRoot: vault, recentProjects: [] });
  await writeSkill(path.join(vault, "frontend"), "Frontend Design", "Use for React frontend work.");

  const state = await manager.getState(project);
  const skill = state.skills[0];
  await fs.mkdir(path.join(project, ".agents", "skills", skill.linkName), { recursive: true });

  await assert.rejects(
    manager.toggleSkill({
      projectPath: project,
      targetId: "agents-project",
      skillId: skill.id,
      enabled: true,
    }),
    /already exists/,
  );
});

test("finds symlinked skills as import candidates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-symlink-candidate-"));
  const source = path.join(root, "source", "adapt");
  const target = path.join(root, "target", "adapt");
  await writeSkill(source, "Adapt", "Use to adapt output.");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.symlink(source, target, "dir");

  const candidates = await findImportCandidates(path.dirname(target));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "symlink");
  assert.equal(candidates[0].entryPath, target);
  assert.equal(candidates[0].realPath, await fs.realpath(source));
});

test("imports by moving directories into the vault", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-move-dir-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const source = path.join(root, "source", "swiftui");
  const project = path.join(root, "project");
  await manager.writeConfig({ vaultRoot: vault, recentProjects: [] });
  await writeSkill(source, "SwiftUI Patterns", "Use for SwiftUI iOS views.");

  const result = await manager.importSkills(path.join(root, "source"), project);

  assert.equal(result.imported.length, 1);
  await assert.rejects(fs.lstat(source), /ENOENT/);
  const state = await manager.getState(project);
  assert.equal(state.skills.length, 1);
  assert.equal(state.skills[0].name, "SwiftUI Patterns");
});

test("imports symlinked skills by moving the real source and unlinking target links", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-move-symlink-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const project = path.join(root, "project");
  const source = path.join(root, "source", "adapt");
  const projectTarget = path.join(project, ".agents", "skills");
  const projectLink = path.join(projectTarget, "adapt");

  await manager.writeConfig({ vaultRoot: vault, recentProjects: [] });
  await writeSkill(source, "Adapt", "Use to adapt output.");
  await fs.mkdir(projectTarget, { recursive: true });
  await fs.symlink(source, projectLink, "dir");

  const result = await manager.importSkills(projectTarget, project);

  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].kind, "symlink");
  await assert.rejects(fs.lstat(source), /ENOENT/);
  await assert.rejects(fs.lstat(projectLink), /ENOENT/);
  const state = await manager.getState(project);
  assert.equal(state.summary.skillCount, 1);
  assert.equal(state.targets.find((target) => target.id === "agents-project").unmanaged.length, 0);
});

test("dedupes imports when an identical skill is already in the vault", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-dedupe-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const source = path.join(root, "source", "adapt");
  const existing = path.join(vault, "adapt");
  const project = path.join(root, "project");

  await manager.writeConfig({ vaultRoot: vault, recentProjects: [] });
  await writeSkill(source, "Adapt", "Use to adapt output.");
  await writeSkill(existing, "Adapt", "Use to adapt output.");

  const result = await manager.importSkills(source, project);

  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].deduped, true);
  assert.equal(result.imported[0].to, existing);
  await assert.rejects(fs.lstat(source), /ENOENT/);
  const state = await manager.getState(project);
  assert.equal(state.skills.filter((skill) => skill.name === "Adapt").length, 1);
});

test("deduped symlink imports clear conflicts so the vault skill can be enabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-dedupe-enable-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const source = path.join(root, "source", "adapt");
  const existing = path.join(vault, "adapt");
  const project = path.join(root, "project");
  const projectTarget = path.join(project, ".agents", "skills");
  const projectLink = path.join(projectTarget, "adapt");

  await manager.writeConfig({ vaultRoot: vault, recentProjects: [] });
  await writeSkill(source, "Adapt", "Use to adapt output.");
  await writeSkill(existing, "Adapt", "Use to adapt output.");
  await fs.mkdir(projectTarget, { recursive: true });
  await fs.symlink(source, projectLink, "dir");

  await manager.importSkills(projectTarget, project);
  let state = await manager.getState(project);
  const skill = state.skills.find((item) => item.name === "Adapt");
  assert.equal(state.targets.find((target) => target.id === "agents-project").skillStatuses[skill.id].conflict, false);

  state = await manager.toggleSkill({
    projectPath: project,
    targetId: "agents-project",
    skillId: skill.id,
    enabled: true,
  });

  const status = state.targets.find((target) => target.id === "agents-project").skillStatuses[skill.id];
  assert.equal(status.enabled, true);
  assert.equal(await fs.realpath(projectLink), await fs.realpath(existing));
});

test("batch import skips missing paths and imports every suggested source once", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-batch-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const sourceA = path.join(root, "source-a");
  const sourceB = path.join(root, "source-b");
  const missing = path.join(root, "missing");
  const project = path.join(root, "project");

  await manager.writeConfig({ vaultRoot: vault, recentProjects: [] });
  await writeSkill(path.join(sourceA, "adapt"), "Adapt", "Use to adapt output.");
  await writeSkill(path.join(sourceB, "swiftui"), "SwiftUI Patterns", "Use for SwiftUI iOS views.");

  const result = await manager.importPaths([missing, sourceA, sourceA, sourceB], project);

  assert.equal(result.imported.length, 2);
  assert.equal(result.skipped.filter((item) => item.reason === "Path does not exist").length, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.state.summary.skillCount, 2);
  await assert.rejects(fs.lstat(path.join(sourceA, "adapt")), /ENOENT/);
  await assert.rejects(fs.lstat(path.join(sourceB, "swiftui")), /ENOENT/);
});

test("installing from a source can link imported skills to a preferred target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-install-target-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const source = path.join(root, "repo");
  const project = path.join(root, "project");

  await manager.writeConfig({ vaultRoot: vault, recentProjects: [] });
  await writeSkill(path.join(source, "swiftui"), "SwiftUI Patterns", "Use for SwiftUI iOS views.");

  const result = await manager.installSkills(source, project, "agents-project");

  assert.equal(result.imported.length, 1);
  assert.equal(result.enabled.length, 1);
  const state = await manager.getState(project);
  const skill = state.skills[0];
  const target = state.targets.find((item) => item.id === "agents-project");
  assert.equal(target.skillStatuses[skill.id].enabled, true);
  assert.equal(await fs.realpath(path.join(project, ".agents", "skills", skill.linkName)), skill.realPath);
});

test("bulk toggles selected skills in a target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-bulk-toggle-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const project = path.join(root, "project");

  await manager.writeConfig({ vaultRoot: vault, recentProjects: [] });
  await writeSkill(path.join(vault, "adapt"), "Adapt", "Use to adapt output.");
  await writeSkill(path.join(vault, "swiftui"), "SwiftUI Patterns", "Use for SwiftUI iOS views.");

  let state = await manager.getState(project);
  const skillIds = state.skills.map((skill) => skill.id);
  const result = await manager.bulkToggleSkills({
    projectPath: project,
    targetId: "agents-project",
    skillIds,
    mode: "enable",
  });

  assert.equal(result.changed.length, 2);
  state = await manager.getState(project);
  const target = state.targets.find((item) => item.id === "agents-project");
  assert.equal(target.enabledSkillIds.length, 2);
});

test("bulk copies selected skills without removing vault originals", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-bulk-copy-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const destination = path.join(root, "export");

  await manager.writeConfig({ vaultRoot: vault, recentProjects: [] });
  await writeSkill(path.join(vault, "adapt"), "Adapt", "Use to adapt output.");

  const state = await manager.getState(root);
  const result = await manager.bulkCopySkills({
    skillIds: [state.skills[0].id],
    destinationPath: destination,
    projectPath: root,
  });

  assert.equal(result.copied.length, 1);
  assert.equal(await fileExists(path.join(vault, "adapt", "SKILL.md")), true);
  assert.equal(await fileExists(path.join(destination, "adapt", "SKILL.md")), true);
});

test("bulk moves selected skills out of vault and removes managed links", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-bulk-move-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const destination = path.join(root, "archive");
  const project = path.join(root, "project");

  await manager.writeConfig({ vaultRoot: vault, recentProjects: [] });
  await writeSkill(path.join(vault, "adapt"), "Adapt", "Use to adapt output.");
  let state = await manager.getState(project);
  const skill = state.skills[0];
  await manager.toggleSkill({
    projectPath: project,
    targetId: "agents-project",
    skillId: skill.id,
    enabled: true,
  });

  const result = await manager.bulkMoveSkills({
    skillIds: [skill.id],
    destinationPath: destination,
    projectPath: project,
  });

  assert.equal(result.moved.length, 1);
  assert.equal(await fileExists(path.join(vault, "adapt", "SKILL.md")), false);
  assert.equal(await fileExists(path.join(destination, "adapt", "SKILL.md")), true);
  state = await manager.getState(project);
  assert.equal(state.summary.skillCount, 0);
  assert.equal(state.targets.find((item) => item.id === "agents-project").enabledSkillIds.length, 0);
});

test("bulk deletes selected skills from vault and removes managed links", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-bulk-delete-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const project = path.join(root, "project");

  await manager.writeConfig({ vaultRoot: vault, recentProjects: [] });
  await writeSkill(path.join(vault, "adapt"), "Adapt", "Use to adapt output.");
  let state = await manager.getState(project);
  const skill = state.skills[0];
  await manager.toggleSkill({
    projectPath: project,
    targetId: "agents-project",
    skillId: skill.id,
    enabled: true,
  });

  const result = await manager.bulkDeleteSkills({
    skillIds: [skill.id],
    projectPath: project,
  });

  assert.equal(result.deleted.length, 1);
  assert.equal(await fileExists(path.join(vault, "adapt", "SKILL.md")), false);
  state = await manager.getState(project);
  assert.equal(state.summary.skillCount, 0);
  assert.equal(state.targets.find((item) => item.id === "agents-project").enabledSkillIds.length, 0);
});

test("persists custom targets and resolves global-absolute and project-relative paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-custom-targets-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const project = path.join(root, "project");
  const cursorRules = path.join(root, "cursor-rules");

  await manager.writeConfig({
    vaultRoot: vault,
    recentProjects: [],
    customTargets: [
      {
        id: "custom-cursor-rules",
        label: "Cursor global",
        harness: "Cursor",
        scope: "global",
        path: cursorRules,
      },
      {
        id: "team-rules",
        label: "Team rules",
        harness: "Team",
        scope: "project",
        relativePath: ".team/rules",
      },
    ],
  });

  const config = await manager.readConfig();
  assert.equal(config.customTargets.length, 2);
  assert.equal(config.customTargets[0].id, "custom-cursor-rules");

  await fs.mkdir(project, { recursive: true });
  const state = await manager.getState(project);
  const cursorTarget = state.targets.find((target) => target.id === "custom-cursor-rules");
  const teamTarget = state.targets.find((target) => target.id === "team-rules");
  assert.ok(cursorTarget, "custom global target should be in state.targets");
  assert.ok(teamTarget, "custom project target should be in state.targets");
  assert.equal(cursorTarget.path, cursorRules);
  assert.equal(cursorTarget.scope, "global");
  assert.equal(cursorTarget.custom, true);
  assert.equal(teamTarget.path, path.join(project, ".team", "rules"));
  assert.equal(teamTarget.scope, "project");
});

test("enables and disables a skill through a custom target at an arbitrary path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-custom-toggle-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const project = path.join(root, "project");
  const cursorRules = path.join(root, "cursor-rules");

  await manager.writeConfig({
    vaultRoot: vault,
    recentProjects: [],
    customTargets: [
      {
        id: "custom-cursor-rules",
        label: "Cursor global",
        harness: "Cursor",
        scope: "global",
        path: cursorRules,
      },
      {
        id: "team-rules",
        label: "Team rules",
        harness: "Team",
        scope: "project",
        relativePath: ".team/rules",
      },
    ],
  });

  await writeSkill(path.join(vault, "swiftui-patterns"), "SwiftUI Patterns", "Use for SwiftUI iOS views.");
  await fs.mkdir(project, { recursive: true });

  let state = await manager.getState(project);
  const skill = state.skills[0];

  await manager.toggleSkill({
    projectPath: project,
    targetId: "custom-cursor-rules",
    skillId: skill.id,
    enabled: true,
  });
  const globalLink = path.join(cursorRules, skill.linkName);
  assert.equal((await fs.lstat(globalLink)).isSymbolicLink(), true);
  assert.equal(await fs.realpath(globalLink), skill.realPath);

  await manager.toggleSkill({
    projectPath: project,
    targetId: "team-rules",
    skillId: skill.id,
    enabled: true,
  });
  const projectLink = path.join(project, ".team", "rules", skill.linkName);
  assert.equal((await fs.lstat(projectLink)).isSymbolicLink(), true);

  state = await manager.getState(project);
  assert.equal(state.targets.find((t) => t.id === "custom-cursor-rules").skillStatuses[skill.id].enabled, true);
  assert.equal(state.targets.find((t) => t.id === "team-rules").skillStatuses[skill.id].enabled, true);

  await manager.toggleSkill({
    projectPath: project,
    targetId: "custom-cursor-rules",
    skillId: skill.id,
    enabled: false,
  });
  await assert.rejects(fs.lstat(globalLink), /ENOENT/);
});

test("rejects custom targets with invalid scope/path combinations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-custom-invalid-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });

  await assert.rejects(
    manager.writeConfig({
      customTargets: [{ id: "bad", label: "Bad", scope: "global", relativePath: "foo" }],
    }),
    /global.*absolute|absolute.*path/i,
  );
  await assert.rejects(
    manager.writeConfig({
      customTargets: [{ id: "bad", label: "Bad", scope: "project", path: "/abs/path" }],
    }),
    /project.*relative|relative.*path/i,
  );
  await assert.rejects(
    manager.writeConfig({
      customTargets: [{ label: "No id", scope: "global", path: "/abs" }],
    }),
    /id/i,
  );
});

test("installing from a source links imported skills to every requested target in one pass", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-install-multi-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const source = path.join(root, "repo");
  const project = path.join(root, "project");
  const cursorRules = path.join(root, "cursor-rules");

  await manager.writeConfig({
    vaultRoot: vault,
    recentProjects: [],
    customTargets: [
      {
        id: "custom-cursor-rules",
        label: "Cursor global",
        scope: "global",
        path: cursorRules,
      },
    ],
  });
  await writeSkill(path.join(source, "swiftui"), "SwiftUI Patterns", "Use for SwiftUI iOS views.");

  const result = await manager.installSkills(source, project, {
    targetIds: ["agents-project", "custom-cursor-rules"],
  });

  assert.equal(result.imported.length, 1);
  assert.equal(result.enabled.length, 2);
  const targetIds = result.enabled.map((entry) => entry.targetId).sort();
  assert.deepEqual(targetIds, ["agents-project", "custom-cursor-rules"]);

  const state = await manager.getState(project);
  const skill = state.skills[0];
  const agentsProjectLink = path.join(project, ".agents", "skills", skill.linkName);
  const cursorLink = path.join(cursorRules, skill.linkName);
  assert.equal(await fs.realpath(agentsProjectLink), skill.realPath);
  assert.equal(await fs.realpath(cursorLink), skill.realPath);
});

test("install accepts legacy single targetId for backward compatibility", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-install-legacy-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const source = path.join(root, "repo");
  const project = path.join(root, "project");

  await manager.writeConfig({ vaultRoot: vault, recentProjects: [] });
  await writeSkill(path.join(source, "swiftui"), "SwiftUI Patterns", "Use for SwiftUI iOS views.");

  const result = await manager.installSkills(source, project, "agents-project");
  assert.equal(result.imported.length, 1);
  assert.equal(result.enabled.length, 1);
  assert.equal(result.enabled[0].targetId, "agents-project");
});

test("install with no targets is vault-only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-install-vault-only-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const source = path.join(root, "repo");
  const project = path.join(root, "project");

  await manager.writeConfig({ vaultRoot: vault, recentProjects: [] });
  await writeSkill(path.join(source, "swiftui"), "SwiftUI Patterns", "Use for SwiftUI iOS views.");

  const vaultOnly = await manager.installSkills(source, project, { targetIds: [] });
  assert.equal(vaultOnly.imported.length, 1);
  assert.equal(vaultOnly.enabled.length, 0);
});

test("previewInstall reports planned vault moves and per-target links without changing the disk", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-preview-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const source = path.join(root, "repo");
  const project = path.join(root, "project");
  const cursorRules = path.join(root, "cursor-rules");

  await manager.writeConfig({
    vaultRoot: vault,
    recentProjects: [],
    customTargets: [
      { id: "custom-cursor-rules", label: "Cursor global", scope: "global", path: cursorRules },
    ],
  });
  await writeSkill(path.join(source, "swiftui"), "SwiftUI Patterns", "Use for SwiftUI iOS views.");
  await writeSkill(path.join(source, "react-ui"), "React UI Patterns", "Use for React frontend work.");

  const plan = await manager.previewInstall(source, project, {
    targetIds: ["agents-project", "custom-cursor-rules"],
  });

  assert.equal(plan.candidates.length, 2);
  const swiftui = plan.candidates.find((c) => c.name === "SwiftUI Patterns");
  assert.ok(swiftui, "expected swiftui candidate");
  assert.equal(swiftui.action, "move");
  assert.equal(path.dirname(swiftui.vaultDestination), vault);
  assert.equal(swiftui.willDedupe, false);
  const swiftuiTargets = swiftui.targetLinks.map((link) => link.targetId).sort();
  assert.deepEqual(swiftuiTargets, ["agents-project", "custom-cursor-rules"]);
  assert.ok(swiftui.targetLinks.every((link) => link.linkPath && link.linkName));

  // Nothing was actually moved
  assert.equal(await fileExists(path.join(source, "swiftui", "SKILL.md")), true);
  assert.equal(await fileExists(vault), false);
});

test("previewInstall marks duplicate skills as dedupe and points to the existing vault entry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-preview-dedupe-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const source = path.join(root, "repo");
  const project = path.join(root, "project");

  await manager.writeConfig({ vaultRoot: vault, recentProjects: [] });
  await writeSkill(path.join(vault, "swiftui-patterns"), "SwiftUI Patterns", "Use for SwiftUI iOS views.");
  await writeSkill(path.join(source, "swiftui"), "SwiftUI Patterns", "Use for SwiftUI iOS views.");

  const plan = await manager.previewInstall(source, project, { targetIds: ["agents-project"] });
  assert.equal(plan.candidates.length, 1);
  const candidate = plan.candidates[0];
  assert.equal(candidate.willDedupe, true);
  assert.equal(candidate.action, "dedupe");
  assert.equal(candidate.vaultDestination, path.join(vault, "swiftui-patterns"));
});

test("previewInstall returns a sourceKey usable to override per-skill targets on install", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-preview-sourcekey-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const source = path.join(root, "repo");
  const project = path.join(root, "project");

  await manager.writeConfig({ vaultRoot: vault, recentProjects: [] });
  await writeSkill(path.join(source, "ios", "swiftui"), "SwiftUI Patterns", "Use for SwiftUI iOS views.");
  await writeSkill(path.join(source, "web", "react"), "React UI", "Use for React.");

  const plan = await manager.previewInstall(source, project, { targetIds: ["agents-project"] });
  const swiftui = plan.candidates.find((c) => c.name === "SwiftUI Patterns");
  const react = plan.candidates.find((c) => c.name === "React UI");
  assert.equal(swiftui.sourceKey, path.join("ios", "swiftui"));
  assert.equal(react.sourceKey, path.join("web", "react"));
});

test("installSkills with perSkillTargets routes each skill to its chosen targets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-install-per-skill-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const source = path.join(root, "repo");
  const project = path.join(root, "project");

  await manager.writeConfig({ vaultRoot: vault, recentProjects: [] });
  await writeSkill(path.join(source, "ios", "swiftui"), "SwiftUI Patterns", "Use for SwiftUI iOS views.");
  await writeSkill(path.join(source, "web", "react"), "React UI", "Use for React.");

  const result = await manager.installSkills(source, project, {
    targetIds: ["agents-project"],
    perSkillTargets: {
      [path.join("ios", "swiftui")]: ["claude-project"],
      [path.join("web", "react")]: ["codex-project", "agents-project"],
    },
  });

  assert.equal(result.imported.length, 2);
  // swiftui only at claude-project; react at both codex-project and agents-project
  const swiftuiTargets = result.enabled
    .filter((entry) => entry.name === "SwiftUI Patterns")
    .map((entry) => entry.targetId)
    .sort();
  const reactTargets = result.enabled
    .filter((entry) => entry.name === "React UI")
    .map((entry) => entry.targetId)
    .sort();
  assert.deepEqual(swiftuiTargets, ["claude-project"]);
  assert.deepEqual(reactTargets, ["agents-project", "codex-project"]);

  const state = await manager.getState(project);
  const swiftui = state.skills.find((s) => s.name === "SwiftUI Patterns");
  const react = state.skills.find((s) => s.name === "React UI");
  await assert.rejects(
    fs.lstat(path.join(project, ".agents", "skills", swiftui.linkName)),
    /ENOENT/,
  );
  assert.equal(
    (await fs.lstat(path.join(project, ".claude", "skills", swiftui.linkName))).isSymbolicLink(),
    true,
  );
  assert.equal(
    (await fs.lstat(path.join(project, ".agents", "skills", react.linkName))).isSymbolicLink(),
    true,
  );
  assert.equal(
    (await fs.lstat(path.join(project, ".codex", "skills", react.linkName))).isSymbolicLink(),
    true,
  );
});

test("findVaultDuplicates groups byte-identical SKILL.md files and suggests newest as keeper", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-dedupe-find-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  await manager.writeConfig({ vaultRoot: vault, recentProjects: [] });

  await writeSkill(path.join(vault, "animate"), "animate", "Add animations");
  await writeSkill(path.join(vault, "namespaced", "animate"), "animate", "Add animations");
  await writeSkill(path.join(vault, "unique"), "unique", "Different skill");

  const older = new Date(Date.now() - 60_000);
  await fs.utimes(path.join(vault, "animate", "SKILL.md"), older, older);

  const result = await manager.findVaultDuplicates();
  assert.equal(result.groupCount, 1);
  assert.equal(result.duplicateCount, 1);
  const group = result.groups[0];
  assert.equal(group.count, 2);
  assert.equal(group.suggestedKeeperId, "namespaced/animate");
  assert.deepEqual(
    group.skills.map((s) => s.id).sort(),
    ["animate", "namespaced/animate"],
  );
});

test("dedupeVaultSkills deletes duplicates and repoints managed links to the keeper", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-dedupe-apply-"));
  const manager = createManager({ appHome: path.join(root, "home", ".agent-skill-manager") });
  const vault = path.join(root, "vault");
  const project = path.join(root, "project");
  await manager.writeConfig({ vaultRoot: vault, recentProjects: [] });

  await writeSkill(path.join(vault, "harden"), "harden", "Improve resilience");
  await writeSkill(path.join(vault, "plugin", "harden"), "harden", "Improve resilience");

  let state = await manager.getState(project);
  const dup = state.skills.find((s) => s.id === "harden");
  const keeperFromState = state.skills.find((s) => s.id === "plugin/harden");
  assert.ok(dup && keeperFromState);

  await manager.toggleSkill({
    projectPath: project,
    targetId: "agents-project",
    skillId: dup.id,
    enabled: true,
  });

  const result = await manager.dedupeVaultSkills({
    projectPath: project,
    groups: [{ keeperId: "plugin/harden", removeIds: ["harden"] }],
  });

  assert.equal(result.deleted.length, 1);
  assert.equal(result.deleted[0].id, "harden");
  assert.equal(result.errors.length, 0);
  assert.equal(await fileExists(path.join(vault, "harden", "SKILL.md")), false);
  assert.equal(await fileExists(path.join(vault, "plugin", "harden", "SKILL.md")), true);

  const projectTarget = result.state.targets.find((t) => t.id === "agents-project");
  assert.deepEqual(projectTarget.enabledSkillIds, ["plugin/harden"]);
  assert.equal(
    (await fs.lstat(path.join(project, ".agents", "skills", keeperFromState.linkName))).isSymbolicLink(),
    true,
  );
});

test("lists global sets from config.json and project-local sets from sets.json", async () => {
  const env = await makeEnv();
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

test("creates a global set and a project-local set and getSet returns them", async () => {
  const env = await makeEnv();
  const manager = createManager({ appHome: env.appHome });

  const g = await manager.createSet({
    name: "Global mode",
    description: "Use for global agent defaults.",
    scope: "global",
    entries: [{ skillName: "alpha", targetKey: "claude-global" }],
  });
  assert.ok(g.set.id.startsWith("set_"));
  assert.equal(g.set.description, "Use for global agent defaults.");
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
    description: "Use when the renamed set applies.",
    entries: [
      { skillName: "alpha", targetKey: "claude-global" },
      { skillName: "gamma", targetKey: "codex-global" },
    ],
  }, { projectPath: env.project });
  assert.equal(updated.set.name, "G renamed");
  assert.equal(updated.set.description, "Use when the renamed set applies.");
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

test("snapshotSet captures current managed symlinks and re-applies as a no-op", async () => {
  const env = await makeEnv();
  await writeSkill(path.join(env.vault, "alpha"), "alpha", "alpha desc");
  await writeSkill(path.join(env.vault, "beta"), "beta", "beta desc");

  const manager = createManager({ appHome: env.appHome, homeDir: env.root });
  await manager.toggleSkill({ projectPath: env.project, targetId: "claude-global", skillId: "alpha", enabled: true });
  await manager.toggleSkill({ projectPath: env.project, targetId: "codex-global", skillId: "beta",  enabled: true });

  const snap = await manager.snapshotSet({
    name: "Snapshot",
    description: "Captured working state.",
    scope: "global",
    targetKeys: ["claude-global", "codex-global"],
    projectPath: env.project,
  });
  assert.equal(snap.set.description, "Captured working state.");
  const names = snap.set.entries.map((e) => `${e.skillName}@${e.targetKey}`).sort();
  assert.deepEqual(names, ["alpha@claude-global", "beta@codex-global"]);

  const re = await manager.applySet(snap.set.id, { projectPath: env.project });
  for (const t of re.perTargetResult) assert.equal(t.status, "applied");
  assert.deepEqual(re.warnings, []);
});

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

test("MCP server lists descriptions and activates a set", async () => {
  const env = await makeEnv();
  await writeSkill(path.join(env.vault, "alpha"), "alpha", "alpha desc");
  const manager = createManager({ appHome: env.appHome, homeDir: env.root });
  await manager.createSet({
    name: "Agent choice",
    description: "Activate when an agent needs alpha globally.",
    scope: "global",
    entries: [{ skillName: "alpha", targetKey: "claude-global" }],
  });
  await manager.createSet({
    name: "Project cwd",
    description: "Available only when the MCP server resolves the project from cwd.",
    scope: "project",
    projectPath: env.project,
    entries: [{ skillName: "alpha", targetKey: "claude-project" }],
  });

  const child = spawn(
    process.execPath,
    [path.join(__dirname, "..", "src", "mcp-server.js"), "--project-from-cwd", "--home", env.root],
    {
      cwd: env.project,
      env: { ...process.env, AGENT_SKILL_MANAGER_HOME: env.appHome, AGENT_SKILL_PROJECT: path.join(env.root, "wrong") },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  try {
    const listResponse = await sendMcpRequest(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_skill_sets", arguments: {} },
    });
    const listed = JSON.parse(listResponse.result.content[0].text);
    assert.equal(listed.global[0].description, "Activate when an agent needs alpha globally.");
    assert.equal(listed.project[0].description, "Available only when the MCP server resolves the project from cwd.");

    const applyResponse = await sendMcpRequest(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "activate_skill_set", arguments: { name: "Agent choice", projectPath: env.project } },
    });
    const applied = JSON.parse(applyResponse.result.content[0].text);
    assert.equal(applied.perTargetResult[0].status, "applied");

    const state = await manager.getState(env.project);
    const claudeState = state.targets.find((t) => t.id === "claude-global");
    assert.deepEqual(claudeState.enabledSkillIds, ["alpha"]);
  } finally {
    child.kill();
  }
});

async function makeEnv() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-sets-"));
  const appHome = path.join(root, "app");
  const vault = path.join(appHome, "vault");
  const project = path.join(root, "project");
  await fs.mkdir(vault, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  return { root, appHome, vault, project };
}

async function writeSkill(dir, name, description) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, "utf8");
}

async function fileExists(filePath) {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

function sendMcpRequest(child, message) {
  const response = readMcpResponse(child);
  child.stdin.write(encodeMcpMessage(message));
  return response;
}

function encodeMcpMessage(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function readMcpResponse(child) {
  let buffer = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for MCP response"));
    }, 5000);

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const message = parseMcpFrame(buffer);
      if (!message) return;
      cleanup();
      resolve(message.parsed);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = () => {
      cleanup();
      reject(new Error("MCP server exited before responding"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function parseMcpFrame(buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;
  const header = buffer.slice(0, headerEnd).toString("utf8");
  const match = header.match(/content-length:\s*(\d+)/i);
  if (!match) return null;
  const length = Number(match[1]);
  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd) return null;
  return { parsed: JSON.parse(buffer.slice(bodyStart, bodyEnd).toString("utf8")) };
}
