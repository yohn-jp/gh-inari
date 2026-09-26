#!/usr/bin/env node
// Deterministic build of the packaged local setup console (#1121).
//
// Bundles apps/setup-console/src/entry.ts and copies the static page and
// stylesheet into one owned generated directory, `dist/setup-console/` by
// default. The installed setup host serves exactly these files from beside
// its own module; no source-checkout path is needed at runtime.
import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = path.join(repoRoot, "apps", "setup-console");

/** Output files; must match src/console/public-assets.ts SETUP_CONSOLE_ASSETS. */
export const SETUP_CONSOLE_OUTPUT_FILES = Object.freeze(["index.html", "setup-console.js", "styles.css"]);

export async function buildSetupConsole(outputDirectory = path.join(repoRoot, "dist", "setup-console")) {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await build({
    bundle: true,
    entryPoints: { "setup-console": path.join(appRoot, "src", "entry.ts") },
    // Shared contract validators measure JSON with Buffer.byteLength; the browser gets a UTF-8 stand-in.
    inject: [path.join(appRoot, "src", "buffer-shim.ts")],
    format: "esm",
    outdir: outputDirectory,
    platform: "browser",
    target: "es2022",
    sourcemap: false,
    legalComments: "none",
    charset: "utf8",
    logLevel: "warning",
  });
  await copyFile(path.join(appRoot, "index.html"), path.join(outputDirectory, "index.html"));
  await copyFile(path.join(appRoot, "styles.css"), path.join(outputDirectory, "styles.css"));
  return outputDirectory;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outIndex = process.argv.indexOf("--out");
  const target = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
  if (outIndex >= 0 && (target === undefined || target.length === 0)) {
    console.error("Usage: node scripts/build-setup-console.mjs [--out <directory>]");
    process.exit(2);
  }
  const output = await buildSetupConsole(target === undefined ? undefined : path.resolve(target));
  console.log(`setup console assets built: ${path.relative(repoRoot, output) || output}`);
}
