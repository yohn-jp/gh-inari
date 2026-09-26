#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import {
  createEndpointOnboardingDescriptor,
  encodeEndpointOnboardingDescriptor,
} from "../src/endpoint-onboarding.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(repositoryRoot, "dist-hosted-worker");
const dashboardDist = path.join(repositoryRoot, "apps", "dashboard", "dist");
const dashboardEntry = path.join(dashboardDist, "index.html");
const hostedConfigPath = path.join(repositoryRoot, "wrangler.hosted.toml");
const onboardingAssetPath = path.join(dashboardDist, ".well-known", "inari");
const staticHeadersPath = path.join(dashboardDist, "_headers");
const appHtml = fs.readFileSync(path.join(repositoryRoot, "src", "mcp", "apps", "inari-app.html"), "utf8");

function configBlock(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`Hosted configuration is missing ${marker}.`);
  const remainder = source.slice(start + marker.length);
  const next = remainder.search(/^\s*\[/mu);
  return next === -1 ? remainder : remainder.slice(0, next);
}

function assignments(block) {
  const values = new Map();
  for (const rawLine of block.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Z0-9_]+|pattern)\s*=\s*(".*")\s*$/u.exec(line);
    if (match === null) continue;
    let value;
    try {
      value = JSON.parse(match[2]);
    } catch {
      throw new Error(`Hosted configuration has an unsupported quoted value for ${match[1]}.`);
    }
    if (typeof value !== "string" || values.has(match[1])) {
      throw new Error(`Hosted configuration has an invalid ${match[1]} value.`);
    }
    values.set(match[1], value);
  }
  return values;
}

function required(values, key) {
  const value = values.get(key);
  if (value === undefined) throw new Error(`Hosted configuration is missing ${key}.`);
  return value;
}

function hostedOnboardingDescriptor(source) {
  const routeBlock = configBlock(source, "[[routes]]");
  if (!/^\s*custom_domain\s*=\s*true\s*$/mu.test(routeBlock)) {
    throw new Error("Hosted onboarding Static Asset requires a custom-domain route.");
  }
  const route = assignments(routeBlock);
  const host = required(route, "pattern");
  const parsedHost = new URL(`https://${host}/`);
  if (host.includes("/") || host.includes("*") || parsedHost.hostname !== host) {
    throw new Error("Hosted custom-domain route must be one exact hostname.");
  }
  const vars = assignments(configBlock(source, "[vars]"));
  return createEndpointOnboardingDescriptor({
    githubHost: required(vars, "INARI_HOSTED_REPOSITORY_HOST"),
    appId: required(vars, "INARI_GITHUB_APP_ID"),
    appClientId: required(vars, "INARI_GITHUB_APP_CLIENT_ID"),
    appSlug: required(vars, "INARI_GITHUB_APP_SLUG"),
    appInstallationUrl: required(vars, "INARI_GITHUB_APP_INSTALLATION_URL"),
    appUserAuthProfile: required(vars, "INARI_GITHUB_APP_USER_AUTH_PROFILE"),
    appCallbackUrl: required(vars, "INARI_GITHUB_APP_CALLBACK_URL"),
    relayConnectionBase: `wss://${host}/v1/relay/connect`,
  });
}

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

const onboardingDescriptor = hostedOnboardingDescriptor(fs.readFileSync(hostedConfigPath, "utf8"));
fs.mkdirSync(path.dirname(onboardingAssetPath), { recursive: true });
fs.writeFileSync(onboardingAssetPath, `${encodeEndpointOnboardingDescriptor(onboardingDescriptor)}\n`, "utf8");
fs.writeFileSync(
  staticHeadersPath,
  "/.well-known/inari\n  Content-Type: application/json; charset=utf-8\n  X-Content-Type-Options: nosniff\n",
  "utf8",
);

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
