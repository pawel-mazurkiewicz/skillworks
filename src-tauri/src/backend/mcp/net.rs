//! SSRF-safe fetch + bounded body read for URL-based MCP server ingestion.
//!
//! Spec: docs/superpowers/specs/2026-07-21-mcp-management-phase-d-design.md §5.2
//! "Ingestion hardening".
//!
//! No reliance on reqwest's built-in redirect policy: `fetch_markdown_guarded`
//! drives a manual hop loop so every hop's resolved addresses can be
//! validated *before* the connection is made, and the connection is then
//! pinned to exactly those validated addresses (closing the classic
//! DNS-rebinding / TOCTOU gap between "we checked the IP" and "we connected
//! to the IP").

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use reqwest::redirect::Policy;

use super::super::marketplace::USER_AGENT;
use super::super::state::{BackendError, BackendResult};

/// Maximum number of redirect hops to follow after the initial request.
const MAX_REDIRECTS: u8 = 3;
/// Maximum response body size, in bytes (1 MiB).
///
/// This is the single source of truth for the ingestion body-size cap;
/// `commands.rs` reuses it for the `get_capped`-based fetch path rather than
/// defining its own copy.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(30);

/// True if `ip` is a "global" (public, routable) address — i.e. safe to let
/// an ingestion fetch connect to. Deliberately manual (no unstable
/// `IpAddr::is_global()`): every excluded range is documented below.
pub fn addr_is_global(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => ipv4_is_global(v4),
        IpAddr::V6(v6) => {
            // IPv4-mapped IPv6 (::ffff:a.b.c.d) carries the same routability
            // as the wrapped v4 address — recurse into it rather than
            // treating it as an opaque v6 address.
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return ipv4_is_global(mapped);
            }
            ipv6_is_global(v6)
        }
    }
}

fn ipv4_is_global(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    if ip.is_unspecified() {
        return false; // 0.0.0.0
    }
    // "This host on this network", RFC 791 §3.2 / RFC 1122 §3.2.1.3: the
    // whole 0.0.0.0/8, not just the single 0.0.0.0 address covered by
    // is_unspecified() above.
    if octets[0] == 0 {
        return false;
    }
    if ip.is_loopback() {
        return false; // 127.0.0.0/8
    }
    if ip.is_link_local() {
        return false; // 169.254.0.0/16
    }
    if ip.is_private() {
        return false; // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (RFC 1918)
    }
    if ip.is_multicast() {
        return false; // 224.0.0.0/4
    }
    if ip.is_broadcast() {
        return false; // 255.255.255.255
    }
    if ip.is_documentation() {
        return false; // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24
    }
    // CGNAT shared address space, RFC 6598: 100.64.0.0/10.
    if octets[0] == 100 && (octets[1] & 0b1100_0000) == 0b0100_0000 {
        return false;
    }
    // IETF Protocol Assignments, RFC 6890 §2.1: 192.0.0.0/24 (includes the
    // DS-Lite 192.0.0.0/29 sub-block).
    if octets[0] == 192 && octets[1] == 0 && octets[2] == 0 {
        return false;
    }
    // 6to4 Relay Anycast, RFC 3068 (still reserved in the IANA special-use
    // registry despite 6to4 itself being deprecated by RFC 7526):
    // 192.88.99.0/24.
    if octets[0] == 192 && octets[1] == 88 && octets[2] == 99 {
        return false;
    }
    // Benchmarking, RFC 2544: 198.18.0.0/15 (198.18.0.0 - 198.19.255.255).
    if octets[0] == 198 && (octets[1] == 18 || octets[1] == 19) {
        return false;
    }
    // Reserved / Class E, RFC 1112: 240.0.0.0/4. Subsumes 255.255.255.255
    // (the broadcast check above is kept anyway — harmless overlap).
    if (octets[0] & 0xf0) == 0xf0 {
        return false;
    }
    true
}

