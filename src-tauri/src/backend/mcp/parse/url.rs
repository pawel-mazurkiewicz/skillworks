//! URL classification: turns a pasted GitHub/gist/raw-markdown URL into a
//! `FetchPlan` (fetch URL + retry + fallback name). Network-free.

use crate::backend::state::{BackendError, BackendResult};

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
