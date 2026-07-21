//! Phase B Task 4: draft assembly — groups candidates by slugified name,
//! picks the highest-priority (lowest `priority`) candidate as canonical,
//! folds the rest into variants (or drops them as exact-invocation dupes),
//! validates, and collects placeholder warnings.

use std::collections::BTreeMap;

use crate::backend::mcp::spec::{validate_spec, McpServerSpec, McpSource, McpTransport, McpVariant};
use crate::backend::types::McpServerDraft;

use super::fences::scan_fences;
use super::heuristics::{extract_h1, extract_h2, extract_h3, Candidate};

pub struct ExtractionResult {
    pub drafts: Vec<McpServerDraft>,
    pub warnings: Vec<String>,
}

fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = true; // suppress leading dashes
    for c in name.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') { out.pop(); }
    out
}

fn variant_label(c: &Candidate) -> String {
    match (&c.transport, c.command.as_deref()) {
        (McpTransport::Http, _) => "remote-http".to_string(),
        (McpTransport::Sse, _) => "remote-sse".to_string(),
        (_, Some("docker")) => "docker".to_string(),
        (_, Some("npx")) => "npx".to_string(),
        (_, Some("uvx")) => "uvx".to_string(),
        (_, Some(cmd)) => slugify(cmd),
        _ => "alt".to_string(),
    }
}

const PLACEHOLDER_MARKERS: &[&str] = &["your_", "${", "replace", "changeme"];

fn is_placeholder(value: &str) -> bool {
    let v = value.to_ascii_lowercase();
    (value.starts_with('<') && value.ends_with('>'))
        || v.contains("xxx")
        || v.ends_with("_here")
        || PLACEHOLDER_MARKERS.iter().any(|m| v.contains(m))
}

/// True if `value` looks like a shell variable expansion or a home-relative
/// path rather than a literal, resolved command — e.g. `$HOME/.local/bin/uvx`
/// or `~/bin/mcp`. These are valid, verbatim-preserved commands (see
/// `h3_prompt_strip_preserves_dollar_vars`), but should be flagged for
/// review before activation since they depend on the *activating* shell's
/// environment, not the one documented in the source markdown.
fn looks_like_shell_reference(value: &str) -> bool {
    value.starts_with('$') || value.starts_with('~') || value.contains("${")
}

fn placeholder_warnings(spec: &McpServerSpec) -> Vec<String> {
    let mut out = Vec::new();
    let mut check = |field: &str, value: &str| {
        if is_placeholder(value) {
            out.push(format!(
                "{}: {field} contains placeholder {value:?} — fill in a real value before activating",
                spec.id
            ));
        }
    };
    for (k, v) in &spec.env { check(&format!("env.{k}"), v); }
    for (k, v) in &spec.headers { check(&format!("headers.{k}"), v); }
    for a in &spec.args { check("args", a); }
    if let Some(u) = &spec.url { check("url", u); }
    if let Some(cmd) = &spec.command {
        if looks_like_shell_reference(cmd) {
            out.push(format!(
                "{}: command references a shell variable or home path ({cmd}) — verify the path before activating",
                spec.id
            ));
        }
    }
    for variant in &spec.variants {
        let mut check_variant = |field: &str, value: &str| {
            if is_placeholder(value) {
                out.push(format!(
                    "{} (variant {}): {field} contains placeholder {value:?} — fill in a real value before activating",
                    spec.id, variant.label
                ));
            }
        };
        if let Some(env) = &variant.env {
            for (k, v) in env { check_variant(&format!("env.{k}"), v); }
        }
        if let Some(headers) = &variant.headers {
            for (k, v) in headers { check_variant(&format!("headers.{k}"), v); }
        }
        if let Some(args) = &variant.args {
            for a in args { check_variant("args", a); }
        }
        if let Some(u) = &variant.url { check_variant("url", u); }
        if let Some(cmd) = &variant.command {
            if looks_like_shell_reference(cmd) {
                out.push(format!(
                    "{} (variant {}): command references a shell variable or home path ({cmd}) — verify the path before activating",
                    spec.id, variant.label
                ));
            }
        }
    }
    out
}

