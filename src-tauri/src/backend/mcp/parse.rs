//! Phase B: heuristic URL → draft-spec ingestion.
//! Spec: docs/superpowers/specs/2026-07-20-mcp-management-phase-b-design.md

use std::collections::BTreeMap;

use super::super::state::{BackendError, BackendResult};
use super::spec::McpTransport;

#[derive(Debug)]
pub struct FetchPlan {
    pub fetch_url: String,
    pub retry_url: Option<String>,
    pub fallback_name: String,
    pub warnings: Vec<String>,
}

fn file_stem_slug(seg: &str) -> String {
    let stem = seg.rsplit('/').next().unwrap_or(seg);
    let stem = stem.strip_suffix(".md").unwrap_or(stem);
    stem.to_ascii_lowercase()
}

pub fn source_for_url(url: &str) -> BackendResult<FetchPlan> {
    let fallback_err = || {
        BackendError::Validation(format!(
            "Can't parse this URL type: {url}. Supported: GitHub repo/file URLs, raw .md links, \
             gists. For other pages, ask your coding agent to import it or use manual entry."
        ))
    };
    if !url.starts_with("https://") {
        return Err(BackendError::Validation(format!(
            "Only https URLs are supported: {url}"
        )));
    }
    let no_query = url.split(['?', '#']).next().unwrap_or(url);
    let trimmed = no_query.trim_end_matches('/');

    if let Some(rest) = trimmed.strip_prefix("https://github.com/") {
        let segs: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
        match segs.as_slice() {
            [org, repo] => {
                return Ok(FetchPlan {
                    fetch_url: format!(
                        "https://raw.githubusercontent.com/{org}/{repo}/HEAD/README.md"
                    ),
                    retry_url: Some(format!(
                        "https://raw.githubusercontent.com/{org}/{repo}/master/README.md"
                    )),
                    fallback_name: repo.to_ascii_lowercase(),
                    warnings: Vec::new(),
                });
            }
            [org, repo, "tree", git_ref, path @ ..] if !path.is_empty() => {
                let path = path.join("/");
                return Ok(FetchPlan {
                    fetch_url: format!(
                        "https://raw.githubusercontent.com/{org}/{repo}/{git_ref}/{path}/README.md"
                    ),
                    retry_url: None,
                    fallback_name: file_stem_slug(&path),
                    warnings: Vec::new(),
                });
            }
            [org, repo, "blob", git_ref, path @ ..]
                if path.last().is_some_and(|p| p.ends_with(".md")) =>
            {
                let path = path.join("/");
                return Ok(FetchPlan {
                    fetch_url: format!(
                        "https://raw.githubusercontent.com/{org}/{repo}/{git_ref}/{path}"
                    ),
                    retry_url: None,
                    fallback_name: file_stem_slug(&path),
                    warnings: Vec::new(),
                });
            }
            _ => return Err(fallback_err()),
        }
    }
    if let Some(rest) = trimmed.strip_prefix("https://gist.github.com/") {
        let segs: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
        if segs.len() == 2 {
            return Ok(FetchPlan {
                fetch_url: format!("{trimmed}/raw"),
                retry_url: None,
                fallback_name: segs[0].to_ascii_lowercase(),
                warnings: vec![
                    "Gist: only the first file is fetched; multi-file gists may be truncated."
                        .to_string(),
                ],
            });
        }
        return Err(fallback_err());
    }
    if trimmed.starts_with("https://raw.githubusercontent.com/") || trimmed.ends_with(".md") {
        return Ok(FetchPlan {
            fetch_url: trimmed.to_string(),
            retry_url: None,
            fallback_name: file_stem_slug(trimmed),
            warnings: Vec::new(),
        });
    }
    Err(fallback_err())
}

// Fence scanning, JSONC tolerance, and H1 candidate extraction (Phase B
// Task 2). Callers land in a later Phase B task (H2/H3 heuristics + the
// public draft-spec entry point); kept `#[allow(dead_code)]` until then so
// a plain `cargo build` stays warning-free in the interim.
#[allow(dead_code)]
struct Fence {
    info: String,
    start_line: usize,
    body: String,
}

#[allow(dead_code)]
fn scan_fences(markdown: &str) -> Vec<Fence> {
    let mut fences = Vec::new();
    let mut open: Option<(String, usize, String)> = None;
    for (idx, line) in markdown.lines().enumerate() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("```") {
            match open.take() {
                Some((info, start, body)) => fences.push(Fence { info, start_line: start, body }),
                None => open = Some((rest.trim().to_ascii_lowercase(), idx + 1, String::new())),
            }
        } else if let Some((_, _, body)) = open.as_mut() {
            body.push_str(line);
            body.push('\n');
        }
    }
    fences
}

