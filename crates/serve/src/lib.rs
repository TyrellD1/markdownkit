use std::fs;
use std::path::{Path, PathBuf};

use markdownkit_engine::{self as engine, LinkMode};

const STYLES: &str = include_str!("../../../ui/styles.css");
const SERVE_JS: &str = include_str!("../../../ui/serve.js");
const MERMAID_JS: &str = include_str!("../../../ui/mermaid.js");
const MERMAID_MIN: &[u8] = include_bytes!("../../../ui/vendor/mermaid.min.js");

#[derive(Debug, Clone)]
pub struct Config {
    pub root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

impl Reply {
    fn text(status: u16, content_type: &'static str, body: impl Into<String>) -> Self {
        Self {
            status,
            content_type,
            body: body.into().into_bytes(),
        }
    }

    fn bytes(status: u16, content_type: &'static str, body: Vec<u8>) -> Self {
        Self {
            status,
            content_type,
            body,
        }
    }
}

pub fn handle(config: &Config, method: &str, url: &str) -> Reply {
    if !method.eq_ignore_ascii_case("GET") {
        return Reply::text(405, "text/plain; charset=utf-8", "Method not allowed\n");
    }

    let (path, query) = split_path_query(url);
    match path {
        "/styles.css" => Reply::text(200, "text/css; charset=utf-8", STYLES),
        "/serve.js" => Reply::text(200, "text/javascript; charset=utf-8", SERVE_JS),
        "/mermaid.js" => Reply::text(200, "text/javascript; charset=utf-8", MERMAID_JS),
        "/vendor/mermaid.min.js" => Reply::bytes(200, "text/javascript; charset=utf-8", MERMAID_MIN.to_vec()),
        "/settings" => settings_page(),
        "/" | "/index.html" => {
            if let Some(requested) = query_param(query, "path") {
                serve_markdown(config, &requested)
            } else {
                help_page()
            }
        }
        "/asset" => {
            if let Some(requested) = query_param(query, "path") {
                serve_asset(config, &requested)
            } else {
                Reply::text(400, "text/plain; charset=utf-8", "Missing path\n")
            }
        }
        _ => Reply::text(404, "text/plain; charset=utf-8", "Not found\n"),
    }
}

pub fn resolve_under_root(root: &Path, requested: &str) -> Result<PathBuf, u16> {
    if requested.trim().is_empty() {
        return Err(400);
    }
    let raw = PathBuf::from(requested);
    let candidate = if raw.is_absolute() {
        raw
    } else {
        root.join(raw)
    };
    let canonical = candidate.canonicalize().map_err(|_| 404_u16)?;
    if !canonical.starts_with(root) {
        return Err(403);
    }
    Ok(canonical)
}

fn serve_markdown(config: &Config, requested: &str) -> Reply {
    let path = match resolve_under_root(&config.root, requested) {
        Ok(path) => path,
        Err(status) => return status_page(status),
    };
    if !path.is_file() {
        return status_page(404);
    }
    if !engine::is_markdown_path(&path) {
        return status_page(404);
    }
    let source = match fs::read_to_string(&path) {
        Ok(source) => source,
        Err(_) => return status_page(404),
    };
    let doc = engine::render_with(&source, &path, LinkMode::Http);
    let body = document_page(&doc);
    Reply::text(200, "text/html; charset=utf-8", body)
}

fn serve_asset(config: &Config, requested: &str) -> Reply {
    let path = match resolve_under_root(&config.root, requested) {
        Ok(path) => path,
        Err(status) => return Reply::text(status, "text/plain; charset=utf-8", "Unavailable\n"),
    };
    if !path.is_file() || !engine::is_image_path(&path) {
        return Reply::text(404, "text/plain; charset=utf-8", "Not found\n");
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return Reply::text(404, "text/plain; charset=utf-8", "Not found\n"),
    };
    Reply::bytes(200, image_content_type(&path), bytes)
}

fn document_page(doc: &engine::RenderedDocument) -> String {
    let has_mermaid = doc.html.contains("language-mermaid");
    let mermaid = if has_mermaid {
        r#"<script src="/mermaid.js"></script>
    <script>
      document.addEventListener("DOMContentLoaded", () => {
        const root = document.querySelector(".content");
        renderMermaid(root);
        window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
          renderMermaid(root);
        });
      });
    </script>"#
    } else {
        ""
    };

    let mut props = String::new();
    if !doc.frontmatter.is_empty() {
        props.push_str("<dl class=\"props\">");
        for field in &doc.frontmatter {
            props.push_str("<dt>");
            props.push_str(&escape_html(&field.key));
            props.push_str("</dt><dd>");
            props.push_str(&escape_html(&field.value));
            props.push_str("</dd>");
        }
        props.push_str("</dl>");
    }

    shell(&escape_html(&doc.title), &props, &doc.html, mermaid, true)
}

