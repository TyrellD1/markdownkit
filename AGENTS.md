# Agent instructions

## Git workflow

- Commit often with focused, complete checkpoints. Prefer several small commits over one large dump.
- Push to `origin` at the **end of every turn**.
- Remote: https://github.com/TyrellD1/markdownkit
- Do not force-push, amend published history, skip hooks, or rewrite git config unless the user explicitly asks.

## Product

MarkdownKit is a macOS-only Tauri markdown viewer. Keep it simple, correct, and cheap to run:

- Parse markdown in Rust (`pulldown-cmark`). Do not add a JS markdown library.
- No frontend framework, bundler, webfonts, animation loops, or polling.
- Watch only the currently open file. Idle CPU should be effectively zero.
- macOS is the only supported platform.

## Tests

When you change rendering, sanitization, path rewriting, or frontmatter, update tests in `src-tauri` and run:

```sh
cargo test --manifest-path src-tauri/Cargo.toml
```
