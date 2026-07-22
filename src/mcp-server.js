#!/usr/bin/env node
const path = require("node:path");
const { createManager } = require("./core");
const mcpCore = require("./mcp-core");

const MCP_SERVER_NAME = "skillworks";

const args = parseArgs(process.argv.slice(2));
const initialProject = resolveInitialProject(args);
const selfHarness = normalizeHarness(args.harness);
const manager = createManager({
  appHome: args["app-home"],
  homeDir: args.home,
});

// Session-scoped active project. `activate_project` mutates this so subsequent
// tool calls default to it without the agent passing projectPath every time.
let activeProject = path.resolve(initialProject);

// Map a harness identity (from --harness or a tool argument) to the
// project-scoped target id that core.js understands.
const HARNESS_PROJECT_TARGETS = {
  claude: "claude-project",
  codex: "codex-project",
  opencode: "opencode-project",
  gemini: "gemini-project",
  cursor: "cursor-project",
};

// `appHome`/`homeDir` for the MCP-server-management tools (mcp-core.js),
// resolved the same way `manager` resolved them (it was built from
// `args["app-home"]`/`args.home` above). `appHome` in particular can involve
// a legacy-directory fallback check that only `core.js` knows about, so we
// ask the manager for its resolved value (via `getState`, which always
// returns the fixed `appHome` it was constructed with) instead of
// re-implementing that resolution here. Memoized: both values are fixed for
// the lifetime of this process.
let mcpHomesPromise = null;
function resolveMcpHomes() {
  if (!mcpHomesPromise) {
    mcpHomesPromise = (async () => {
      const state = await manager.getState(activeProject);
      const homeDir = path.resolve(expandHomePath(args.home || require("node:os").homedir()));
      return { appHome: state.appHome, homeDir };
    })();
  }
  return mcpHomesPromise;
}

// --- SDK bootstrap -----------------------------------------------------
// The MCP SDK ships as ESM; src/ stays CommonJS, so the SDK is loaded via
// dynamic import() inside this async bootstrap (no repo-wide ESM switch).

async function main() {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");

  const server = new McpServer({ name: MCP_SERVER_NAME, version: readVersion() });
  registerSkillTools(server, z);
  registerMcpTools(server, z);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`MCP server fatal: ${err.stack || err}\n`);
  process.exit(1);
});

