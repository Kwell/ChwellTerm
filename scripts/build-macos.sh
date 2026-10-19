#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
if [[ "$(uname -s)" != Darwin ]]; then
  printf '%s\n' 'This script must run on macOS with Xcode Command Line Tools.' >&2
  exit 1
fi
for command in node pnpm cargo rustup xcrun lipo ditto shasum; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Missing prerequisite: %s\n' "$command" >&2
    exit 1
  fi
done
xcrun --find clang >/dev/null
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { throw Error("Node.js 22 or later required"); }'
if [[ "${1:-}" == --check ]]; then
  printf '%s\n' 'macOS build prerequisites are available.'
  rustup target list --installed
  exit 0
fi
if [[ $# -ne 0 ]]; then
  printf '%s\n' 'Usage: bash scripts/build-macos.sh [--check]' >&2
  exit 1
fi

pnpm install --frozen-lockfile
pnpm test
pnpm build
cargo test --locked --lib --manifest-path src-tauri/Cargo.toml
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm desktop:build --bundles app,dmg --target universal-apple-darwin

bundle_root='src-tauri/target/universal-apple-darwin/release/bundle'
app_path="$bundle_root/macos/ChwellTerm.app"
app_binary="$app_path/Contents/MacOS/chwellterm"
lipo -verify_arch arm64 x86_64 "$app_binary"
version="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version')"
artifact_dir="output/macos/v$version"
mkdir -p "$artifact_dir"
ditto -c -k --sequesterRsrc --keepParent "$app_path" "$artifact_dir/ChwellTerm-v$version-universal.zip"
found_dmg=false
for dmg in "$bundle_root"/dmg/*.dmg; do
  [[ -f "$dmg" ]] || continue
  cp "$dmg" "$artifact_dir/"
  found_dmg=true
done
if [[ "$found_dmg" != true ]]; then
  printf '%s\n' 'Build did not produce a DMG.' >&2
  exit 1
fi
(
  cd "$artifact_dir"
  shasum -a 256 ./*.zip ./*.dmg > SHA256.txt
)
printf 'Universal application and DMG verified. Output: %s\n' "$artifact_dir"
