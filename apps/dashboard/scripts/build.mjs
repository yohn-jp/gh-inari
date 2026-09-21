#!/usr/bin/env node
import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(appRoot, "../..");
const outputDirectory = path.join(repositoryRoot, "dist/dashboard");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  bundle: true,
  entryPoints: [path.join(appRoot, "src/main.ts")],
  format: "esm",
  outdir: outputDirectory,
  platform: "browser",
  sourcemap: true,
  target: "es2022",
  logLevel: "warning",
});
