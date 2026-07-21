# MCP Server Management — Roadmap

**Status:** Living document. Phases A + B + D implemented on `feature/mcp-management-phase-a` (reviewed, all tests green); C, E, F pending.
**Date:** 2026-07-20

## Ultimate goal

Make MCP server activation/deactivation a first-class Skillworks feature,
mirroring how skills work today: a canonical library the user curates, activated
into any harness × {global, project} scope with one action. A server is defined
once (with per-harness/per-scope invocation variants), then toggled anywhere.

**Decisions locked during brainstorming (2026-07-20):**
- Library is the source of truth; a spec carries a quick-start default
  invocation plus optional variants (different transport/args/env per harness,
  scope, or project).
- **No in-app browsing/marketplace for MCP servers.** The user brings a GitHub
  repo or instruction-page URL; Skillworks parses it into a draft spec.
- Ingestion paths: URL parsing (heuristic), agent-assisted (MCP tools), manual
  entry, and discovery of servers already configured on the machine.
- No bundled local LLM for parsing (considered, rejected: 0.4–1.5GB weight,
  ML-runtime complexity, tiny models hallucinate flags; the user's own frontier
  agent does it better via the MCP-tool path). Possible far-future enhancement.
- Deactivate = remove the entry from the harness config. Out-of-band
  enable/disable state (Gemini enablement file, Cursor UI toggle, Claude
  `disabledMcpjsonServers`) is never managed.
- v1 harness set = the 7 with high-confidence research (below). Others deferred.

## Phases

