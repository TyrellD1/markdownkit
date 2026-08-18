![MarkdownKit — a calm local markdown reader](docs/markdownkit-hero.png)

# MarkdownKit

A beautiful, simple markdown viewer for local files on macOS. It is built to stay out of the way: Notion-like typography, native parsing, and essentially no CPU while a document is just sitting there.

MarkdownKit is a **viewer**. Open a `.md` file, read it, click a link, go back to work.

## What it does

- Opens local markdown (`.md`, `.markdown`, `.mdown`, `.mkd`)
- Renders GFM basics: headings, lists, task lists, tables, strike, footnotes, fenced code
- Resolves relative images and in-app links to other markdown files
- Reloads when the open file changes on disk
- Registers as a macOS viewer so Finder can double-click `.md` files into the app
- Uses no web fonts, no JS markdown parser, and no animation loop

Parsing happens in Rust (`pulldown-cmark`). The UI is a small static HTML/CSS/JS shell. There is no React, no bundler, and no background polling.

## Requirements

- macOS 11 or later
- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) (stable)

## Run it

```sh
git clone https://github.com/TyrellD1/markdownkit.git
cd markdownkit
npm install
npm test
npm run dev
```

Then **File → Open** (`⌘O`) and choose `examples/welcome.md`. You can also drop a markdown file onto the window.

To build the `.app`:

```sh
npm run build
```

The app bundle is written under `src-tauri/target/release/bundle/macos/`. Drag **MarkdownKit.app** into `/Applications`.

## Open `.md` files from Finder

1. Install the built app (see above).
2. Select any `.md` file in Finder.
3. **File → Get Info**.
4. Under **Open with**, choose **MarkdownKit**.
5. Click **Change All…** if you want double-click to always use MarkdownKit.

Until that default is set, you can still **Open With → MarkdownKit**.

## How anyone can test

| Check | How |
| --- | --- |
| Unit tests | `npm test` (or `cargo test --manifest-path src-tauri/Cargo.toml`) |
| Visual layout | `npm run dev`, open `examples/welcome.md` |
| Relative links | Click “the linked note” in the welcome file |
| Relative images | Confirm the `markdownkit` SVG at the bottom of welcome |
| Live reload | Edit `examples/welcome.md` in another editor; the viewer should refresh |
| External links | Click `https://` links; they open in the default browser |
| Finder | Build the app, then Open With / double-click a `.md` file |

There is a longer checklist in [DEV_TESTING.md](DEV_TESTING.md).

## Project layout

```
ui/                 static viewer (no bundler)
src-tauri/          Tauri + markdown engine
examples/           sample notes for manual tests
docs/               README artwork and source icon
```

## License

Use it. The repo is at [github.com/TyrellD1/markdownkit](https://github.com/TyrellD1/markdownkit).
