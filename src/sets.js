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
