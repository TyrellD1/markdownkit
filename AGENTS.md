# Agent instructions

## Git workflow

- Commit often with focused, complete checkpoints. Prefer several small commits over one large dump.
- Push to `origin` at the **end of every turn**.
- Remote: https://github.com/TyrellD1/markdownkit
- Do not force-push, amend published history, skip hooks, or rewrite git config unless the user explicitly asks.

Commit + push is **not** a release. Do not tag, bump the shipped version, build a `.dmg` for GitHub, or run `gh release` unless the user explicitly asked to release.

## Releases

Only cut a GitHub Release when the user says to (e.g. “release”, “cut a release”, “publish v0.2.0”). Do not infer a release from a merge, a version-looking commit, or end-of-turn push.

When they do ask:

1. Bump the version in lockstep: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.
2. Commit and push that bump (same as any other change).
3. Build the disk image on a Mac:

```sh
npx tauri build --bundles dmg
```

The file lands at `src-tauri/target/release/bundle/dmg/MarkdownKit_<version>_aarch64.dmg` (Apple Silicon, ad-hoc signed, not notarized).

4. Publish with a matching git tag `v<version>`. Prefer `gh` if it is authenticated:

```sh
gh release create "v${VERSION}" \
  --title "MarkdownKit ${VERSION}" \
  --notes "…" \
  "src-tauri/target/release/bundle/dmg/MarkdownKit_${VERSION}_aarch64.dmg"
```

Substitute the real version in the tag, title, and filename. Notes should say what changed, and that Gatekeeper needs `xattr -cr /Applications/MarkdownKit.app` because the build is not notarized.

Do not enroll in the Apple Developer Program, Developer ID-sign, or notarize unless the user explicitly asks. Do not treat `./scripts/install.sh` or copying into `/Applications` as a GitHub Release.

## Product

MarkdownKit is a macOS-only Tauri markdown viewer. Keep it simple, correct, and cheap to run:

- Always keep the clean, minimal aesthetic. Quiet type, generous whitespace, no chrome for chrome’s sake. Do not add visual noise, extra panels, or decoration that does not help reading.
- Minimal hardware utilization. No background work when idle: no poll loops, animation loops, webfonts, JS markdown parsing, or extra frameworks. Watch only the currently open file, and only when live reload is on. Idle CPU should be effectively zero.
- Parse markdown in Rust (`pulldown-cmark`). Do not add a JS markdown library.
- Mermaid is the exception: load `ui/vendor/mermaid.min.js` only when the open document contains a mermaid fence. Do not load it on empty or mermaid-free pages. Theme diagrams to match the page; no extra chrome.
- macOS is the only supported platform.

## Tests

When you change rendering, sanitization, path rewriting, or frontmatter, update tests in `src-tauri` and run:

```sh
cargo test --manifest-path src-tauri/Cargo.toml
```