fn same_invocation(a: &Candidate, b: &Candidate) -> bool {
    a.transport == b.transport && a.command == b.command && a.args == b.args && a.url == b.url
}

/// A map is "compatible" with a fold target's map when every value in the
/// group is either empty (so it simply adopts the target's value) or
/// exactly equal to the target's value. This is deliberately one-sided:
/// it never asks whether the target's map is empty, only the folding
/// (inferred-name) side's.
fn maps_compatible(group_map: &BTreeMap<String, String>, target_map: &BTreeMap<String, String>) -> bool {
    group_map.is_empty() || group_map == target_map
}

pub fn extract_drafts(markdown: &str, fallback_name: &str, source_url: &str) -> ExtractionResult {
    let fences = scan_fences(markdown);
    let mut warnings = Vec::new();
    let (mut candidates, w1) = extract_h1(&fences);
    warnings.extend(w1);
    let (h2, w2) = extract_h2(&fences);
    candidates.extend(h2);
    warnings.extend(w2);
    candidates.extend(extract_h3(markdown, &fences));

    // group by slug, preserving first-seen order
    let mut order: Vec<String> = Vec::new();
    let mut groups: std::collections::BTreeMap<String, Vec<Candidate>> = Default::default();
    for c in candidates {
        let raw = c.name.clone().unwrap_or_else(|| fallback_name.to_string());
        let mut slug = slugify(&raw);
        if slug.is_empty() { slug = slugify(fallback_name); }
        if slug.is_empty() { slug = "server".to_string(); }
        if !groups.contains_key(&slug) { order.push(slug.clone()); }
        groups.entry(slug).or_default().push(c);
    }

    // Guarded one-way fold: a name-group is only ever a *fold source* when
    // every candidate in it got its name inferred from a package/image
    // basename (bare `npx`/`uvx`, `docker run`) — never when any candidate
    // has an explicit name (H1/H2 config key, `claude mcp add`/`add-json`).
    // This prevents the old union-find bridge's data loss: two explicitly
    // named servers that happen to share a launcher (e.g. two `npx -y
    // multi-mcp` entries with different `env`) must never merge, since
    // in-group dedup would silently drop the second server's name + env.
    //
    // A foldable group folds into exactly one explicitly-named group when
    // that group has a candidate with the identical invocation AND every
    // candidate in the foldable group has env/headers that are empty or
    // equal to that target candidate's env/headers. Zero or multiple
    // matching targets means the fold is ambiguous or incompatible, so the
    // group is left standing on its own (never guess).
    let mut fold_target: Vec<Option<usize>> = vec![None; order.len()];
    for i in 0..order.len() {
        let g_candidates = &groups[&order[i]];
        let foldable = g_candidates.iter().all(|c| c.name_inferred);
        if !foldable {
            continue;
        }
        let mut targets: Vec<usize> = Vec::new();
        for (j, other_slug) in order.iter().enumerate() {
            if i == j {
                continue;
            }
            let h_candidates = &groups[other_slug];
            let is_explicit = h_candidates.iter().any(|c| !c.name_inferred);
            if !is_explicit {
                continue;
            }
            let matches = h_candidates.iter().any(|c_h| {
                g_candidates.iter().any(|g| same_invocation(g, c_h))
                    && g_candidates
                        .iter()
                        .all(|g| maps_compatible(&g.env, &c_h.env) && maps_compatible(&g.headers, &c_h.headers))
            });
            if matches {
                targets.push(j);
            }
        }
        if targets.len() == 1 {
            fold_target[i] = Some(targets[0]);
        }
    }
    let mut group_vecs: Vec<Vec<Candidate>> = order.iter().map(|s| groups.remove(s).unwrap()).collect();
    for i in 0..order.len() {
        if let Some(target) = fold_target[i] {
            let moved = std::mem::take(&mut group_vecs[i]);
            group_vecs[target].extend(moved);
        }
    }

    let mut drafts = Vec::new();
    for mut group in group_vecs {
        if group.is_empty() {
            continue; // folded into another group above
        }
        group.sort_by_key(|c| c.priority);
        let canonical = group[0].clone();
        // The merged group's id/name follows the highest-priority candidate
        // (config key > `claude mcp add` name > package/image basename),
        // not necessarily the name-slug it was first bucketed under.
        let raw = canonical.name.clone().unwrap_or_else(|| fallback_name.to_string());
        let mut slug = slugify(&raw);
        if slug.is_empty() { slug = slugify(fallback_name); }
        if slug.is_empty() { slug = "server".to_string(); }
        let mut evidence = vec![canonical.evidence.clone()];
        if !canonical.ignored_keys.is_empty() {
            evidence.push(format!("ignored: {}", canonical.ignored_keys.join(", ")));
        }
        let mut variants: Vec<McpVariant> = Vec::new();
        let mut used_labels: Vec<String> = Vec::new();
        for alt in &group[1..] {
            if same_invocation(&canonical, alt) || variants.iter().any(|v| {
                // compare against already-added variants via their fields
                v.transport == Some(alt.transport)
                    && v.command == alt.command
                    && v.args.as_deref() == Some(alt.args.as_slice())
                    && v.url == alt.url
            }) {
                continue;
            }
            let mut label = variant_label(alt);
            let mut n = 2;
            while used_labels.contains(&label) {
                label = format!("{}-{n}", variant_label(alt));
                n += 1;
            }
            used_labels.push(label.clone());
            evidence.push(format!("variant {label:?}: {}", alt.evidence));
            variants.push(McpVariant {
                label,
                applies_to: None,
                transport: Some(alt.transport),
                command: alt.command.clone(),
                args: Some(alt.args.clone()),
                env: if alt.env.is_empty() { None } else { Some(alt.env.clone()) },
                url: alt.url.clone(),
                headers: if alt.headers.is_empty() { None } else { Some(alt.headers.clone()) },
            });
        }
        let spec = McpServerSpec {
            id: slug.clone(),
            name: canonical.name.clone().unwrap_or_else(|| slug.clone()),
            description: None,
            source: McpSource { kind: "url".to_string(), url: Some(source_url.to_string()) },
            transport: canonical.transport,
            command: canonical.command.clone(),
            args: canonical.args.clone(),
            env: canonical.env.clone(),
            url: canonical.url.clone(),
            headers: canonical.headers.clone(),
            variants,
        };
        match validate_spec(&spec) {
            Ok(()) => {
                warnings.extend(placeholder_warnings(&spec));
                drafts.push(McpServerDraft { spec, evidence });
            }
            Err(e) => warnings.push(format!("Dropped candidate {slug:?}: {e}")),
        }
    }
    ExtractionResult { drafts, warnings }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drafts_of(md: &str) -> ExtractionResult {
        extract_drafts(md, "fallback-repo", "https://github.com/o/r")
    }

    #[test]
    fn assembles_single_server_with_style_variants() {
        let md = concat!(
            "```json\n{\"mcpServers\":{\"context7\":{\"command\":\"npx\",\"args\":[\"-y\",\"@upstash/context7-mcp\"]}}}\n```\n",
            "Or docker:\n```bash\ndocker run --rm -i ghcr.io/upstash/context7:latest\n```\n",
            "Or remote:\n```json\n{\"mcpServers\":{\"context7\":{\"type\":\"http\",\"url\":\"https://mcp.context7.com/mcp\"}}}\n```\n",
        );
        let r = drafts_of(md);
        // Per the Phase B design doc §8: "multi-style README (npx + docker +
        // remote -> 1 draft + 2 variants)". All three fences share the name
        // "context7" (the docker image basename collides with the explicit
        // json key), so they collapse into one draft with two variants.
        assert_eq!(r.drafts.len(), 1, "one server, described three ways");
        let c7 = r.drafts.iter().find(|d| d.spec.id == "context7").unwrap();
        assert_eq!(c7.spec.command.as_deref(), Some("npx"), "H1 canonical");
        assert_eq!(c7.spec.variants.len(), 2, "docker + http styles both become variants");
        assert_eq!(c7.spec.variants[0].label, "remote-http");
        assert_eq!(c7.spec.variants[1].label, "docker");
        assert_eq!(c7.spec.source.kind, "url");
        assert_eq!(c7.spec.source.url.as_deref(), Some("https://github.com/o/r"));
        assert!(c7.evidence.iter().any(|e| e.contains("H1")), "evidence carried");
    }

    #[test]
    fn monorepo_yields_one_draft_per_server() {
        let md = "```json\n{\"mcpServers\":{\"alpha\":{\"command\":\"npx\",\"args\":[\"a\"]},\"beta\":{\"command\":\"npx\",\"args\":[\"b\"]},\"gamma\":{\"type\":\"http\",\"url\":\"https://g/mcp\"}}}\n```";
        let r = drafts_of(md);
        let mut ids: Vec<&str> = r.drafts.iter().map(|d| d.spec.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["alpha", "beta", "gamma"]);
    }

    #[test]
    fn identical_invocations_dedup_no_variant() {
        let md = concat!(
            "```json\n{\"mcpServers\":{\"x\":{\"command\":\"npx\",\"args\":[\"-y\",\"pkg\"]}}}\n```\n",
            "```bash\nnpx -y pkg\n```\n",
        );
        let r = drafts_of(md);
        assert_eq!(r.drafts.len(), 1);
        assert!(r.drafts[0].spec.variants.is_empty(), "same invocation → dedup, not variant");
    }

    #[test]
    fn placeholder_values_warn_but_stay() {
        let md = "```json\n{\"mcpServers\":{\"s\":{\"command\":\"npx\",\"args\":[\"-y\",\"pkg\"],\"env\":{\"API_KEY\":\"YOUR_API_KEY\",\"T\":\"<token>\"}}}}\n```";
        let r = drafts_of(md);
        assert_eq!(r.drafts.len(), 1);
        assert_eq!(r.drafts[0].spec.env.get("API_KEY").map(String::as_str), Some("YOUR_API_KEY"));
        assert!(r.warnings.iter().any(|w| w.contains("YOUR_API_KEY")));
        assert!(r.warnings.iter().any(|w| w.contains("<token>")));
    }

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

    #[test]
    fn invalid_group_becomes_warning_not_draft() {
        // remote entry with empty url → validate_spec fails → warning
        let md = "```json\n{\"mcpServers\":{\"broken\":{\"type\":\"http\",\"url\":\"\"}}}\n```";
        let r = drafts_of(md);
        assert!(r.drafts.is_empty());
        assert!(r.warnings.iter().any(|w| w.contains("broken")));
    }

    #[test]
    fn nothing_found_is_empty_success() {
        let r = drafts_of("# Just a readme\nNo config here.\n");
        assert!(r.drafts.is_empty());
        assert!(r.warnings.is_empty(), "the 'nothing found' warning is added by the command, not the parser");
    }

    #[test]
    fn slugify_and_name_fallback() {
        let md = "```bash\nnpx -y @Upstash/Context7_MCP\n```";
        let r = drafts_of(md);
        assert_eq!(r.drafts[0].spec.id, "context7-mcp");
        assert!(slugify("").is_empty());
        assert_eq!(slugify("Hello World! 2"), "hello-world-2");
    }

    #[test]
    fn dollar_command_gets_warning() {
        let md = "```sh\n$ $HOME/.local/bin/uvx some-mcp\n```";
        let r = drafts_of(md);
        assert_eq!(r.drafts.len(), 1);
        assert!(r.warnings.iter().any(|w| w.contains("shell variable")));
    }

    #[test]
    fn explicit_names_with_shared_launcher_never_merge() {
        let md = "```json\n{\"mcpServers\":{\"github\":{\"command\":\"npx\",\"args\":[\"-y\",\"multi-mcp\"],\"env\":{\"GITHUB_TOKEN\":\"a\"}},\"gitlab\":{\"command\":\"npx\",\"args\":[\"-y\",\"multi-mcp\"],\"env\":{\"GITLAB_TOKEN\":\"b\"}}}}\n```";
        let r = drafts_of(md);
        assert_eq!(r.drafts.len(), 2, "distinct explicit servers must both survive");
        let ids: Vec<&str> = r.drafts.iter().map(|d| d.spec.id.as_str()).collect();
        assert!(ids.contains(&"github") && ids.contains(&"gitlab"));
        let gl = r.drafts.iter().find(|d| d.spec.id == "gitlab").unwrap();
        assert_eq!(gl.spec.env.get("GITLAB_TOKEN").map(String::as_str), Some("b"), "env preserved");
    }

    #[test]
    fn inferred_fold_is_blocked_on_env_mismatch() {
        let md = concat!(
            "```json\n{\"mcpServers\":{\"x\":{\"command\":\"docker\",\"args\":[\"run\",\"-e\",\"T=real\",\"img\"],\"env\":{\"T\":\"real\"}}}}\n```\n",
            "```sh\ndocker run -e T=other img\n```\n",
        );
        let r = drafts_of(md);
        assert_eq!(r.drafts.len(), 2, "env-incompatible inferred group stays separate");
    }

    #[test]
    fn ambiguous_fold_targets_stay_separate() {
        let md = concat!(
            "```json\n{\"mcpServers\":{\"a\":{\"command\":\"npx\",\"args\":[\"-y\",\"pkg\"]},\"b\":{\"command\":\"npx\",\"args\":[\"-y\",\"pkg\"],\"env\":{\"E\":\"1\"}}}}\n```\n",
            "```sh\nnpx -y pkg\n```\n",
        );
        let r = drafts_of(md);
        // "a" and "b" are both explicit (never merge with each other); the bare npx line
        // matches both invocations env-compatibly for "a" (empty env) — but "b" also matches
        // same_invocation. Two candidate targets -> ambiguity -> the inferred group must NOT fold.
        assert_eq!(r.drafts.len(), 3);
    }

    // --- Real-world-realistic fixtures (Phase D Task 5) -----------------
    //
    // These two READMEs are modeled on real MCP server docs (Context7-style
    // single server, monorepo-style server bundle) with two wrinkles that
    // real-world markdown actually has: CRLF line endings (common on repos
    // authored/edited on Windows) and a non-ASCII server name. Both are
    // regression fixtures for the parser, not just illustrative examples.

    /// Context7-style single-server README, CRLF (`\r\n`) line endings
    /// throughout — verbatim-realistic: intro prose, an H1 json config
    /// block, an H3 `claude mcp add` bash block (identical invocation to
    /// the H1 block, so it dedups rather than becoming a variant), and a
    /// remote/hosted H1 json block (becomes the one surviving variant).
    const CONTEXT7_STYLE_README_CRLF: &str = "# Context7 MCP Server\r\n\r\nContext7 pulls up-to-date, version-specific documentation and code examples straight from the source, and places them directly into your prompt.\r\n\r\nWithout Context7, LLMs often hallucinate APIs or reference outdated library versions, because their training data is frozen in time.\r\n\r\n## Why Context7?\r\n\r\n- Up-to-date code examples, straight from the source\r\n- Removes outdated or hallucinated APIs\r\n- No more tab-switching to check documentation\r\n\r\n## Installation\r\n\r\nAdd this to your `claude_desktop_config.json`:\r\n\r\n```json\r\n{\r\n  \"mcpServers\": {\r\n    \"context7\": {\r\n      \"command\": \"npx\",\r\n      \"args\": [\"-y\", \"@upstash/context7-mcp\"]\r\n    }\r\n  }\r\n}\r\n```\r\n\r\nOr install it directly with the Claude Code CLI:\r\n\r\n```bash\r\nclaude mcp add context7 -- npx -y @upstash/context7-mcp\r\n```\r\n\r\n### Remote server (hosted)\r\n\r\nIf you would rather not run anything locally, point your agent at our hosted endpoint instead:\r\n\r\n```json\r\n{\r\n  \"mcpServers\": {\r\n    \"context7\": {\r\n      \"type\": \"http\",\r\n      \"url\": \"https://mcp.context7.com/mcp\"\r\n    }\r\n  }\r\n}\r\n```\r\n\r\nThat's it — restart your client and the Context7 tools will show up.\r\n";

    #[test]
    fn crlf_readme_yields_one_draft_with_remote_variant() {
        let r = drafts_of(CONTEXT7_STYLE_README_CRLF);
        assert_eq!(r.drafts.len(), 1, "one server, three CRLF sections: {:?}", r.warnings);
        let d = &r.drafts[0];
        assert_eq!(d.spec.id, "context7");
        assert_eq!(d.spec.command.as_deref(), Some("npx"), "H1 json block is canonical");
        assert_eq!(d.spec.args, vec!["-y", "@upstash/context7-mcp"]);
        assert_eq!(
            d.spec.variants.len(),
            1,
            "the `claude mcp add` bash block is an identical invocation (dedup, not a variant); \
             only the remote block survives as a variant"
        );
        assert_eq!(d.spec.variants[0].label, "remote-http");
        assert_eq!(d.spec.variants[0].url.as_deref(), Some("https://mcp.context7.com/mcp"));
        assert!(r.warnings.is_empty(), "no placeholders in this fixture: {:?}", r.warnings);
    }

    /// Monorepo-style README bundling three servers under one `mcpServers`
    /// map, one of which is named with a non-ASCII character (`café-mcp`).
    /// `slugify` drops non-ASCII codepoints as separators (see
    /// `slugify_and_name_fallback` above for the ASCII case), so the actual
    /// (not guessed) slug is asserted below by running the real function.
    const MONOREPO_STYLE_README: &str = concat!(
        "# Acme MCP Monorepo\n",
        "\n",
        "This repo bundles three Model Context Protocol servers behind a single package.\n",
        "\n",
        "## Configuration\n",
        "\n",
        "```json\n",
        "{\n",
        "  \"mcpServers\": {\n",
        "    \"alpha\": {\n",
        "      \"command\": \"npx\",\n",
        "      \"args\": [\"-y\", \"@acme/alpha-mcp\"]\n",
        "    },\n",
        "    \"beta\": {\n",
        "      \"command\": \"npx\",\n",
        "      \"args\": [\"-y\", \"@acme/beta-mcp\"]\n",
        "    },\n",
        "    \"café-mcp\": {\n",
        "      \"command\": \"npx\",\n",
        "      \"args\": [\"-y\", \"@acme/cafe-mcp\"]\n",
        "    }\n",
        "  }\n",
        "}\n",
        "```\n",
    );

    #[test]
    fn monorepo_readme_with_unicode_name_yields_three_drafts() {
        assert_eq!(slugify("café-mcp"), "caf-mcp", "actual slugify behavior for this fixture's unicode name");

        let r = drafts_of(MONOREPO_STYLE_README);
        assert_eq!(r.drafts.len(), 3, "three servers, one unicode-named: {:?}", r.warnings);
        let mut ids: Vec<&str> = r.drafts.iter().map(|d| d.spec.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["alpha", "beta", "caf-mcp"]);
        let cafe = r.drafts.iter().find(|d| d.spec.id == "caf-mcp").unwrap();
        assert_eq!(cafe.spec.name, "café-mcp", "display name keeps the original unicode; only the id is slugified");
        assert_eq!(cafe.spec.command.as_deref(), Some("npx"));
        assert_eq!(cafe.spec.args, vec!["-y", "@acme/cafe-mcp"]);
    }
}