function readVersion() {
  try {
    const pkg = require(path.join(__dirname, "..", "package.json"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch (error) {
    return "0.0.0";
  }
}

function toContent(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

// Registers all 9 SDK-based skill tools.
function registerSkillTools(server, z) {
  server.registerTool(
    "search_skills",
    {
      description:
        "Search the Skillworks vault for skills by name, description, or tags. Returns matching skills with id, name, description, and tags.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Search text matched against skill name, description, and tags. Empty returns all skills."),
        limit: z.number().optional().describe("Maximum number of results to return. Defaults to 50."),
      },
    },
    async ({ query, limit }) => {
      const normalizedQuery = typeof query === "string" ? query : "";
      const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
      const state = await manager.getState(activeProject);
      const matches = searchSkills(state.skills, normalizedQuery).slice(0, normalizedLimit);
      return toContent({
        query: normalizedQuery,
        total: matches.length,
        skills: matches.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          type: skill.type,
          tags: skill.tags,
        })),
      });
    },
  );

  server.registerTool(
    "list_skill_sets",
    {
      description:
        "List available skill sets, including descriptions and entries, so an agent can choose which set to activate.",
      inputSchema: {
        projectPath: z
          .string()
          .optional()
          .describe("Project path used to include project-local sets and resolve project targets. Defaults to the server project."),
      },
    },
    async ({ projectPath }) => {
      const resolvedProjectPath = normalizeProjectArg(projectPath);
      const result = await manager.listSets({ projectPath: resolvedProjectPath });
      return toContent(result);
    },
  );

  server.registerTool(
    "activate_skill_set",
    {
      description:
        "Activate a skill set by id or exact name for a project. Applying a set changes only the targets referenced by that set.",
      inputSchema: {
        setId: z.string().optional().describe("Skill set id to activate."),
        name: z.string().optional().describe("Exact skill set name to activate when setId is not known."),
        projectPath: z
          .string()
          .optional()
          .describe("Project path used for project-local sets and project-scoped targets. Defaults to the server project."),
      },
    },
    async (args) => {
      requireSetIdOrName(args);
      const projectPath = normalizeProjectArg(args.projectPath);
      const setId = await resolveSetId(args, projectPath);
      const result = await manager.applySet(setId, { projectPath });
      return toContent({
        activatedSetId: setId,
        plan: result.plan,
        perTargetResult: result.perTargetResult,
        warnings: result.warnings,
      });
    },
  );

  server.registerTool(
    "create_skill_set",
    {
      description:
        "Create a new skill set (a reusable bundle of skills). Optionally seed it with skills for a harness. Use activate_skill_set to apply it later.",
      inputSchema: {
        name: z.string().describe("Display name for the set."),
        description: z.string().optional().describe("Optional description of what the set is for."),
        scope: z
          .enum(["global", "project"])
          .optional()
          .describe("Whether the set is global (available everywhere) or project-local. Defaults to global."),
        skills: z.array(z.string()).optional().describe("Optional skill ids to include in the set."),
        harness: z
          .string()
          .optional()
          .describe(
            "Harness the seeded skills target (claude, codex, opencode, gemini, cursor). Defaults to the harness this server was registered for. Only used when skills are provided.",
          ),
        projectPath: z
          .string()
          .optional()
          .describe("Project path for project-scoped sets and target resolution. Defaults to the active project."),
      },
    },
    async (args) => {
      const projectPath = normalizeProjectArg(args.projectPath);
      const setName = typeof args.name === "string" ? args.name.trim() : "";
      if (!setName) {
        throw new Error("create_skill_set requires a name");
      }
      const scope = args.scope === "project" ? "project" : "global";
      const skillIds = normalizeSkillIds(args.skills);
      let entries = [];
      if (skillIds.length > 0) {
        const targetId = resolveProjectTargetId(args.harness);
        const state = await manager.getState(projectPath);
        const skillsById = new Map(state.skills.map((skill) => [skill.id, skill]));
        entries = skillIds.map((skillId) => {
          const skill = skillsById.get(skillId);
          if (!skill) {
            throw new Error(`Unknown skill: ${skillId}`);
          }
          return { targetKey: targetId, skillName: skill.name };
        });
      }
      const result = await manager.createSet({
        name: setName,
        description: typeof args.description === "string" ? args.description : "",
        scope,
        projectPath: scope === "project" ? projectPath : undefined,
        entries,
      });
      return toContent({ set: result.set });
    },
  );

  server.registerTool(
    "delete_skill_set",
    {
      description:
        "Delete a skill set by id or exact name. This removes the saved set definition; it does not unlink skills already applied to targets.",
      inputSchema: {
        setId: z.string().optional().describe("Skill set id to delete."),
        name: z.string().optional().describe("Exact skill set name to delete when setId is not known."),
        projectPath: z
          .string()
          .optional()
          .describe("Project path used to resolve project-local sets. Defaults to the active project."),
      },
    },
    async (args) => {
      requireSetIdOrName(args);
      const projectPath = normalizeProjectArg(args.projectPath);
      const setId = await resolveSetId(args, projectPath);
      const result = await manager.deleteSet(setId, { projectPath });
      return toContent({ deletedId: result.deletedId });
    },
  );

  server.registerTool(
    "add_project",
    {
      description: "Register a project with Skillworks so it can hold skills. Returns the created project record and current state.",
      inputSchema: {
        path: z.string().describe("Absolute or ~-relative path to the project directory."),
        name: z.string().optional().describe("Optional display name. Defaults to the directory name."),
      },
    },
    async (args) => {
      const projectPath = requireProjectPath(args.path);
      const result = await manager.addProject(projectPath, {
        name: typeof args.name === "string" ? args.name : undefined,
      });
      return toContent({ project: result.project, activeProject });
    },
  );

  server.registerTool(
    "activate_project",
    {
      description:
        "Set the active project for this session. Subsequent skill/set operations default to it when no projectPath is given. Registers the project if it is not already known.",
      inputSchema: {
        path: z.string().describe("Absolute or ~-relative path to the project directory to activate."),
      },
    },
    async (args) => {
      const projectPath = requireProjectPath(args.path);
      const result = await manager.addProject(projectPath, {});
      activeProject = projectPath;
      return toContent({
        activeProject,
        project: compactProject(result.project),
        summary: result.state && result.state.summary,
      });
    },
  );

  server.registerTool(
    "add_skills_to_project",
    {
      description:
        "Link one or more vault skills into the active project's skill directory. By default targets the calling harness; pass `harness` to target a different one.",
      inputSchema: {
        skills: z.array(z.string()).describe("Skill ids (vault-relative paths) to add to the project."),
        harness: z
          .string()
          .optional()
          .describe("Harness to link for (claude, codex, opencode, gemini, cursor). Defaults to the harness this server was registered for."),
        projectPath: z.string().optional().describe("Project path to act on. Defaults to the active project."),
      },
    },
    async (args) => toggleSkillsTool("add_skills_to_project", args),
  );

  server.registerTool(
    "remove_skills_from_project",
    {
      description:
        "Unlink one or more skills from the active project's skill directory. By default targets the calling harness; pass `harness` to target a different one.",
      inputSchema: {
        skills: z.array(z.string()).describe("Skill ids (vault-relative paths) to remove from the project."),
        harness: z
          .string()
          .optional()
          .describe("Harness to unlink from (claude, codex, opencode, gemini, cursor). Defaults to the harness this server was registered for."),
        projectPath: z.string().optional().describe("Project path to act on. Defaults to the active project."),
      },
    },
    async (args) => toggleSkillsTool("remove_skills_from_project", args),
  );

  async function toggleSkillsTool(name, args) {
    const enabled = name === "add_skills_to_project";
    const projectPath = normalizeProjectArg(args.projectPath);
    const targetId = resolveProjectTargetId(args.harness);
    const skillIds = normalizeSkillIds(args.skills);
    if (skillIds.length === 0) {
      throw new Error(`${name} requires a non-empty "skills" array`);
    }
    let state;
    for (const skillId of skillIds) {
      state = await manager.toggleSkill({ projectPath, targetId, skillId, enabled });
    }
    const target = state && state.targets && state.targets.find((t) => t.id === targetId);
    return toContent({
      targetId,
      projectPath,
      [enabled ? "added" : "removed"]: skillIds,
      enabledInTarget: target ? target.enabledSkillIds.length : undefined,
    });
  }
}

