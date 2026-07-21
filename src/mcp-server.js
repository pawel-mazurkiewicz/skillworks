#!/usr/bin/env node
const path = require("node:path");
const { createManager } = require("./core");

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

// --- SDK bootstrap -----------------------------------------------------
// The MCP SDK ships as ESM; src/ stays CommonJS, so the SDK is loaded via
// dynamic import() inside this async bootstrap (no repo-wide ESM switch).

async function main() {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");

  const server = new McpServer({ name: MCP_SERVER_NAME, version: readVersion() });
  registerSkillTools(server, z); // Task 1 registers search_skills; Task 2 ports the rest.
  // registerMcpTools(server, z); // added in Part 2 (Task 6)
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

// Registers the SDK-based skill tools. For this task only `search_skills` is
// wired up; the remaining 8 tools' logic is preserved below (in the legacy
// `tools()`/`callTool()` pair) for Task 2 to port over.
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
      // Ported verbatim from the old `if (name === "search_skills")` branch
      // in callTool() below.
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
}

// --- Legacy hand-rolled tool definitions (stashed for Task 2) ----------
// No longer wired to a transport; kept only so Task 2 can port the
// remaining 8 tools' handler bodies into registerSkillTools() without
// re-deriving their logic. Safe to delete once Task 2 lands.

function tools() {
  return [
    {
      name: "list_skill_sets",
      description: "List available skill sets, including descriptions and entries, so an agent can choose which set to activate.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: {
            type: "string",
            description: "Project path used to include project-local sets and resolve project targets. Defaults to the server project.",
          },
        },
      },
    },
    {
      name: "activate_skill_set",
      description: "Activate a skill set by id or exact name for a project. Applying a set changes only the targets referenced by that set.",
      inputSchema: {
        type: "object",
        properties: {
          setId: {
            type: "string",
            description: "Skill set id to activate.",
          },
          name: {
            type: "string",
            description: "Exact skill set name to activate when setId is not known.",
          },
          projectPath: {
            type: "string",
            description: "Project path used for project-local sets and project-scoped targets. Defaults to the server project.",
          },
        },
        anyOf: [
          { required: ["setId"] },
          { required: ["name"] },
        ],
      },
    },
    {
      name: "create_skill_set",
      description: "Create a new skill set (a reusable bundle of skills). Optionally seed it with skills for a harness. Use activate_skill_set to apply it later.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Display name for the set.",
          },
          description: {
            type: "string",
            description: "Optional description of what the set is for.",
          },
          scope: {
            type: "string",
            enum: ["global", "project"],
            description: "Whether the set is global (available everywhere) or project-local. Defaults to global.",
          },
          skills: {
            type: "array",
            items: { type: "string" },
            description: "Optional skill ids to include in the set.",
          },
          harness: {
            type: "string",
            description: "Harness the seeded skills target (claude, codex, opencode, gemini, cursor). Defaults to the harness this server was registered for. Only used when skills are provided.",
          },
          projectPath: {
            type: "string",
            description: "Project path for project-scoped sets and target resolution. Defaults to the active project.",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "delete_skill_set",
      description: "Delete a skill set by id or exact name. This removes the saved set definition; it does not unlink skills already applied to targets.",
      inputSchema: {
        type: "object",
        properties: {
          setId: {
            type: "string",
            description: "Skill set id to delete.",
          },
          name: {
            type: "string",
            description: "Exact skill set name to delete when setId is not known.",
          },
          projectPath: {
            type: "string",
            description: "Project path used to resolve project-local sets. Defaults to the active project.",
          },
        },
        anyOf: [
          { required: ["setId"] },
          { required: ["name"] },
        ],
      },
    },
    {
      name: "add_project",
      description: "Register a project with Skillworks so it can hold skills. Returns the created project record and current state.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or ~-relative path to the project directory.",
          },
          name: {
            type: "string",
            description: "Optional display name. Defaults to the directory name.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "activate_project",
      description: "Set the active project for this session. Subsequent skill/set operations default to it when no projectPath is given. Registers the project if it is not already known.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or ~-relative path to the project directory to activate.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "search_skills",
      description: "Search the Skillworks vault for skills by name, description, or tags. Returns matching skills with id, name, description, and tags.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search text matched against skill name, description, and tags. Empty returns all skills.",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return. Defaults to 50.",
          },
        },
      },
    },
    {
      name: "add_skills_to_project",
      description: "Link one or more vault skills into the active project's skill directory. By default targets the calling harness; pass `harness` to target a different one.",
      inputSchema: {
        type: "object",
        properties: {
          skills: {
            type: "array",
            items: { type: "string" },
            description: "Skill ids (vault-relative paths) to add to the project.",
          },
          harness: {
            type: "string",
            description: "Harness to link for (claude, codex, opencode, gemini, cursor). Defaults to the harness this server was registered for.",
          },
          projectPath: {
            type: "string",
            description: "Project path to act on. Defaults to the active project.",
          },
        },
        required: ["skills"],
      },
    },
    {
      name: "remove_skills_from_project",
      description: "Unlink one or more skills from the active project's skill directory. By default targets the calling harness; pass `harness` to target a different one.",
      inputSchema: {
        type: "object",
        properties: {
          skills: {
            type: "array",
            items: { type: "string" },
            description: "Skill ids (vault-relative paths) to remove from the project.",
          },
          harness: {
            type: "string",
            description: "Harness to unlink from (claude, codex, opencode, gemini, cursor). Defaults to the harness this server was registered for.",
          },
          projectPath: {
            type: "string",
            description: "Project path to act on. Defaults to the active project.",
          },
        },
        required: ["skills"],
      },
    },
  ];
}

