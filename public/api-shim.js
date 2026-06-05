// Thin invoke() shim that mirrors the old fetch-based `api()` helper.
//
// When the page is loaded inside the Tauri desktop shell, requests are
// translated into `invoke(command, args)` calls against the Rust backend.
// In a browser/dev context (e.g. `npm start`) we fall through to the legacy
// JS sidecar over HTTP so the standalone server keeps working.
//
// The mapping table below lists every API endpoint the frontend calls. Each
// entry includes:
//   [method, pathPattern, commandName, argsBuilder, responseAdapter?]
//
// argsBuilder(url, body, match) -> object passed to invoke()
// responseAdapter(rust, body, url) -> value returned to the caller
//
// Response adapters exist because a few Rust commands return narrower
// payloads (just State) than the frontend currently consumes — the shim
// reshapes those without forcing additional Rust changes in this phase.

const TAURI_DESKTOP =
  typeof window !== "undefined" &&
  (Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__) ||
    window.location.protocol === "tauri:" ||
    window.location.hostname === "tauri.localhost");

const FETCH_API_ORIGIN = "http://127.0.0.1:5179";

function modeToEnabled(mode) {
  if (mode === "enable") return true;
  if (mode === "disable") return false;
  // "toggle" is not supported atomically by the Rust bulk command — flip to
  // explicit enable for now; the frontend will rerender from the fresh state.
  return true;
}

function wrapBulkToggleResponse(state, body) {
  const ids = Array.isArray(body && body.skillIds) ? body.skillIds : [];
  const targetId = (body && body.targetId) || "";
  const enabled = modeToEnabled(body && body.mode);
  return {
    state,
    changed: ids.map((id) => ({ id, targetId, enabled })),
    errors: [],
  };
}

function wrapBulkCopyResponse(state, body) {
  const ids = Array.isArray(body && body.skillIds) ? body.skillIds : [];
  return {
    state,
    copied: ids.map((id) => ({ id })),
    errors: [],
  };
}

function wrapBulkMoveResponse(state, body) {
  const ids = Array.isArray(body && body.skillIds) ? body.skillIds : [];
  return {
    state,
    moved: ids.map((id) => ({ id })),
    errors: [],
  };
}

function wrapBulkDeleteResponse(state, body) {
  const ids = Array.isArray(body && body.skillIds) ? body.skillIds : [];
  return {
    state,
    deleted: ids.map((id) => ({ id })),
    errors: [],
  };
}

function wrapDedupeResponse(state, body) {
  const groups = Array.isArray(body && body.groups) ? body.groups : [];
  const deleted = [];
  for (const g of groups) {
    for (const id of (g && g.removeIds) || []) {
      deleted.push({ id });
    }
  }
  return { state, deleted, errors: [] };
}

function wrapSaveSkillResponse(state) {
  return { state };
}

function adaptReadSkillResponse(rust) {
  // Rust currently returns { id, path, content }. The frontend reads
  // `preview.skill.name`/`.id`/etc. We synthesize a minimal skill object
  // from the flat fields; the editor only uses `id` and `name`. `name`
  // defaults to the trailing path segment.
  if (!rust) return rust;
  if (rust.skill) return rust;
  const id = rust.id || "";
  const segments = String(id).split("/").filter(Boolean);
  const name = segments[segments.length - 1] || id;
  return {
    skill: { id, name, path: rust.path || "" },
    content: rust.content || "",
  };
}

function buildBulkToggleArgs(_url, body) {
  const targetId = (body && body.targetId) || "";
  return {
    skillIds: (body && body.skillIds) || [],
    targetIds: targetId ? [targetId] : [],
    enabled: modeToEnabled(body && body.mode),
    projectPath: body && body.projectPath,
  };
}

function buildDedupeArgs(_url, body) {
  const groups = Array.isArray(body && body.groups) ? body.groups : [];
  const keepIds = [];
  const deleteIds = [];
  for (const g of groups) {
    const keeper = g && g.keeperId;
    if (!keeper) continue;
    for (const id of (g && g.removeIds) || []) {
      keepIds.push(keeper);
      deleteIds.push(id);
    }
  }
  return {
    keepIds,
    deleteIds,
    projectPath: body && body.projectPath,
  };
}

