// DOM module for the "MCP Servers" tab (Phase D). Plain state/render/event
// delegation in the same style as app.js — no React. Wired from app.js via
// window.McpServers.{onEnter,onWorkspaceChanged}; see bootstrap() in app.js
// for the tab-switch, project-change, and Refresh-button hooks.
//
// Skeleton scope (Task 7 of the mcp-management Phase D plan): sidebar list
// + refresh model only. The detail pane's fields form + activation matrix
// land in Task 8; the tri-state variant editor, add-from-URL/manual flow,
// and discovered panel land in Task 9.

import { api } from "./api-shim.js";
import { escapeHtml, newGeneration, isStale } from "./mcp-logic.js";

const state = {
  generation: 0,
  servers: [],
  statuses: [],
  discovered: [],
  selectedId: null,
  loading: false,
};

// True once the tab has been entered at least once — onWorkspaceChanged
// (project-change / global Refresh) is a no-op until then so we don't fetch
// MCP data the user has never asked to see.
let entered = false;

const els = {
  list: document.querySelector("#mcpServersList"),
  detail: document.querySelector("#mcpServersDetail"),
  add: document.querySelector("#mcpServersAdd"),
  discovered: document.querySelector("#mcpServersDiscovered"),
};

function projectPath() {
  const input = document.querySelector("#projectInput");
  return input ? input.value.trim() : "";
}

function withProject(path) {
  const project = projectPath();
  return project ? `${path}?project=${encodeURIComponent(project)}` : path;
}

async function refreshAll() {
  const gen = newGeneration();
  state.generation = gen;
  state.loading = true;
  render();
  try {
    const [library, statuses, discovered] = await Promise.all([
      api("/api/mcp/servers"),
      api(withProject("/api/mcp/servers/status")),
      api(withProject("/api/mcp/servers/discover")),
    ]);
    if (isStale(gen, state.generation)) return;
    state.servers = Array.isArray(library && library.servers) ? library.servers : [];
    state.statuses = Array.isArray(statuses) ? statuses : [];
    state.discovered = Array.isArray(discovered) ? discovered : [];
    if (state.selectedId && !state.servers.some((s) => s.id === state.selectedId)) {
      state.selectedId = null;
    }
  } catch (err) {
    if (isStale(gen, state.generation)) return;
    // api() already surfaces a toast for non-silent routes; log for
    // debugging without throwing into callers that don't await/catch us.
    console.error("[mcp-servers] refresh failed", err);
  } finally {
    if (!isStale(gen, state.generation)) {
      state.loading = false;
      render();
    }
  }
}

export async function onEnter() {
  entered = true;
  await refreshAll();
}

export async function onWorkspaceChanged() {
  if (!entered) return;
  await refreshAll();
}

function activeCountFor(serverId) {
  return state.statuses.filter((s) => s.serverId === serverId && s.active).length;
}

function transportLabel(transport) {
  const value = String(transport || "").toLowerCase();
  if (value === "stdio") return "Stdio";
  if (value === "http") return "HTTP";
  if (value === "sse") return "SSE";
  return value ? value.toUpperCase() : "Unknown";
}

function render() {
  renderList();
  renderDetail();
}

function renderList() {
  if (!els.list) return;
  if (state.loading && !state.servers.length) {
    els.list.innerHTML = `<p class="empty-copy">Loading MCP servers…</p>`;
    return;
  }
  if (!state.servers.length) {
    els.list.innerHTML = `
      <div class="mcp-servers-empty empty-copy">
        <p>No MCP servers in your library yet.</p>
        <p>Add one from a URL or enter it manually below.</p>
      </div>`;
    return;
  }
  els.list.innerHTML = state.servers
    .map((server) => {
      const count = activeCountFor(server.id);
      const selected = server.id === state.selectedId;
      return `
        <button type="button" class="mcp-servers-row${selected ? " is-selected" : ""}" data-mcp-server-id="${escapeHtml(server.id)}" aria-pressed="${selected ? "true" : "false"}">
          <span class="mcp-servers-row-name">${escapeHtml(server.name || server.id)}</span>
          <span class="mcp-servers-chip">${escapeHtml(transportLabel(server.transport))}</span>
          <span class="mcp-servers-badge"${count ? "" : ' data-empty="true"'}>${count} active</span>
        </button>`;
    })
    .join("");
}

// Stub — the fields form + activation matrix land in Task 8.
function renderDetail() {
  if (!els.detail) return;
  if (!state.selectedId) {
    els.detail.innerHTML = `<p class="empty-copy">Select a server on the left to view its details.</p>`;
    return;
  }
  const server = state.servers.find((s) => s.id === state.selectedId);
  if (!server) {
    els.detail.innerHTML = `<p class="empty-copy">That server is no longer in the library — try refreshing.</p>`;
    return;
  }
  els.detail.innerHTML = `<p class="empty-copy">Editing “${escapeHtml(server.name || server.id)}” isn't available yet — coming in the next update.</p>`;
}

if (els.list) {
  els.list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-mcp-server-id]");
    if (!button) return;
    const id = button.dataset.mcpServerId;
    state.selectedId = state.selectedId === id ? null : id;
    renderList();
    renderDetail();
  });
}

window.McpServers = { onEnter, onWorkspaceChanged };