async function callTool(params) {
  const name = params.name;
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};

  if (name === "list_skill_sets") {
    const projectPath = normalizeProjectArg(args.projectPath);
    const result = await manager.listSets({ projectPath });
    return toolResult(result);
  }

  if (name === "activate_skill_set") {
    const projectPath = normalizeProjectArg(args.projectPath);
    const setId = await resolveSetId(args, projectPath);
    const result = await manager.applySet(setId, { projectPath });
    return toolResult({
      activatedSetId: setId,
      plan: result.plan,
      perTargetResult: result.perTargetResult,
      warnings: result.warnings,
    });
  }

  if (name === "create_skill_set") {
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
    return toolResult({ set: result.set });
  }

  if (name === "delete_skill_set") {
    const projectPath = normalizeProjectArg(args.projectPath);
    const setId = await resolveSetId(args, projectPath);
    const result = await manager.deleteSet(setId, { projectPath });
    return toolResult({ deletedId: result.deletedId });
  }

  if (name === "add_project") {
    const projectPath = requireProjectPath(args.path);
    const result = await manager.addProject(projectPath, {
      name: typeof args.name === "string" ? args.name : undefined,
    });
    return toolResult({ project: result.project, activeProject });
  }

  if (name === "activate_project") {
    const projectPath = requireProjectPath(args.path);
    const result = await manager.addProject(projectPath, {});
    activeProject = projectPath;
    return toolResult({
      activeProject,
      project: compactProject(result.project),
      summary: result.state && result.state.summary,
    });
  }

  if (name === "search_skills") {
    const query = typeof args.query === "string" ? args.query : "";
    const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 50;
    const state = await manager.getState(activeProject);
    const matches = searchSkills(state.skills, query).slice(0, limit);
    return toolResult({
      query,
      total: matches.length,
      skills: matches.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        type: skill.type,
        tags: skill.tags,
      })),
    });
  }

  if (name === "add_skills_to_project" || name === "remove_skills_from_project") {
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
    return toolResult({
      targetId,
      projectPath,
      [enabled ? "added" : "removed"]: skillIds,
      enabledInTarget: target ? target.enabledSkillIds.length : undefined,
    });
  }

  throw new Error(`Unknown tool: ${name}`);
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

function toolResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
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
