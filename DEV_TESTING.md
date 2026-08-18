# Dev testing

How to run MarkdownKit locally and confirm it is still correct, quiet, and pleasant.

## One-time setup

1. macOS 11+
2. Node 20+ (`node -v`)
3. Rust stable (`rustc -V`). If missing: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
4. Xcode Command Line Tools: `xcode-select -p`

Then:

```sh
cd markdownkit
npm install
```

If app icons are missing or you changed `docs/markdownkit-icon.png`:

```sh
npm run icon
```

## Automated tests

These do not open a window. They cover parsing, frontmatter, sanitization, heading ids, and local path rewriting.

```sh
npm test
```

Equivalent:

```sh
cargo test --manifest-path src-tauri/Cargo.toml
```

Run them after any change to `src-tauri/src/markdown.rs`.

## Run the app

```sh
npm run dev
```

Expected:

- Overlay traffic lights on a cream (or dark) page
- Empty state titled **markdownkit**
- `⌘O` or the **Open a file** button opens a native picker

Open `examples/welcome.md`.

### Visual checklist

- [ ] Serif H1, sans body, ~720px column
- [ ] Frontmatter `title` / `author` shown as a quiet property list
- [ ] Checked / unchecked task boxes
- [ ] Table, blockquote, inline code, fenced `rust` block
- [ ] SVG image at the bottom
- [ ] Window title / top chrome shows `Welcome to MarkdownKit`

### Interaction checklist

- [ ] Click **the linked note** → `examples/linked.md` opens
- [ ] In-page `#` links still scroll when present
- [ ] `https://` links leave the app (default browser)
- [ ] Drop `examples/welcome.md` onto the window
- [ ] Edit `welcome.md` on disk → viewer reloads without a full restage
- [ ] Opening a `.txt` file is rejected with a toast

### Idle cost

With a document open and the window in the background, Activity Monitor should show **MarkdownKit** near 0% CPU. There is no poll loop; disk changes use FSEvents on the current file’s folder only.

## Production build and Finder

```sh
npm run build
open src-tauri/target/release/bundle/macos/
```

1. Copy `MarkdownKit.app` to `/Applications`.
2. Right-click `examples/welcome.md` → **Open With → MarkdownKit**.
3. To make double-click the default: Get Info on a `.md` file → **Open with → MarkdownKit → Change All…**

Cold start from Finder should show the file immediately, not the empty state.

If macOS holds on to an old bundle, quit the app and reopen the one in `/Applications`, or `killall MarkdownKit` first.

## What “good” looks like

- First paint is a still page, not a spinner
- No webfont download, no markdown parse in JS
- Switching files is a single Rust `read_to_string` + parse
- The webview only displays already-sanitized HTML
