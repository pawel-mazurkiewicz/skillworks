//! Phase B: heuristic URL → draft-spec ingestion.
//! Spec: docs/superpowers/specs/2026-07-20-mcp-management-phase-b-design.md

use std::collections::BTreeMap;

use super::super::state::{BackendError, BackendResult};
use super::spec::{validate_spec, McpServerSpec, McpSource, McpTransport, McpVariant};
use crate::backend::types::McpServerDraft;

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
            "Only https URLs are supported: {url}. For other pages, ask your coding agent to import it or use manual entry."
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

// Fence scanning, JSONC tolerance, and H1/H2/H3 candidate extraction (Phase B
// Tasks 2-3), wired together by `extract_drafts` below (Phase B Task 4).
struct Fence {
    info: String,
    start_line: usize,
    body: String,
}

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
    /// True only when `name` was derived from a package/image basename
    /// (bare `npx`/`uvx` and `docker run` lines in `parse_command_line`).
    /// Everywhere else (H1/H2 config keys, `claude mcp add`/`add-json`
    /// names) the name is explicit and this is `false`. Drives the guarded
    /// fold pass in `extract_drafts`: only inferred-name groups may ever
    /// fold into an explicitly-named group.
    pub name_inferred: bool,
}

const SERVER_MAP_KEYS: &[&str] = &["mcpServers", "mcp_servers", "servers", "mcp"];
const KNOWN_ENTRY_KEYS: &[&str] = &[
    "type", "transport", "command", "args", "env", "environment",
    "url", "httpUrl", "serverUrl", "headers", "http_headers",
];

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
        name_inferred: false,
    })
}

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

