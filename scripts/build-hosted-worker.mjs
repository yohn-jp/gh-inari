#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(repositoryRoot, "dist-hosted-worker");
const dashboardDist = path.join(repositoryRoot, "apps", "dashboard", "dist");
const dashboardEntry = path.join(dashboardDist, "index.html");
const appHtml = fs.readFileSync(path.join(repositoryRoot, "src", "mcp", "apps", "inari-app.html"), "utf8");

const dashboardBuild = spawnSync("pnpm", ["--dir", "apps/dashboard", "build"], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
if (dashboardBuild.error !== undefined) throw dashboardBuild.error;
if (dashboardBuild.status !== 0) {
  throw new Error(`Dashboard build failed with exit code ${dashboardBuild.status ?? "unknown"}.`);
}
if (!fs.existsSync(dashboardEntry)) {
  throw new Error(`Dashboard build output is missing ${path.relative(repositoryRoot, dashboardEntry)}.`);
}

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
