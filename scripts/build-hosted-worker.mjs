#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(repositoryRoot, "dist-hosted-worker");

fs.rmSync(outdir, { recursive: true, force: true });

await esbuild.build({
  entryPoints: [path.join(repositoryRoot, "src", "hosted-worker.ts")],
  outfile: path.join(outdir, "hosted-worker.js"),
  bundle: true,
  platform: "neutral",
  mainFields: ["module", "main"],
  external: ["node:*"],
  format: "esm",
  target: "es2022",
  minify: false,
  sourcemap: true,
  logLevel: "info",
});