fn extract_h2(fences: &[Fence]) -> (Vec<Candidate>, Vec<String>) {
    let mut candidates = Vec::new();
    let mut warnings = Vec::new();
    for f in fences {
        if f.info != "toml" || !f.body.contains("mcp_servers") { continue; }
        let doc = match f.body.parse::<toml_edit::DocumentMut>() {
            Ok(d) => d,
            Err(e) => {
                warnings.push(format!("Skipped unparseable toml block at line {}: {e}", f.start_line));
                continue;
            }
        };
        let Some(servers) = doc.get("mcp_servers").and_then(|i| i.as_table()) else { continue };
        for (name, item) in servers.iter() {
            let Some(t) = item.as_table_like() else { continue };
            let get_str = |k: &str| t.get(k).and_then(|i| i.as_str()).map(String::from);
            let command = get_str("command");
            let args: Vec<String> = t
                .get("args")
                .and_then(|i| i.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let map_of = |k: &str| -> BTreeMap<String, String> {
                t.get(k)
                    .and_then(|i| i.as_table_like())
                    .map(|tbl| {
                        tbl.iter()
                            .filter_map(|(k, v)| v.as_str().map(|s| (k.to_string(), s.to_string())))
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let env = map_of("env");
            let headers = map_of("http_headers");
            let url = get_str("url");
            let transport = if command.is_some() { McpTransport::Stdio }
                else if url.is_some() { McpTransport::Http }
                else { continue };
            candidates.push(Candidate {
                name: Some(name.to_string()),
                priority: 2,
                transport, command, args, env, url, headers,
                evidence: format!("H2 toml block (line {}): [mcp_servers.{name}]", f.start_line),
                ignored_keys: Vec::new(),
                name_inferred: false,
            });
        }
    }
    (candidates, warnings)
}

fn shell_tokens(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in line.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => cur.push(c),
            (None, '"') | (None, '\'') => quote = Some(c),
            (None, c) if c.is_whitespace() => {
                if !cur.is_empty() { out.push(std::mem::take(&mut cur)); }
            }
            (None, c) => cur.push(c),
        }
    }
    if !cur.is_empty() { out.push(cur); }
    out
}

fn package_basename(pkg: &str) -> String {
    let last = pkg.rsplit('/').next().unwrap_or(pkg);
    let no_tag = last.split(':').next().unwrap_or(last);
    let no_ver = match no_tag.char_indices().find(|&(i, c)| c == '@' && i > 0) {
        Some((i, _)) => &no_tag[..i],
        None => no_tag,
    };
    no_ver.to_string()
}

const SHELL_INFOS: &[&str] = &["bash", "sh", "shell", "zsh", "console", "text", ""];

fn strip_prompt(line: &str) -> String {
    let t = line.trim_start();
    let t = t.strip_prefix('$').or_else(|| t.strip_prefix('>')).unwrap_or(t);
    t.trim_start().to_string()
}

fn extract_h3(markdown: &str, fences: &[Fence]) -> Vec<Candidate> {
    let mut lines: Vec<String> = Vec::new();
    for f in fences {
        if SHELL_INFOS.contains(&f.info.as_str()) {
            lines.extend(f.body.lines().map(strip_prompt));
        }
    }
    // inline code spans only; prose without backtick spans contributes nothing
    let mut in_fence = false;
    for line in markdown.lines() {
        if line.trim_start().starts_with("```") { in_fence = !in_fence; continue; }
        if in_fence { continue; }
        let parts: Vec<&str> = line.split('`').collect();
        for (i, part) in parts.iter().enumerate() {
            if i % 2 == 1 { lines.push(part.to_string()); }
        }
    }

    let mut candidates: Vec<Candidate> = Vec::new();
    let mut seen: Vec<(Option<String>, Option<String>, Vec<String>, Option<String>)> = Vec::new();
    for line in &lines {
        let Some(c) = parse_command_line(line) else { continue };
        let key = (c.name.clone(), c.command.clone(), c.args.clone(), c.url.clone());
        if seen.contains(&key) { continue; }
        seen.push(key);
        candidates.push(c);
    }
    candidates
}

fn parse_command_line(line: &str) -> Option<Candidate> {
    let toks = shell_tokens(line);
    // claude mcp add / add-json
    if toks.len() >= 4 && toks[0] == "claude" && toks[1] == "mcp" {
        if toks[2] == "add" {
            let mut transport = None;
            let mut env = BTreeMap::new();
            let mut i = 3;
            let mut name = None;
            let mut positional: Vec<String> = Vec::new();
            while i < toks.len() {
                match toks[i].as_str() {
                    "--transport" => { transport = toks.get(i + 1).cloned(); i += 2; }
                    "--env" | "-e" => {
                        if let Some((k, v)) = toks.get(i + 1).and_then(|s| s.split_once('=')) {
                            env.insert(k.to_string(), v.to_string());
                        }
                        i += 2;
                    }
                    "--scope" | "-s" | "--header" | "-H" => { i += 2; }
                    "--" => { positional.extend(toks[i + 1..].iter().cloned()); break; }
                    t if t.starts_with('-') => { i += 1; }
                    t => {
                        if name.is_none() { name = Some(t.to_string()); }
                        else { positional.push(t.to_string()); }
                        i += 1;
                    }
                }
            }
            let name = name?;
            match transport.as_deref() {
                Some("http") | Some("sse") => {
                    let url = positional.first()?.clone();
                    let transport = if transport.as_deref() == Some("sse") { McpTransport::Sse } else { McpTransport::Http };
                    return Some(Candidate {
                        name: Some(name), priority: 3, transport,
                        command: None, args: Vec::new(), env: BTreeMap::new(),
                        url: Some(url), headers: BTreeMap::new(),
                        evidence: format!("H3 command line: {}", line.trim()),
                        ignored_keys: Vec::new(),
                        name_inferred: false,
                    });
                }
                _ => {
                    let command = positional.first()?.clone();
                    return Some(Candidate {
                        name: Some(name), priority: 3, transport: McpTransport::Stdio,
                        command: Some(command), args: positional[1..].to_vec(), env,
                        url: None, headers: BTreeMap::new(),
                        evidence: format!("H3 command line: {}", line.trim()),
                        ignored_keys: Vec::new(),
                        name_inferred: false,
                    });
                }
            }
        }
        if toks[2] == "add-json" && toks.len() >= 5 {
            let name = toks[3].clone();
            let json: serde_json::Value = serde_json::from_str(&toks[4]).ok()?;
            let mut c = candidate_from_json(&name, &json, 0)?;
            c.priority = 3;
            c.evidence = format!("H3 add-json: {}", line.trim());
            return Some(c);
        }
        return None;
    }
    // bare npx / uvx
    for (tool, skip_flags) in [("npx", true), ("uvx", false)] {
        if let Some(pos) = toks
            .iter()
            .position(|t| t.rsplit('/').next().unwrap_or(t) == tool)
        {
            let matched = toks[pos].clone();
            let rest = &toks[pos + 1..];
            let mut it = rest.iter();
            let mut args: Vec<String> = Vec::new();
            if skip_flags { args.push("-y".to_string()); }
            let pkg = loop {
                match it.next() {
                    Some(t) if skip_flags && (t == "-y" || t == "--yes") => continue,
                    Some(t) if !t.starts_with('-') => break t.clone(),
                    Some(_) => continue,
                    None => return None,
                }
            };
            args.push(pkg.clone());
            args.extend(it.cloned());
            return Some(Candidate {
                name: Some(package_basename(&pkg)),
                priority: 3, transport: McpTransport::Stdio,
                command: Some(matched), args,
                env: BTreeMap::new(), url: None, headers: BTreeMap::new(),
                evidence: format!("H3 command line: {}", line.trim()),
                ignored_keys: Vec::new(),
                name_inferred: true,
            });
        }
    }
    // docker run — args preserved verbatim, -e mirrored into env
    if let Some(pos) = toks.iter().position(|t| t == "docker") {
        if toks.get(pos + 1).map(String::as_str) == Some("run") {
            let rest = &toks[pos + 1..];
            let mut env = BTreeMap::new();
            let mut image = None;
            let mut i = 1;
            while i < rest.len() {
                match rest[i].as_str() {
                    "-e" | "--env" => {
                        if let Some((k, v)) = rest.get(i + 1).and_then(|s| s.split_once('=')) {
                            env.insert(k.to_string(), v.to_string());
                        }
                        i += 2;
                    }
                    t if t.starts_with('-') => i += 1,
                    t => { image = Some(t.to_string()); break; }
                }
            }
            let image = image?;
            return Some(Candidate {
                name: Some(package_basename(&image)),
                priority: 3, transport: McpTransport::Stdio,
                command: Some("docker".to_string()),
                args: rest.to_vec(), env,
                url: None, headers: BTreeMap::new(),
                evidence: format!("H3 command line: {}", line.trim()),
                ignored_keys: Vec::new(),
                name_inferred: true,
            });
        }
    }
    None
}

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

/// Phase B Task 4: draft assembly — groups candidates by slugified name,
/// picks the highest-priority (lowest `priority`) candidate as canonical,
/// folds the rest into variants (or drops them as exact-invocation dupes),
/// validates, and collects placeholder warnings.
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

    #[test]
    fn h2_extracts_codex_toml() {
        let md = "```toml\n[mcp_servers.context7]\ncommand = \"npx\"\nargs = [\"-y\", \"@upstash/context7-mcp\"]\n\n[mcp_servers.context7.env]\nK = \"V\"\n\n[mcp_servers.remote]\nurl = \"https://x/mcp\"\n```";
        let (cands, warns) = extract_h2(&scan_fences(md));
        assert!(warns.is_empty());
        assert_eq!(cands.len(), 2);
        let c = cands.iter().find(|c| c.name.as_deref() == Some("context7")).unwrap();
        assert_eq!(c.priority, 2);
        assert_eq!(c.command.as_deref(), Some("npx"));
        assert_eq!(c.env.get("K").map(String::as_str), Some("V"));
        let r = cands.iter().find(|c| c.name.as_deref() == Some("remote")).unwrap();
        assert_eq!(r.transport, McpTransport::Http);
    }

    #[test]
    fn shell_tokens_respects_quotes() {
        assert_eq!(
            shell_tokens(r#"claude mcp add ctx --env K="a b" -- npx -y pkg"#),
            vec!["claude", "mcp", "add", "ctx", "--env", "K=a b", "--", "npx", "-y", "pkg"]
        );
    }

    #[test]
    fn h3_claude_mcp_add_stdio_and_http() {
        let md = "```bash\nclaude mcp add --env API_KEY=YOUR_KEY context7 -- npx -y @upstash/context7-mcp\nclaude mcp add --transport http ctx-remote https://mcp.context7.com/mcp\n```";
        let cands = extract_h3(md, &scan_fences(md));
        assert_eq!(cands.len(), 2);
        let s = &cands[0];
        assert_eq!(s.name.as_deref(), Some("context7"));
        assert_eq!(s.priority, 3);
        assert_eq!(s.command.as_deref(), Some("npx"));
        assert_eq!(s.args, vec!["-y", "@upstash/context7-mcp"]);
        assert_eq!(s.env.get("API_KEY").map(String::as_str), Some("YOUR_KEY"));
        let r = &cands[1];
        assert_eq!(r.transport, McpTransport::Http);
        assert_eq!(r.url.as_deref(), Some("https://mcp.context7.com/mcp"));
    }

    #[test]
    fn h3_bare_npx_uvx_docker() {
        let md = "Install:\n```sh\nnpx -y @upstash/context7-mcp --port 3000\nuvx some-mcp-server\ndocker run --rm -i -e TOKEN=abc ghcr.io/org/mcp-img:latest --flag\n```";
        let cands = extract_h3(md, &scan_fences(md));
        assert_eq!(cands.len(), 3);
        assert_eq!(cands[0].command.as_deref(), Some("npx"));
        assert_eq!(cands[0].args, vec!["-y", "@upstash/context7-mcp", "--port", "3000"]);
        assert_eq!(cands[0].name.as_deref(), Some("context7-mcp"));
        assert_eq!(cands[1].command.as_deref(), Some("uvx"));
        assert_eq!(cands[1].name.as_deref(), Some("some-mcp-server"));
        let d = &cands[2];
        assert_eq!(d.command.as_deref(), Some("docker"));
        assert_eq!(d.args[0], "run", "docker args preserved verbatim");
        assert!(d.args.contains(&"TOKEN=abc".to_string()));
        assert_eq!(d.name.as_deref(), Some("mcp-img"));
        assert_eq!(d.env.get("TOKEN").map(String::as_str), Some("abc"), "docker -e also mirrored to env for placeholder checks");
    }

    #[test]
    fn h3_skips_json_blocks_and_dedups() {
        let md = "```json\n{\"mcpServers\":{\"a\":{\"command\":\"npx\",\"args\":[\"-y\",\"x\"]}}}\n```\n```bash\nnpx -y x\nnpx -y x\n```";
        let cands = extract_h3(md, &scan_fences(md));
        assert_eq!(cands.len(), 1, "json block lines not scanned; duplicate command deduped");
    }

    #[test]
    fn package_basename_strips_scope_and_version() {
        assert_eq!(package_basename("@upstash/context7-mcp"), "context7-mcp");
        assert_eq!(package_basename("some-pkg@1.2.3"), "some-pkg");
        assert_eq!(package_basename("ghcr.io/org/mcp-img:latest"), "mcp-img");
    }

    #[test]
    fn h3_prompt_strip_preserves_dollar_vars() {
        let md = "```sh\n$ $HOME/.local/bin/uvx some-mcp\n```";
        let cands = extract_h3(md, &scan_fences(md));
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].command.as_deref(), Some("$HOME/.local/bin/uvx"));
    }

    #[test]
    fn h3_distinct_remote_adds_both_survive() {
        let md = "```bash\nclaude mcp add --transport http one https://a/mcp\nclaude mcp add --transport http two https://b/mcp\n```";
        let cands = extract_h3(md, &scan_fences(md));
        assert_eq!(cands.len(), 2);
    }

    #[test]
    fn h3_prose_scans_only_inline_code_spans() {
        let md = "Run `npx -y pkg` to start. Plain npx -y other prose is ignored.";
        let cands = extract_h3(md, &scan_fences(md));
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].args, vec!["-y", "pkg"], "no trailing prose tokens");
    }

    #[test]
    fn h3_add_json_parses_inline_entry() {
        let md = "```bash\nclaude mcp add-json ctx '{\"command\":\"npx\",\"args\":[\"-y\",\"ctx-mcp\"]}'\n```";
        let cands = extract_h3(md, &scan_fences(md));
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].name.as_deref(), Some("ctx"));
        assert_eq!(cands[0].command.as_deref(), Some("npx"));
    }

    #[test]
    fn h2_malformed_toml_warns_and_continues() {
        let md = "```toml\n[mcp_servers.broken\ncommand = \"x\"\n```\n```toml\n[mcp_servers.ok]\ncommand = \"y\"\n```";
        let (cands, warns) = extract_h2(&scan_fences(md));
        assert_eq!(cands.len(), 1);
        assert_eq!(warns.len(), 1);
    }

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

    #[test]
    fn rejects_blob_without_md_and_empty_tree_path() {
        assert!(source_for_url("https://github.com/org/repo/blob/main/src/lib.rs").is_err());
        assert!(source_for_url("https://github.com/org/repo/tree/main").is_err());
    }

    #[test]
    fn rejects_gist_revision_and_bare_org_urls() {
        assert!(source_for_url("https://gist.github.com/user/abc123/deadbeef").is_err());
        assert!(source_for_url("https://github.com/orgonly").is_err());
    }

    #[test]
    fn https_rejection_message_carries_guidance() {
        let err = source_for_url("http://github.com/org/repo").unwrap_err();
        assert!(format!("{err}").contains("manual"));
    }
}
