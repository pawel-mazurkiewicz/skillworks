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
const initialProject = args.project || process.env.AGENT_SKILL_PROJECT || process.cwd();
const publicDir = path.join(__dirname, "..", "public");
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
  console.log(`Agent Skill Manager running at ${address}`);
  console.log(`Initial project: ${path.resolve(initialProject)}`);
});

async function handleApi(request, response, url) {
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

  if (request.method === "POST" && url.pathname === "/api/install-git") {
    const body = await readJsonBody(request);
    const projectPath = body.projectPath || initialProject;
    const result = await installFromGit({
      repoUrl: body.repoUrl,
      ref: body.ref,
      targetId: body.targetId || "vault",
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

  sendJson(response, 404, { error: "Unknown API route" });
}

async function serveStatic(response, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(publicDir, relativePath);
  const publicRelativePath = path.relative(publicDir, filePath);
  if (publicRelativePath.startsWith("..") || path.isAbsolute(publicRelativePath)) {
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
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    throw error;
  }
}

function contentType(filePath) {
  const extension = path.extname(filePath);
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
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
  });
  response.end(JSON.stringify(payload, null, 2));
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
      'POSIX path of (choose folder with prompt "Choose a folder for Agent Skill Manager")',
    ]);
    return stdout.trim();
  }

  if (process.platform === "win32") {
    const command = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;",
      "$dialog.Description = 'Choose a folder for Agent Skill Manager';",
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

async function installFromGit({ repoUrl, ref, targetId, projectPath }) {
  const source = parseGitSource(repoUrl, ref);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skill-manager-git-"));
  const clonePath = path.join(tempRoot, "repo");

  try {
    const cloneArgs = ["clone", "--depth", "1"];
    if (source.ref) {
      cloneArgs.push("--branch", source.ref);
    }
    cloneArgs.push(source.repoUrl, clonePath);
    await execFileAsync("git", cloneArgs, { timeout: 120000 });

    const installRoot = source.subdir ? path.join(clonePath, source.subdir) : clonePath;
    const result = await manager.installSkills(installRoot, projectPath, targetId);
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
