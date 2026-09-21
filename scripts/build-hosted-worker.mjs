#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(repositoryRoot, "dist-hosted-worker");
const appHtml = fs.readFileSync(path.join(repositoryRoot, "src", "mcp", "apps", "inari-app.html"), "utf8");

fs.rmSync(outdir, { recursive: true, force: true });

await esbuild.build({
  entryPoints: [path.join(repositoryRoot, "src", "hosted-worker.ts")],
  outfile: path.join(outdir, "hosted-worker.js"),
  bundle: true,
  platform: "neutral",
  conditions: ["workerd"],
  mainFields: ["module", "main"],
  external: ["node:*"],
  format: "esm",
  target: "es2022",
  define: { INARI_APP_HTML_SOURCE: JSON.stringify(appHtml) },
  minify: false,
  sourcemap: true,
  logLevel: "info",
});
