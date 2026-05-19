//! YAML frontmatter parsing for `SKILL.md` files.
//!
//! Ports `parseFrontmatter` from `src/core.js`. The JS implementation uses a
//! bespoke line-based key/value parser; here we recognize the same `---`
//! delimited block but feed the contents to `serde_yaml` so structured
//! values (lists, nested maps) round-trip correctly.
//!
//! Differences from `core.js`:
//! - The JS version returns just the parsed object and discards the body;
//!   here we return both the parsed data and the post-frontmatter body so
//!   callers can rewrite skill files in later phases without re-reading.
//! - The JS line parser collapses leading-whitespace continuations into the
//!   previous key's value (with a single-space separator). `serde_yaml`
//!   handles this idiomatically via YAML's folded/literal scalars.

use once_cell::sync::Lazy;
use regex::Regex;

/// Result of parsing a `SKILL.md` blob.
#[derive(Debug, Clone, Default)]
pub struct ParsedFrontmatter {
    /// Parsed YAML frontmatter. `Null` when no frontmatter block was found
    /// or when the block was empty.
    pub data: serde_yaml::Value,
    /// File body (everything after the closing `---` line). When there is
    /// no frontmatter, this is the entire input text.
    pub body: String,
}

static FRONTMATTER_RE: Lazy<Regex> = Lazy::new(|| {
    // Matches an opening `---\n`, captures the YAML block lazily up to a
    // closing `---` on its own line, then captures everything after.
    // Equivalent to core.js's `/^---\r?\n([\s\S]*?)\r?\n---/`, extended to
    // also capture the trailing body so callers don't have to slice again.
    Regex::new(r"(?s)\A---\r?\n(.*?)\r?\n---[ \t]*\r?\n?(.*)\z").unwrap()
});

/// Parse a `SKILL.md`-style blob.
///
/// When there is no leading `---` block (or it never closes), the entire
/// input is returned as `body` and `data` is `Null` — matching how
/// `core.js`'s `parseFrontmatter` returns `{}` for absent frontmatter.
pub fn parse(text: &str) -> ParsedFrontmatter {
    if let Some(caps) = FRONTMATTER_RE.captures(text) {
        let yaml_block = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let body = caps.get(2).map(|m| m.as_str()).unwrap_or("").to_string();

        let data = if yaml_block.trim().is_empty() {
            serde_yaml::Value::Null
        } else {
            serde_yaml::from_str::<serde_yaml::Value>(yaml_block)
                .unwrap_or(serde_yaml::Value::Null)
        };

        ParsedFrontmatter { data, body }
    } else {
        ParsedFrontmatter {
            data: serde_yaml::Value::Null,
            body: text.to_string(),
        }
    }
}

/// Look up a string field from a YAML mapping, applying the same quote-
/// stripping rules as `core.js::stripQuotes`. `serde_yaml` already unwraps
/// surrounding quotes on scalars, so this is mainly a convenience for the
/// non-YAML fallback path; callers should prefer this over direct `Value`
/// indexing.
pub fn string_field(data: &serde_yaml::Value, key: &str) -> Option<String> {
    let value = data.get(key)?;
    match value {
        serde_yaml::Value::String(s) => Some(strip_quotes(s)),
        serde_yaml::Value::Number(n) => Some(n.to_string()),
        serde_yaml::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn strip_quotes(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_frontmatter_with_valid_yaml() {
        let text = "---\nname: Swift Tools\ndescription: Use for Swift apps\n---\n\n# Body\n";
        let parsed = parse(text);
        assert_eq!(
            string_field(&parsed.data, "name").as_deref(),
            Some("Swift Tools")
        );
        assert_eq!(
            string_field(&parsed.data, "description").as_deref(),
            Some("Use for Swift apps")
        );
        assert!(parsed.body.contains("# Body"));
    }

    #[test]
    fn parse_frontmatter_no_delimiters_returns_body_only() {
        let text = "# Just a heading\nNo frontmatter here.\n";
        let parsed = parse(text);
        assert!(parsed.data.is_null());
        assert_eq!(parsed.body, text);
    }

    #[test]
    fn parse_frontmatter_unclosed_block() {
        // Opening `---` with no closing fence: the whole text is the body
        // (matches `core.js` which returns `{}` and effectively ignores it).
        let text = "---\nname: Broken\ndescription: never closed\n";
        let parsed = parse(text);
        assert!(parsed.data.is_null());
        assert_eq!(parsed.body, text);
    }

    #[test]
    fn parse_frontmatter_empty_block() {
        // `core.js`'s regex requires at least one line between the fences
        // (`---\n([\s\S]*?)\n---`), so `---\n---\n` does not match and the
        // entire input falls through as the body. We mirror that exactly.
        let text = "---\n---\nBody only.\n";
        let parsed = parse(text);
        assert!(parsed.data.is_null());
        assert_eq!(parsed.body, text);
    }

    #[test]
    fn parse_frontmatter_blank_line_block() {
        // A blank-content frontmatter block (one empty line between fences)
        // does match, and serde_yaml parses the empty document to Null.
        let text = "---\n\n---\nBody only.\n";
        let parsed = parse(text);
        assert!(parsed.data.is_null());
        assert_eq!(parsed.body, "Body only.\n");
    }

    #[test]
    fn parse_frontmatter_quoted_values() {
        let text = "---\nname: \"Quoted Name\"\nauthor: 'Single Quoted'\n---\nbody\n";
        let parsed = parse(text);
        assert_eq!(
            string_field(&parsed.data, "name").as_deref(),
            Some("Quoted Name")
        );
        assert_eq!(
            string_field(&parsed.data, "author").as_deref(),
            Some("Single Quoted")
        );
    }
}