fn help_page() -> Reply {
    let content = r#"<h1>markdownkit-serve</h1>
<p>Pass a markdown file path:</p>
<pre><code>/?path=/absolute/note.md</code></pre>
<p>Files must stay under the configured root (default: home). Images next to a note are served from <code>/asset?path=…</code>.</p>
<p>Appearance and front matter live in this browser at <a href="/settings">/settings</a>.</p>"#;
    Reply::text(
        200,
        "text/html; charset=utf-8",
        shell("markdownkit-serve", "", content, "", true),
    )
}

fn status_page(status: u16) -> Reply {
    let message = match status {
        400 => "Missing or empty path.",
        403 => "That path is outside the serve root.",
        404 => "File not found.",
        _ => "Unavailable.",
    };
    let content = format!("<h1>{status}</h1><p>{}</p>", escape_html(message));
    Reply::text(
        status,
        "text/html; charset=utf-8",
        shell("MarkdownKit", "", &content, "", true),
    )
}

fn settings_page() -> Reply {
    let content = r#"<div class="modal-card serve-card">
        <h2 id="settings-title">Settings</h2>
        <div class="setting">
          <p class="setting-label">Appearance</p>
          <div class="seg" role="radiogroup" aria-label="Appearance">
            <button type="button" data-theme="system">System</button>
            <button type="button" data-theme="light">Light</button>
            <button type="button" data-theme="dark">Dark</button>
          </div>
        </div>
        <label class="setting toggle">
          <input type="checkbox" id="show-frontmatter" />
          <span>Show front matter</span>
        </label>
        <button type="button" class="done" id="settings-done">Done</button>
      </div>"#;
    Reply::text(
        200,
        "text/html; charset=utf-8",
        shell("Settings", "", content, "", false),
    )
}

fn shell(title: &str, props: &str, content: &str, extra_head: &str, settings_link: bool) -> String {
    let link = if settings_link {
        r#"<a class="serve-settings" href="/settings">Settings</a>"#
    } else {
        ""
    };
    format!(
        r#"<!DOCTYPE html>
<html lang="en" class="serve" data-theme="system">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <script>
      try {{
        const theme = localStorage.getItem("markdownkit.theme") || "system";
        if (["system", "light", "dark"].includes(theme)) {{
          document.documentElement.dataset.theme = theme;
        }}
      }} catch {{
        /* ignore */
      }}
    </script>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <article class="page">
      {props}
      <div class="content">{content}</div>
    </article>
    {link}
    <script src="/serve.js"></script>
    {extra_head}
  </body>
</html>
"#
    )
}

fn split_path_query(url: &str) -> (&str, &str) {
    let url = url.split('#').next().unwrap_or(url);
    match url.split_once('?') {
        Some((path, query)) => (if path.is_empty() { "/" } else { path }, query),
        None => (if url.is_empty() { "/" } else { url }, ""),
    }
}

fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (name, value) = match pair.split_once('=') {
            Some(parts) => parts,
            None => continue,
        };
        if name == key {
            return Some(urlencoding::decode(value).ok()?.into_owned());
        }
    }
    None
}