// Normalize an agent-assembled spec into mcp-core.js's canonical shape:
// default `source.kind` to "manual" and coerce array/object fields to their
// empty defaults (mirrors `McpServerSpec`'s `#[serde(default)]` fields in
// `src-tauri/src/backend/mcp/spec.rs`).
function normalizeMcpServerSpec(spec) {
  const source = spec && spec.source && typeof spec.source === "object" ? spec.source : {};
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    source: { kind: source.kind || "manual", url: source.url },
    transport: spec.transport,
    command: spec.command,
    args: Array.isArray(spec.args) ? spec.args : [],
    env: spec.env && typeof spec.env === "object" ? spec.env : {},
    url: spec.url,
    headers: spec.headers && typeof spec.headers === "object" ? spec.headers : {},
    variants: Array.isArray(spec.variants) ? spec.variants : [],
  };
}

// Registers the 5 MCP-server-management tools (add/list/activate/deactivate/
// remove a library server), backed by mcp-core.js. Errors (unknown harness,
// unknown scope, validation failures, unknown id) are thrown and surfaced by
// the SDK as a tool error.
function registerMcpTools(server, z) {
  const mcpSourceShape = z.object({
    kind: z.string(),
    url: z.string().optional(),
  });

  server.registerTool(
    "list_mcp_servers",
    {
      description:
        "List every MCP server in the Skillworks library, plus its activation status (active/inactive, config path, trust notes) for every supported harness and scope.",
      inputSchema: {
        projectPath: z
          .string()
          .optional()
          .describe("Project path to include project-scope status for. Defaults to the active project."),
      },
    },
    async ({ projectPath }) => {
      const { appHome, homeDir } = await resolveMcpHomes();
      const resolvedProjectPath = normalizeProjectArg(projectPath);
      const servers = await mcpCore.loadLibrary(appHome);
      const status = await mcpCore.mcpStatus(appHome, homeDir, resolvedProjectPath);
      return toContent({ servers, status });
    },
  );

  server.registerTool(
    "add_mcp_server",
    {
      description:
        "Add an MCP server to the Skillworks library from a structured spec you assembled (e.g. after reading a README). Does not activate it.",
      inputSchema: {
        spec: z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().optional(),
          source: mcpSourceShape.optional(),
          transport: z.enum(["stdio", "http", "sse"]),
          command: z.string().optional(),
          args: z.array(z.string()).optional(),
          env: z.record(z.string()).optional(),
          url: z.string().optional(),
          headers: z.record(z.string()).optional(),
          variants: z.array(z.any()).optional(),
        }),
      },
    },
    async ({ spec }) => {
      const { appHome } = await resolveMcpHomes();
      const normalized = normalizeMcpServerSpec(spec);
      mcpCore.validateSpec(normalized);
      const servers = await mcpCore.loadLibrary(appHome);
      if (servers.some((s) => s.id === normalized.id)) {
        throw new Error(`A server with id ${JSON.stringify(normalized.id)} already exists in the library`);
      }
      servers.push(normalized);
      await mcpCore.saveLibrary(appHome, servers);
      return toContent({ server: normalized });
    },
  );

  server.registerTool(
    "activate_mcp_server",
    {
      description:
        "Activate a library MCP server for a harness + scope, writing it into that harness's config file so the harness picks it up.",
      inputSchema: {
        id: z.string().describe("Library server id to activate."),
        harness: z.string().describe("Harness id: claude, codex, cursor, opencode, gemini, copilot, or kiro."),
        scope: z
          .enum(["global", "project"])
          .describe("Whether to write into the harness's global config or the active project's config."),
        variantLabel: z
          .string()
          .optional()
          .describe("Explicit variant label to use instead of automatic appliesTo matching."),
        projectPath: z.string().optional().describe("Project path for project scope. Defaults to the active project."),
      },
    },
    async ({ id, harness, scope, variantLabel, projectPath }) => {
      const { appHome, homeDir } = await resolveMcpHomes();
      const servers = await mcpCore.loadLibrary(appHome);
      const spec = servers.find((s) => s.id === id);
      if (!spec) {
        throw new Error(`No library server with id ${JSON.stringify(id)}`);
      }
      const adapter = mcpCore.adapterFor(harness);
      const resolvedProjectPath = normalizeProjectArg(projectPath);
      const configPath = mcpCore.configPathFor(adapter, scope, homeDir, resolvedProjectPath);
      const inv = mcpCore.resolveEffective(spec, harness, scope, variantLabel);
      await mcpCore.writeEntry(configPath, adapter, id, inv);
      const result = { configPath };
      if (adapter.projectTrustNote && scope === "project") {
        result.trustNote = mcpCore.PROJECT_TRUST_NOTE;
      }
      return toContent(result);
    },
  );

  server.registerTool(
    "deactivate_mcp_server",
    {
      description:
        "Remove an MCP server entry from a harness + scope config, without touching the library. Works even if the id is no longer in the library.",
      inputSchema: {
        id: z.string().describe("Server id to remove from the target harness config."),
        harness: z.string().describe("Harness id: claude, codex, cursor, opencode, gemini, copilot, or kiro."),
        scope: z.enum(["global", "project"]).describe("Which config to remove it from."),
        projectPath: z.string().optional().describe("Project path for project scope. Defaults to the active project."),
      },
    },
    async ({ id, harness, scope, projectPath }) => {
      const { homeDir } = await resolveMcpHomes();
      const adapter = mcpCore.adapterFor(harness);
      const resolvedProjectPath = normalizeProjectArg(projectPath);
      const configPath = mcpCore.configPathFor(adapter, scope, homeDir, resolvedProjectPath);
      const removed = await mcpCore.removeEntry(configPath, adapter, id);
      return toContent({ removed, configPath });
    },
  );

  server.registerTool(
    "remove_mcp_server",
    {
      description:
        "Remove a server from the Skillworks library. Warns (but does not deactivate) if the entry is still written into any harness's config, and separately warns about any harness config that couldn't be checked (e.g. malformed or unreadable).",
      inputSchema: {
        id: z.string().describe("Library server id to remove."),
        projectPath: z
          .string()
          .optional()
          .describe("Project path to check for project-scope activation warnings. Defaults to the active project."),
      },
    },
    async ({ id, projectPath }) => {
      const { appHome, homeDir } = await resolveMcpHomes();
      const resolvedProjectPath = normalizeProjectArg(projectPath);
      // Computed BEFORE the library removal below: mcpStatus derives its
      // rows from the library, so the id must still be present in it to
      // report whether it's still active anywhere.
      const status = await mcpCore.mcpStatus(appHome, homeDir, resolvedProjectPath);
      const stillActiveAt = status
        .filter((row) => row.serverId === id && row.active)
        .map((row) => ({ harness: row.harness, scope: row.scope, configPath: row.configPath }));
      // mcpStatus rows for a target it couldn't even read (malformed JSON/TOML,
      // permission error, ...) come back as `active: false` + an `error`
      // field, so the filter above silently drops them -- `stillActiveAt: []`
      // would then falsely read as "definitely removed everywhere". Surface
      // those separately so the caller knows the check was incomplete for
      // that target. Mirrors Rust's `mcp_remove_server_impl`, which folds an
      // unreadable target into its `warnings` list instead of dropping it.
      const couldNotCheck = status
        .filter((row) => row.serverId === id && row.error)
        .map((row) => ({ harness: row.harness, scope: row.scope, configPath: row.configPath, error: row.error }));

      const servers = await mcpCore.loadLibrary(appHome);
      const before = servers.length;
      const remaining = servers.filter((s) => s.id !== id);
      if (remaining.length === before) {
        throw new Error(`No library server with id ${JSON.stringify(id)}`);
      }
      await mcpCore.saveLibrary(appHome, remaining);
      return toContent({ removed: id, stillActiveAt, couldNotCheck });
    },
  );
}

