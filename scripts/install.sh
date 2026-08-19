#!/usr/bin/env bash
# Build MarkdownKit and install it into /Applications.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if ! command -v node >/dev/null || ! command -v rustc >/dev/null; then
  echo "Need Node.js and Rust (rustup) on PATH." >&2
  exit 1
fi

npm install
npx tauri build --bundles app

src="$root/src-tauri/target/release/bundle/macos/MarkdownKit.app"
if [[ ! -d "$src" ]]; then
  echo "Build did not produce MarkdownKit.app at $src" >&2
  exit 1
fi

killall markdownkit 2>/dev/null || true
rm -rf /Applications/MarkdownKit.app
cp -R "$src" /Applications/MarkdownKit.app
xattr -cr /Applications/MarkdownKit.app 2>/dev/null || true

echo "Installed /Applications/MarkdownKit.app"
open -a /Applications/MarkdownKit.app