fn ipv6_is_global(ip: Ipv6Addr) -> bool {
    if ip.is_unspecified() {
        return false; // ::
    }
    if ip.is_loopback() {
        return false; // ::1
    }
    if ip.is_multicast() {
        return false; // ff00::/8 (covers ff02::/16 link-local-scope multicast etc.)
    }
    let seg0 = ip.segments()[0];
    // Link-local unicast, fe80::/10.
    if (seg0 & 0xffc0) == 0xfe80 {
        return false;
    }
    // Unique local address (ULA), fc00::/7.
    if (seg0 & 0xfe00) == 0xfc00 {
        return false;
    }
    let segs = ip.segments();
    // IPv6 documentation range, RFC 3849: 2001:db8::/32.
    if segs[0] == 0x2001 && segs[1] == 0x0db8 {
        return false;
    }
    // 6to4 relay range, RFC 3056: 2002::/16.
    if segs[0] == 0x2002 {
        return false;
    }
    // Teredo tunneling, RFC 4380: 2001::/32.
    if segs[0] == 0x2001 && segs[1] == 0x0000 {
        return false;
    }
    // NAT64 well-known prefix, RFC 6052: 64:ff9b::/96.
    if segs[0..6] == [0x0064, 0xff9b, 0, 0, 0, 0] {
        return false;
    }
    // Discard-Only address block, RFC 6666: 100::/64.
    if segs[0..4] == [0x0100, 0, 0, 0] {
        return false;
    }
    // Benchmarking, RFC 5180 §8: 2001:2::/48.
    if segs[0] == 0x2001 && segs[1] == 0x0002 && segs[2] == 0 {
        return false;
    }
    true
}

/// Resolve `host:port` and reject unless *every* resolved address is global.
/// Resolving all addresses (rather than just the first) and validating all
/// of them closes the "DNS returns one safe + one unsafe address" gap.
pub async fn validated_addrs(host: &str, port: u16) -> BackendResult<Vec<SocketAddr>> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| BackendError::Validation(format!("DNS lookup failed for {host}: {e}")))?
        .collect();
    if addrs.is_empty() {
        return Err(BackendError::Validation(format!(
            "DNS lookup for {host} returned no addresses"
        )));
    }
    for addr in &addrs {
        if !addr_is_global(addr.ip()) {
            return Err(BackendError::Validation(format!(
                "Refusing to fetch {host}: resolves to a non-public address ({})",
                addr.ip()
            )));
        }
    }
    Ok(addrs)
}

/// Outcome of following one hop chain (initial request + up to
/// `MAX_REDIRECTS` redirects) to completion.
enum HopOutcome {
    /// A 2xx response was read in full, within the size cap.
    Fetched { url: String, body: String },
    /// The chain terminated on a non-2xx, non-redirect status.
    NonSuccess { url: String, status: u16 },
}

/// Resolve a redirect `Location` header against the URL that produced it.
/// Handles both absolute and relative locations (relative resolution is the
/// common case for same-host redirects, e.g. GitHub's `HEAD` -> branch-SHA
/// redirects). No network access; pure URL-joining logic pulled out of
/// `fetch_hops` so it's independently unit-testable.
fn resolve_redirect(current: &reqwest::Url, location: &str) -> BackendResult<reqwest::Url> {
    current
        .join(location)
        .map_err(|e| BackendError::Validation(format!("Invalid redirect location {location}: {e}")))
}

/// Accumulate `chunk` into `buf`, rejecting once the total exceeds `max`.
/// Pulled out of `fetch_hops`'s body-read loop so the cap logic is
/// independently unit-testable without a socket.
fn push_capped(buf: &mut Vec<u8>, chunk: &[u8], max: usize) -> BackendResult<()> {
    buf.extend_from_slice(chunk);
    if buf.len() > max {
        return Err(BackendError::Validation(format!(
            "Fetched document is too large (limit {max})"
        )));
    }
    Ok(())
}