const ROUTES = [
  ["GET", /^\/api\/state$/, "get_state", (url) => ({
    project: url.searchParams.get("project") || undefined,
  })],

  ["GET", /^\/api\/skill$/, "read_skill_file", (url) => ({
    id: url.searchParams.get("id"),
  }), adaptReadSkillResponse],

  ["POST", /^\/api\/skill$/, "save_skill_file", (_url, body) => ({
    id: body.id,
    content: body.content,
    projectPath: body.projectPath,
  }), wrapSaveSkillResponse],

  ["POST", /^\/api\/toggle$/, "toggle_skill", (_url, body) => ({
    skillId: body.skillId,
    targetId: body.targetId,
    enabled: body.enabled,
    projectPath: body.projectPath,
  })],

  ["POST", /^\/api\/bulk-toggle$/, "bulk_toggle_skills",
    buildBulkToggleArgs, wrapBulkToggleResponse],

  ["POST", /^\/api\/bulk-copy$/, "bulk_copy_skills", (_url, body) => ({
    skillIds: body.skillIds || [],
    destination: body.destinationPath || body.destination || "",
    projectPath: body.projectPath,
  }), wrapBulkCopyResponse],

  ["POST", /^\/api\/bulk-move$/, "bulk_move_skills", (_url, body) => ({
    skillIds: body.skillIds || [],
    destination: body.destinationPath || body.destination || "",
    projectPath: body.projectPath,
  }), wrapBulkMoveResponse],

  ["POST", /^\/api\/bulk-delete$/, "bulk_delete_skills", (_url, body) => ({
    skillIds: body.skillIds || [],
    projectPath: body.projectPath,
  }), wrapBulkDeleteResponse],

  ["GET", /^\/api\/duplicates$/, "find_vault_duplicates", () => ({})],

  ["POST", /^\/api\/dedupe$/, "dedupe_vault_skills",
    buildDedupeArgs, wrapDedupeResponse],

  ["POST", /^\/api\/config$/, "write_config", (_url, body) => ({
    vaultRoot: body.vaultRoot,
    recentProjects: body.recentProjects,
    projects: body.projects,
    customTargets: body.customTargets,
    hiddenTargetIds: body.hiddenTargetIds,
    sets: body.sets,
    projectPath: body.projectPath,
  })],

  ["POST", /^\/api\/projects\/add$/, "add_project", (_url, body) => ({
    projectPath: body.projectPath || body.path,
    name: body.name,
    currentProjectPath: body.currentProjectPath,
  })],

  ["POST", /^\/api\/projects\/remove$/, "remove_project", (_url, body) => ({
    projectPath: body.projectPath || body.path,
    currentProjectPath: body.currentProjectPath,
  })],

  ["POST", /^\/api\/projects\/clear-scanned$/, "clear_scanned_projects",
    (_url, body) => ({ projectPath: body && body.projectPath })],

  ["POST", /^\/api\/projects\/scan$/, "scan_projects", (_url, body) => ({
    roots: body.roots,
    maxDepth: body.maxDepth,
    projectPath: body.projectPath,
  })],

  ["POST", /^\/api\/projects\/pinned-sets$/, "set_project_pinned_sets",
    (_url, body) => ({
      projectPath: body.projectPath,
      setIds: body.setIds || [],
    })],

  ["POST", /^\/api\/import$/, "import_skills", (_url, body) => ({
    sourcePath: body.sourcePath,
    projectPath: body.projectPath,
  }), (rust) => (rust && rust.state ? rust.state : rust)],

  ["POST", /^\/api\/import-suggested$/, "import_suggested_skills",
    (_url, body) => ({
      sourcePaths: body.sourcePaths || [],
      projectPath: body.projectPath,
    })],

  ["POST", /^\/api\/install-git\/preview$/, "preview_git_install",
    (_url, body) => ({
      repoUrl: body.repoUrl,
      ref: body.ref,
      targetIds: body.targetIds,
      targetId: body.targetId,
      projectPath: body.projectPath,
    })],

  ["POST", /^\/api\/install-git$/, "install_from_git", (_url, body) => ({
    repoUrl: body.repoUrl,
    ref: body.ref,
    targetIds: body.targetIds,
    targetId: body.targetId,
    perSkillTargets: body.perSkillTargets,
    projectPath: body.projectPath,
  })],

  ["GET", /^\/api\/marketplace\/skills$/, "fetch_marketplace_skills",
    (url) => ({
      q: url.searchParams.get("q") || undefined,
      view: url.searchParams.get("view") || undefined,
      page: url.searchParams.get("page") || undefined,
      perPage: url.searchParams.get("per_page") || undefined,
    })],

  ["POST", /^\/api\/create-skill$/, "create_skill", (_url, body) => ({
    name: body.name,
    description: body.description,
    content: body.content,
    projectPath: body.projectPath,
  })],

  ["POST", /^\/api\/pick-directory$/, "pick_directory", () => ({})],

  ["GET", /^\/api\/sets$/, "list_sets", (url) => ({
    project: url.searchParams.get("project") || undefined,
  })],

  ["POST", /^\/api\/sets$/, "create_set", (_url, body) => ({
    name: body.name,
    description: body.description,
    scope: body.scope,
    projectPath: body.projectPath,
    entries: body.entries,
  })],

  ["POST", /^\/api\/sets\/snapshot$/, "snapshot_set", (_url, body) => ({
    name: body.name,
    description: body.description,
    scope: body.scope,
    projectPath: body.projectPath,
    targetKeys: body.targetKeys,
  })],

  ["POST", /^\/api\/sets\/([^/]+)\/plan$/, "plan_apply_set",
    (_url, body, m) => ({ id: m[1], projectPath: body && body.projectPath })],

  ["POST", /^\/api\/sets\/([^/]+)\/apply$/, "apply_set",
    (_url, body, m) => ({ id: m[1], projectPath: body && body.projectPath })],

  ["PATCH", /^\/api\/sets\/([^/]+)$/, "update_set",
    (_url, body, m) => ({
      id: m[1],
      patch: body || {},
      projectPath: body && body.projectPath,
    })],

  ["DELETE", /^\/api\/sets\/([^/]+)$/, "delete_set",
    (url, _body, m) => ({
      id: m[1],
      project: url.searchParams.get("project") || undefined,
    })],

  ["GET", /^\/api\/mcp\/status$/, "mcp_registration_status", () => ({})],

  ["GET", /^\/api\/mcp\/snippet$/, "mcp_manual_snippet", () => ({})],

  ["POST", /^\/api\/mcp\/register$/, "register_mcp_server",
    (_url, body) => ({ harnessIds: (body && body.harnessIds) || [] })],

  ["POST", /^\/api\/mcp\/unregister$/, "unregister_mcp_server",
    (_url, body) => ({ harnessIds: (body && body.harnessIds) || [] })],
];

