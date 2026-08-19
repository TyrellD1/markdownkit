use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use pulldown_cmark::{
    CodeBlockKind, CowStr, Event, HeadingLevel, Options, Parser, Tag, TagEnd, html,
};
use serde::Serialize;

const OPEN_PREFIX: &str = "/__mk__/open?path=";
const EXTERNAL_PREFIX: &str = "/__mk__/external?path=";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FrontmatterField {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RenderedDocument {
    pub path: String,
    pub title: String,
    pub html: String,
    pub frontmatter: Vec<FrontmatterField>,
}

pub fn render(source: &str, path: &Path) -> RenderedDocument {
    let (frontmatter, body) = split_frontmatter(source);
    let base_dir = path.parent().unwrap_or(path);

    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_HEADING_ATTRIBUTES);
    options.insert(Options::ENABLE_SMART_PUNCTUATION);

    let mut events: Vec<Event> = Parser::new_ext(body, options).collect();
    assign_heading_ids(&mut events);

    let title = frontmatter
        .iter()
        .find(|field| field.key.eq_ignore_ascii_case("title"))
        .map(|field| field.value.clone())
        .or_else(|| first_heading(&events))
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| file_stem(path));

    let events = events
        .into_iter()
        .map(|event| rewrite_event(event, base_dir));

    let mut html = String::with_capacity(body.len().saturating_mul(2).max(64));
    html::push_html(&mut html, events);
    let html = sanitize(&html);

    RenderedDocument {
        path: path.to_string_lossy().into_owned(),
        title,
        html,
        frontmatter,
    }
}

pub fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "md" | "markdown" | "mdown" | "mkd"
            )
        })
}

pub fn split_frontmatter(source: &str) -> (Vec<FrontmatterField>, &str) {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let Some(after_open) = source.strip_prefix("---") else {
        return (Vec::new(), source);
    };
    let after_open = after_open.strip_prefix('\r').unwrap_or(after_open);
    let Some(after_open) = after_open.strip_prefix('\n') else {
        return (Vec::new(), source);
    };

    let Some(rel_end) = find_frontmatter_end(after_open) else {
        return (Vec::new(), source);
    };

    let yaml = &after_open[..rel_end];
    let mut rest = &after_open[rel_end..];
    rest = rest.strip_prefix('\r').unwrap_or(rest);
    rest = rest.strip_prefix('\n').unwrap_or(rest);
    rest = rest.strip_prefix("---").unwrap_or(rest);
    rest = rest.strip_prefix('\r').unwrap_or(rest);
    rest = rest.strip_prefix('\n').unwrap_or(rest);

    (parse_simple_yaml(yaml), rest)
}

fn find_frontmatter_end(after_open: &str) -> Option<usize> {
    after_open.find("\n---").map(|i| i + 1).or_else(|| {
        after_open
            .find("\r\n---")
            .map(|i| i + 2)
    })
}

fn parse_simple_yaml(yaml: &str) -> Vec<FrontmatterField> {
    let mut fields = Vec::new();
    for line in yaml.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let value = trim_simple_yaml_value(value);
        fields.push(FrontmatterField {
            key: key.to_string(),
            value,
        });
    }
    fields
}

