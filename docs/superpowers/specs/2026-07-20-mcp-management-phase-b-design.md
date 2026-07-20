# MCP Server Management — Phase B: URL Ingestion

**Status:** Design approved (brainstorm), ready for implementation plan
**Date:** 2026-07-20
**Scope:** Phase B of the MCP-management feature (roadmap:
`2026-07-20-mcp-management-roadmap.md`). Heuristic parsing of user-supplied
URLs into draft `McpServerSpec`s. Builds on Phase A (library, adapters,
engine); ships one new command and one parser module. No UI (Phase D), no
agent tools (Phase E), no library writes.

---

## 1. Motivation

Skillworks has no MCP marketplace by design: the user brings a GitHub repo or
instruction page. Phase B turns the machine-readable majority of those pages
into prefilled draft specs, so manual entry is the exception, not the rule.
Prose-heavy pages remain the agent-assisted path's job (Phase E).

## 2. Goals / Non-goals

**Goals:**
- `mcp_add_from_url(url)` Tauri command: fetch → parse → return drafts +
  warnings. **Never persists** — the caller reviews and then uses the existing
  `mcp_add_manual`.
- Markdown-source support only: GitHub repo URLs (README), raw `.md` URLs,
  gists.
- Heuristic extraction of stdio and remote server definitions from fenced
  config blocks (JSON + TOML), and from install command lines.
- Reverse dialect mapping: recognize harness-specific field spellings and
  normalize to the canonical `McpServerSpec` shape.
- Multi-candidate handling: one draft per distinct server name; alternate
  invocation styles of the same server become `variants`.
- Evidence + warnings so a reviewer can judge each draft's provenance.

**Non-goals:**
- Arbitrary HTML instruction pages (regex-stripping `<pre>` blocks) — deferred;
  the error message routes users to the agent path or manual entry.
- Fetching/cloning repos, reading package.json/pyproject — README text only.
- Any library mutation, UI, or MCP-server tool surface.
- LLM-based parsing (rejected for the product; see roadmap).

## 3. URL classification

`source_for_url(url) -> BackendResult<FetchPlan>` (pure):

| Input | Fetch target | Notes |
|---|---|---|
| `https://github.com/<org>/<repo>` | `https://raw.githubusercontent.com/<org>/<repo>/HEAD/README.md` | `HEAD` resolves the default branch |
| `https://github.com/<org>/<repo>/tree/<ref>/<path>` | `https://raw.githubusercontent.com/<org>/<repo>/<ref>/<path>/README.md` | monorepo subdir support |
| `https://github.com/<org>/<repo>/blob/<ref>/<path>.md` | corresponding `raw.githubusercontent.com` URL | direct file link |
| `https://raw.githubusercontent.com/...` or any URL ending `.md` | as-is | |
| `https://gist.github.com/<user>/<id>` | `<url>/raw` | first file only; warning attached |
| anything else | `Validation` error | message names the two fallbacks: "ask your coding agent to import it" / manual entry |

Only `https` URLs are accepted. The fetch uses `marketplace.rs`'s existing
`HttpClient` trait (`ReqwestHttpClient` in production, mock in tests) with a
size cap (1 MiB) and a follow-redirects GET. Non-2xx → `Validation` error
including the status code. A 404 on `HEAD/README.md` retries once with
`master/README.md` before giving up (old repos).

## 4. Extraction heuristics (`backend/mcp/parse.rs`)

`extract_drafts(markdown: &str, fallback_name: &str) -> ExtractionResult`
(pure; `fallback_name` is the repo/file slug from the URL).

