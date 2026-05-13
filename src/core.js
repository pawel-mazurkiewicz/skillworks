const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const CONFIG_DIR = ".agent-skill-manager";
const MANIFEST_FILE = ".agent-skill-manager.json";
const SKILL_FILE = "SKILL.md";
const CONFIG_FILE_NAMES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules", ".windsurfrules"];

const HARNESS_TARGETS = [
  {
    id: "codex-global",
    harness: "Codex",
    scope: "global",
    label: "Codex global",
    shortLabel: "CX G",
    pathParts: [".codex", "skills"],
  },
  {
    id: "claude-global",
    harness: "Claude",
    scope: "global",
    label: "Claude global",
    shortLabel: "CL G",
    pathParts: [".claude", "skills"],
  },
  {
    id: "agents-global",
    harness: "Agents",
    scope: "global",
    label: "Agents global",
    shortLabel: "AG G",
    pathParts: [".agents", "skills"],
  },
];

const PROJECT_TARGETS = [
  {
    id: "codex-project",
    harness: "Codex",
    scope: "project",
    label: "Codex project",
    shortLabel: "CX P",
    pathParts: [".codex", "skills"],
  },
  {
    id: "claude-project",
    harness: "Claude",
    scope: "project",
    label: "Claude project",
    shortLabel: "CL P",
    pathParts: [".claude", "skills"],
  },
  {
    id: "agents-project",
    harness: "Agents",
    scope: "project",
    label: "Agents project",
    shortLabel: "AG P",
    pathParts: [".agents", "skills"],
  },
];

const BUILT_IN_TARGET_IDS = new Set([...HARNESS_TARGETS, ...PROJECT_TARGETS].map((target) => target.id));

function safeReadCustomTargets(input) {
  try {
    return normalizeCustomTargets(input);
  } catch {
    return [];
  }
}

