//! skills.sh marketplace integration.
//!
//! Ports `fetchMarketplaceSkills`, `fetchSkillsJson`, `fetchSkillsPage`,
//! `scrapeMarketplaceSkills`, `extractSkillLinks`, `decodeHtml`, and
//! `isNonSkillPath` from `src/server.js`.
//!
//! The HTTP layer is hidden behind a small `HttpClient` trait so unit tests
//! can inject a deterministic mock without spinning up a real server.

use std::collections::{BTreeMap, HashSet};

use async_trait::async_trait;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;

use super::state::{BackendError, BackendResult};
use super::types::{MarketplacePagination, MarketplaceSkill, MarketplaceSkillsResponse};

const BASE_URL: &str = "https://skills.sh";
const USER_AGENT: &str = "Skillworks/0.1.0";

/// HTTP response surface that the marketplace logic needs from its
/// underlying client. Mirrors the subset of `fetch`'s behaviour the JS
/// implementation relied on.
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

impl HttpResponse {
    pub fn is_ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Minimal HTTP-GET abstraction so tests can inject a mock.
///
/// The trait is intentionally tiny: the marketplace code only ever does
/// `GET` requests with a fixed set of headers, so we don't need a full
/// reqwest surface here.
#[async_trait]
pub trait HttpClient: Send + Sync {
    async fn get(&self, url: &str, headers: &[(&str, &str)]) -> BackendResult<HttpResponse>;
}

/// Production HTTP client backed by `reqwest` with rustls-tls (so we never
/// depend on the system OpenSSL). Follows redirects automatically per
/// reqwest's default policy, matching the JS implementation's manual
/// redirect-following behaviour.
pub struct ReqwestHttpClient {
    client: reqwest::Client,
}

impl ReqwestHttpClient {
    pub fn new() -> BackendResult<Self> {
        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .build()
            .map_err(|e| BackendError::Validation(format!("http client init failed: {e}")))?;
        Ok(Self { client })
    }
}

#[async_trait]
impl HttpClient for ReqwestHttpClient {
    async fn get(&self, url: &str, headers: &[(&str, &str)]) -> BackendResult<HttpResponse> {
        let mut req = self.client.get(url);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| BackendError::Validation(format!("skills.sh request failed: {e}")))?;
        let status = resp.status().as_u16();
        let body = resp
            .text()
            .await
            .map_err(|e| BackendError::Validation(format!("skills.sh body read failed: {e}")))?;
        Ok(HttpResponse { status, body })
    }
}

/// Tauri-command-facing entry point. Resolves a default `ReqwestHttpClient`
/// and delegates to `fetch_marketplace_skills_with`.
pub async fn fetch_marketplace_skills(
    query: Option<String>,
    view: Option<String>,
    page: Option<String>,
    per_page: Option<String>,
) -> BackendResult<MarketplaceSkillsResponse> {
    let client = ReqwestHttpClient::new()?;
    fetch_marketplace_skills_with(&client, query, view, page, per_page).await
}

/// Test-friendly core. Mirrors `fetchMarketplaceSkills` in `src/server.js`.
pub async fn fetch_marketplace_skills_with<C: HttpClient + ?Sized>(
    client: &C,
    query: Option<String>,
    view: Option<String>,
    page: Option<String>,
    per_page: Option<String>,
) -> BackendResult<MarketplaceSkillsResponse> {
    let trimmed = query.as_deref().unwrap_or("").trim().to_string();
    let view = view.as_deref().unwrap_or("trending").to_string();
    let per_page = per_page.as_deref().unwrap_or("24").to_string();
    let page = page.as_deref().unwrap_or("0").to_string();

    let attempt: BackendResult<MarketplaceSkillsResponse> = if trimmed.len() >= 2 {
        let mut params = BTreeMap::new();
        params.insert("q", trimmed.clone());
        params.insert("limit", per_page.clone());
        fetch_skills_json_typed(client, "/api/v1/skills/search", &params).await
    } else if view == "official" {
        // Curated has a different shape: `data` is an owner list, not skills.
        // Fetch as raw JSON and reshape before typing.
        let raw =
            fetch_skills_json_raw(client, "/api/v1/skills/curated", &BTreeMap::new()).await;
        raw.map(reshape_curated)
    } else {
        let mut params = BTreeMap::new();
        let normalized_view = if ["all-time", "trending", "hot"]
            .contains(&view.as_str())
        {
            view.clone()
        } else {
            "trending".to_string()
        };
        params.insert("view", normalized_view);
        params.insert("page", page.clone());
        params.insert("per_page", per_page.clone());
        fetch_skills_json_typed(client, "/api/v1/skills", &params).await
    };

    match attempt {
        Ok(resp) => Ok(resp),
        Err(BackendError::Validation(msg)) if msg == AUTH_REQUIRED_MARKER => {
            scrape_marketplace_skills(client, &trimmed, &view, &page, &per_page).await
        }
        Err(e) => Err(e),
    }
}