function requireSetIdOrName(args) {
  const hasSetId = typeof args.setId === "string" && args.setId.trim();
  const hasName = typeof args.name === "string" && args.name.trim();
  if (!hasSetId && !hasName) {
    throw new Error("This tool requires exactly one of setId or name");
  }
}

function compactProject(project) {
  if (!project || typeof project !== "object") return project;
  return {
    path: project.path,
    name: project.name,
    source: project.source,
  };
}

function searchSkills(skills, query) {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) {
    return skills;
  }
  const terms = normalized.split(/\s+/).filter(Boolean);
  return skills.filter((skill) => {
    const haystack = [
      skill.id,
      skill.name,
      skill.description,
      Array.isArray(skill.tags) ? skill.tags.join(" ") : "",
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function resolveProjectTargetId(harnessArg) {
  const harness = normalizeHarness(harnessArg) || selfHarness;
  if (!harness) {
    throw new Error(
      'Cannot determine harness. Pass "harness" (claude, codex, opencode, gemini, cursor) or register the server with --harness.',
    );
  }
  const targetId = HARNESS_PROJECT_TARGETS[harness];
  if (!targetId) {
    throw new Error(`Unsupported harness: ${harness}`);
  }
  return targetId;
}

function normalizeSkillIds(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function requireProjectPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error('A non-empty "path" is required');
  }
  return path.resolve(expandHomePath(value.trim()));
}

function expandHomePath(input) {
  if (input === "~") {
    return require("node:os").homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(require("node:os").homedir(), input.slice(2));
  }
  return input;
}

function normalizeHarness(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

async function resolveSetId(args, projectPath) {
  if (typeof args.setId === "string" && args.setId.trim()) {
    return args.setId.trim();
  }

  const requestedName = typeof args.name === "string" ? args.name.trim() : "";
  if (!requestedName) {
    throw new Error("This tool requires setId or name");
  }

  const sets = await manager.listSets({ projectPath });
  const matches = [...sets.global, ...sets.project].filter((set) => set.name === requestedName);
  if (matches.length === 0) {
    throw new Error(`Unknown set name: ${requestedName}`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple skill sets named "${requestedName}"; activate by setId`);
  }
  return matches[0].id;
}

function normalizeProjectArg(projectPath) {
  if (typeof projectPath === "string" && projectPath.trim()) {
    return path.resolve(expandHomePath(projectPath.trim()));
  }
  return activeProject;
}

function resolveInitialProject(parsedArgs) {
  if (parsedArgs["project-from-cwd"]) {
    return process.cwd();
  }
  if (typeof parsedArgs.project === "string" && parsedArgs.project.trim()) {
    return parsedArgs.project;
  }
  if (process.env.SKILLWORKS_PROJECT) {
    return process.env.SKILLWORKS_PROJECT;
  }
  if (process.env.AGENT_SKILL_PROJECT) {
    return process.env.AGENT_SKILL_PROJECT;
  }
  if (process.env.CLAUDE_PROJECT_DIR) {
    return process.env.CLAUDE_PROJECT_DIR;
  }
  return process.cwd();
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const item = rawArgs[index];
    if (!item.startsWith("--")) continue;
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
