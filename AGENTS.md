# Agent instructions

## Git workflow

- Commit often with focused, complete checkpoints. Prefer several small commits over one large dump.
- Push to `origin` at the **end of every turn**.
- Remote: https://github.com/TyrellD1/markdownkit
- Do not force-push, amend published history, skip hooks, or rewrite git config unless the user explicitly asks.

## Product

MarkdownKit is a macOS-only Tauri markdown viewer. Keep it simple, correct, and cheap to run:

- Always keep the clean, minimal aesthetic. Quiet type, generous whitespace, no chrome for chrome’s sake. Do not add visual noise, extra panels, or decoration that does not help reading.
- Minimal hardware utilization. No background work when idle: no poll loops, animation loops, webfonts, JS markdown parsing, or extra frameworks. Watch only the currently open file, and only when live reload is on. Idle CPU should be effectively zero.
- Parse markdown in Rust (`pulldown-cmark`). Do not add a JS markdown library.
- macOS is the only supported platform.

## Tests

When you change rendering, sanitization, path rewriting, or frontmatter, update tests in `src-tauri` and run:

```sh
cargo test --manifest-path src-tauri/Cargo.toml
```


## Tests

When you change rendering, sanitization, path rewriting, or frontmatter, update tests in `src-tauri` and run:

```sh
cargo test --manifest-path src-tauri/Cargo.toml
```
