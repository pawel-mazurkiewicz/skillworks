//! Fence scanning and JSONC tolerance (Phase B Task 2).

pub(super) struct Fence {
    pub(super) info: String,
    pub(super) start_line: usize,
    pub(super) body: String,
}

pub(super) fn scan_fences(markdown: &str) -> Vec<Fence> {
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

pub(super) fn strip_jsonc(text: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