fn image_content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("avif") => "image/avif",
        Some("bmp") => "image/bmp",
        _ => "application/octet-stream",
    }
}

fn escape_html(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mk-serve-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp root");
        dir.canonicalize().expect("canonical temp root")
    }

    fn write_file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        let mut file = fs::File::create(&path).expect("create");
        file.write_all(bytes).expect("write");
        path
    }

    #[test]
    fn rejects_paths_outside_root() {
        let root = temp_root("jail");
        write_file(&root, "ok.md", b"# Inside\n");
        let outside = std::env::temp_dir().join(format!("mk-serve-outside-{}", std::process::id()));
        write_file(&outside, "secret.md", b"# Secret\n");
        let secret = outside.join("secret.md").canonicalize().unwrap();
        assert_eq!(resolve_under_root(&root, &secret.to_string_lossy()).unwrap_err(), 403);
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn serves_markdown_under_root() {
        let root = temp_root("md");
        let path = write_file(&root, "note.md", b"# Hello\n\nWorld.\n");
        let config = Config { root: root.clone() };
        let url = format!("/?path={}", urlencoding::encode(&path.to_string_lossy()));
        let reply = handle(&config, "GET", &url);
        let body = String::from_utf8(reply.body).unwrap();
        assert_eq!(reply.status, 200);
        assert!(body.contains("<h1 id=\"hello\">Hello</h1>"));
        assert!(body.contains("World."));
        assert!(body.contains("class=\"serve\""));
        assert!(body.contains("/serve.js"));
        assert!(body.contains("href=\"/settings\""));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn serves_images_but_not_other_files() {
        let root = temp_root("asset");
        let png = write_file(&root, "pic.png", &[137, 80, 78, 71]);
        let env = write_file(&root, ".env", b"SECRET=1\n");
        let config = Config { root: root.clone() };
        let png_url = format!("/asset?path={}", urlencoding::encode(&png.to_string_lossy()));
        let env_url = format!("/asset?path={}", urlencoding::encode(&env.to_string_lossy()));
        let png_reply = handle(&config, "GET", &png_url);
        let env_reply = handle(&config, "GET", &env_url);
        assert_eq!(png_reply.status, 200);
        assert_eq!(png_reply.content_type, "image/png");
        assert_eq!(env_reply.status, 404);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn help_page_has_no_mermaid_engine() {
        let root = temp_root("help");
        let config = Config { root: root.clone() };
        let reply = handle(&config, "GET", "/");
        let body = String::from_utf8(reply.body).unwrap();
        assert_eq!(reply.status, 200);
        assert!(body.contains("markdownkit-serve"));
        assert!(body.contains("/settings"));
        assert!(!body.contains("/mermaid.js"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn settings_page_has_app_prefs_without_live_reload() {
        let root = temp_root("settings");
        let config = Config { root: root.clone() };
        let reply = handle(&config, "GET", "/settings");
        let body = String::from_utf8(reply.body).unwrap();
        assert_eq!(reply.status, 200);
        assert!(body.contains("Appearance"));
        assert!(body.contains("Show front matter"));
        assert!(body.contains("/serve.js"));
        assert!(!body.contains("live-reload"));
        assert!(!body.contains("file changes on disk"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn http_view_rewrites_relative_markdown_links() {
        let root = temp_root("links");
        let path = write_file(&root, "a.md", b"[next](./b.md)\n");
        write_file(&root, "b.md", b"# B\n");
        let config = Config { root: root.clone() };
        let url = format!("/?path={}", urlencoding::encode(&path.to_string_lossy()));
        let body = String::from_utf8(handle(&config, "GET", &url).body).unwrap();
        assert!(body.contains("/?path="));
        assert!(body.contains("b.md"));
        assert!(!body.contains("asset://"));
        let _ = fs::remove_dir_all(&root);
    }
}
