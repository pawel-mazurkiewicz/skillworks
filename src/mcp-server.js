#!/usr/bin/env node
const path = require("node:path");
const { createManager } = require("./core");

const MCP_SERVER_NAME = "skillworks";

const args = parseArgs(process.argv.slice(2));
const initialProject = resolveInitialProject(args);
const manager = createManager({
  appHome: args["app-home"],
  homeDir: args.home,
});

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drainMessages().catch((error) => {
    process.stderr.write(`MCP server error: ${error.stack || error.message || error}\n`);
  });
});

process.stdin.on("end", () => {
  process.exit(0);
});

async function drainMessages() {
  while (true) {
    const parsed = readFrame();
    if (!parsed) return;
    await handleMessage(parsed);
  }
}

function readFrame() {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;

  const header = buffer.slice(0, headerEnd).toString("utf8");
  const match = header.match(/content-length:\s*(\d+)/i);
  if (!match) {
    throw new Error("Missing Content-Length header");
  }

  const length = Number(match[1]);
  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd) return null;

  const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
  buffer = buffer.slice(bodyEnd);
  return JSON.parse(body);
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  if (!Object.prototype.hasOwnProperty.call(message, "id")) return;

  try {
    if (message.method === "initialize") {
      sendResponse(message.id, {
        protocolVersion: message.params?.protocolVersion || "2025-06-18",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: MCP_SERVER_NAME,
          version: "0.1.0",
        },
      });
      return;
    }

    if (message.method === "tools/list") {
      sendResponse(message.id, { tools: tools() });
      return;
    }

    if (message.method === "tools/call") {
      const result = await callTool(message.params || {});
      sendResponse(message.id, result);
      return;
    }

    sendError(message.id, -32601, `Unknown method: ${message.method}`);
  } catch (error) {
    sendError(message.id, -32000, error.message || "Tool execution failed");
  }
}

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

  throw new Error(`Unknown tool: ${name}`);
}

async function resolveSetId(args, projectPath) {
  if (typeof args.setId === "string" && args.setId.trim()) {
    return args.setId.trim();
  }

  const requestedName = typeof args.name === "string" ? args.name.trim() : "";
  if (!requestedName) {
    throw new Error("activate_skill_set requires setId or name");
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

function sendResponse(id, result) {
  sendMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  sendMessage({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

function sendMessage(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function normalizeProjectArg(projectPath) {
  if (typeof projectPath === "string" && projectPath.trim()) {
    return path.resolve(projectPath.trim());
  }
  return path.resolve(initialProject);
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
