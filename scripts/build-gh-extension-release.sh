#!/usr/bin/env bash
# Build entrypoint invoked by the shared `gh extension precompiled release`
# reusable workflow (yohn-jp/.github/.github/workflows/gh-extension-release.yml@main,
# wired in via .github/workflows/gh-extension-release.yml). That workflow owns
# checking out the exact release tag, verifying artifact naming, and
# uploading to the Release; it invokes this script with no arguments and
# expects finished, correctly named binaries in $ARTIFACT_DIR when it exits
# 0. Everything about *how* those binaries get built — toolchain, packaging,
# and which platforms ship — is owned here.
#
# Approach: bundle the compiled CLI (dist/cli.js, produced by the normal
# `pnpm run build`) into a single CommonJS file with esbuild, then use
# Node's built-in Single Executable Application (SEA) support to inject it
# into a real `node` binary per target platform via postject. Node ships
# prebuilt binaries for every target this script cares about, and postject
# patches them by byte-injection rather than executing them, so all targets
# can be produced from this one Linux build host without cross-compilers or
# emulation.
set -euo pipefail

: "${ARTIFACT_DIR:?ARTIFACT_DIR must be set to the directory release artifacts are written to}"

# Pinned so every build produces byte-for-byte comparable executables and the
# SEA blob (built once, injected into every platform's binary unmodified) has
# a single, known-good Node runtime backing it. Bump deliberately; there is
# no reproducibility check tying this to package.json's `engines.node` range.
NODE_VERSION="24.21.0"

# GitHub CLI's precompiled-extension naming contract expects the artifact
# name prefix to equal the repository name (the shared workflow's own
# default for `extension-name`); derive it the same way so naming can never
# drift between this script and the workflow that verifies it.
EXTENSION_NAME="${GITHUB_REPOSITORY#*/}"
if [ -z "$EXTENSION_NAME" ] || [ "$EXTENSION_NAME" = "$GITHUB_REPOSITORY" ]; then
  EXTENSION_NAME="$(node -p "require('./package.json').name")"
fi

# os/arch pairs as (nodeOs, nodeArch, ghOs, ghArch, archiveExt). gh's naming
# vocabulary (amd64/arm64, darwin/linux/windows) differs from Node's own
# (x64/arm64, darwin/linux/win); the mapping only exists to bridge that.
PLATFORMS=(
  "linux:x64:linux:amd64:tar.gz"
  "linux:arm64:linux:arm64:tar.gz"
  "darwin:x64:darwin:amd64:tar.gz"
  "darwin:arm64:darwin:arm64:tar.gz"
  "win:x64:windows:amd64:zip"
)

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> Downloading Node.js v${NODE_VERSION} build toolchain (linux-x64)"
BUILD_NODE_ARCHIVE="$WORK_DIR/node-build.tar.gz"
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" -o "$BUILD_NODE_ARCHIVE"
tar -xzf "$BUILD_NODE_ARCHIVE" -C "$WORK_DIR"
BUILD_NODE_DIR="$WORK_DIR/node-v${NODE_VERSION}-linux-x64"
export PATH="$BUILD_NODE_DIR/bin:$PATH"

echo "==> Installing dependencies and building the CLI"
corepack enable
PACKAGE_MANAGER_SPEC="$(node -p "require('./package.json').packageManager")"
corepack prepare "$PACKAGE_MANAGER_SPEC" --activate
pnpm install --frozen-lockfile
pnpm run build

PACKAGE_NAME="$(node -p "require('./package.json').name")"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
PACKAGE_DESCRIPTION="$(node -p "JSON.stringify(require('./package.json').description ?? '')")"
EMBEDDED_METADATA="{\"name\":\"${PACKAGE_NAME}\",\"version\":\"${PACKAGE_VERSION}\",\"description\":${PACKAGE_DESCRIPTION}}"

echo "==> Bundling dist/cli.js into a single CommonJS file"
ENTRY_FILE="$WORK_DIR/entry.mjs"
cat >"$ENTRY_FILE" <<EOF
import { runCli } from "$(pwd)/dist/cli.js";
runCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
EOF

BUNDLE_FILE="$WORK_DIR/bundle.cjs"
node_modules/.bin/esbuild "$ENTRY_FILE" \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node24 \
  --define:__GH_INARI_EMBEDDED_METADATA__="$EMBEDDED_METADATA" \
  --outfile="$BUNDLE_FILE"

echo "==> Generating the Node.js SEA blob"
SEA_CONFIG_FILE="$WORK_DIR/sea-config.json"
SEA_BLOB_FILE="$WORK_DIR/sea-prep.blob"
cat >"$SEA_CONFIG_FILE" <<EOF
{
  "main": "$BUNDLE_FILE",
  "output": "$SEA_BLOB_FILE",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": false
}
EOF
node --experimental-sea-config "$SEA_CONFIG_FILE"

SEA_FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"

mkdir -p "$ARTIFACT_DIR"

for entry in "${PLATFORMS[@]}"; do
  IFS=':' read -r node_os node_arch gh_os gh_arch archive_ext <<<"$entry"

  echo "==> Building ${gh_os}/${gh_arch}"
  node_dist_name="node-v${NODE_VERSION}-${node_os}-${node_arch}"
  archive_file="$WORK_DIR/${node_dist_name}.${archive_ext}"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${node_dist_name}.${archive_ext}" -o "$archive_file"

  extract_dir="$WORK_DIR/extract-${gh_os}-${gh_arch}"
  mkdir -p "$extract_dir"
  if [ "$archive_ext" = "zip" ]; then
    unzip -q "$archive_file" -d "$extract_dir"
    source_binary="$extract_dir/${node_dist_name}/node.exe"
  else
    tar -xzf "$archive_file" -C "$extract_dir"
    source_binary="$extract_dir/${node_dist_name}/bin/node"
  fi

  artifact_name="${EXTENSION_NAME}-${gh_os}-${gh_arch}"
  if [ "$gh_os" = "windows" ]; then
    artifact_name="${artifact_name}.exe"
  fi
  artifact_path="$ARTIFACT_DIR/$artifact_name"

  cp "$source_binary" "$artifact_path"
  chmod +x "$artifact_path"

  postject_args=("$artifact_path" NODE_SEA_BLOB "$SEA_BLOB_FILE" --sentinel-fuse "$SEA_FUSE")
  if [ "$gh_os" = "darwin" ]; then
    postject_args+=(--macho-segment-name NODE_SEA)
  fi
  node_modules/.bin/postject "${postject_args[@]}"

  echo "    wrote $artifact_path"
done

echo "==> Done: $(ls -1 "$ARTIFACT_DIR" | wc -l) artifact(s) in $ARTIFACT_DIR"