function normalizeCustomTargets(input) {
  if (input === undefined || input === null) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw new Error("customTargets must be an array");
  }
  const seen = new Set();
  const normalized = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") {
      throw new Error("Each custom target must be an object");
    }
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) {
      throw new Error("Custom target requires an id");
    }
    if (BUILT_IN_TARGET_IDS.has(id)) {
      throw new Error(`Custom target id collides with built-in: ${id}`);
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate custom target id: ${id}`);
    }
    seen.add(id);

    const scope = raw.scope === "project" ? "project" : raw.scope === "global" ? "global" : null;
    if (!scope) {
      throw new Error(`Custom target ${id} requires scope "global" or "project"`);
    }

    let resolvedPath = null;
    let relativePath = null;
    if (scope === "global") {
      if (raw.relativePath) {
        throw new Error(`Global custom target ${id} must not set relativePath; use an absolute path`);
      }
      if (typeof raw.path !== "string" || !raw.path.trim()) {
        throw new Error(`Global custom target ${id} requires an absolute path`);
      }
      resolvedPath = path.resolve(expandHome(raw.path.trim()));
      if (!path.isAbsolute(resolvedPath)) {
        throw new Error(`Global custom target ${id} requires an absolute path`);
      }
    } else {
      if (raw.path) {
        throw new Error(`Project custom target ${id} must not set absolute path; use a relative path`);
      }
      if (typeof raw.relativePath !== "string" || !raw.relativePath.trim()) {
        throw new Error(`Project custom target ${id} requires a relative path`);
      }
      const candidate = raw.relativePath.trim();
      if (path.isAbsolute(candidate) || candidate.startsWith("~")) {
        throw new Error(`Project custom target ${id} requires a relative path`);
      }
      relativePath = candidate;
    }

    const entry = {
      id,
      label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : id,
      harness: typeof raw.harness === "string" && raw.harness.trim() ? raw.harness.trim() : "Custom",
      scope,
    };
    if (typeof raw.shortLabel === "string" && raw.shortLabel.trim()) {
      entry.shortLabel = raw.shortLabel.trim();
    }
    if (resolvedPath !== null) {
      entry.path = resolvedPath;
    }
    if (relativePath !== null) {
      entry.relativePath = relativePath;
    }
    normalized.push(entry);
  }
  return normalized;
}

function resolveInstallTargetIds(selector) {
  if (selector === undefined || selector === null) {
    return [];
  }
  if (Array.isArray(selector)) {
    return selector.filter((id) => typeof id === "string" && id && id !== "vault");
  }
  if (typeof selector === "string") {
    return selector && selector !== "vault" ? [selector] : [];
  }
  if (typeof selector === "object") {
    if (Array.isArray(selector.targetIds)) {
      return selector.targetIds.filter((id) => typeof id === "string" && id && id !== "vault");
    }
    if (typeof selector.targetId === "string") {
      return selector.targetId && selector.targetId !== "vault" ? [selector.targetId] : [];
    }
  }
  return [];
}

function createManager(options = {}) {
  const homeDir = path.resolve(expandHome(options.homeDir || os.homedir()));
  const appHome = path.resolve(
    expandHome(options.appHome || process.env.AGENT_SKILL_MANAGER_HOME || path.join(homeDir, CONFIG_DIR)),
  );

  async function readConfig() {
    await ensureDir(appHome);
    const configPath = path.join(appHome, "config.json");
    const config = await readJson(configPath, {});
    const vaultRoot = path.resolve(
      expandHome(config.vaultRoot || process.env.AGENT_SKILL_VAULT || path.join(appHome, "vault")),
    );
    return {
      configPath,
      appHome,
      vaultRoot,
      recentProjects: Array.isArray(config.recentProjects) ? config.recentProjects : [],
      projects: normalizeProjectRecords(config.projects || []),
      customTargets: safeReadCustomTargets(config.customTargets),
    };
  }

  async function writeConfig(nextConfig) {
    await ensureDir(appHome);
    const configPath = path.join(appHome, "config.json");
    const current = await readConfig();
    const merged = {
      vaultRoot: nextConfig.vaultRoot ? path.resolve(expandHome(nextConfig.vaultRoot)) : current.vaultRoot,
      recentProjects: Array.isArray(nextConfig.recentProjects) ? nextConfig.recentProjects : current.recentProjects,
      projects: Array.isArray(nextConfig.projects) ? normalizeProjectRecords(nextConfig.projects) : current.projects,
      customTargets: nextConfig.customTargets !== undefined
        ? normalizeCustomTargets(nextConfig.customTargets)
        : current.customTargets,
    };
    await writeJson(configPath, merged);
    return readConfig();
  }

  async function addRecentProject(projectPath) {
    const normalized = normalizeProjectPath(projectPath);
    const config = await readConfig();
    const recentProjects = [normalized, ...config.recentProjects.filter((item) => item !== normalized)].slice(0, 12);
    await writeConfig({ vaultRoot: config.vaultRoot, recentProjects });
    return recentProjects;
  }

  async function addProject(projectPath, metadata = {}) {
    const config = await readConfig();
    const record = await buildProjectRecord(projectPath, {
      source: metadata.source || "manual",
      name: metadata.name,
    });
    const projects = mergeProjectRecords(config.projects, [record]);
    await writeConfig({ vaultRoot: config.vaultRoot, recentProjects: config.recentProjects, projects });
    return { project: record, state: await getState(projectPath) };
  }

  async function scanProjects(options = {}) {
    const config = await readConfig();
    const scan = await scanProjectRoots({
      homeDir,
      appHome: config.appHome,
      vaultRoot: config.vaultRoot,
      roots: options.roots,
      maxDepth: options.maxDepth,
    });
    const projects = mergeProjectRecords(config.projects, scan.projects);
    await writeConfig({ vaultRoot: config.vaultRoot, recentProjects: config.recentProjects, projects });

    return {
      ...scan,
      state: await getState(options.projectPath || process.cwd()),
    };
  }

  async function getState(projectPath) {
    const config = await readConfig();
    await ensureDir(config.vaultRoot);

    const selectedProject = projectPath ? normalizeProjectPath(projectPath) : process.cwd();
    await addRecentProject(selectedProject).catch(() => undefined);

    const skills = await discoverSkills(config.vaultRoot);
    const targets = buildTargets(selectedProject, homeDir, config.customTargets);
    const targetStates = await Promise.all(targets.map((target) => inspectTarget(target, skills, config.vaultRoot)));
    const discovery = await discoverSources(selectedProject, {
      homeDir,
      appHome: config.appHome,
      vaultRoot: config.vaultRoot,
    });

    const enabledCount = targetStates.reduce((count, target) => count + target.enabledSkillIds.length, 0);
    const unmanagedCount = targetStates.reduce((count, target) => count + target.unmanaged.length, 0);

    return {
      appHome: config.appHome,
      configPath: config.configPath,
      vaultRoot: config.vaultRoot,
      project: {
        path: selectedProject,
        exists: await exists(selectedProject),
      },
      recentProjects: (await readConfig()).recentProjects,
      projects: (await readConfig()).projects,
      skills,
      customTargets: config.customTargets,
      targets: targetStates,
      summary: {
        skillCount: skills.length,
        targetCount: targetStates.length,
        enabledCount,
        unmanagedCount,
      },
      discovery,
      suggestedImports: discovery.sources
        .filter((source) => source.importable && source.importMode === "move")
        .map((source) => source.path),
    };
  }

  async function toggleSkill({ projectPath, targetId, skillId, enabled }) {
    const config = await readConfig();
    const skills = await discoverSkills(config.vaultRoot);
    const skill = skills.find((item) => item.id === skillId);
    if (!skill) {
      throw new Error(`Unknown skill: ${skillId}`);
    }

    const target = buildTargets(normalizeProjectPath(projectPath || process.cwd()), homeDir, config.customTargets).find((item) => item.id === targetId);
    if (!target) {
      throw new Error(`Unknown target: ${targetId}`);
    }

    if (enabled) {
      await enableSkill(target, skill);
    } else {
      await disableSkill(target, skill);
    }

    return getState(projectPath);
  }

  async function bulkToggleSkills({ projectPath, targetId, skillIds, mode }) {
    const config = await readConfig();
    const target = buildTargets(normalizeProjectPath(projectPath || process.cwd()), homeDir, config.customTargets).find((item) => item.id === targetId);
    if (!target) {
      throw new Error(`Unknown target: ${targetId}`);
    }

    const skills = await resolveSkills(config.vaultRoot, skillIds);
    const report = { changed: [], errors: [] };
    for (const skill of skills) {
      try {
        const currentlyEnabled = await isSkillEnabledInTarget(target, skill);
        const shouldEnable = mode === "toggle" ? !currentlyEnabled : mode === "enable";
        if (shouldEnable) {
          await enableSkill(target, skill);
        } else {
          await disableSkill(target, skill);
        }
        report.changed.push({
          id: skill.id,
          name: skill.name,
          targetId: target.id,
          enabled: shouldEnable,
        });
      } catch (error) {
        report.errors.push({
          id: skill.id,
          name: skill.name,
          reason: error.message || "Toggle failed",
        });
      }
    }

    return { ...report, state: await getState(projectPath) };
  }

  async function bulkCopySkills({ skillIds, destinationPath, projectPath }) {
    const config = await readConfig();
    const destinationRoot = path.resolve(expandHome(destinationPath || ""));
    if (!destinationPath) {
      throw new Error("Destination path is required");
    }
    await ensureDir(destinationRoot);

    const skills = await resolveSkills(config.vaultRoot, skillIds);
    const report = { copied: [], errors: [] };
    for (const skill of skills) {
      try {
        const destination = await uniqueSkillDestination(destinationRoot, skill.name || skill.id);
        await copyDirectory(skill.path, destination);
        report.copied.push({
          id: skill.id,
          name: skill.name,
          to: destination,
        });
      } catch (error) {
        report.errors.push({
          id: skill.id,
          name: skill.name,
          reason: error.message || "Copy failed",
        });
      }
    }

    return { ...report, state: await getState(projectPath) };
  }

  async function bulkMoveSkills({ skillIds, destinationPath, projectPath }) {
    const config = await readConfig();
    const destinationRoot = path.resolve(expandHome(destinationPath || ""));
    if (!destinationPath) {
      throw new Error("Destination path is required");
    }
    await ensureDir(destinationRoot);

    const skills = await resolveSkills(config.vaultRoot, skillIds);
    const report = { moved: [], errors: [] };
    for (const skill of skills) {
      try {
        if (isInsidePath(destinationRoot, skill.realPath)) {
          throw new Error("Cannot move a skill into itself");
        }
        const destination = await uniqueSkillDestination(destinationRoot, skill.name || skill.id);
        await removeManagedSkillLinks(skill, projectPath, homeDir);
        await moveDirectory(skill.path, destination);
        report.moved.push({
          id: skill.id,
          name: skill.name,
          to: destination,
        });
      } catch (error) {
        report.errors.push({
          id: skill.id,
          name: skill.name,
          reason: error.message || "Move failed",
        });
      }
    }

    return { ...report, state: await getState(projectPath) };
  }

  async function bulkDeleteSkills({ skillIds, projectPath }) {
    const config = await readConfig();
    const skills = await resolveSkills(config.vaultRoot, skillIds);
    const report = { deleted: [], errors: [] };
    for (const skill of skills) {
      try {
        await removeManagedSkillLinks(skill, projectPath, homeDir);
        await fs.rm(skill.path, { recursive: true, force: false });
        report.deleted.push({
          id: skill.id,
          name: skill.name,
        });
      } catch (error) {
        report.errors.push({
          id: skill.id,
          name: skill.name,
          reason: error.message || "Delete failed",
        });
      }
    }

    return { ...report, state: await getState(projectPath) };
  }

  async function importSkills(sourcePath, projectPath = process.cwd()) {
    const config = await readConfig();
    await ensureDir(config.vaultRoot);
    const result = await importSource(config, sourcePath, projectPath, { requireExists: true });
    return { ...result, state: await getState(projectPath) };
  }

  async function importPaths(sourcePaths, projectPath = process.cwd()) {
    const config = await readConfig();
    await ensureDir(config.vaultRoot);
    const paths = Array.isArray(sourcePaths) ? sourcePaths : [];
    const seen = new Set();
    const report = {
      imported: [],
      skipped: [],
      errors: [],
    };

    for (const sourcePath of paths) {
      const source = path.resolve(expandHome(sourcePath));
      if (seen.has(source)) {
        continue;
      }
      seen.add(source);

      if (!(await pathExists(source))) {
        report.skipped.push({ path: source, reason: "Path does not exist" });
        continue;
      }

      try {
        const result = await importSource(config, source, projectPath, { requireExists: false });
        report.imported.push(...result.imported);
        report.skipped.push(...result.skipped);
      } catch (error) {
        report.errors.push({ path: source, reason: error.message || "Import failed" });
      }
    }

    return { ...report, state: await getState(projectPath) };
  }

  async function installSkills(sourcePath, projectPath = process.cwd(), targetSelector = "vault") {
    const config = await readConfig();
    await ensureDir(config.vaultRoot);
    const result = await importSource(config, sourcePath, projectPath, { requireExists: true });
    const targetIds = resolveInstallTargetIds(targetSelector);
    const enableResult = await enableImportedSkills(config.vaultRoot, result.imported, projectPath, targetIds, homeDir, config.customTargets);
    return {
      ...result,
      enabled: enableResult.enabled,
      errors: enableResult.errors,
      state: await getState(projectPath),
    };
  }


  async function previewInstall(sourcePath, projectPath = process.cwd(), targetSelector = "vault") {
    const config = await readConfig();
    const source = path.resolve(expandHome(sourcePath));
    if (!(await pathExists(source))) {
      throw new Error(`Preview path does not exist: ${source}`);
    }
    const targetIds = resolveInstallTargetIds(targetSelector);
    const allTargets = buildTargets(normalizeProjectPath(projectPath || process.cwd()), homeDir, config.customTargets);
    const targetsById = new Map(allTargets.map((target) => [target.id, target]));
    const targets = [];
    for (const id of targetIds) {
      const target = targetsById.get(id);
      if (!target) {
        throw new Error(`Unknown target: ${id}`);
      }
      targets.push(target);
    }

    const candidates = await findImportCandidates(source);
    const usedDestinationBases = new Set();
    const usedLinkNames = new Set();
    const plan = [];
    for (const candidate of candidates) {
      const desiredName = candidate.metadata.name || path.basename(candidate.entryPath);
      const linkBase = safeSegment(desiredName);
      let linkName = linkBase;
      if (usedLinkNames.has(linkName)) {
        linkName = `${linkBase}-${shortHash(candidate.realPath)}`;
      }
      usedLinkNames.add(linkName);

      let action = "move";
      let vaultDestination = "";
      let willDedupe = false;
      let skipReason = "";

      if (isInsidePath(candidate.realPath, config.vaultRoot)) {
        action = "skip";
        skipReason = "Already in vault";
        vaultDestination = candidate.realPath;
      } else if (isInsidePath(config.vaultRoot, candidate.realPath)) {
        action = "skip";
        skipReason = "Refusing to move a skill into its own child directory";
      } else {
        const existingDestination = await findDuplicateVaultSkill(config.vaultRoot, candidate);
        if (existingDestination) {
          action = "dedupe";
          willDedupe = true;
          vaultDestination = existingDestination;
        } else {
          const baseName = safeSegment(desiredName);
          let base = baseName;
          let index = 2;
          while (
            usedDestinationBases.has(base) ||
            (await exists(path.join(config.vaultRoot, base)))
          ) {
            base = `${baseName}-${index}`;
            index += 1;
          }
          usedDestinationBases.add(base);
          vaultDestination = path.join(config.vaultRoot, base);
        }
      }

      const targetLinks = action === "skip"
        ? []
        : targets.map((target) => ({
            targetId: target.id,
            targetLabel: target.label,
            scope: target.scope,
            linkName,
            linkPath: path.join(target.path, linkName),
          }));

      plan.push({
        name: desiredName,
        sourcePath: candidate.entryPath,
        realSourcePath: candidate.realPath,
        kind: candidate.kind,
        action,
        skipReason,
        willDedupe,
        vaultDestination,
        linkName,
        targetLinks,
      });
    }

    return {
      vaultRoot: config.vaultRoot,
      candidates: plan,
      targets: targets.map((target) => ({
        id: target.id,
        label: target.label,
        scope: target.scope,
        path: target.path,
      })),
      summary: {
        candidates: plan.length,
        toMove: plan.filter((p) => p.action === "move").length,
        toDedupe: plan.filter((p) => p.action === "dedupe").length,
        toSkip: plan.filter((p) => p.action === "skip").length,
      },
    };
  }

  async function importSource(config, sourcePath, projectPath, options) {
    const source = path.resolve(expandHome(sourcePath));
    if (options.requireExists && !(await pathExists(source))) {
      throw new Error(`Import path does not exist: ${source}`);
    }

    const candidates = await findImportCandidates(source);
    const imported = [];
    const skipped = [];

    for (const candidate of candidates) {
      if (isInsidePath(candidate.realPath, config.vaultRoot)) {
        await removeKnownSymlinksTo(candidate.realPath, projectPath, homeDir);
        if (candidate.kind === "symlink") {
          await unlinkIfSymlink(candidate.entryPath);
        }
        skipped.push({
          path: candidate.entryPath,
          reason: "Already in vault",
        });
        continue;
      }

      if (isInsidePath(config.vaultRoot, candidate.realPath)) {
        skipped.push({
          path: candidate.entryPath,
          reason: "Refusing to move a skill into its own child directory",
        });
        continue;
      }

      const desiredName = candidate.metadata.name || path.basename(candidate.entryPath);
      const existingDestination = await findDuplicateVaultSkill(config.vaultRoot, candidate);
      if (existingDestination) {
        await removeKnownSymlinksTo(candidate.realPath, projectPath, homeDir);
        await fs.rm(candidate.realPath, { recursive: true, force: false });
        if (candidate.kind === "symlink") {
          await unlinkIfSymlink(candidate.entryPath);
        }
        imported.push({
          name: desiredName,
          from: candidate.entryPath,
          movedSource: candidate.realPath,
          to: existingDestination,
          kind: candidate.kind,
          deduped: true,
        });
        continue;
      }

      const destination = await uniqueSkillDestination(config.vaultRoot, desiredName);
      await removeKnownSymlinksTo(candidate.realPath, projectPath, homeDir);
      await moveDirectory(candidate.realPath, destination);
      if (candidate.kind === "symlink") {
        await unlinkIfSymlink(candidate.entryPath);
      }
      imported.push({
        name: desiredName,
        from: candidate.entryPath,
        movedSource: candidate.realPath,
        to: destination,
        kind: candidate.kind,
      });
    }

    if (candidates.length === 0) {
      skipped.push({ path: source, reason: "No SKILL.md files found" });
    }

    return { imported, skipped };
  }

  async function enableImportedSkills(vaultRoot, imported, projectPath, targetIds, targetHomeDir = os.homedir(), customTargets = []) {
    const ids = Array.isArray(targetIds) ? targetIds.filter((id) => id && id !== "vault") : [];
    if (ids.length === 0) {
      return { enabled: [], errors: [] };
    }

    const allTargets = buildTargets(normalizeProjectPath(projectPath || process.cwd()), targetHomeDir, customTargets);
    const targetsById = new Map(allTargets.map((target) => [target.id, target]));
    const targets = [];
    for (const id of ids) {
      const target = targetsById.get(id);
      if (!target) {
        throw new Error(`Unknown target: ${id}`);
      }
      targets.push(target);
    }

    const skills = await discoverSkills(vaultRoot);
    const skillsByRealPath = new Map();
    for (const skill of skills) {
      skillsByRealPath.set(skill.realPath, skill);
    }

    const enabled = [];
    const errors = [];
    const seenSkillDestinations = new Set();
    const resolvedSkillDestinations = [];

    for (const item of imported) {
      const destination = await realPath(item.to).catch(() => "");
      if (!destination || seenSkillDestinations.has(destination)) {
        continue;
      }
      seenSkillDestinations.add(destination);
      resolvedSkillDestinations.push(destination);
    }

    for (const destination of resolvedSkillDestinations) {
      const skill = skillsByRealPath.get(destination);
      if (!skill) {
        errors.push({
          path: destination,
          reason: "Installed skill was not discoverable in the vault",
        });
        continue;
      }

      for (const target of targets) {
        try {
          await enableSkill(target, skill);
          enabled.push({
            id: skill.id,
            name: skill.name,
            targetId: target.id,
            targetLabel: target.label,
            linkPath: path.join(target.path, skill.linkName),
          });
        } catch (error) {
          errors.push({
            id: skill.id,
            name: skill.name,
            targetId: target.id,
            reason: error.message || "Enable failed",
          });
        }
      }
    }

    return { enabled, errors };
  }

  async function createSkill({ name, description = "" }) {
    if (!name || !name.trim()) {
      throw new Error("Skill name is required");
    }

    const config = await readConfig();
    await ensureDir(config.vaultRoot);
    const destination = await uniqueSkillDestination(config.vaultRoot, name);
    await ensureDir(destination);
    const body = [
      "---",
      `name: ${name.trim()}`,
      `description: ${description.trim() || "Describe when this skill should be used."}`,
      "---",
      "",
      "# Workflow",
      "",
      "Add the operating instructions for this skill here.",
      "",
    ].join("\n");
    await fs.writeFile(path.join(destination, SKILL_FILE), body, "utf8");
    return { created: destination, state: await getState(process.cwd()) };
  }

  async function readSkillFile(skillId) {
    const config = await readConfig();
    const skills = await discoverSkills(config.vaultRoot);
    const skill = skills.find((item) => item.id === skillId);
    if (!skill) {
      throw new Error(`Unknown skill: ${skillId}`);
    }
    return {
      skill,
      content: await fs.readFile(path.join(skill.path, SKILL_FILE), "utf8"),
    };
  }

  return {
    appHome,
    readConfig,
    writeConfig,
    addProject,
    scanProjects,
    getState,
    toggleSkill,
    bulkToggleSkills,
    bulkCopySkills,
    bulkMoveSkills,
    bulkDeleteSkills,
    importSkills,
    importPaths,
    installSkills,
    previewInstall,
    createSkill,
    readSkillFile,
  };
}

async function discoverSkills(vaultRoot) {
  const roots = await findSkillRoots(vaultRoot);
  const skills = [];

  for (const root of roots) {
    const metadata = await readSkillMetadata(root);
    const id = normalizePath(path.relative(vaultRoot, root));
    const skill = {
      id,
      name: metadata.name || path.basename(root),
      description: metadata.description || "",
      path: root,
      realPath: await realPath(root),
      relativePath: id,
      linkName: "",
      tags: inferTags(`${metadata.name || ""} ${metadata.description || ""} ${id}`),
    };
    skills.push(skill);
  }

  const linkNames = new Set();
  for (const skill of skills.sort((a, b) => a.name.localeCompare(b.name))) {
    const base = safeSegment(skill.name || skill.relativePath);
    let linkName = base;
    if (linkNames.has(linkName)) {
      linkName = `${base}-${shortHash(skill.id)}`;
    }
    linkNames.add(linkName);
    skill.linkName = linkName;
  }

  return skills;
}

async function findSkillRoots(root) {
  const absoluteRoot = path.resolve(expandHome(root));
  if (!(await exists(absoluteRoot))) {
    return [];
  }

  if (await exists(path.join(absoluteRoot, SKILL_FILE))) {
    return [absoluteRoot];
  }

  const roots = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    const hasSkillFile = entries.some((entry) => entry.isFile() && entry.name === SKILL_FILE);
    if (hasSkillFile) {
      roots.push(current);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if ([".git", "node_modules"].includes(entry.name)) {
        continue;
      }
      await walk(path.join(current, entry.name));
    }
  }

  await walk(absoluteRoot);
  return roots.sort((a, b) => a.localeCompare(b));
}

async function findImportCandidates(root) {
  const absoluteRoot = path.resolve(expandHome(root));
  const seenRealPaths = new Set();
  const candidates = [];

  async function addCandidate(entryPath, kind) {
    const realSourcePath = await realPath(entryPath).catch(() => "");
    if (!realSourcePath || seenRealPaths.has(realSourcePath)) {
      return;
    }
    if (!(await exists(path.join(realSourcePath, SKILL_FILE)))) {
      return;
    }

    const metadata = await readSkillMetadata(realSourcePath);
    seenRealPaths.add(realSourcePath);
    candidates.push({
      entryPath,
      realPath: realSourcePath,
      kind,
      metadata,
    });
  }

  async function walk(current) {
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat) {
      return;
    }

    if (stat.isSymbolicLink()) {
      await addCandidate(current, "symlink");
      return;
    }

    if (!stat.isDirectory()) {
      return;
    }

    if (await exists(path.join(current, SKILL_FILE))) {
      await addCandidate(current, "directory");
      return;
    }

    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if ([".git", "node_modules"].includes(entry.name)) {
        continue;
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      await walk(path.join(current, entry.name));
    }
  }

  await walk(absoluteRoot);
  return candidates.sort((a, b) => a.entryPath.localeCompare(b.entryPath));
}

async function readSkillMetadata(skillRoot) {
  const raw = await fs.readFile(path.join(skillRoot, SKILL_FILE), "utf8");
  const frontmatter = parseFrontmatter(raw);
  return {
    name: frontmatter.name,
    description: frontmatter.description,
  };
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }

  const block = match[1].split(/\r?\n/);
  const data = {};
  let currentKey = "";

  for (const line of block) {
    const keyValue = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyValue) {
      currentKey = keyValue[1];
      data[currentKey] = stripQuotes(keyValue[2].trim());
      continue;
    }

    if (currentKey && /^\s+/.test(line)) {
      data[currentKey] = `${data[currentKey]} ${line.trim()}`.trim();
    }
  }

  return data;
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function inferTags(text) {
  const haystack = text.toLowerCase();
  const rules = [
    ["iOS", /\b(swift|swiftui|xcode|ios|app intents?|siri|widget)\b/],
    ["Web", /\b(react|vue|svelte|frontend|tailwind|css|html|browser|vite)\b/],
    ["Backend", /\b(node|express|api|backend|oauth|redis|postgres|database|microservice)\b/],
    ["Infra", /\b(terraform|devops|ci\/cd|github actions|docker|kubernetes|deploy)\b/],
    ["Docs", /\b(docx|document|pptx|presentation|xlsx|spreadsheet|pdf)\b/],
    ["Media", /\b(image|video|vision|shader|multimodal|audio|gif)\b/],
  ];

  const tags = rules.filter(([, pattern]) => pattern.test(haystack)).map(([label]) => label);
  return tags.length ? tags.slice(0, 3) : ["General"];
}

function buildTargets(projectPath, homeDir = os.homedir(), customTargets = []) {
  const home = homeDir;
  const globals = HARNESS_TARGETS.map((target) => ({
    ...target,
    path: path.join(home, ...target.pathParts),
    custom: false,
  }));

  const projectTargets = PROJECT_TARGETS.map((target) => ({
    ...target,
    path: path.join(projectPath, ...target.pathParts),
    custom: false,
  }));

  const customs = (customTargets || []).map((target) => {
    const resolvedPath = target.scope === "global"
      ? target.path
      : path.join(projectPath, target.relativePath);
    const shortLabel = target.shortLabel || target.label;
    return {
      id: target.id,
      label: target.label,
      harness: target.harness || "Custom",
      scope: target.scope,
      shortLabel,
      path: resolvedPath,
      custom: true,
    };
  });

  return [...globals, ...projectTargets, ...customs];
}

async function inspectTarget(target, skills, vaultRoot) {
  const targetExists = await exists(target.path);
  const manifest = await readManifest(target.path);
  const entries = targetExists ? await listTargetEntries(target.path) : [];
  const linksByRealPath = new Map();
  const unmanaged = [];

  for (const entry of entries) {
    if (entry.name === MANIFEST_FILE) {
      continue;
    }

    const entryPath = path.join(target.path, entry.name);
    const stat = await fs.lstat(entryPath).catch(() => null);
    if (!stat) {
      continue;
    }

    if (stat.isSymbolicLink()) {
      const resolved = await realPath(entryPath).catch(() => "");
      if (resolved) {
        const hasSkillFile = await exists(path.join(resolved, SKILL_FILE));
        linksByRealPath.set(resolved, {
          name: entry.name,
          path: entryPath,
          target: resolved,
          managed: isInsidePath(resolved, vaultRoot),
        });
        if (hasSkillFile && !isInsidePath(resolved, vaultRoot)) {
          const metadata = await readSkillMetadata(resolved).catch(() => ({}));
          unmanaged.push({
            name: metadata.name || entry.name,
            description: metadata.description || "",
            path: entryPath,
            realPath: resolved,
            target: resolved,
            kind: "symlink",
            importable: true,
          });
        }
      } else {
        unmanaged.push({
          name: entry.name,
          path: entryPath,
          target: "",
          kind: "broken-symlink",
          importable: false,
        });
      }
      continue;
    }

    if (stat.isDirectory() && (await exists(path.join(entryPath, SKILL_FILE)))) {
      const metadata = await readSkillMetadata(entryPath).catch(() => ({}));
      unmanaged.push({
        name: metadata.name || entry.name,
        description: metadata.description || "",
        path: entryPath,
        realPath: await realPath(entryPath).catch(() => entryPath),
        kind: "directory",
        importable: true,
      });
    }
  }

  const skillStatuses = {};
  const enabledSkillIds = [];

  for (const skill of skills) {
    const manifestRecord = manifest.managedLinks[skill.id];
    const enabledLink = linksByRealPath.get(skill.realPath);
    const plannedName = manifestRecord?.linkName || skill.linkName;
    const plannedPath = path.join(target.path, plannedName);
    const plannedExists = await pathExists(plannedPath);
    const conflict = plannedExists && !enabledLink && !(await isSymlinkTo(plannedPath, skill.realPath));

    if (enabledLink) {
      enabledSkillIds.push(skill.id);
    }

    skillStatuses[skill.id] = {
      enabled: Boolean(enabledLink),
      managed: Boolean(enabledLink?.managed || manifestRecord),
      linkName: enabledLink?.name || plannedName,
      linkPath: enabledLink?.path || plannedPath,
      conflict,
      staleManifest: Boolean(manifestRecord && !enabledLink),
    };
  }

  return {
    ...target,
    exists: targetExists,
    manifestPath: path.join(target.path, MANIFEST_FILE),
    enabledSkillIds,
    skillStatuses,
    unmanaged,
  };
}

async function enableSkill(target, skill) {
  await ensureDir(target.path);
  const manifest = await readManifest(target.path);
  const linkName = manifest.managedLinks[skill.id]?.linkName || skill.linkName;
  const linkPath = path.join(target.path, linkName);

  if (await pathExists(linkPath)) {
    if (await isSymlinkTo(linkPath, skill.realPath)) {
      manifest.managedLinks[skill.id] = {
        linkName,
        source: skill.path,
        enabledAt: new Date().toISOString(),
      };
      await writeManifest(target.path, manifest);
      return;
    }
    throw new Error(`Cannot enable ${skill.name}: ${linkPath} already exists and is not its managed symlink`);
  }

  await fs.symlink(skill.path, linkPath, process.platform === "win32" ? "junction" : "dir");
  manifest.managedLinks[skill.id] = {
    linkName,
    source: skill.path,
    enabledAt: new Date().toISOString(),
  };
  await writeManifest(target.path, manifest);
}

async function isSkillEnabledInTarget(target, skill) {
  if (!(await exists(target.path))) {
    return false;
  }

  const entries = await listTargetEntries(target.path);
  for (const entry of entries) {
    const entryPath = path.join(target.path, entry.name);
    if (await isSymlinkTo(entryPath, skill.realPath)) {
      return true;
    }
  }
  return false;
}

async function disableSkill(target, skill) {
  const manifest = await readManifest(target.path);
  const candidates = new Set();
  if (manifest.managedLinks[skill.id]?.linkName) {
    candidates.add(path.join(target.path, manifest.managedLinks[skill.id].linkName));
  }

  if (await exists(target.path)) {
    const entries = await listTargetEntries(target.path);
    for (const entry of entries) {
      const entryPath = path.join(target.path, entry.name);
      if (await isSymlinkTo(entryPath, skill.realPath)) {
        candidates.add(entryPath);
      }
    }
  }

  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) {
      continue;
    }
    if (!(await isSymlinkTo(candidate, skill.realPath))) {
      throw new Error(`Refusing to remove non-managed path: ${candidate}`);
    }
    await fs.unlink(candidate);
  }

  delete manifest.managedLinks[skill.id];
  if (await exists(target.path)) {
    await writeManifest(target.path, manifest);
  }
}

async function removeManagedSkillLinks(skill, projectPath, homeDir = os.homedir()) {
  const targets = buildTargets(normalizeProjectPath(projectPath || process.cwd()), homeDir);
  for (const target of targets) {
    if (!(await exists(target.path))) {
      continue;
    }

    const manifest = await readManifest(target.path);
    let manifestChanged = false;
    const entries = await listTargetEntries(target.path);
    for (const entry of entries) {
      const entryPath = path.join(target.path, entry.name);
      if (await isSymlinkTo(entryPath, skill.realPath)) {
        await fs.unlink(entryPath);
      }
    }

    if (manifest.managedLinks[skill.id]) {
      delete manifest.managedLinks[skill.id];
      manifestChanged = true;
    }

    if (manifestChanged) {
      await writeManifest(target.path, manifest);
    }
  }
}

async function readManifest(targetPath) {
  return {
    version: 1,
    managedLinks: {},
    ...(await readJson(path.join(targetPath, MANIFEST_FILE), {})),
  };
}

async function writeManifest(targetPath, manifest) {
  await ensureDir(targetPath);
  await writeJson(path.join(targetPath, MANIFEST_FILE), {
    version: 1,
    managedLinks: manifest.managedLinks || {},
  });
}

async function isSymlinkTo(candidate, expectedRealPath) {
  const stat = await fs.lstat(candidate).catch(() => null);
  if (!stat || !stat.isSymbolicLink()) {
    return false;
  }
  const candidateRealPath = await realPath(candidate).catch(() => "");
  return candidateRealPath === expectedRealPath;
}

async function listTargetEntries(targetPath) {
  return fs.readdir(targetPath, { withFileTypes: true }).catch(() => []);
}

async function uniqueSkillDestination(vaultRoot, name) {
  const base = safeSegment(name);
  let candidate = path.join(vaultRoot, base);
  let index = 2;
  while (await exists(candidate)) {
    candidate = path.join(vaultRoot, `${base}-${index}`);
    index += 1;
  }
  return candidate;
}

async function copyDirectory(from, to) {
  await fs.cp(from, to, {
    recursive: true,
    errorOnExist: true,
    filter: (source) => {
      const name = path.basename(source);
      return ![".git", "node_modules"].includes(name);
    },
  });
}

async function findDuplicateVaultSkill(vaultRoot, candidate) {
  const candidateSkillFile = await fs.readFile(path.join(candidate.realPath, SKILL_FILE), "utf8").catch(() => "");
  if (!candidateSkillFile) {
    return "";
  }

  const desiredName = candidate.metadata.name || path.basename(candidate.entryPath);
  const primary = path.join(vaultRoot, safeSegment(desiredName));
  if (await skillFileMatches(primary, candidateSkillFile)) {
    return primary;
  }

  const roots = await findSkillRoots(vaultRoot);
  for (const root of roots) {
    if (root === primary) {
      continue;
    }
    if (await skillFileMatches(root, candidateSkillFile)) {
      return root;
    }
  }

  return "";
}

async function skillFileMatches(skillRoot, expectedContent) {
  const currentContent = await fs.readFile(path.join(skillRoot, SKILL_FILE), "utf8").catch(() => "");
  return Boolean(currentContent) && currentContent === expectedContent;
}

async function moveDirectory(from, to) {
  try {
    await fs.rename(from, to);
  } catch (error) {
    if (error.code !== "EXDEV") {
      throw error;
    }
    await fs.cp(from, to, {
      recursive: true,
      errorOnExist: true,
      filter: (source) => {
        const name = path.basename(source);
        return ![".git", "node_modules"].includes(name);
      },
    });
    await fs.rm(from, { recursive: true, force: false });
  }
}

async function removeKnownSymlinksTo(realSourcePath, projectPath, homeDir = os.homedir()) {
  const targets = buildTargets(normalizeProjectPath(projectPath || process.cwd()), homeDir);
  for (const target of targets) {
    if (!(await exists(target.path))) {
      continue;
    }
    const entries = await listTargetEntries(target.path);
    for (const entry of entries) {
      const entryPath = path.join(target.path, entry.name);
      if (await isSymlinkTo(entryPath, realSourcePath)) {
        await fs.unlink(entryPath);
      }
    }
  }
}

async function resolveSkills(vaultRoot, skillIds) {
  const ids = Array.isArray(skillIds) ? skillIds : [];
  const skills = await discoverSkills(vaultRoot);
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const resolved = [];
  const missing = [];

  for (const id of ids) {
    const skill = byId.get(id);
    if (skill) {
      resolved.push(skill);
    } else {
      missing.push(id);
    }
  }

  if (missing.length) {
    throw new Error(`Unknown skill id${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  }

  return resolved;
}