/// Sentinel error message used to flag the 401-authentication-required
/// branch through `BackendError::Validation`. Kept as a const so the call
/// site stays a string comparison rather than a typed error variant we'd
/// have to thread through every layer.
const AUTH_REQUIRED_MARKER: &str = "__SKILLS_SH_AUTH_REQUIRED__";

#[derive(Debug, Deserialize)]
struct ApiErrorBody {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

/// Hit a JSON endpoint on skills.sh and return the body as a raw
/// `serde_json::Value`. Most callers want a typed shape on top of this; the
/// curated endpoint is the exception because it nests skills under an owner
/// list and needs reshaping before it can fit the standard DTO.
async fn fetch_skills_json_raw<C: HttpClient + ?Sized>(
    client: &C,
    pathname: &str,
    params: &BTreeMap<&str, String>,
) -> BackendResult<serde_json::Value> {
    let url = build_url(pathname, params);
    let auth_header;
    let mut headers: Vec<(&str, &str)> =
        vec![("accept", "application/json"), ("user-agent", USER_AGENT)];
    if let Ok(key) = std::env::var("SKILLS_SH_API_KEY") {
        if !key.is_empty() {
            auth_header = format!("Bearer {}", key);
            headers.push(("authorization", Box::leak(auth_header.into_boxed_str())));
        }
    }

    let resp = client.get(&url, &headers).await?;
    if resp.is_ok() {
        return serde_json::from_str(&resp.body).map_err(|e| {
            BackendError::Validation(format!("skills.sh JSON parse failed: {e}"))
        });
    }

    // Try to read the structured error envelope. If body isn't JSON, fall
    // back to a status-coded message.
    let err: ApiErrorBody = serde_json::from_str(&resp.body).unwrap_or(ApiErrorBody {
        error: None,
        message: None,
    });
    if err.error.as_deref() == Some("authentication_required") {
        return Err(BackendError::Validation(AUTH_REQUIRED_MARKER.to_string()));
    }
    let msg = err
        .message
        .or(err.error)
        .unwrap_or_else(|| format!("skills.sh request failed ({})", resp.status));
    Err(BackendError::Validation(msg))
}

/// Same as `fetch_skills_json_raw`, but deserialize into the typed
/// `MarketplaceSkillsResponse`. Use this for endpoints whose response
/// already matches that shape (live `/skills` and `/skills/search`).
async fn fetch_skills_json_typed<C: HttpClient + ?Sized>(
    client: &C,
    pathname: &str,
    params: &BTreeMap<&str, String>,
) -> BackendResult<MarketplaceSkillsResponse> {
    let raw = fetch_skills_json_raw(client, pathname, params).await?;
    serde_json::from_value(raw)
        .map_err(|e| BackendError::Validation(format!("skills.sh JSON shape mismatch: {e}")))
}

fn build_url(pathname: &str, params: &BTreeMap<&str, String>) -> String {
    let mut url = format!("{}{}", BASE_URL, pathname);
    let mut first = true;
    for (k, v) in params {
        if v.is_empty() {
            continue;
        }
        url.push(if first { '?' } else { '&' });
        first = false;
        // skills.sh params are simple identifiers/numbers/short queries —
        // do a minimal percent-encode for spaces and the handful of chars
        // that actually break URL parsing.
        url.push_str(k);
        url.push('=');
        url.push_str(&percent_encode(v));
    }
    url
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

/// `/api/v1/skills/curated` returns a list of owners with nested skills.
/// `fetchMarketplaceSkills` flattens that into the standard `data` shape so
/// the frontend doesn't need to know about the wrapping.
fn reshape_curated(raw: serde_json::Value) -> MarketplaceSkillsResponse {
    let owners = raw
        .get("data")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut data: Vec<MarketplaceSkill> = Vec::new();
    for owner_val in owners.iter() {
        let owner_obj = owner_val.get("owner").cloned();
        if let Some(skills) = owner_val.get("skills").and_then(|v| v.as_array()) {
            for skill in skills {
                let mut merged = skill.clone();
                if let Some(obj) = merged.as_object_mut() {
                    if let Some(owner) = owner_obj.clone() {
                        obj.insert("owner".to_string(), owner);
                    }
                }
                if let Ok(parsed) = serde_json::from_value::<MarketplaceSkill>(merged) {
                    data.push(parsed);
                }
            }
        }
    }

    let total_owners = raw
        .get("totalOwners")
        .and_then(|v| v.as_u64())
        .map(|n| n as u32)
        .unwrap_or(owners.len() as u32);
    let total_skills = raw
        .get("totalSkills")
        .and_then(|v| v.as_u64())
        .map(|n| n as u32)
        .unwrap_or(0);
    let generated_at = raw
        .get("generatedAt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    MarketplaceSkillsResponse {
        data,
        curated: Some(true),
        total_owners: Some(total_owners),
        total_skills: Some(total_skills),
        generated_at: Some(generated_at),
        ..MarketplaceSkillsResponse::default()
    }
}

/// HTML scrape fallback used when the JSON API returns 401.
async fn scrape_marketplace_skills<C: HttpClient + ?Sized>(
    client: &C,
    query: &str,
    view: &str,
    page: &str,
    per_page: &str,
) -> BackendResult<MarketplaceSkillsResponse> {
    let current_page: u32 = page.parse().unwrap_or(0);
    let limit: u32 = per_page.parse().ok().filter(|n| *n >= 1).unwrap_or(24).min(100);
    let page_path = match view {
        "hot" => "/hot",
        "official" => "/official",
        _ => "/trending",
    };
    let html = fetch_skills_page(client, page_path).await?;
    let all = extract_skill_links(&html);
    let normalized_query = query.to_lowercase();
    let filtered: Vec<MarketplaceSkill> = if normalized_query.len() >= 2 {
        all.into_iter()
            .filter(|skill| {
                let hay = format!(
                    "{} {} {}",
                    skill.id,
                    skill.name.as_deref().unwrap_or(""),
                    skill.source.as_deref().unwrap_or("")
                )
                .to_lowercase();
                hay.contains(&normalized_query)
            })
            .collect()
    } else {
        all
    };

    let start = (current_page * limit) as usize;
    let total = filtered.len() as u32;
    let data: Vec<MarketplaceSkill> = filtered
        .iter()
        .skip(start)
        .take(limit as usize)
        .cloned()
        .collect();
    let has_more = (start + limit as usize) < filtered.len();

    Ok(MarketplaceSkillsResponse {
        data,
        scraped: Some(true),
        query: Some(query.to_string()),
        count: Some(total),
        pagination: Some(MarketplacePagination {
            page: current_page,
            per_page: limit,
            total,
            has_more,
        }),
        ..MarketplaceSkillsResponse::default()
    })
}

async fn fetch_skills_page<C: HttpClient + ?Sized>(
    client: &C,
    page_path: &str,
) -> BackendResult<String> {
    let url = format!("{}{}", BASE_URL, page_path);
    let resp = client
        .get(
            &url,
            &[("accept", "text/html"), ("user-agent", USER_AGENT)],
        )
        .await?;
    if !resp.is_ok() {
        return Err(BackendError::Validation(format!(
            "skills.sh page fetch failed ({})",
            resp.status
        )));
    }
    Ok(resp.body)
}

static LINK_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"href="/([^"?#]+/[^"?#]+/[^"?#]+)""#).expect("valid link regex")
});

/// Pulls `<a href="/{owner}/{repo}/{slug}">` triples out of a skills.sh
/// listing page. Mirrors the JS `extractSkillLinks` regex exactly.
pub fn extract_skill_links(html: &str) -> Vec<MarketplaceSkill> {
    let mut skills = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for cap in LINK_PATTERN.captures_iter(html) {
        let raw = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let decoded = decode_html(raw);
        let trimmed = decoded.trim_matches('/').to_string();
        let parts: Vec<&str> = trimmed.split('/').collect();
        if parts.len() != 3 || is_non_skill_path(&parts) {
            continue;
        }
        let owner = parts[0];
        let repo = parts[1];
        let slug = parts[2];
        let key = format!("{}/{}/{}", owner, repo, slug);
        if !seen.insert(key.clone()) {
            continue;
        }
        skills.push(MarketplaceSkill {
            id: key.clone(),
            slug: Some(slug.to_string()),
            name: Some(humanize_skill_slug(slug)),
            source: Some(format!("{}/{}", owner, repo)),
            source_type: Some("github".to_string()),
            install_url: Some(format!("https://github.com/{}/{}", owner, repo)),
            url: Some(format!("https://skills.sh/{}", key)),
            owner: None,
            scraped: Some(true),
            extra: serde_json::Map::new(),
        });
    }
    skills
}

/// Filters out skills.sh URLs that match the listing-page chrome but aren't
/// actually skills (Next.js asset paths, agent index, etc.). Mirrors
/// `isNonSkillPath` in `src/server.js`.
pub fn is_non_skill_path(parts: &[&str]) -> bool {
    let first = parts.first().copied().unwrap_or("");
    let second = parts.get(1).copied().unwrap_or("");
    let third = parts.get(2).copied().unwrap_or("");
    first.starts_with("_next")
        || first == "agents"
        || first == "api"
        || first == "topic"
        || first == "agent"
        || third == "security"
        || second == "security"
}

fn humanize_skill_slug(slug: &str) -> String {
    let dashed = slug.replace(['-', '_'], " ");
    let mut out = String::with_capacity(dashed.len());
    let mut at_boundary = true;
    for ch in dashed.chars() {
        if at_boundary && ch.is_alphabetic() {
            for up in ch.to_uppercase() {
                out.push(up);
            }
        } else {
            out.push(ch);
        }
        at_boundary = ch.is_whitespace();
    }
    out
}

/// Decode the handful of HTML entities the JS implementation cared about.
/// Intentionally narrow — skills.sh listing pages don't emit a wider set,
/// and matching the JS behavior exactly avoids surprise differences.
pub fn decode_html(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&#x27;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Records what URL a given call was made against and serves a canned
    /// response. One entry in `responses` per expected GET.
    struct MockClient {
        responses: Mutex<Vec<HttpResponse>>,
        calls: Mutex<Vec<String>>,
    }

    impl MockClient {
        fn new(responses: Vec<HttpResponse>) -> Self {
            Self {
                responses: Mutex::new(responses),
                calls: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl HttpClient for MockClient {
        async fn get(
            &self,
            url: &str,
            _headers: &[(&str, &str)],
        ) -> BackendResult<HttpResponse> {
            self.calls.lock().unwrap().push(url.to_string());
            let mut responses = self.responses.lock().unwrap();
            if responses.is_empty() {
                return Err(BackendError::Validation(format!(
                    "unexpected extra call: {}",
                    url
                )));
            }
            Ok(responses.remove(0))
        }
    }

    fn ok_json(body: &str) -> HttpResponse {
        HttpResponse {
            status: 200,
            body: body.to_string(),
        }
    }

    #[tokio::test]
    async fn fetch_marketplace_skills_jsonpath_for_view() {
        // Trending → /api/v1/skills?view=trending&page=0&per_page=24
        let client = MockClient::new(vec![ok_json(r#"{"data":[]}"#)]);
        fetch_marketplace_skills_with(
            &client,
            None,
            Some("trending".to_string()),
            None,
            None,
        )
        .await
        .unwrap();
        let calls = client.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].starts_with("https://skills.sh/api/v1/skills?"));
        assert!(calls[0].contains("view=trending"));
        assert!(calls[0].contains("page=0"));
        assert!(calls[0].contains("per_page=24"));

        // Hot → view=hot
        let client = MockClient::new(vec![ok_json(r#"{"data":[]}"#)]);
        fetch_marketplace_skills_with(&client, None, Some("hot".to_string()), None, None)
            .await
            .unwrap();
        assert!(client.calls.lock().unwrap()[0].contains("view=hot"));

        // All-time → view=all-time
        let client = MockClient::new(vec![ok_json(r#"{"data":[]}"#)]);
        fetch_marketplace_skills_with(
            &client,
            None,
            Some("all-time".to_string()),
            Some("2".to_string()),
            Some("48".to_string()),
        )
        .await
        .unwrap();
        let url = &client.calls.lock().unwrap()[0];
        assert!(url.contains("view=all-time"));
        assert!(url.contains("page=2"));
        assert!(url.contains("per_page=48"));

        // Official → /api/v1/skills/curated, no params
        let client = MockClient::new(vec![ok_json(
            r#"{"data":[{"owner":{"login":"acme"},"skills":[{"id":"acme/skill-one"}]}],"totalOwners":1,"totalSkills":1,"generatedAt":"2026-05-19T00:00:00Z"}"#,
        )]);
        let resp = fetch_marketplace_skills_with(
            &client,
            None,
            Some("official".to_string()),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            client.calls.lock().unwrap()[0],
            "https://skills.sh/api/v1/skills/curated"
        );
        assert_eq!(resp.curated, Some(true));
        assert_eq!(resp.total_owners, Some(1));
        assert_eq!(resp.total_skills, Some(1));
        assert_eq!(resp.data.len(), 1);
        assert_eq!(resp.data[0].id, "acme/skill-one");

        // Search (query >= 2 chars) → /api/v1/skills/search?q=…&limit=…
        let client = MockClient::new(vec![ok_json(r#"{"data":[]}"#)]);
        fetch_marketplace_skills_with(
            &client,
            Some("ts".to_string()),
            Some("trending".to_string()),
            None,
            Some("10".to_string()),
        )
        .await
        .unwrap();
        let url = &client.calls.lock().unwrap()[0];
        assert!(url.starts_with("https://skills.sh/api/v1/skills/search?"));
        assert!(url.contains("q=ts"));
        assert!(url.contains("limit=10"));
    }

    #[tokio::test]
    async fn fetch_marketplace_skills_falls_back_to_scrape_on_401() {
        let body_401 = r#"{"error":"authentication_required"}"#;
        let html = r#"
            <html><body>
              <a href="/acme/repo/skill-one">one</a>
              <a href="/_next/static/foo.js">noise</a>
              <a href="/acme/repo/skill-two">two</a>
            </body></html>
        "#;
        let client = MockClient::new(vec![
            HttpResponse {
                status: 401,
                body: body_401.to_string(),
            },
            HttpResponse {
                status: 200,
                body: html.to_string(),
            },
        ]);
        let resp = fetch_marketplace_skills_with(
            &client,
            None,
            Some("trending".to_string()),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(resp.scraped, Some(true));
        assert_eq!(resp.data.len(), 2);
        assert_eq!(resp.data[0].id, "acme/repo/skill-one");
        assert_eq!(resp.data[1].id, "acme/repo/skill-two");
        let calls = client.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 2);
        assert!(calls[1].ends_with("/trending"));
    }

    #[test]
    fn scrape_extracts_skill_links_from_html() {
        let html = r#"
            <a href="/anthropic/skills/web-search">x</a>
            <a href="/anthropic/skills/web-search">dup</a>
            <a href="/_next/static/chunk.js">no</a>
            <a href="/agents/index">no</a>
            <a href="/owner/repo/security">no</a>
            <a href="/owner/security/foo">no</a>
            <a href="/me/skills/markdown-magic">y</a>
        "#;
        let skills = extract_skill_links(html);
        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].id, "anthropic/skills/web-search");
        assert_eq!(skills[0].name.as_deref(), Some("Web Search"));
        assert_eq!(skills[0].source.as_deref(), Some("anthropic/skills"));
        assert_eq!(
            skills[0].install_url.as_deref(),
            Some("https://github.com/anthropic/skills")
        );
        assert_eq!(skills[1].id, "me/skills/markdown-magic");
        assert_eq!(skills[1].name.as_deref(), Some("Markdown Magic"));
    }

    #[test]
    fn decode_html_handles_common_entities() {
        assert_eq!(decode_html("a&amp;b"), "a&b");
        assert_eq!(decode_html("it&#x27;s"), "it's");
        assert_eq!(decode_html("&quot;hi&quot;"), "\"hi\"");
        assert_eq!(decode_html("&lt;tag&gt;"), "<tag>");
        // Anything we don't know about should pass through unchanged.
        assert_eq!(decode_html("&nbsp;"), "&nbsp;");
    }

    #[test]
    fn is_non_skill_path_matches_js() {
        assert!(is_non_skill_path(&["_next", "x", "y"]));
        assert!(is_non_skill_path(&["agents", "x", "y"]));
        assert!(is_non_skill_path(&["api", "x", "y"]));
        assert!(is_non_skill_path(&["topic", "x", "y"]));
        assert!(is_non_skill_path(&["agent", "x", "y"]));
        assert!(is_non_skill_path(&["o", "x", "security"]));
        assert!(is_non_skill_path(&["o", "security", "y"]));
        assert!(!is_non_skill_path(&["o", "r", "s"]));
    }

    #[tokio::test]
    #[ignore = "hits real skills.sh; run with `cargo test -- --ignored`"]
    async fn live_trending_smoke() {
        let client = ReqwestHttpClient::new().unwrap();
        let resp = fetch_marketplace_skills_with(
            &client,
            None,
            Some("trending".to_string()),
            None,
            None,
        )
        .await
        .unwrap();
        assert!(!resp.data.is_empty());
    }
}