/// Follow redirects for a single starting URL under SSRF/size/time guards,
/// returning either the fetched body or the terminal non-2xx status (both
/// treated as "soft" outcomes the caller may retry against an alternate
/// URL). Anything else (bad scheme, DNS/SSRF rejection, redirect overflow,
/// transport error, oversize body) is a hard `Err` — not retried.
async fn fetch_hops(start_url: &str) -> BackendResult<HopOutcome> {
    let mut current = start_url.to_string();
    let mut redirects_used = 0u8;

    loop {
        if !current.starts_with("https://") {
            return Err(BackendError::Validation(format!(
                "Only https URLs are supported: {current}"
            )));
        }
        let parsed = reqwest::Url::parse(&current)
            .map_err(|e| BackendError::Validation(format!("Invalid URL {current}: {e}")))?;
        let host = parsed.host_str().ok_or_else(|| {
            BackendError::Validation(format!("URL has no host: {current}"))
        })?;
        let port = parsed.port_or_known_default().unwrap_or(443);
        let addrs = validated_addrs(host, port).await?;

        let client = reqwest::ClientBuilder::new()
            .user_agent(USER_AGENT)
            .redirect(Policy::none())
            .resolve_to_addrs(host, &addrs)
            .no_proxy()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TOTAL_TIMEOUT)
            .build()
            .map_err(|e| BackendError::Validation(format!("http client init failed: {e}")))?;

        let mut resp = client
            .get(parsed.clone())
            .header("Accept", "text/plain, text/markdown")
            .send()
            .await
            .map_err(|e| BackendError::Validation(format!("Fetch failed for {current}: {e}")))?;

        let status = resp.status();

        if status.is_redirection() {
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| {
                    BackendError::Validation(format!(
                        "Redirect from {current} had no Location header"
                    ))
                })?
                .to_string();
            if redirects_used >= MAX_REDIRECTS {
                return Err(BackendError::Validation(format!(
                    "Too many redirects starting at {start_url} (limit {MAX_REDIRECTS})"
                )));
            }
            let next = resolve_redirect(&parsed, &location)?;
            redirects_used += 1;
            current = next.to_string();
            continue;
        }

        if !status.is_success() {
            return Ok(HopOutcome::NonSuccess {
                url: current,
                status: status.as_u16(),
            });
        }

        if let Some(len) = resp.content_length() {
            if len > MAX_BODY_BYTES as u64 {
                return Err(BackendError::Validation(format!(
                    "Fetched document is too large ({len} bytes; limit {MAX_BODY_BYTES})"
                )));
            }
        }

        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| BackendError::Validation(format!("Body read failed for {current}: {e}")))?
        {
            push_capped(&mut buf, &chunk, MAX_BODY_BYTES)?;
        }
        let body = String::from_utf8(buf)
            .map_err(|e| BackendError::Validation(format!("Fetched document is not valid UTF-8: {e}")))?;
        return Ok(HopOutcome::Fetched { url: current, body });
    }
}