Scanning order (priority high → low; priority decides which match becomes a
draft's canonical invocation vs a variant):

**H1 — fenced JSON config blocks.** Scan ``` fences (any info-string: json,
jsonc, json5, js, empty). Strip `//`-style line comments before parsing
(tolerant of JSONC docs). Accept a block when the parsed object contains one
of the known server-map keys, searched at any nesting depth: `mcpServers`,
`mcp_servers`, `mcp` (OpenCode: entries under it that look like server
objects), `servers` (VS Code style). Each entry under the map is one
candidate.

**H2 — fenced TOML blocks** containing `[mcp_servers.<name>]` tables
(Codex-style docs). Parsed with `toml_edit` (already a dependency).

**H3 — command lines** inside any fenced block or inline code span:
- `claude mcp add [--transport <t>] [--scope …] [--env K=V]* <name> [--] <cmd> [args…]`
  → stdio candidate (or remote when `--transport http|sse` + URL argument).
- `claude mcp add-json <name> '<json>'` → parse the inline JSON as one entry.
- Bare install-style lines producing a candidate named from the package:
  `npx [-y] <pkg> [args…]`, `uvx <pkg> [args…]`,
  `docker run … <image> [args…]` (image = last non-flag token; env from `-e K=V`).

**Reverse dialect mapping** (H1 entries) — the adapter table's knowledge run
backwards, applied per entry:
- command shape: `command: [argv…]` (OpenCode) → split into command + args;
  `command` + `args` → as-is.
- env key: `env` or `environment` → `env`.
- remote url key: `url`, `httpUrl`, or `serverUrl` → `url`; `httpUrl` implies
  transport http; a `type`/`transport` field maps via
  {`stdio`,`local` → stdio; `http`, `streamable-http`, `remote` → http;
  `sse` → sse}; absent type: `command` present → stdio, else url present → http.
- `headers` / `http_headers` → `headers`.
- Ignored keys (`enabled`, `disabled`, `timeout`, `autoApprove`, tool filters,
  `cwd`, `envFile`, `oauth`, …) are dropped and listed in that draft's
  evidence as "ignored: …" so nothing disappears silently.

## 5. Draft assembly

- Group candidates by inferred name (config key > `claude mcp add` name >
  package/image basename > `fallback_name`).
- Id: name slugified to `^[a-z0-9][a-z0-9-]*$` (lowercase, non-alnum → `-`,
  collapse repeats, trim). Empty after slugging → `fallback_name` slug.
- Per group: highest-priority candidate (H1 > H2 > H3) supplies the canonical
  fields; every other distinct invocation becomes a `McpVariant` with a
  generated label (`"docker"`, `"remote-http"`, `"npx"` — derived from the
  invocation shape) and no `applies_to`.
- Two candidates are "the same invocation" (deduped, no variant) when
  transport, command, args, url all match.
- A group whose name was only inferred from a package/image basename folds
  into an explicitly-named group when exactly one such group has an
  env/headers-compatible identical invocation; ambiguous or env-incompatible
  folds are left as separate drafts.
- `source` = `{ kind: "url", url: <original input url> }`, `transport` = the
  canonical candidate's transport.
- Each draft passes Phase A's `validate_spec` before being returned; a
  candidate group that cannot form a valid spec (e.g. stdio with no command)
  is dropped into `warnings` instead of `drafts`.

**Placeholder detection** (values in env, headers, args, url): a value
matching any of `YOUR_*`, `<...>`, `${...}`, `xxx+`, `REPLACE`, `changeme`,
`*_HERE` (case-insensitive) is kept verbatim but adds a warning:
`"<draft-id>: <field> contains placeholder '<value>' — fill in a real value
before activating"`.

## 6. IPC surface

`types.rs`:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerDraft {
    pub spec: super::mcp::spec::McpServerSpec,
    pub evidence: Vec<String>,   // e.g. "H1 json block (line 42): key \"context7\""
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpUrlParseResponse {
    pub source_url: String,
    pub fetched_url: String,     // what was actually downloaded
    pub drafts: Vec<McpServerDraft>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}
```

`commands.rs`: `mcp_add_from_url(url: String) -> BackendResult<McpUrlParseResponse>`
+ `mcp_add_from_url_impl(url, client: &dyn HttpClient)` for tests. Registered
in `lib.rs`.

Empty `drafts` with no fetch error is **success** with a warning
("nothing machine-readable found — use manual entry or ask your agent"), not
an error: the caller distinguishes "bad URL" (error) from "page had nothing"
(empty drafts).

## 7. Error handling

- Non-https / unclassifiable URL → `Validation` (with fallback guidance).
- Fetch failure / non-2xx / over size cap → `Validation` incl. status.
- Malformed JSON inside a fence → that block is skipped with a warning; other
  blocks still parse (one bad snippet must not kill the page).
- Library id collisions are NOT checked here (drafts aren't persisted);
  `mcp_add_manual` already rejects duplicates at save time.

## 8. Testing

- **Parser (pure, fixture-driven):** single-server README (Claude-style
  mcpServers block); OpenCode argv/environment block; Codex TOML block;
  VS Code `servers` block; monorepo README (3 servers → 3 drafts);
  multi-style README (npx + docker + remote → 1 draft + 2 variants);
  `claude mcp add` line incl. `--transport http` and `add-json`;
  docker `-e` env extraction; JSONC comment tolerance; malformed-block
  skip-with-warning; placeholder warnings; nothing-found → empty drafts +
  warning; name slugging edge cases.
- **URL classification (pure):** every row of the §3 table + rejection cases.
- **Command (mock HttpClient):** github → raw README fetch; 404 →
  master-branch retry; non-2xx error; end-to-end drafts from a fixture body.
- All tests `#[tokio::test]`/`#[test]` per codebase convention; no network in
  tests.

## 9. Open questions carried forward

- HTML instruction pages: revisit after Phase E ships (agent path may prove
  sufficient).
- `HEAD` ref on raw.githubusercontent: works for default branches today;
  the master-retry covers the residual. If GitHub changes behavior, switch to
  the repos API (adds auth/rate-limit concerns — avoided for now).
- Should evidence carry byte offsets for future UI highlighting? Deferred to
  Phase D's needs.