async function unlinkIfSymlink(candidate) {
  const stat = await fs.lstat(candidate).catch(() => null);
  if (stat?.isSymbolicLink()) {
    await fs.unlink(candidate);
  }
}

async function discoverSources(projectPath, options = {}) {
  const normalizedProject = normalizeProjectPath(projectPath || process.cwd());
  const homeDir = path.resolve(expandHome(options.homeDir || os.homedir()));
  const appHome = options.appHome ? path.resolve(expandHome(options.appHome)) : path.join(homeDir, CONFIG_DIR);
  const vaultRoot = options.vaultRoot ? path.resolve(expandHome(options.vaultRoot)) : path.join(appHome, "vault");
  const definitions = buildDiscoveryDefinitions(normalizedProject, homeDir, appHome, vaultRoot);
  const sources = [];
  const seen = new Set();

  for (const definition of definitions) {
    const key = `${definition.kind}:${definition.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    sources.push(await inspectDiscoverySource(definition));
  }

  return {
    sources,
    summary: {
      sourceCount: sources.length,
      existingCount: sources.filter((source) => source.exists).length,
      importableCount: sources.filter((source) => source.importable && source.exists).length,
      skillCount: sources.reduce((count, source) => count + source.skillCount, 0),
      configFileCount: sources.reduce((count, source) => count + source.configFileCount, 0),
    },
  };
}

async function buildProjectRecord(projectPath, options = {}) {
  const normalized = normalizeProjectPath(projectPath);
  const skillSources = await findProjectSkillSources(normalized);
  return {
    path: normalized,
    name: options.name || path.basename(normalized) || normalized,
    source: options.source || "manual",
    skillSourceCount: skillSources.length,
    skillSources,
    lastSeenAt: new Date().toISOString(),
  };
}

async function scanProjectRoots(options = {}) {
  const homeDir = path.resolve(expandHome(options.homeDir || os.homedir()));
  const appHome = options.appHome ? path.resolve(expandHome(options.appHome)) : path.join(homeDir, CONFIG_DIR);
  const vaultRoot = options.vaultRoot ? path.resolve(expandHome(options.vaultRoot)) : path.join(appHome, "vault");
  const roots = normalizeScanRoots(options.roots, homeDir);
  const maxDepth = Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : 10;
  const projectMap = new Map();
  const skipped = [];

  for (const root of roots) {
    if (!(await exists(root))) {
      skipped.push({ path: root, reason: "Path does not exist" });
      continue;
    }
    await walkForProjects(root, {
      depth: 0,
      maxDepth,
      homeDir,
      appHome,
      vaultRoot,
      projectMap,
      skipped,
    });
  }

  return {
    roots,
    projects: [...projectMap.values()].sort((a, b) => a.path.localeCompare(b.path)),
    skipped,
  };
}

async function walkForProjects(current, context) {
  const stat = await fs.lstat(current).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink?.()) {
    return;
  }

  if (shouldSkipScanDir(current, context)) {
    return;
  }

  if (path.basename(current) === "skills") {
    const projectRoot = inferProjectRootFromSkillDir(current);
    if (projectRoot && !isGlobalHarnessSkillDir(current, context.homeDir) && !(await shouldSkipProjectRoot(projectRoot, context))) {
      const roots = await findSkillRoots(current);
      if (roots.length) {
        const existing = context.projectMap.get(projectRoot);
        const source = {
          path: current,
          skillCount: roots.length,
        };
        if (existing) {
          existing.skillSourceCount += 1;
          existing.skillSources.push(source);
          existing.lastSeenAt = new Date().toISOString();
        } else {
          context.projectMap.set(projectRoot, {
            path: projectRoot,
            name: path.basename(projectRoot) || projectRoot,
            source: "scan",
            skillSourceCount: 1,
            skillSources: [source],
            lastSeenAt: new Date().toISOString(),
          });
        }
      }
      return;
    }
  }

  if (context.depth >= context.maxDepth) {
    return;
  }

  const entries = await fs.readdir(current, { withFileTypes: true }).catch((error) => {
    context.skipped.push({ path: current, reason: error.message || "Cannot read directory" });
    return [];
  });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    await walkForProjects(path.join(current, entry.name), {
      ...context,
      depth: context.depth + 1,
    });
  }
}

function normalizeScanRoots(roots, homeDir) {
  const defaults = defaultScanRoots(homeDir);
  const rawRoots = Array.isArray(roots) && roots.length ? roots : defaults;
  const seen = new Set();
  const normalized = [];
  for (const root of rawRoots) {
    const resolved = path.resolve(expandHome(root));
    if (!seen.has(resolved)) {
      seen.add(resolved);
      normalized.push(resolved);
    }
  }
  return normalized;
}

function defaultScanRoots(homeDir) {
  if (process.platform === "win32") {
    return [homeDir, path.join(path.parse(homeDir).root, "Users")];
  }
  if (process.platform === "darwin") {
    return [homeDir, path.dirname(homeDir)];
  }
  return [homeDir, "/home"];
}

function inferProjectRootFromSkillDir(skillDir) {
  const parent = path.dirname(skillDir);
  const parentName = path.basename(parent);
  if ([".agents", ".codex", ".claude"].includes(parentName)) {
    return path.dirname(parent);
  }
  return parent;
}

async function findProjectSkillSources(projectRoot) {
  const candidates = [
    path.join(projectRoot, "skills"),
    path.join(projectRoot, ".agents", "skills"),
    path.join(projectRoot, ".codex", "skills"),
    path.join(projectRoot, ".claude", "skills"),
  ];
  const sources = [];
  for (const candidate of candidates) {
    const roots = await findSkillRoots(candidate);
    if (roots.length) {
      sources.push({
        path: candidate,
        skillCount: roots.length,
      });
    }
  }
  return sources;
}

function shouldSkipScanDir(current, context) {
  const name = path.basename(current);
  const skipNames = new Set([
    ".git",
    "node_modules",
    ".svn",
    ".hg",
    ".next",
    ".nuxt",
    "dist",
    "build",
    "target",
    "DerivedData",
    "Library",
    "Applications",
    "System",
    "Volumes",
    "private",
    "tmp",
    "temp",
    "__pycache__",
  ]);

  if (skipNames.has(name)) {
    return true;
  }

  return [
    context.appHome,
    path.join(context.homeDir, ".codex", "plugins", "cache"),
    path.join(context.homeDir, ".agents", "plugins", "cache"),
    path.join(context.homeDir, ".claude", "plugins", "cache"),
  ].some((skipPath) => isInsidePath(current, skipPath));
}

async function shouldSkipProjectRoot(projectRoot, context) {
  if (projectRoot === context.homeDir || isInsidePath(projectRoot, context.appHome) || isInsidePath(projectRoot, context.vaultRoot)) {
    return true;
  }
  return false;
}

function isGlobalHarnessSkillDir(skillDir, homeDir) {
  return [
    path.join(homeDir, ".agents", "skills"),
    path.join(homeDir, ".codex", "skills"),
    path.join(homeDir, ".claude", "skills"),
  ].some((globalPath) => path.resolve(skillDir) === path.resolve(globalPath));
}

function normalizeProjectRecords(records) {
  const normalized = [];
  const seen = new Set();
  for (const record of records) {
    const rawPath = typeof record === "string" ? record : record.path || "";
    if (!rawPath) {
      continue;
    }
    const projectPath = path.resolve(expandHome(rawPath));
    if (seen.has(projectPath)) {
      continue;
    }
    seen.add(projectPath);
    normalized.push({
      path: projectPath,
      name: record.name || path.basename(projectPath) || projectPath,
      source: record.source || "manual",
      skillSourceCount: Number(record.skillSourceCount || 0),
      skillSources: Array.isArray(record.skillSources) ? record.skillSources : [],
      lastSeenAt: record.lastSeenAt || "",
    });
  }
  return normalized;
}

function mergeProjectRecords(existing, incoming) {
  const merged = new Map();
  for (const record of normalizeProjectRecords(existing)) {
    merged.set(record.path, record);
  }

  for (const record of normalizeProjectRecords(incoming)) {
    const current = merged.get(record.path);
    merged.set(record.path, {
      ...current,
      ...record,
      source: current?.source === "manual" ? "manual" : record.source,
      name: current?.name || record.name,
    });
  }

  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function buildDiscoveryDefinitions(projectPath, homeDir, appHome, vaultRoot) {
  const globals = [
    ["codex-global-skills", "Codex global skills", path.join(homeDir, ".codex", "skills")],
    ["agents-global-skills", "Agents global skills", path.join(homeDir, ".agents", "skills")],
    ["claude-global-skills", "Claude global skills", path.join(homeDir, ".claude", "skills")],
  ].map(([id, label, sourcePath]) => ({
    id,
    label,
    path: sourcePath,
    kind: "global-directory",
    scope: "global",
    importable: !isInsidePath(sourcePath, vaultRoot),
    importMode: "move",
  }));

  const projectFolders = [
    ["project-skills", "Project skills", path.join(projectPath, "skills")],
    ["project-agents-skills", "Project Agents skills", path.join(projectPath, ".agents", "skills")],
    ["project-codex-skills", "Project Codex skills", path.join(projectPath, ".codex", "skills")],
    ["project-claude-skills", "Project Claude skills", path.join(projectPath, ".claude", "skills")],
  ].map(([id, label, sourcePath]) => ({
    id,
    label,
    path: sourcePath,
    kind: "project-directory",
    scope: "project",
    importable: !isInsidePath(sourcePath, vaultRoot),
    importMode: "move",
  }));

  const pluginCaches = [
    ["codex-plugin-cache", "Codex plugin cache", path.join(homeDir, ".codex", "plugins", "cache")],
    ["agents-plugin-cache", "Agents plugin cache", path.join(homeDir, ".agents", "plugins", "cache")],
    ["claude-plugin-cache", "Claude plugin cache", path.join(homeDir, ".claude", "plugins", "cache")],
    ["project-codex-plugin-cache", "Project Codex plugin cache", path.join(projectPath, ".codex", "plugins", "cache")],
    ["project-agents-plugin-cache", "Project Agents plugin cache", path.join(projectPath, ".agents", "plugins", "cache")],
    ["project-claude-plugin-cache", "Project Claude plugin cache", path.join(projectPath, ".claude", "plugins", "cache")],
  ].map(([id, label, sourcePath]) => ({
    id,
    label,
    path: sourcePath,
    kind: "plugin-cache",
    scope: id.startsWith("project-") ? "project" : "global",
    importable: false,
    importMode: "scan",
  }));

  const configFiles = [
    ...CONFIG_FILE_NAMES.map((fileName) => ({
      id: `project-config-${safeSegment(fileName)}`,
      label: `Project ${fileName}`,
      path: path.join(projectPath, fileName),
      scope: "project",
    })),
    {
      id: "project-codex-agents",
      label: "Project Codex AGENTS.md",
      path: path.join(projectPath, ".codex", "AGENTS.md"),
      scope: "project",
    },
    {
      id: "project-claude-claude",
      label: "Project Claude CLAUDE.md",
      path: path.join(projectPath, ".claude", "CLAUDE.md"),
      scope: "project",
    },
    {
      id: "home-agents",
      label: "Home AGENTS.md",
      path: path.join(homeDir, "AGENTS.md"),
      scope: "global",
    },
    {
      id: "home-claude",
      label: "Home CLAUDE.md",
      path: path.join(homeDir, "CLAUDE.md"),
      scope: "global",
    },
    {
      id: "codex-agents",
      label: "Codex AGENTS.md",
      path: path.join(homeDir, ".codex", "AGENTS.md"),
      scope: "global",
    },
    {
      id: "claude-claude",
      label: "Claude CLAUDE.md",
      path: path.join(homeDir, ".claude", "CLAUDE.md"),
      scope: "global",
    },
    {
      id: "agents-agents",
      label: "Agents AGENTS.md",
      path: path.join(homeDir, ".agents", "AGENTS.md"),
      scope: "global",
    },
  ].map((source) => ({
    ...source,
    kind: "single-file-config",
    importable: false,
    importMode: "scan",
  }));

  return [
    ...globals,
    ...pluginCaches,
    ...projectFolders,
    ...configFiles,
    {
      id: "vault",
      label: "Skill Manager vault",
      path: vaultRoot,
      kind: "vault",
      scope: "global",
      importable: false,
      importMode: "scan",
    },
  ];
}

async function inspectDiscoverySource(definition) {
  const source = {
    ...definition,
    exists: await pathExists(definition.path),
    skillCount: 0,
    configFileCount: 0,
    samples: [],
  };

  if (!source.exists) {
    return source;
  }

  if (source.kind === "single-file-config") {
    source.configFileCount = 1;
    return source;
  }

  if (source.kind === "plugin-cache" || source.kind === "vault") {
    const roots = await findSkillRoots(source.path);
    source.skillCount = roots.length;
    source.samples = await sampleSkillNames(roots);
    return source;
  }

  const candidates = await findImportCandidates(source.path);
  source.skillCount = candidates.length;
  source.samples = candidates.slice(0, 5).map((candidate) => candidate.metadata.name || path.basename(candidate.entryPath));
  return source;
}

async function sampleSkillNames(roots) {
  const names = [];
  for (const root of roots.slice(0, 5)) {
    const metadata = await readSkillMetadata(root).catch(() => ({}));
    names.push(metadata.name || path.basename(root));
  }
  return names;
}

function safeSegment(value) {
  const segment = String(value || "skill")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return segment || "skill";
}

function shortHash(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function normalizeProjectPath(projectPath) {
  return path.resolve(expandHome(projectPath || process.cwd()));
}

function expandHome(inputPath) {
  if (!inputPath) {
    return inputPath;
  }
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith(`~${path.sep}`) || inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function normalizePath(inputPath) {
  return inputPath.split(path.sep).join("/");
}

function isInsidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function exists(candidate) {
  return fs
    .access(candidate)
    .then(() => true)
    .catch(() => false);
}

async function pathExists(candidate) {
  return fs
    .lstat(candidate)
    .then(() => true)
    .catch(() => false);
}

async function realPath(candidate) {
  return fs.realpath(candidate);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

module.exports = {
  createManager,
  discoverSources,
  discoverSkills,
  findImportCandidates,
  findSkillRoots,
  parseFrontmatter,
  safeSegment,
  buildTargets,
};