/// SSRF-safe, size- and time-bounded fetch of a markdown document, following
/// redirects manually (so every hop's resolved addresses can be validated
/// before connecting). If the first URL's hop chain terminates on a
/// non-2xx status and `retry_url` is given, retries once against it with a
/// fresh redirect budget — mirroring the plain-HTTP-client retry semantics
/// used for the mocked/test fetch path. Any hard failure (bad scheme, SSRF
/// rejection, timeout, transport error, oversize body, redirect overflow)
/// is returned immediately without retry.
pub async fn fetch_markdown_guarded(
    url: &str,
    retry_url: Option<&str>,
) -> BackendResult<(String, String)> {
    match fetch_hops(url).await? {
        HopOutcome::Fetched { url, body } => Ok((url, body)),
        HopOutcome::NonSuccess { url: url1, status: status1 } => match retry_url {
            None => Err(BackendError::Validation(format!(
                "Fetch failed for {url1} (status {status1})"
            ))),
            Some(alt) => match fetch_hops(alt).await? {
                HopOutcome::Fetched { url, body } => Ok((url, body)),
                HopOutcome::NonSuccess { url: url2, status: status2 } => {
                    Err(BackendError::Validation(format!(
                        "Fetch failed for {url1} (status {status1}) and {url2} (status {status2})"
                    )))
                }
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addr_is_global_rejects_non_public_ranges() {
        let non_global: &[&str] = &[
            "127.0.0.1",
            "0.0.0.0",
            // "This network", 0.0.0.0/8 — a non-loopback, non-unspecified
            // member of the range.
            "0.1.2.3",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "100.64.0.1",
            "255.255.255.255",
            "192.0.2.1",
            // IETF Protocol Assignments, 192.0.0.0/24.
            "192.0.0.8",
            // 6to4 Relay Anycast, 192.88.99.0/24.
            "192.88.99.1",
            // Benchmarking, 198.18.0.0/15 (both octets of the /15).
            "198.18.0.1",
            "198.19.255.254",
            "::1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "::ffff:10.0.0.1",
            // IPv6 documentation range, 2001:db8::/32.
            "2001:db8::1",
            // 6to4, 2002::/16.
            "2002:c0a8:0101::1",
            // Teredo, 2001::/32.
            "2001:0:53aa::1",
            // NAT64 well-known prefix, 64:ff9b::/96.
            "64:ff9b::10.0.0.1",
            // Discard-Only address block, 100::/64.
            "100::1",
            // Benchmarking, 2001:2::/48.
            "2001:2::1",
            // Reserved / Class E, 240.0.0.0/4 (also subsumes broadcast,
            // asserted separately above via the dedicated broadcast check).
            "240.0.0.1",
        ];
        for ip in non_global {
            let parsed: IpAddr = ip.parse().unwrap();
            assert!(!addr_is_global(parsed), "expected {ip} to be non-global");
        }
    }

    #[test]
    fn addr_is_global_accepts_public_addresses() {
        // 2606:50c0:: must remain global: its first segment (0x2606) is not
        // caught by the 2001:db8::/32, 2002::/16, or 2001::/32 masks added
        // above.
        let global: &[&str] = &["140.82.112.3", "2606:50c0::1"];
        for ip in global {
            let parsed: IpAddr = ip.parse().unwrap();
            assert!(addr_is_global(parsed), "expected {ip} to be global");
        }
    }

    #[tokio::test]
    async fn validated_addrs_rejects_localhost() {
        let err = validated_addrs("localhost", 443).await.unwrap_err();
        assert!(format!("{err}").contains("localhost") || format!("{err}").contains("non-public"));
    }

    #[tokio::test]
    async fn fetch_markdown_guarded_rejects_non_https() {
        let err = fetch_markdown_guarded("http://example.com/x.md", None)
            .await
            .unwrap_err();
        assert!(format!("{err}").contains("https"));
    }

    #[test]
    fn resolve_redirect_handles_absolute_location() {
        let current: reqwest::Url = "https://raw.githubusercontent.com/a/b/HEAD/README.md"
            .parse()
            .unwrap();
        let next = resolve_redirect(&current, "https://example.com/other.md").unwrap();
        assert_eq!(next.as_str(), "https://example.com/other.md");
    }

    #[test]
    fn resolve_redirect_handles_relative_location() {
        let current: reqwest::Url = "https://raw.githubusercontent.com/a/b/HEAD/README.md"
            .parse()
            .unwrap();
        let next = resolve_redirect(&current, "/other/path").unwrap();
        assert_eq!(next.as_str(), "https://raw.githubusercontent.com/other/path");
    }

    #[test]
    fn resolve_redirect_rejects_garbage_location() {
        let current: reqwest::Url = "https://raw.githubusercontent.com/a/b/HEAD/README.md"
            .parse()
            .unwrap();
        assert!(resolve_redirect(&current, "https://[::1").is_err());
    }

    #[test]
    fn push_capped_allows_under_and_at_cap() {
        let mut buf = Vec::new();
        push_capped(&mut buf, &[1, 2, 3], 10).unwrap();
        assert_eq!(buf.len(), 3);

        let mut buf = Vec::new();
        push_capped(&mut buf, &[0u8; 10], 10).unwrap();
        assert_eq!(buf.len(), 10);
    }

    #[test]
    fn push_capped_rejects_over_cap() {
        let mut buf = Vec::new();
        assert!(push_capped(&mut buf, &[0u8; 11], 10).is_err());
    }
}