fn trim_simple_yaml_value(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'')
        {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

fn first_heading(events: &[Event<'_>]) -> Option<String> {
    let mut collecting = false;
    let mut buf = String::new();
    for event in events {
        match event {
            Event::Start(Tag::Heading { level, .. }) if *level == HeadingLevel::H1 => {
                collecting = true;
                buf.clear();
            }
            Event::End(TagEnd::Heading(level)) if collecting && *level == HeadingLevel::H1 => {
                let title = buf.trim();
                if !title.is_empty() {
                    return Some(title.to_string());
                }
                collecting = false;
            }
            Event::Text(text) | Event::Code(text) if collecting => buf.push_str(text),
            _ => {}
        }
    }
    None
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("Untitled")
        .to_string()
}

fn assign_heading_ids(events: &mut [Event<'_>]) {
    let mut used = HashSet::new();
    let mut index = 0;
    while index < events.len() {
        let slug = heading_slug_at(events, index);
        if let Some(slug) = slug {
            let mut unique = slug;
            if unique.is_empty() {
                unique = "section".to_string();
            }
            let base = unique.clone();
            let mut n = 2;
            while !used.insert(unique.clone()) {
                unique = format!("{base}-{n}");
                n += 1;
            }
            if let Event::Start(Tag::Heading { id, .. }) = &mut events[index] {
                if id.is_none() {
                    *id = Some(CowStr::from(unique));
                } else if let Some(existing) = id.as_ref() {
                    used.insert(existing.to_string());
                }
            }
        }
        index += 1;
    }
}

fn heading_slug_at(events: &[Event<'_>], start: usize) -> Option<String> {
    let Event::Start(Tag::Heading { id, .. }) = &events[start] else {
        return None;
    };
    if id.is_some() {
        return None;
    }
    let mut text = String::new();
    for event in events.iter().skip(start + 1) {
        match event {
            Event::End(TagEnd::Heading(_)) => break,
            Event::Text(value) | Event::Code(value) => text.push_str(value),
            _ => {}
        }
    }
    Some(slugify(&text))
}

pub fn slugify(text: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if ch.is_alphabetic() {
            slug.push(ch);
            prev_dash = false;
        } else if !slug.is_empty() && !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    slug.trim_matches('-').to_string()
}

fn rewrite_event<'a>(event: Event<'a>, base_dir: &Path) -> Event<'a> {
    match event {
        Event::Start(Tag::Image {
            link_type,
            dest_url,
            title,
            id,
        }) => Event::Start(Tag::Image {
            link_type,
            dest_url: CowStr::from(rewrite_image_url(base_dir, &dest_url)),
            title,
            id,
        }),
        Event::Start(Tag::Link {
            link_type,
            dest_url,
            title,
            id,
        }) => Event::Start(Tag::Link {
            link_type,
            dest_url: CowStr::from(rewrite_link_url(base_dir, &dest_url)),
            title,
            id,
        }),
        Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(lang))) => {
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(lang)))
        }
        other => other,
    }
}

pub fn rewrite_image_url(base_dir: &Path, dest: &str) -> String {
    if dest.is_empty() || dest.starts_with('#') || is_external(dest) {
        return dest.to_string();
    }
    let (path_part, _) = split_fragment(dest);
    if path_part.is_empty() {
        return dest.to_string();
    }
    to_asset_url(&resolve_path(base_dir, path_part))
}

pub fn rewrite_link_url(base_dir: &Path, dest: &str) -> String {
    if dest.is_empty() || dest.starts_with('#') || is_external(dest) {
        return dest.to_string();
    }
    let (path_part, fragment) = split_fragment(dest);
    if path_part.is_empty() {
        return dest.to_string();
    }
    let resolved = resolve_path(base_dir, path_part);
    if is_markdown_path(&resolved) {
        let mut url = format!(
            "{OPEN_PREFIX}{}",
            urlencoding::encode(&resolved.to_string_lossy())
        );
        if let Some(fragment) = fragment {
            url.push('#');
            url.push_str(fragment);
        }
        url
    } else {
        format!(
            "{EXTERNAL_PREFIX}{}",
            urlencoding::encode(&resolved.to_string_lossy())
        )
    }
}

pub fn to_asset_url(path: &Path) -> String {
    format!(
        "asset://localhost/{}",
        urlencoding::encode(&path.to_string_lossy())
    )
}

pub fn is_external(dest: &str) -> bool {
    let dest = dest.trim();
    dest.starts_with("//")
        || dest.contains("://")
        || dest.starts_with("mailto:")
        || dest.starts_with("data:")
}

fn split_fragment(dest: &str) -> (&str, Option<&str>) {
    match dest.split_once('#') {
        Some((path, fragment)) => (path, Some(fragment)),
        None => (dest, None),
    }
}

pub fn resolve_path(base_dir: &Path, dest: &str) -> PathBuf {
    let dest = dest.trim();
    let path = Path::new(dest);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base_dir.join(path)
    };
    normalize_path(&joined)
}

