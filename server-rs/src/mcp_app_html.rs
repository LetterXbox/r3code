//! Inject the sandbox bridge needed by captured MCP app documents.
use regex::Regex;
use std::sync::OnceLock;

const THEME: &str = r#"<script>
(() => {
  try {
    const initial = new URLSearchParams(location.search).get("t3-color-scheme");
    if (initial === "light" || initial === "dark") {
      const meta = document.createElement("meta");
      meta.name = "color-scheme";
      meta.content = initial;
      document.head.append(meta);
    }
  } catch {}
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    const theme = message.method === "ui/notifications/host-context-changed"
      ? message.params?.theme
      : message.id !== undefined && message.method === undefined
        ? message.result?.hostContext?.theme
        : undefined;
    if (theme === "light" || theme === "dark") {
      document.documentElement.style.colorScheme = theme;
    }
  });
})();
</script>"#;
const COOKIE: &str = r#"<script>(function(){try{void document.cookie;}catch(error){if(error&&error.name==="SecurityError"){Object.defineProperty(document,"cookie",{configurable:true,get:function(){return "";},set:function(){}});}}})();</script>"#;

pub fn inject(html: &str) -> String {
    static THEME_PREFIX: OnceLock<Regex> = OnceLock::new();
    static COOKIE_PREFIX: OnceLock<Regex> = OnceLock::new();
    let theme = THEME_PREFIX.get_or_init(|| Regex::new(r#"(?i)^\x{feff}?\s*<!doctype[^>]*>\s*(?:<meta\s+http-equiv="Content-Security-Policy"[^>]*>)?"#).unwrap());
    let with_theme = match theme.find(html) {
        Some(m) => format!("{}{THEME}{}", &html[..m.end()], &html[m.end()..]),
        None => format!("<!doctype html>{THEME}{html}"),
    };
    let cookie = COOKIE_PREFIX.get_or_init(|| Regex::new(r#"(?i)^(?:\x{feff}?\s*<!doctype[^>]*>\s*)?(?:<meta http-equiv="Content-Security-Policy" content="[^"]*">)?"#).unwrap());
    let end = cookie.find(&with_theme).map_or(0, |m| m.end());
    format!("{}{COOKIE}{}", &with_theme[..end], &with_theme[end..])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_meta_policy_before_bootstraps_and_rejects_untrusted_parent() {
        let input = "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'\"><body>app</body>";
        let output = inject(input);
        assert!(output.starts_with("<!doctype html><meta http-equiv=\"Content-Security-Policy\""));
        let csp = output.find("default-src").unwrap();
        let cookie = output.find("document.cookie").unwrap();
        let theme = output.find("host-context-changed").unwrap();
        assert!(csp < cookie && cookie < theme);
        assert!(output.contains("event.source !== window.parent"));
        assert!(inject("<html>app</html>").starts_with("<!doctype html>"));
    }
}