#[allow(dead_code)]
fn strip_jsonc(text: &str) -> String {
    // 1. drop whole-line // comments (never touches // inside values)
    let no_comments: String = text
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    // 2. remove trailing commas before } or ], respecting strings
    let mut out = String::with_capacity(no_comments.len());
    let mut in_str = false;
    let mut escaped = false;
    let chars: Vec<char> = no_comments.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if in_str {
            out.push(c);
            if escaped { escaped = false; }
            else if c == '\\' { escaped = true; }
            else if c == '"' { in_str = false; }
            continue;
        }
        match c {
            '"' => { in_str = true; out.push(c); }
            ',' => {
                let next_sig = chars[i + 1..].iter().find(|ch| !ch.is_whitespace());
                if !matches!(next_sig, Some('}') | Some(']')) { out.push(c); }
            }
            _ => out.push(c),
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub(crate) struct Candidate {
    pub name: Option<String>,
    pub priority: u8, // 1=H1, 2=H2, 3=H3
    pub transport: McpTransport,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub url: Option<String>,
    pub headers: BTreeMap<String, String>,
    pub evidence: String,
    pub ignored_keys: Vec<String>,
}

#[allow(dead_code)]
const SERVER_MAP_KEYS: &[&str] = &["mcpServers", "mcp_servers", "servers", "mcp"];
#[allow(dead_code)]
const KNOWN_ENTRY_KEYS: &[&str] = &[
    "type", "transport", "command", "args", "env", "environment",
    "url", "httpUrl", "serverUrl", "headers", "http_headers",
];

#[allow(dead_code)]
fn candidate_from_json(name: &str, v: &serde_json::Value, line: usize) -> Option<Candidate> {
    let obj = v.as_object()?;
    let mut command = None;
    let mut args: Vec<String> = Vec::new();
    match obj.get("command") {
        Some(serde_json::Value::String(s)) => {
            command = Some(s.clone());
            if let Some(a) = obj.get("args").and_then(|a| a.as_array()) {
                args = a.iter().filter_map(|x| x.as_str().map(String::from)).collect();
            }
        }
        Some(serde_json::Value::Array(argv)) => {
            let mut it = argv.iter().filter_map(|x| x.as_str().map(String::from));
            command = it.next();
            args = it.collect();
        }
        _ => {}
    }
    let str_map = |key: &str| -> BTreeMap<String, String> {
        obj.get(key)
            .and_then(|m| m.as_object())
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut env = str_map("env");
    if env.is_empty() { env = str_map("environment"); }
    let mut headers = str_map("headers");
    if headers.is_empty() { headers = str_map("http_headers"); }
    let url = ["url", "httpUrl", "serverUrl"]
        .iter()
        .find_map(|k| obj.get(*k).and_then(|v| v.as_str()).map(String::from));
    let type_field = obj
        .get("type")
        .or_else(|| obj.get("transport"))
        .and_then(|v| v.as_str())
        .map(str::to_ascii_lowercase);
    let transport = match type_field.as_deref() {
        Some("stdio") | Some("local") => McpTransport::Stdio,
        Some("http") | Some("streamable-http") | Some("remote") => McpTransport::Http,
        Some("sse") => McpTransport::Sse,
        _ if obj.contains_key("httpUrl") => McpTransport::Http,
        _ if command.is_some() => McpTransport::Stdio,
        _ if url.is_some() => McpTransport::Http,
        _ => return None,
    };
    if command.is_none() && url.is_none() { return None; }
    let ignored_keys: Vec<String> = obj
        .keys()
        .filter(|k| !KNOWN_ENTRY_KEYS.contains(&k.as_str()))
        .cloned()
        .collect();
    Some(Candidate {
        name: Some(name.to_string()),
        priority: 1,
        transport, command, args, env, url, headers,
        evidence: format!("H1 json block (line {line}): key {name:?}"),
        ignored_keys,
    })
}

#[allow(dead_code)]
fn find_server_maps<'a>(
    v: &'a serde_json::Value,
    out: &mut Vec<&'a serde_json::Map<String, serde_json::Value>>,
) {
    if let Some(obj) = v.as_object() {
        for (k, val) in obj {
            if SERVER_MAP_KEYS.contains(&k.as_str()) {
                if let Some(map) = val.as_object() { out.push(map); }
            } else {
                find_server_maps(val, out);
            }
        }
    }
}

#[allow(dead_code)]
fn extract_h1(fences: &[Fence]) -> (Vec<Candidate>, Vec<String>) {
    let mut candidates = Vec::new();
    let mut warnings = Vec::new();
    for f in fences {
        if !matches!(f.info.as_str(), "json" | "jsonc" | "json5" | "js" | "") { continue; }
        if !SERVER_MAP_KEYS.iter().any(|k| f.body.contains(k)) { continue; }
        let cleaned = strip_jsonc(&f.body);
        let parsed: serde_json::Value = match serde_json::from_str(&cleaned) {
            Ok(v) => v,
            Err(e) => {
                warnings.push(format!("Skipped unparseable json block at line {}: {e}", f.start_line));
                continue;
            }
        };
        let mut maps = Vec::new();
        find_server_maps(&parsed, &mut maps);
        for map in maps {
            for (name, entry) in map {
                if let Some(c) = candidate_from_json(name, entry, f.start_line) {
                    candidates.push(c);
                }
            }
        }
    }
    (candidates, warnings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_github_repo_root() {
        let p = source_for_url("https://github.com/upstash/context7-mcp").unwrap();
        assert_eq!(p.fetch_url, "https://raw.githubusercontent.com/upstash/context7-mcp/HEAD/README.md");
        assert_eq!(p.retry_url.as_deref(), Some("https://raw.githubusercontent.com/upstash/context7-mcp/master/README.md"));
        assert_eq!(p.fallback_name, "context7-mcp");
        assert!(p.warnings.is_empty());
    }

    #[test]
    fn classifies_github_tree_subdir() {
        let p = source_for_url("https://github.com/modelcontextprotocol/servers/tree/main/src/fetch").unwrap();
        assert_eq!(p.fetch_url, "https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/fetch/README.md");
        assert!(p.retry_url.is_none(), "explicit ref: no master retry");
        assert_eq!(p.fallback_name, "fetch");
    }

    #[test]
    fn classifies_github_blob_md() {
        let p = source_for_url("https://github.com/org/repo/blob/main/docs/INSTALL.md").unwrap();
        assert_eq!(p.fetch_url, "https://raw.githubusercontent.com/org/repo/main/docs/INSTALL.md");
        assert_eq!(p.fallback_name, "install");
    }

    #[test]
    fn classifies_raw_and_plain_md_as_is() {
        let raw = "https://raw.githubusercontent.com/org/repo/main/README.md";
        assert_eq!(source_for_url(raw).unwrap().fetch_url, raw);
        let md = "https://example.com/docs/setup.md";
        let p = source_for_url(md).unwrap();
        assert_eq!(p.fetch_url, md);
        assert_eq!(p.fallback_name, "setup");
    }

    #[test]
    fn classifies_gist_with_warning() {
        let p = source_for_url("https://gist.github.com/user/abc123").unwrap();
        assert_eq!(p.fetch_url, "https://gist.github.com/user/abc123/raw");
        assert_eq!(p.warnings.len(), 1, "gist first-file caveat");
    }

    #[test]
    fn rejects_http_and_unclassifiable() {
        assert!(source_for_url("http://github.com/org/repo").is_err());
        let err = source_for_url("https://docs.example.com/mcp-setup").unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("manual"), "error guides to fallbacks: {msg}");
    }

    #[test]
    fn github_url_with_trailing_slash_and_query() {
        let p = source_for_url("https://github.com/org/repo/?tab=readme-ov-file").unwrap();
        assert_eq!(p.fetch_url, "https://raw.githubusercontent.com/org/repo/HEAD/README.md");
    }

    use crate::backend::mcp::spec::McpTransport;

    #[test]
    fn scan_fences_finds_blocks_with_info_and_line() {
        let md = "intro\n```json\n{\"a\":1}\n```\ntext\n```bash\nnpx foo\n```\n";
        let fences = scan_fences(md);
        assert_eq!(fences.len(), 2);
        assert_eq!(fences[0].info, "json");
        assert_eq!(fences[0].start_line, 2);
        assert_eq!(fences[0].body, "{\"a\":1}\n");
        assert_eq!(fences[1].info, "bash");
    }

    #[test]
    fn strip_jsonc_removes_line_comments_and_trailing_commas() {
        let src = "{\n// top comment\n\"a\": \"http://x\", \n\"b\": [1,2,],\n}";
        let clean = strip_jsonc(src);
        let v: serde_json::Value = serde_json::from_str(&clean).unwrap();
        assert_eq!(v["a"], "http://x", "urls with // survive");
        assert_eq!(v["b"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn h1_extracts_claude_style_entry() {
        let md = "```json\n{\"mcpServers\":{\"context7\":{\"type\":\"stdio\",\"command\":\"npx\",\"args\":[\"-y\",\"@upstash/context7-mcp\"],\"env\":{\"K\":\"V\"}}}}\n```\n";
        let (cands, warns) = extract_h1(&scan_fences(md));
        assert!(warns.is_empty());
        assert_eq!(cands.len(), 1);
        let c = &cands[0];
        assert_eq!(c.name.as_deref(), Some("context7"));
        assert_eq!(c.priority, 1);
        assert_eq!(c.transport, McpTransport::Stdio);
        assert_eq!(c.command.as_deref(), Some("npx"));
        assert_eq!(c.args, vec!["-y", "@upstash/context7-mcp"]);
        assert_eq!(c.env.get("K").map(String::as_str), Some("V"));
    }

    #[test]
    fn h1_reverse_maps_opencode_and_gemini_and_vscode_dialects() {
        // OpenCode: argv command + environment + type local, under "mcp"
        let md = "```json\n{\"mcp\":{\"srv\":{\"type\":\"local\",\"command\":[\"bunx\",\"my-mcp\"],\"environment\":{\"T\":\"1\"},\"enabled\":true}}}\n```";
        let (cands, _) = extract_h1(&scan_fences(md));
        let c = &cands[0];
        assert_eq!(c.command.as_deref(), Some("bunx"));
        assert_eq!(c.args, vec!["my-mcp"]);
        assert_eq!(c.env.get("T").map(String::as_str), Some("1"));
        assert!(c.ignored_keys.contains(&"enabled".to_string()));

        // Gemini httpUrl → http transport
        let md = "```json\n{\"mcpServers\":{\"r\":{\"httpUrl\":\"https://x/mcp\",\"headers\":{\"A\":\"B\"}}}}\n```";
        let (cands, _) = extract_h1(&scan_fences(md));
        assert_eq!(cands[0].transport, McpTransport::Http);
        assert_eq!(cands[0].url.as_deref(), Some("https://x/mcp"));
        assert_eq!(cands[0].headers.get("A").map(String::as_str), Some("B"));

        // VS Code "servers" + explicit sse + serverUrl accepted
        let md = "```json\n{\"servers\":{\"s\":{\"type\":\"sse\",\"serverUrl\":\"https://y/sse\"}}}\n```";
        let (cands, _) = extract_h1(&scan_fences(md));
        assert_eq!(cands[0].transport, McpTransport::Sse);
        assert_eq!(cands[0].url.as_deref(), Some("https://y/sse"));
    }

    #[test]
    fn h1_nested_and_non_server_objects() {
        // nested under wrapper keys still found; non-server entries skipped
        let md = "```json\n{\"config\":{\"mcpServers\":{\"a\":{\"command\":\"x\"},\"junk\":{\"note\":\"hi\"}}}}\n```";
        let (cands, _) = extract_h1(&scan_fences(md));
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].name.as_deref(), Some("a"));
    }

    #[test]
    fn h1_malformed_block_warns_and_continues() {
        // Wrinkle adjustment: the malformed block must contain a server-map
        // key (here `mcpServers`) so it passes the skip-guard in extract_h1
        // and reaches the JSON parse step, where it fails and produces a
        // warning. A bare `{not json` block (no server-map key) would be
        // silently skipped by the guard, never warned.
        //
        // A leading blank line puts the malformed block's opening fence at
        // file line 2 (Fence::start_line is the 1-indexed line of the fence
        // marker itself — see scan_fences_finds_blocks_with_info_and_line),
        // matching the "line 2" the warning is expected to cite below.
        let md = "\n```json\n{\"mcpServers\": not json\n```\n```json\n{\"mcpServers\":{\"ok\":{\"command\":\"x\"}}}\n```";
        let (cands, warns) = extract_h1(&scan_fences(md));
        assert_eq!(cands.len(), 1);
        assert_eq!(warns.len(), 1);
        assert!(warns[0].contains("line 2"), "warning cites location: {}", warns[0]);
    }
}