function invokeFn() {
  if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
    return window.__TAURI__.core.invoke;
  }
  if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === "function") {
    return window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
  }
  throw new Error("Tauri invoke() is not available");
}

function fireToast(message) {
  if (typeof window.__SKILLWORKS_TOAST__ === "function") {
    try {
      window.__SKILLWORKS_TOAST__(message);
    } catch (_) {
      // ignore — toast is best-effort
    }
  }
}

export async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const body = options.body || null;

  if (TAURI_DESKTOP) {
    const url = new URL(path, "http://localhost");
    for (const route of ROUTES) {
      const [routeMethod, pattern, command, argsBuilder, adapter] = route;
      if (routeMethod !== method) continue;
      const m = url.pathname.match(pattern);
      if (!m) continue;
      let invoke;
      try {
        invoke = invokeFn();
      } catch (err) {
        fireToast(err.message || "Tauri invoke unavailable");
        throw err;
      }
      try {
        const args = argsBuilder(url, body, m);
        const rust = await invoke(command, args);
        return adapter ? adapter(rust, body, url) : rust;
      } catch (err) {
        const message = extractInvokeError(err);
        fireToast(message);
        throw new Error(message);
      }
    }
    const err = `No Tauri command mapped for ${method} ${path}`;
    fireToast(err);
    throw new Error(err);
  }

  // Browser/dev fallback — legacy fetch path.
  const response = await fetch(apiUrl(path), {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error || "Request failed";
    fireToast(message);
    throw new Error(message);
  }
  return payload;
}

function extractInvokeError(err) {
  if (!err) return "Request failed";
  if (typeof err === "string") return err;
  if (err.error) return String(err.error);
  if (err.message) return String(err.message);
  try {
    return JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

export function apiUrl(path) {
  const value = String(path);
  if (/^https?:\/\//.test(value)) return value;
  if (TAURI_DESKTOP) return value;
  return value.startsWith("/api/") ? `${FETCH_API_ORIGIN}${value}` : value;
}

// Exposed for tests that want to introspect/validate the route table without
// reaching into Tauri.
export const __ROUTES__ = ROUTES;
