const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { URL } = require("node:url");
const { createManager } = require("./core");

const execFileAsync = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const host = args.host || "127.0.0.1";
const port = Number(args.port || process.env.PORT || 5179);
const initialProject = args.project || process.env.SKILLWORKS_PROJECT || process.env.AGENT_SKILL_PROJECT || process.cwd();
const publicDir = path.join(__dirname, "..", "public");
const distDir = path.join(__dirname, "..", "dist");
const assetsDir = path.join(__dirname, "..", "assets");
const manager = createManager();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    await serveStatic(response, url.pathname);
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Unexpected server error" });
  }
});

server.listen(port, host, () => {
  const address = `http://${host}:${port}`;
  console.log(`Skillworks running at ${address}`);
  console.log(`Initial project: ${path.resolve(initialProject)}`);
});

async function handleApi(request, response, url) {
  if (request.method === "OPTIONS") {
    sendNoContent(response, 204);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    const projectPath = url.searchParams.get("project") || initialProject;
    sendJson(response, 200, await manager.getState(projectPath));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/skill") {
    const skillId = url.searchParams.get("id");
    sendJson(response, 200, await manager.readSkillFile(skillId));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/skill") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await manager.saveSkillFile(body.id, body.content, body.projectPath || initialProject));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/toggle") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await manager.toggleSkill(body));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bulk-toggle") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await manager.bulkToggleSkills(body));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bulk-copy") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await manager.bulkCopySkills(body));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bulk-move") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await manager.bulkMoveSkills(body));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bulk-delete") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await manager.bulkDeleteSkills(body));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/duplicates") {
    sendJson(response, 200, await manager.findVaultDuplicates());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/dedupe") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await manager.dedupeVaultSkills(body));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/config") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await manager.writeConfig(body));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/projects/add") {
    const body = await readJsonBody(request);
    const result = await manager.addProject(body.projectPath || body.path, { source: "manual", name: body.name });
    sendJson(response, 200, result.state);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/projects/remove") {
    const body = await readJsonBody(request);
    const result = await manager.removeProject(body.projectPath || body.path, {
      projectPath: body.currentProjectPath || initialProject,
    });
    sendJson(response, 200, result.state);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/projects/clear-scanned") {
    const body = await readJsonBody(request);
    const result = await manager.clearScannedProjects({
      projectPath: body.projectPath || initialProject,
    });
    sendJson(response, 200, result.state);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/projects/scan") {
    const body = await readJsonBody(request);
    const result = await manager.scanProjects({
      roots: body.roots,
      maxDepth: body.maxDepth,
      projectPath: body.projectPath || initialProject,
    });
    sendJson(response, 200, {
      state: result.state,
      report: {
        roots: result.roots,
        discovered: result.projects.length,
        skipped: result.skipped.length,
      },
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/import") {
    const body = await readJsonBody(request);
    const result = await manager.importSkills(body.sourcePath, body.projectPath || initialProject);
    sendJson(response, 200, result.state);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/import-suggested") {
    const body = await readJsonBody(request);
    const projectPath = body.projectPath || initialProject;
    const state = await manager.getState(projectPath);
    const result = await manager.importPaths(body.sourcePaths || state.suggestedImports, projectPath);
    sendJson(response, 200, {
      state: result.state,
      report: {
        imported: result.imported.length,
        skipped: result.skipped.length,
        errors: result.errors.length,
      },
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/install-git/preview") {
    const body = await readJsonBody(request);
    const projectPath = body.projectPath || initialProject;
    const plan = await previewGitInstall({
      repoUrl: body.repoUrl,
      ref: body.ref,
      targetIds: Array.isArray(body.targetIds) ? body.targetIds : undefined,
      targetId: typeof body.targetId === "string" ? body.targetId : undefined,
      projectPath,
    });
    sendJson(response, 200, plan);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/install-git") {
    const body = await readJsonBody(request);
    const projectPath = body.projectPath || initialProject;
    const result = await installFromGit({
      repoUrl: body.repoUrl,
      ref: body.ref,
      targetIds: Array.isArray(body.targetIds) ? body.targetIds : undefined,
      targetId: typeof body.targetId === "string" ? body.targetId : undefined,
      perSkillTargets:
        body.perSkillTargets && typeof body.perSkillTargets === "object"
          ? body.perSkillTargets
          : undefined,
      projectPath,
    });
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/create-skill") {
    const body = await readJsonBody(request);
    await manager.createSkill(body);
    sendJson(response, 200, await manager.getState(body.projectPath || initialProject));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/pick-directory") {
    sendJson(response, 200, { path: await pickDirectory() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/sets") {
    const projectPath = url.searchParams.get("project") || initialProject;
    sendJson(response, 200, await manager.listSets({ projectPath }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sets") {
    const body = await readJsonBody(request);
    const result = await manager.createSet({
      name: body.name,
      description: body.description,
      scope: body.scope,
      projectPath: body.projectPath || (body.scope === "project" ? initialProject : undefined),
      entries: body.entries,
    });
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sets/snapshot") {
    const body = await readJsonBody(request);
    const result = await manager.snapshotSet({
      name: body.name,
      description: body.description,
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

  if (request.method === "PATCH" && url.pathname.startsWith("/api/sets/") && !url.pathname.endsWith("/snapshot")) {
    const id = url.pathname.slice("/api/sets/".length);
    const body = await readJsonBody(request);
    const result = await manager.updateSet(id, body, { projectPath: body.projectPath || initialProject });
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/api/sets/") && !url.pathname.endsWith("/snapshot")) {
    const id = url.pathname.slice("/api/sets/".length);
    const projectPath = url.searchParams.get("project") || initialProject;
    const result = await manager.deleteSet(id, { projectPath });
    sendJson(response, 200, result);
    return;
  }

  sendJson(response, 404, { error: "Unknown API route" });
}

async function serveStatic(response, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidates = relativePath.startsWith("assets/")
    ? [
        { rootDir: distDir, localRelativePath: relativePath },
        { rootDir: assetsDir, localRelativePath: relativePath.slice("assets/".length) },
      ]
    : [
        { rootDir: distDir, localRelativePath: relativePath },
        { rootDir: publicDir, localRelativePath: relativePath },
      ];

  for (const candidate of candidates) {
    const filePath = path.resolve(candidate.rootDir, candidate.localRelativePath);
    const safeRelativePath = path.relative(candidate.rootDir, filePath);
    if (safeRelativePath.startsWith("..") || path.isAbsolute(safeRelativePath)) {
      sendJson(response, 403, { error: "Forbidden" });
      return;
    }

    try {
      const body = await fs.readFile(filePath);
      response.writeHead(200, {
        "content-type": contentType(filePath),
        "cache-control": "no-store",
      });
      response.end(body);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  sendJson(response, 404, { error: "Not found" });
}

function contentType(filePath) {
  const extension = path.extname(filePath);
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  }[extension] || "application/octet-stream";
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...corsHeaders(),
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendNoContent(response, statusCode) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    ...corsHeaders(),
  });
  response.end();
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const item = rawArgs[index];
    if (!item.startsWith("--")) {
      continue;
    }
    const key = item.slice(2);
    const next = rawArgs[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

async function pickDirectory() {
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Choose a folder for Skillworks")',
    ]);
    return stdout.trim();
  }

  if (process.platform === "win32") {
    const command = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;",
      "$dialog.Description = 'Choose a folder for Skillworks';",
      "$dialog.ShowNewFolderButton = $true;",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }",
    ].join(" ");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command]);
    return stdout.trim();
  }

  try {
    const { stdout } = await execFileAsync("zenity", ["--file-selection", "--directory", "--title", "Choose a folder"]);
    return stdout.trim();
  } catch (error) {
    const { stdout } = await execFileAsync("kdialog", ["--getexistingdirectory", process.env.HOME || "/"]);
    return stdout.trim();
  }
}

async function installFromGit({ repoUrl, ref, targetIds, targetId, perSkillTargets, projectPath }) {
  const source = parseGitSource(repoUrl, ref);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skillworks-git-"));
  const clonePath = path.join(tempRoot, "repo");

  try {
    const cloneArgs = ["clone", "--depth", "1"];
    if (source.ref) {
      cloneArgs.push("--branch", source.ref);
    }
    cloneArgs.push(source.repoUrl, clonePath);
    await execFileAsync("git", cloneArgs, { timeout: 120000 });

    const installRoot = source.subdir ? path.join(clonePath, source.subdir) : clonePath;
    let selector;
    if (perSkillTargets && typeof perSkillTargets === "object") {
      selector = {
        targetIds: Array.isArray(targetIds) ? targetIds : [],
        perSkillTargets,
      };
    } else if (Array.isArray(targetIds)) {
      selector = { targetIds };
    } else if (targetId !== undefined) {
      selector = { targetId };
    } else {
      selector = "vault";
    }
    const result = await manager.installSkills(installRoot, projectPath, selector);
    return {
      state: result.state,
      report: {
        imported: result.imported.length,
        skipped: result.skipped.length,
        enabled: result.enabled.length,
        errors: result.errors.length,
      },
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}


async function previewGitInstall({ repoUrl, ref, targetIds, targetId, projectPath }) {
  const source = parseGitSource(repoUrl, ref);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skillworks-git-preview-"));
  const clonePath = path.join(tempRoot, "repo");

  try {
    const cloneArgs = ["clone", "--depth", "1"];
    if (source.ref) {
      cloneArgs.push("--branch", source.ref);
    }
    cloneArgs.push(source.repoUrl, clonePath);
    await execFileAsync("git", cloneArgs, { timeout: 120000 });

    const installRoot = source.subdir ? path.join(clonePath, source.subdir) : clonePath;
    const selector = Array.isArray(targetIds)
      ? { targetIds }
      : targetId !== undefined
        ? { targetId }
        : "vault";
    const plan = await manager.previewInstall(installRoot, projectPath, selector);
    return {
      source: { repoUrl: source.repoUrl, ref: source.ref || "", subdir: source.subdir || "" },
      ...plan,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parseGitSource(rawRepoUrl, explicitRef) {
  const raw = String(rawRepoUrl || "").trim();
  if (!raw) {
    throw new Error("Git repository URL is required");
  }

  let repoUrl = raw;
  let ref = String(explicitRef || "").trim();
  let subdir = "";

  const hashIndex = raw.indexOf("#");
  if (hashIndex !== -1) {
    repoUrl = raw.slice(0, hashIndex);
    const fragment = raw.slice(hashIndex + 1);
    const slashIndex = fragment.indexOf(":");
    if (slashIndex === -1) {
      ref = ref || fragment;
    } else {
      ref = ref || fragment.slice(0, slashIndex);
      subdir = fragment.slice(slashIndex + 1);
    }
  }

  if (!repoUrl.trim()) {
    throw new Error("Git repository URL is required");
  }

  if (subdir.includes("..")) {
    throw new Error("Git subdirectory cannot contain '..'");
  }

  return {
    repoUrl: repoUrl.trim(),
    ref,
    subdir: subdir.replace(/^\/+/, ""),
  };
}