pub fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn sanitize(html: &str) -> String {
    let mut builder = ammonia::Builder::default();
    builder.add_tags(["input"]);
    builder.add_tag_attributes("input", ["type", "checked", "disabled", "value"]);
    builder.add_tag_attributes("code", ["class"]);
    builder.add_tag_attributes("pre", ["class"]);
    builder.add_tag_attributes("a", ["href", "title", "id"]);
    builder.add_tag_attributes("img", ["src", "alt", "title"]);
    builder.add_generic_attributes(["id"]);
    builder.url_schemes(HashSet::from([
        "http",
        "https",
        "mailto",
        "asset",
        "data",
    ]));
    builder.attribute_filter(|element, attribute, value| {
        if element == "input" {
            return match attribute {
                "type" if value.eq_ignore_ascii_case("checkbox") => Some(value.into()),
                "checked" | "disabled" => Some(value.into()),
                _ => None,
            };
        }
        if attribute == "href" && value.trim().to_ascii_lowercase().starts_with("javascript:") {
            return None;
        }
        Some(value.into())
    });
    builder.clean(html).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render_named(source: &str, name: &str) -> RenderedDocument {
        render(source, Path::new("/notes").join(name).as_path())
    }

    #[test]
    fn renders_headings_and_paragraphs() {
        let doc = render_named("# Hello\n\nWorld.", "hello.md");
        assert_eq!(doc.title, "Hello");
        assert!(doc.html.contains("<h1 id=\"hello\">Hello</h1>"));
        assert!(doc.html.contains("<p>World.</p>"));
    }

    #[test]
    fn uses_filename_when_no_heading() {
        let doc = render_named("just text", "journal.md");
        assert_eq!(doc.title, "journal");
        assert!(doc.html.contains("<p>just text</p>"));
    }

    #[test]
    fn prefers_frontmatter_title() {
        let source = "---\ntitle: Cover\n---\n# Body heading\n";
        let doc = render_named(source, "cover.md");
        assert_eq!(doc.title, "Cover");
        assert_eq!(
            doc.frontmatter,
            vec![FrontmatterField {
                key: "title".into(),
                value: "Cover".into(),
            }]
        );
        assert!(doc.html.contains("Body heading"));
        assert!(!doc.html.contains("Cover</h1>"));
    }

    #[test]
    fn splits_frontmatter_and_strips_bom() {
        let source = "\u{feff}---\nauthor: Ada\ntags: notes\n---\n# Ada\n";
        let (fields, body) = split_frontmatter(source);
        assert_eq!(fields.len(), 2);
        assert_eq!(fields[0].key, "author");
        assert_eq!(fields[0].value, "Ada");
        assert_eq!(body, "# Ada\n");
    }

    #[test]
    fn unclosed_frontmatter_is_plain_markdown() {
        let source = "---\nnot closed\n# Heading\n";
        let (fields, body) = split_frontmatter(source);
        assert!(fields.is_empty());
        assert_eq!(body, source);
    }

    #[test]
    fn renders_gfm_tables_tasks_and_strike() {
        let source = "\
| A | B |\n\
| --- | --- |\n\
| 1 | 2 |\n\
\n\
- [x] done\n\
- [ ] todo\n\
\n\
~~old~~ new\n";
        let html = render_named(source, "gfm.md").html;
        assert!(html.contains("<table>"));
        assert!(html.contains("<th>A</th>"));
        assert!(html.contains("type=\"checkbox\""));
        assert!(html.contains("checked"));
        assert!(html.contains("<del>old</del>") || html.contains("<s>old</s>"));
    }

    #[test]
    fn unique_heading_ids() {
        let html = render_named("# Hello\n\n# Hello\n", "ids.md").html;
        assert!(html.contains("id=\"hello\""));
        assert!(html.contains("id=\"hello-2\""));
    }

    #[test]
    fn rewrites_relative_images_to_asset_urls() {
        let html = render_named("![cat](./images/cat.png)", "post.md").html;
        assert!(html.contains("asset://localhost/"));
        assert!(html.contains("%2Fnotes%2Fimages%2Fcat.png"));
        assert!(!html.contains("./images/cat.png"));
    }

    #[test]
    fn leaves_remote_images_alone() {
        let html = render_named("![cat](https://example.com/cat.png)", "post.md").html;
        assert!(html.contains("https://example.com/cat.png"));
    }

    #[test]
    fn rewrites_local_markdown_links() {
        let html = render_named("[next](./more.md#todo)", "post.md").html;
        assert!(html.contains("/__mk__/open?path="));
        assert!(html.contains("more.md"));
        assert!(html.contains("#todo"));
    }

    #[test]
    fn leaves_in_page_and_web_links() {
        let html = render_named("[a](#hello)\n[b](https://example.com)", "post.md").html;
        assert!(html.contains("href=\"#hello\""));
        assert!(html.contains("href=\"https://example.com\""));
    }

    #[test]
    fn strips_scripts_and_javascript_urls() {
        let html = render_named(
            "<script>alert(1)</script>\n[x](javascript:alert(1))\n",
            "evil.md",
        )
        .html;
        assert!(!html.to_lowercase().contains("<script"));
        assert!(!html.to_lowercase().contains("javascript:"));
        assert!(!html.contains("alert(1)"));
    }

    #[test]
    fn strips_non_checkbox_inputs() {
        let html = render_named("<input type=\"password\" name=\"x\">\n", "form.md").html;
        assert!(!html.contains("password"));
    }

    #[test]
    fn preserves_fenced_code() {
        let html = render_named("```rust\nlet x = 1;\n```\n", "code.md").html;
        assert!(html.contains("<pre>"));
        assert!(html.contains("let x = 1;"));
        assert!(html.contains("language-rust") || html.contains("rust"));
    }

    #[test]
    fn preserves_mermaid_fences() {
        let html = render_named("```mermaid\nflowchart LR\n  A --> B\n```\n", "diagram.md").html;
        assert!(html.contains("language-mermaid"));
        assert!(html.contains("flowchart LR"));
        assert!(html.contains("A --&gt; B") || html.contains("A --> B"));
    }

    #[test]
    fn resolve_parent_segments_without_filesystem() {
        let resolved = resolve_path(Path::new("/notes/sub"), "../img/a.png");
        assert_eq!(resolved, PathBuf::from("/notes/img/a.png"));
    }

    #[test]
    fn markdown_extensions() {
        assert!(is_markdown_path(Path::new("a.md")));
        assert!(is_markdown_path(Path::new("a.MARKDOWN")));
        assert!(!is_markdown_path(Path::new("a.txt")));
    }

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("Hello World"), "hello-world");
        assert_eq!(slugify("  Hello -- World!! "), "hello-world");
    }

    #[test]
    fn quoted_frontmatter_values() {
        let (fields, _) = split_frontmatter("---\ntitle: \"Quoted: value\"\n---\n\n");
        assert_eq!(fields[0].value, "Quoted: value");
    }

    #[test]
    fn welcome_fixture_renders() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../examples/welcome.md");
        let source = std::fs::read_to_string(&path).expect("welcome.md");
        let doc = render(&source, &path);
        assert_eq!(doc.title, "Welcome to MarkdownKit");
        assert!(doc.html.contains("Thoughts become clarity"));
        assert!(doc.html.contains("asset://localhost/"));
        assert!(doc.html.contains("/__mk__/open?path="));
        assert!(doc.frontmatter.iter().any(|field| field.key == "author"));
    }

    #[test]
    fn kitchen_sink_renders_gfm_shapes() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../examples/kitchen-sink.md");
        let source = std::fs::read_to_string(&path).expect("kitchen-sink.md");
        let doc = render(&source, &path);
        assert_eq!(doc.title, "Kitchen sink");
        assert!(doc.html.contains("<table>"));
        assert!(doc.html.contains("type=\"checkbox\""));
        assert!(doc.html.contains("<blockquote>"));
        assert!(doc.html.contains("<pre>"));
        assert!(doc.html.contains("language-mermaid"));
        assert!(doc.html.contains("id=\"custom-id\""));
        assert!(doc.html.contains("footnote") || doc.html.contains("Footnotes"));
        assert!(doc.html.contains("/__mk__/open?path="));
        assert!(doc.html.contains("asset://localhost/"));
        assert!(doc.html.contains("https://example.com"));
    }
}
