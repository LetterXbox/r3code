//! JSON with comments and trailing commas, as accepted by configuration files.
pub fn parse<T: serde::de::DeserializeOwned>(input: &[u8]) -> Result<T, serde_json::Error> {
    let mut cleaned = Vec::with_capacity(input.len());
    let mut i = 0;
    let mut string = false;
    let mut escaped = false;
    while i < input.len() {
        let c = input[i];
        if string {
            cleaned.push(c);
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                string = false;
            }
            i += 1;
        } else if c == b'"' {
            string = true;
            cleaned.push(c);
            i += 1;
        } else if c == b'/' && input.get(i + 1) == Some(&b'/') {
            cleaned.push(b' ');
            i += 2;
            while i < input.len() && input[i] != b'\n' && input[i] != b'\r' {
                i += 1;
            }
        } else if c == b'/' && input.get(i + 1) == Some(&b'*') {
            let start = i;
            i += 2;
            while i + 1 < input.len() && !(input[i] == b'*' && input[i + 1] == b'/') {
                i += 1;
            }
            if i + 1 >= input.len() {
                cleaned.extend_from_slice(&input[start..]);
                break;
            }
            i += 2;
            cleaned.push(b' ');
        } else {
            cleaned.push(c);
            i += 1;
        }
    }
    let mut output = Vec::with_capacity(cleaned.len());
    let mut string = false;
    let mut escaped = false;
    for (i, &c) in cleaned.iter().enumerate() {
        if string {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                string = false;
            }
        } else if c == b'"' {
            string = true;
        }
        if !string
            && c == b','
            && cleaned[i + 1..]
                .iter()
                .copied()
                .find(|b| !b.is_ascii_whitespace())
                .is_some_and(|b| b == b'}' || b == b']')
        {
            continue;
        }
        output.push(c);
    }
    serde_json::from_slice(&output)
}

#[cfg(test)]
mod tests {
    #[test]
    fn comments_and_trailing_commas_preserve_strings() {
        let value: serde_json::Value = super::parse(
            br#"{/*comment*/"url":"https://example/x,]", "quote":"\\\"//", // comment
        "items":[1,2,],}"#,
        )
        .unwrap();
        assert_eq!(value["url"], "https://example/x,]");
        assert_eq!(value["items"], serde_json::json!([1, 2]));
        assert!(super::parse::<serde_json::Value>(b"[1, /* unfinished").is_err());
    }
}
