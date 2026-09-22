#!/usr/bin/env node
import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(appRoot, "dist");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  bundle: true,
  entryPoints: [path.join(appRoot, "src/browser.ts")],
  format: "esm",
  outdir: outputDirectory,
  platform: "browser",
  sourcemap: true,
  target: "es2022",
  logLevel: "warning",
});
await copyFile(path.join(appRoot, "index.html"), path.join(outputDirectory, "index.html"));
await copyFile(path.join(appRoot, "styles.css"), path.join(outputDirectory, "styles.css"));
