# MCP Management Phase D (Frontend UI + Hardening) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The "MCP Servers" tab (library, activation matrix, tri-state variant editor, add-from-URL, discovered panel) over the Phase A/B backend, plus the ingestion hardening and backend additions from the spec.

**Spec (authoritative):** `docs/superpowers/specs/2026-07-21-mcp-management-phase-d-design.md` — every task below cites its sections; read the cited sections before implementing.

**Architecture:** Backend tasks extend `backend/mcp/` + `commands.rs`; frontend is a new `public/mcp-servers.js` DOM module + api-shim routes + markup/styles, mirroring app.js patterns.

**Tech Stack:** Rust/Tauri, serde_json, toml_edit, tokio, reqwest (existing features only); vanilla JS DOM module, `node --test`, Playwright (new devDependency, Task 10 only).

**Plan-form note:** backend steps carry complete code. Frontend DOM steps carry exact interfaces, DOM contracts, representative snippets for the tricky parts, and acceptance criteria — NOT full verbatim markup; the spec §4/§6 govern. This is deliberate (verbatim UI code in plans has been this project's main source of plan bugs).

## Global Constraints

- Branch: `feature/mcp-management-phase-a`. Conventional commits, no Co-Authored-By.
- Spec §2 namespaces: new tab `data-top-tab="mcp-servers"`, state slice `state.mcpServers`, classes `mcp-servers-*`. Existing `mcp` namespace/tab untouched except the §6 relabel to "Connector".
- Design tokens only; no new colors/radii. AA floor per spec §6. Safe-rendering rule: ALL backend/URL-derived strings via `textContent` or the shared escape helper; env/header values masked by default.
- All library mutations serialized behind one `tokio::sync::Mutex` (spec §5.1).
- Evidence is pre-save only (spec Non-goals). The saved detail pane never shows evidence.
- Tests: cargo (`cd src-tauri && cargo test`), `npm test`, `npm run build` — full gate in Task 10; each task runs its focused tests + the suites it touches. Warning-free builds throughout.

---

### Task 1: variant-aware centralized validation (spec §5.1)

**Files:** Modify `src-tauri/src/backend/mcp/spec.rs`

**Interfaces:**
- `validate_spec(&McpServerSpec) -> BackendResult<()>` (same signature) now ALSO validates: variant labels non-empty + unique; `applies_to.harness` ∈ adapter ids when present; `applies_to.scope` ∈ {"global","project"} when present; every variant's effective invocation valid.
- New helper `pub fn validate_variants(spec) -> BackendResult<()>` called from `validate_spec` (import `super::adapters::adapter_for` — note: spec.rs gains a dependency on adapters.rs; acceptable, adapters has no reverse dependency).

- [ ] **Step 1: failing tests** (append to spec.rs tests)

```rust
    fn spec_with_variant(v: McpVariant) -> McpServerSpec {
        let mut s = stdio_spec();
        s.variants = vec![v];
        s
    }

    #[test]
    fn validate_rejects_bad_variants() {
        // empty label
        assert!(validate_spec(&spec_with_variant(McpVariant {
            label: "".into(), applies_to: None, transport: None, command: None,
            args: None, env: None, url: None, headers: None,
        })).is_err());
        // duplicate labels
        let mut s = stdio_spec();
        let v = McpVariant { label: "x".into(), applies_to: None, transport: None,
            command: None, args: None, env: None, url: None, headers: None };
        s.variants = vec![v.clone(), v];
        assert!(validate_spec(&s).is_err());
        // unknown harness in applies_to
        assert!(validate_spec(&spec_with_variant(McpVariant {
            label: "a".into(),
            applies_to: Some(McpAppliesTo { harness: Some("emacs".into()), scope: None }),
            transport: None, command: None, args: None, env: None, url: None, headers: None,
        })).is_err());
        // bad scope
        assert!(validate_spec(&spec_with_variant(McpVariant {
            label: "a".into(),
            applies_to: Some(McpAppliesTo { harness: None, scope: Some("universe".into()) }),
            transport: None, command: None, args: None, env: None, url: None, headers: None,
        })).is_err());
        // variant flips to http without url -> unusable effective invocation
        assert!(validate_spec(&spec_with_variant(McpVariant {
            label: "broken-remote".into(), applies_to: None,
            transport: Some(McpTransport::Http),
            command: None, args: None, env: None, url: None, headers: None,
        })).is_err());
        // valid variant still passes
        assert!(validate_spec(&spec_with_variant(McpVariant {
            label: "remote".into(), applies_to: None,
            transport: Some(McpTransport::Http),
            command: None, args: None, env: None,
            url: Some("https://x/mcp".into()), headers: None,
        })).is_ok());
    }
```

- [ ] **Step 2: run** `cd src-tauri && cargo test backend::mcp::spec` → FAIL (assertions).
- [ ] **Step 3: implement**

```rust
fn validate_variants(spec: &McpServerSpec) -> BackendResult<()> {
    let mut seen = Vec::new();
    for v in &spec.variants {
        if v.label.trim().is_empty() {
            return Err(BackendError::Validation(format!(
                "{}: variant label must not be empty", spec.id
            )));
        }
        if seen.contains(&v.label) {
            return Err(BackendError::Validation(format!(
                "{}: duplicate variant label {:?}", spec.id, v.label
            )));
        }
        seen.push(v.label.clone());
        if let Some(applies) = &v.applies_to {
            if let Some(h) = &applies.harness {
                super::adapters::adapter_for(h).map_err(|_| {
                    BackendError::Validation(format!(
                        "{}: variant {:?} targets unknown harness {h:?}", spec.id, v.label
                    ))
                })?;
            }
            if let Some(s) = &applies.scope {
                if s != "global" && s != "project" {
                    return Err(BackendError::Validation(format!(
                        "{}: variant {:?} has invalid scope {s:?}", spec.id, v.label
                    )));
                }
            }
        }
        // effective invocation must be valid
        let inv_transport = v.transport.unwrap_or(spec.transport);
        let inv_command = v.command.clone().or_else(|| spec.command.clone());
        let inv_url = v.url.clone().or_else(|| spec.url.clone());
        check_transport_fields(inv_transport, &inv_command, &inv_url,
            &format!("{} variant {:?}", spec.id, v.label))?;
    }
    Ok(())
}
```
Call `validate_variants(spec)?;` at the end of `validate_spec`. Note the overlay here mirrors `resolve_effective`'s merge for the three fields that matter to `check_transport_fields`.
- [ ] **Step 4: run** module + full `cargo test` → green, warning-free. (This also hardens `mcp_add_manual` — it already calls `validate_spec`.)
- [ ] **Step 5: commit** `feat(mcp): variant-aware validation in validate_spec`

---

### Task 2: `mcp_update_server` + serialized library mutations (spec §5.1)

**Files:** Modify `src-tauri/src/backend/commands.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- `static MCP_LIBRARY_LOCK: tokio::sync::Mutex<()>` (via `std::sync::OnceLock` or `tokio::sync::Mutex::const_new`) guarding every library load-modify-save (add/update/remove).
- `#[tauri::command] mcp_update_server(spec: McpServerSpec) -> McpLibraryResponse` + `mcp_update_server_impl(spec, app_home_override)`: validate → lock → load → find id (`NotFound` if absent) → replace → save → return `McpLibraryResponse { servers, warnings: vec![] }`.
- Wrap the existing bodies of `mcp_add_manual_impl` and `mcp_remove_server_impl` in the same lock (acquire after validation, before `load_library`).

- [ ] **Step 1: failing tests**

```rust
    #[tokio::test]
    async fn mcp_update_server_replaces_and_validates() {
        let dir = tempfile::TempDir::new().unwrap();
        let app_home = dir.path().join("apphome");
        mcp_add_manual_impl(test_spec("s1"), Some(app_home.clone())).await.unwrap();

        let mut edited = test_spec("s1");
        edited.args = vec!["-y".into(), "other-pkg".into()];
        let resp = mcp_update_server_impl(edited, Some(app_home.clone())).await.unwrap();
        assert_eq!(resp.servers[0].args[1], "other-pkg");

        // unknown id
        assert!(matches!(
            mcp_update_server_impl(test_spec("ghost"), Some(app_home.clone())).await,
            Err(BackendError::NotFound(_))
        ));
        // invalid spec rejected before any write
        let mut bad = test_spec("s1");
        bad.command = None;
        assert!(mcp_update_server_impl(bad, Some(app_home)).await.is_err());
    }

    #[tokio::test]
    async fn library_mutations_do_not_lose_updates() {
        let dir = tempfile::TempDir::new().unwrap();
        let app_home = dir.path().join("apphome");
        // 10 concurrent adds with distinct ids -> all 10 present afterward
        let mut handles = Vec::new();
        for i in 0..10 {
            let ah = app_home.clone();
            handles.push(tokio::spawn(async move {
                mcp_add_manual_impl(test_spec(&format!("srv-{i}")), Some(ah)).await
            }));
        }
        for h in handles { h.await.unwrap().unwrap(); }
        let resp = mcp_list_library_impl(Some(app_home)).await.unwrap();
        assert_eq!(resp.servers.len(), 10, "no lost updates under concurrency");
    }
```

- [ ] **Step 2: run** → `mcp_update_server_impl` missing (compile fail); the concurrency test would flake/fail against unlocked code.
- [ ] **Step 3: implement** (lock: `static MCP_LIBRARY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());` at module scope; `let _guard = MCP_LIBRARY_LOCK.lock().await;` in each mutator). Register `mcp_update_server` in `lib.rs` after `mcp_remove_server`.
- [ ] **Step 4: run** focused + full suite → green.
- [ ] **Step 5: commit** `feat(mcp): mcp_update_server and serialized library mutations`

---

### Task 3: project-aware tolerant `mcp_remove_server` (spec §5.1)

**Files:** Modify `src-tauri/src/backend/commands.rs`, `src-tauri/src/lib.rs` (signature unchanged in list, but command gains an arg — verify generate_handler needs no change beyond recompile)

**Interfaces:**
- `mcp_remove_server(id, project_path: Option<String>)` + `_impl(id, project_path, app_home_override, home_dir_override)`.
- Warning scan: global targets always; project targets when `project_path` given; a failing `read_entries` produces a warning `"couldn't check <harness> <scope> (<path>): <err>"` instead of aborting.

- [ ] **Step 1: failing tests** — extend the existing remove tests:

```rust
    #[tokio::test]
    async fn remove_warns_project_scope_and_tolerates_malformed() {
        let dir = tempfile::TempDir::new().unwrap();
        let app_home = dir.path().join("apphome");
        let home = dir.path().join("home");
        let project = dir.path().join("repo");
        tokio::fs::create_dir_all(&home).await.unwrap();
        tokio::fs::create_dir_all(&project).await.unwrap();

        mcp_add_manual_impl(test_spec("s1"), Some(app_home.clone())).await.unwrap();
        mcp_activate_impl("s1".into(), "claude".into(), "project".into(), None,
            Some(project.to_string_lossy().into_owned()),
            Some(app_home.clone()), Some(home.clone())).await.unwrap();
        // malformed global cursor config must not abort the removal
        tokio::fs::create_dir_all(home.join(".cursor")).await.unwrap();
        tokio::fs::write(home.join(".cursor/mcp.json"), "{ nope").await.unwrap();

        let resp = mcp_remove_server_impl("s1".into(),
            Some(project.to_string_lossy().into_owned()),
            Some(app_home), Some(home)).await.unwrap();
        assert!(resp.servers.is_empty(), "removal succeeded despite malformed config");
        assert!(resp.warnings.iter().any(|w| w.contains("claude") && w.contains("project")),
            "project activation warned: {:?}", resp.warnings);
        assert!(resp.warnings.iter().any(|w| w.contains("couldn't check")),
            "malformed config becomes warning: {:?}", resp.warnings);
    }
```

- [ ] **Step 2: run** → fails (signature + behavior).
- [ ] **Step 3: implement** — extend the scan loop: targets = global ∀ adapters + project ∀ adapters when project root present; `match read_entries { Ok(e) => …existing check…, Err(err) => warnings.push(format!("couldn't check {} {} ({}): {err}", adapter.harness_id, scope, path.display())) }`. Update the existing `mcp_remove_server` wrapper + the one existing call in tests to pass `None`.
- [ ] **Step 4: run** focused + full → green.
- [ ] **Step 5: commit** `feat(mcp): project-aware, error-tolerant removal warnings`

---

### Task 4: SSRF-safe fetch + bounded body read (spec §5.2)

**Files:** Create `src-tauri/src/backend/mcp/net.rs`; modify `src-tauri/src/backend/mcp/mod.rs`, `src-tauri/src/backend/marketplace.rs` (trait method), `src-tauri/src/backend/commands.rs` (`mcp_add_from_url_impl` rewire)

**Interfaces (net.rs):**
```rust
pub fn addr_is_global(ip: std::net::IpAddr) -> bool                 // pure; rejects loopback/unspecified/link-local/RFC1918/ULA/multicast/reserved/v4-mapped
pub async fn validated_addrs(host: &str, port: u16) -> BackendResult<Vec<std::net::SocketAddr>>  // lookup_host + ALL must be global
pub async fn fetch_markdown_guarded(url: &str) -> BackendResult<(String /*final url*/, String /*body*/)>
    // manual hop loop: max 3 redirects; https-only each hop; per-hop validated_addrs;
    // per-fetch reqwest client: redirects disabled, resolve_to_addrs(host, addrs),
    // no_proxy(), connect_timeout 10s, timeout 30s; Content-Length > 1MiB early reject;
    // chunk()-loop read capped at 1MiB (Validation on overflow)
```
**Trait (marketplace.rs):** add default method
```rust
    async fn get_capped(&self, url: &str, headers: &[(&str, &str)], max_bytes: usize) -> BackendResult<HttpResponse> {
        let resp = self.get(url, headers).await?;
        if resp.body.len() > max_bytes {
            return Err(BackendError::Validation(format!(
                "Fetched document is too large ({} bytes; limit {max_bytes})", resp.body.len())));
        }
        Ok(resp)
    }
```
(mocks keep working unchanged; `ReqwestHttpClient` does NOT override — the real capped/pinned path is `fetch_markdown_guarded`, used only by the URL-ingestion command).
**Command rewire:** `mcp_add_from_url_impl(url, client)` keeps its testable shape: it now takes `client: &dyn HttpClient` for the mock path AND a `use_guarded: bool`?? NO — keep it simple and honest: `mcp_add_from_url_impl` keeps using the injected `client.get_capped(..., 1 MiB)` for fetch + retry exactly as today (tests unchanged in shape), and the `#[tauri::command]` wrapper calls a NEW `mcp_add_from_url_guarded(url)` that uses `fetch_markdown_guarded` for the fetch/redirect/SSRF path and then shares the post-fetch logic (`build_url_parse_response(url, plan, fetched_url, body)` extracted as a pure helper both paths call). SSRF behavior is tested at the net.rs level; the command test keeps its mock.

- [ ] **Step 1: failing tests**
  - net.rs unit table for `addr_is_global`: `127.0.0.1`, `0.0.0.0`, `10.1.2.3`, `172.16.0.1`, `192.168.1.1`, `169.254.1.1`, `::1`, `fc00::1`, `fe80::1`, `ff02::1`, `::ffff:10.0.0.1` all false; `140.82.112.3`, `2606:50c0::1` true.
  - `validated_addrs("localhost", 443)` → Err.
  - commands.rs: existing add_from_url mock tests must stay green with `get_capped` default method (oversize case now exercises the default's post-check — same assertion).
- [ ] **Step 2: run** → compile fail.
- [ ] **Step 3: implement** per interfaces. `addr_is_global` implemented manually (no unstable `ip.is_global()`): match on IpAddr with explicit range checks (document each). The hop loop uses `reqwest::ClientBuilder::new().redirect(Policy::none()).resolve_to_addrs(...).no_proxy().connect_timeout(10s).timeout(30s)`.
- [ ] **Step 4: run** `cargo test backend::mcp::net` + `cargo test add_from_url` + full → green.
- [ ] **Step 5: commit** `feat(mcp): ssrf-guarded, time- and size-bounded url fetching`

---

### Task 5: parse.rs split + variant-aware warnings + fixtures (spec §5.2)

**Files:** Create `src-tauri/src/backend/mcp/parse/{mod.rs,url.rs,fences.rs,heuristics.rs,assembly.rs}` (delete `parse.rs`); modify `mcp/mod.rs` only if needed (module name unchanged)

- [ ] **Step 1:** pure move per spec §5.2 ownership: `url.rs` (FetchPlan, source_for_url + its tests), `fences.rs` (Fence, scan_fences, strip_jsonc + tests), `heuristics.rs` (Candidate `pub(super)`, SERVER_MAP_KEYS, candidate_from_json, find_server_maps, extract_h1/h2/h3, shell_tokens, package_basename, strip_prompt + tests), `assembly.rs` (slugify, variant_label, placeholders, same_invocation, fold, extract_drafts, ExtractionResult + tests), `mod.rs` = re-exports (`pub use url::{source_for_url, FetchPlan}; pub use assembly::{extract_drafts, ExtractionResult};` + `pub(crate)` as needed). No logic edits in this step. Run: full `cargo test` → all 41 parse tests + suite green. Commit: `refactor(mcp): split parse.rs into url/fences/heuristics/assembly modules`
- [ ] **Step 2 (failing tests, assembly.rs):** variant-aware placeholder warnings —

```rust
    #[test]
    fn variant_placeholder_values_warn_with_label() {
        let md = concat!(
            "```json\n{\"mcpServers\":{\"s\":{\"command\":\"npx\",\"args\":[\"-y\",\"pkg\"]}}}\n```\n",
            "```json\n{\"mcpServers\":{\"s\":{\"type\":\"http\",\"url\":\"https://x/mcp\",\"headers\":{\"Auth\":\"YOUR_TOKEN\"}}}}\n```\n",
        );
        let r = drafts_of(md);
        assert_eq!(r.drafts.len(), 1);
        assert!(r.warnings.iter().any(|w| w.contains("remote-http") && w.contains("YOUR_TOKEN")),
            "variant label named in warning: {:?}", r.warnings);
    }
```
- [ ] **Step 3: implement** — `placeholder_warnings` walks `spec.variants`: for each populated Option field, same checks, warning text `"{id} (variant {label}): {field} contains placeholder …"`. Run → green.
- [ ] **Step 4 (failing tests then green): fixtures** — two `const` fixtures in assembly.rs tests: (a) Context7-style page (~40 lines verbatim-realistic: intro prose, config block, bash block, remote block) with **CRLF** line endings (`\r\n` literals), asserting 1 draft + expected variants; (b) monorepo-style page with 3 servers, one named with unicode (e.g. `"café-mcp"` — asserts slug `caf-mcp` or `cafe`? slugify drops non-ascii → `caf-mcp`; assert actual behavior), asserting 3 drafts. NOTE: `scan_fences` uses `lines()` which handles `\r\n` but leaves `\r` on fence-info/body? `str::lines` strips `\r\n` — verify; if `\r` residue breaks info matching, fix `scan_fences` to trim `\r` (that's the point of the fixture).
- [ ] **Step 5:** full suite green, warning-free. Commit: `test(mcp): variant-aware placeholder warnings + real-world fixtures`

---

### Task 6: api-shim ApiError/silent + MCP routes + shared escape helper + logic tests (spec §6)

**Files:** Modify `public/api-shim.js`; create `public/mcp-logic.js` (pure, importable by shim/module/tests); create `test/mcp-logic.test.js` (project's existing node --test layout — check `package.json` "test" script's glob first and follow it)

**Interfaces:**
- `mcp-logic.js` exports (pure, no DOM): `escapeHtml(s)`, `looksLikePlaceholder(value)` + `commandLooksShellRef(cmd)` (mirror backend patterns), `slugifyId(name)` (mirror backend), `buildMcpRoutes()` (the 9 route entries: `{method, path, command, argsBuilder, adapter, silent?}` — exact camelCase args: `{ projectPath }` for status/discover/remove, `{ id, harness, scope, variantLabel, projectPath }` for activate/deactivate, `{ spec }` for add/update, `{ url }` for add_from_url), `newGeneration()/isStale(gen, current)` request-generation guard.
- api-shim: `class ApiError extends Error { constructor(kind, message) }`; thrown errors are `ApiError` with `kind` from the Rust envelope (`extractInvokeError` returns both); route entries may carry `silent: true` → no `fireToast`. Existing routes' behavior unchanged.
- Route table in api-shim imports/includes the `buildMcpRoutes()` entries under paths `/api/mcp/*` (follow the existing route-table shape exactly — read the current table first).

- [ ] **Step 1: failing tests** (`node --test`): escapeHtml (script tag, quotes, ampersand); looksLikePlaceholder table (YOUR_X, `<t>`, `${V}`, xxx, changeme, CHANGEME, `_HERE`, negative cases); route table: all 9 present, arg builders produce exact camelCase payloads from given inputs, silent flag set only on add_from_url; generation guard (stale write dropped).
- [ ] **Step 2:** run `npm test` → new tests fail. **Step 3:** implement. **Step 4:** `npm test` all green (46 + new), `npm run build` OK. **Step 5:** commit `feat(mcp-ui): api error kinds, silent routes, mcp route table + pure logic module`

---

### Task 7: markup, styles, module skeleton, refresh model (spec §3, §4.1, §4.7, §6)

**Files:** Modify `public/index.html`, `public/styles.css`, `public/app.js` (minimal hook); create `public/mcp-servers.js`

**DOM contract (binding):**
- index.html: relabel existing mcp tab button text → "Connector", hint → "Let agents drive Skillworks" (ids/data-attrs unchanged). New seventh `top-tab` button `data-top-tab="mcp-servers"` (label "MCP Servers", hint "Connect servers to agents", reuse an existing sprite icon — pick `#icon-stack`-adjacent; no new sprite) + `<section class="tab-content hidden" id="mcpServersTab" data-top-tab-panel="mcp-servers" aria-label="MCP servers">` containing the §3 regions as empty containers with stable ids: `mcpServersList`, `mcpServersDetail`, `mcpServersAdd`, `mcpServersDiscovered`.
- app.js hook (keep diff < ~20 lines): tab-switch dispatch for `mcp-servers` calling `window.McpServers.onEnter()`; project-change + Refresh call `window.McpServers.onWorkspaceChanged()` (guard for module presence).
- mcp-servers.js skeleton: `state = { generation: 0, servers: [], statuses: [], discovered: [], selectedId: null, loading: false }`; `async refreshAll()` (bump generation, parallel list/status/discover via the shim routes, drop stale via `isStale`, render); `onEnter` (first-load or refresh), `onWorkspaceChanged` (refresh if tab visited); sidebar render per §4.1 (rows via `textContent`; active-count badge computed from statuses); selection → `renderDetail()` stub (Task 8). Empty state per §4.1.
- styles.css: `mcp-servers-*` block from tokens; sidebar row + chip + badge modeled on the existing skill-list row classes (read them first).

- [ ] **Steps:** implement → `npm test` (logic module untouched — stays green) + `npm run build` → manual smoke deferred to Task 10. Acceptance: tab renders with sidebar + empty regions; Connector relabel visible; no console errors in `npm run build` output. Commit: `feat(mcp-ui): mcp servers tab skeleton, connector relabel, refresh model`

---

### Task 8: detail pane — fields form, matrix, staleness/reapply (spec §4.2, §4.3)

**Files:** Modify `public/mcp-servers.js`, `public/styles.css`; extend `public/mcp-logic.js` + its tests where logic is pure

**Contracts (binding):**
- Fields form per §4.2: dirty tracking; client-side validation mirrors `validate_spec` basics (transport-dependent required fields) via a pure `validateSpecDraft(spec)` in mcp-logic.js (+ node tests); Save → `mcp_update_server` (authoritative library adopted); masked env/header values (`type=password`-style toggle button with aria-label).
- Matrix per §4.3: rows = the 7 harnesses (order from a const mirroring the backend table); cells bound to statuses; toggle handlers call activate/deactivate then `refreshAll()`; project column disabled w/ hint when no project; trust small-print on claude/codex project cells; `error` rows → ⚠ button (focusable) + `aria-describedby` panel with error + path; variant picker (select of labels + "automatic") feeding `variantLabel`.
- Staleness + Reapply per §4.2/§4.3: after successful save with ≥1 active target, banner + Reapply button; Reapply = sequential `mcp_activate` per active target of this server, collecting per-target results into a toast summary + refresh. Pure helper `activeTargetsOf(serverId, statuses)` in mcp-logic.js (+ test).
- Placeholder flags: reuse `looksLikePlaceholder`/`commandLooksShellRef` for amber inline marks (CSS class, `aria-label` text).

- [ ] **Steps:** logic tests first (validateSpecDraft, activeTargetsOf) → implement UI → `npm test` + `npm run build` green. Commit: `feat(mcp-ui): detail pane with matrix, staleness reapply, masked secrets`

---

### Task 9: variants tri-state editor, add flow, discovered panel (spec §4.4, §4.5, §4.6)

**Files:** Modify `public/mcp-servers.js`, `public/styles.css`; extend `public/mcp-logic.js` + tests

**Contracts (binding):**
- Variant editor per §4.4: per-field Override toggle — OFF renders the inherited canonical value greyed/readonly and stores `null`; ON stores the entered value including empty (`[]`/`{}`); pure `variantFromForm(formState) -> variant` + `formStateFromVariant(variant, canonical)` in mcp-logic.js with node tests covering all three states per field (inherit / override-with-value / override-with-empty). Label uniqueness pre-checked client-side; applies_to selects with "any". All saves via full-spec `mcp_update_server`.
- Add flow per §4.5: URL input + Parse (silent route; errors render in-panel with backend guidance text); draft cards = prefilled form + evidence list + warnings (placeholders highlighted); per-card "Add to library" → `mcp_add_manual`; duplicate-id `ApiError` → inline id editor on the card; manual path opens a blank card with `slugifyId` auto-fill. Evidence displayed on cards only.
- Discovered per §4.6: grouped by harness; escaped `textContent` rendering; monospace path (existing mono token/class); footer note re Phase C.

- [ ] **Steps:** logic tests → UI → `npm test` + `npm run build` green. Commit: `feat(mcp-ui): tri-state variant editor, add-from-url flow, discovered panel`

---

### Task 10: Playwright smoke + docs + full gate

**Files:** Modify `package.json` (devDependency `@playwright/test`, script `test:ui`), create `test/ui/mcp-servers.spec.js` + minimal `playwright.config.js` (chromium only, `npm run dev` webServer or built `dist/` static serve — check which the app supports for browser mode; the api-shim has a browser/dev fallback path — use it with a mocked fetch layer); modify `CLAUDE.md` (fix the stale "Playwright is available" note to name the real setup + `npm run test:ui`); update roadmap phase D status.

**Smoke coverage (binding):** app boots; 7 tabs incl. Connector + MCP Servers; MCP Servers tab: sidebar renders with mocked library; add-URL flow renders draft card from mocked response; matrix toggle fires the right route; keyboard: tab-walk reaches list → form → matrix → variant editor with visible focus; axe-style basic checks optional. Screenshots saved to test-results for the review.

- [ ] **Steps:**
  1. `npm i -D @playwright/test` + `npx playwright install chromium` (dev machine).
  2. Config + spec per contract; run `npm run test:ui` → green; collect screenshots.
  3. Full gate: `cd src-tauri && cargo test` (warning-free) + `npm test` + `npm run build`.
  4. Docs: CLAUDE.md note; roadmap D row → Done.
  5. Commit: `test(mcp-ui): playwright smoke for mcp servers surface; docs updates`

---

## Self-Review Notes

- Spec coverage: §2→T7 (tab/rename/namespaces); §4.1/4.7→T7; §4.2/4.3→T8; §4.4/4.5/4.6→T9; §5.1→T1–T3; §5.2→T4–T5; §6→T6–T7 (+contract details in T6); §7→T6/T8; §8→each task + T10 gate.
- The T4 command-rewire keeps mock-testability by splitting fetch (guarded, prod) from post-fetch logic (shared helper) — no test rewrites, no trait break.
- Frontend tasks deliberately contract-based (declared in header); every pure behavior still lands in `mcp-logic.js` with real `node --test` coverage.
- Type consistency: `state.mcpServers` naming, route payload shapes, and `McpLibraryResponse` adoption named identically across T6–T9.