| Phase | Scope | Status |
|---|---|---|
| **A — Library + engine** | `McpServerSpec`/variants, `<appHome>/mcp/servers.json`, adapter table (7 harnesses), generic JSON/TOML engine, activate/deactivate/status/discover-read commands, `mcp_register.rs` refactored onto engine | **Done** (spec + plan + implementation, final review passed) |
| **B — URL ingestion** | `parse.rs` heuristics: fetch GitHub/README/instruction URL; extract fenced ```json `mcpServers` blocks, `npx`/`uvx`/`docker run` command lines, `claude mcp add …` lines; produce draft spec for user review; `mcp_add_from_url` command | **Done** (spec `2026-07-20-mcp-management-phase-b-design.md`, final review passed; D pre-work items below) |
| **C — Discovery reconciliation** | Promote Phase A's read-only `mcp_discover` into full reconciliation: match unmanaged entries to library specs, "import to library" flow (source.kind = "discovered"), conflict handling when an entry diverges from its spec | Not started |
| **D — Frontend UI** | "MCP Servers" surface mirroring the skills grid: library list, per-harness×scope activation matrix, add-from-URL form, discovered-servers panel, variant editor. Follows design tokens + workshop aesthetic | **Done** (spec `2026-07-21-mcp-management-phase-d-design.md`, Tasks 1–10 complete incl. Playwright smoke + full gate) |
| **E — Agent-assisted tools** | Node MCP server (`src/mcp-server.js` + `core.js`) mirror: `add_mcp_server`, `add_mcp_server_from_url`, `activate_mcp_server`, `deactivate_mcp_server`, `list_mcp_servers` tools so the user's coding agent can parse prose pages and manage servers. Shares the library file + adapter semantics with the Rust side (keep in lockstep like `targets.rs` ↔ `core.js`) | Not started |
| **F — Deferred harnesses** | Add medium/low-confidence harnesses behind an "experimental" flag once verified on a real machine (see below) | Not started |

Recommended order: A → B → D (usable end-to-end at that point) → C → E → F.
C and E are independent of each other and can swap.

## v1 harnesses (Phase A) — research: high confidence

Full write-matrix lives in the Phase A spec §4. Summary: claude, codex, cursor,
opencode, gemini, copilot (CLI), kiro — global + project each.

## Deferred harnesses — research findings (2026-07-20, preserve!)

These were researched but cut from v1. Verify on a real machine before enabling.

### Antigravity (medium confidence)
- Global: `~/.gemini/config/mcp_config.json`, key `mcpServers`, strict JSON.
- Project: `.agents/mcp_config.json` at workspace root.
- Remote entries use **`serverUrl`** (not `url`/`httpUrl`); optional
  `authProviderType`/`oauth`. Explicit **`disabled`** boolean per entry.
- Single config shared by Antigravity IDE + CLI. Windows path unconfirmed.
- Caveat: official docs page yielded no content; schema from two secondary
  sources. Community report of buggy env-var substitution.

### CodeBuddy (medium confidence)
- Global priority order (read first existing, write highest-priority):
  `~/.codebuddy/.mcp.json` (recommended) > `~/.codebuddy/mcp.json` (deprecated)
  > `~/.codebuddy.json` (legacy). Key `mcpServers`.
- Project: `<root>/.mcp.json` (recommended) or `/mcp.json` (deprecated); plus a
  "LOCAL scope" inside the user file under `projects.<workspace_path>`.
- `type: stdio|sse|http` explicit; extras: `description`, `timeout`,
  `defer_loading`. Disable mechanism inconsistent across sources
  (`disabled` bool vs `disabledMcpServers` array) — verify.
- Editor must check all 3 legacy global paths before writing.

### OpenClaw (medium confidence)
- Global only: `~/.openclaw/openclaw.json`, key path **`mcp.servers`** (nested,
  NOT `mcpServers`). No project scope.
- stdio: `command`/`args`/`env`/`cwd`. Remote: `url` + `transport:
  "streamable-http"` + `auth`. Explicit `enabled` flag.
- Rejects interpreter-hijack env keys in stdio `env`. Per-agent routing via
  `agents.<name>.mcpServers`.
- NOT a Claude Code fork (different product category — messaging gateway).

### Trae (LOW confidence — re-verify everything)
- Claimed: `~/.trae/mcp.json` global, `.trae/mcp.json` project, key
  `mcpServers`, three transports, `disabled` bool — but **official docs are a
  client-rendered SPA that returned no content**; details come from conflicting
  third-party guides (one says project file is `mcp_settings.json`).
- Action before enabling: inspect a real Trae install's files after adding a
  server via its UI.

### Qoder (LOW confidence — re-verify everything)
- Key `mcpServers` corroborated; stdio + sse schemas known.
- Global config path NOT officially documented (conflicting third-party claims:
  `~/.qoder/settings.json` vs `mcp-settings.json` variants).
- Project scope confirmed ABSENT as of mid-2026 (open feature request on the
  Qoder forum, 2026-03). Beware AI-generated search snippets projecting Claude
  conventions onto Qoder.
- Separate `qodercli` may read different config than the IDE.

### Excluded permanently (unless the world changes)
- **Agents (AGENTS.md / `.agents/` skills convention):** no MCP concept in the
  spec (pure markdown instructions). The `agentsstandard.com`
  `~/.agents/mcp-settings.json` proposal is third-party, unadopted by any
  shipping harness — do not build against it.

### Adjacent, not in the harness list
- **Copilot in VS Code** uses `.vscode/mcp.json` / user-profile `mcp.json` with
  key **`servers`** (not `mcpServers`) and explicit `type` — a distinct target
  if VS Code support is ever wanted.

## Phase D pre-work (from Phase B whole-phase review, 2026-07-21)

Before the URL-ingestion flow is exposed as a one-click UI action:
- SSRF host guard (deny loopback/link-local/private ranges) + redirect cap on
  `mcp_add_from_url`'s fetch; the `.md` catch-all row fetches arbitrary https
  hosts today.
- Turn the 1 MiB size cap into a real fetch guard (Content-Length check or
  bounded read) — currently enforced only after full download.
- Split `parse.rs` (~1.2k lines) along its natural seams: url / fences /
  heuristics / assembly.
- Add 1-2 verbatim real-world README fixtures (multi-fence, CRLF, unicode
  names) — current tests are synthetic minimal fences.
- Placeholder/shell-ref warnings scan only the canonical spec, not variants.
- Note for UI copy: the "1 draft + 2 variants" multi-style outcome only occurs
  when the docker image basename matches the config key; separate drafts are
  the common real-world result.

## Open questions (carried forward)
- JSONC comment preservation for OpenCode configs (dropped in A).
- Copilot project path: `.mcp.json` chosen; `.github/mcp.json` also exists.
- Claude/Codex project-scope trust approval: surfaced as a note only; could
  Phase D link to docs per harness?
- Discovery matching beyond exact key-name equality (Phase C design question).
- Cursor's ~40-active-tools soft ceiling: worth a warning in Phase D UI when
  many servers are active for Cursor?
