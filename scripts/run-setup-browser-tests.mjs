#!/usr/bin/env node
// Real-browser runner for the packaged local setup console (#1121).
//
// Drives the built product: `node dist/index.js setup console` is started as a
// real process on a clean INARI_CONFIG_HOME, and a real Chromium-compatible
// browser (via playwright-core, no bundled download) loads the actually served
// console. It checks bootstrap/credential handling, refresh and repeated-start
// reuse, cross-origin denial, the real enrollment upload path and owned
// shutdown.
//
// Exit codes: 0 PASS, 1 FAIL, 2 BLOCKED. A missing browser or driver is a
// BLOCKED prerequisite, reported as such; it is never converted into a pass
// or a skip.
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const EXIT_FAIL = 1;
const EXIT_BLOCKED = 2;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(repoRoot, "dist", "index.js");
const REPOSITORY = "inari-certification/setup-browser";
const REPOSITORY_ID = "424242";

function blocked(reason) {
  console.error(`setup browser tests BLOCKED: ${reason}`);
  process.exit(EXIT_BLOCKED);
}

function executable(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Locates a real Chromium-compatible browser; never downloads one. */
export function locateBrowser(environment = process.env) {
  const explicit = environment.INARI_SETUP_BROWSER;
  if (explicit !== undefined && explicit !== "") {
    return executable(explicit) ? explicit : undefined;
  }
  const candidates = [];
  const playwrightPath = environment.PLAYWRIGHT_BROWSERS_PATH;
  if (playwrightPath !== undefined && playwrightPath !== "" && existsSync(playwrightPath)) {
    candidates.push(path.join(playwrightPath, "chromium"));
    for (const entry of readdirSync(playwrightPath).sort().reverse()) {
      if (/^chromium-\d+$/u.test(entry)) candidates.push(path.join(playwrightPath, entry, "chrome-linux", "chrome"));
    }
  }
  for (const directory of (environment.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) {
      candidates.push(path.join(directory, name));
    }
  }
  candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  return candidates.find(executable);
}

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
  console.log(`ok ${checks} - ${message}`);
}

function startConsole(environment, cwd) {
  const child = spawn(
    process.execPath,
    [cliEntry, "setup", "console", "--json", "--repository", REPOSITORY, "--repository-id", REPOSITORY_ID],
    { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`setup console did not start: ${stdout}${stderr}`)), 20_000);
    const onData = () => {
      const line = stdout.split("\n")[0];
      if (!stdout.includes("\n")) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`setup console printed invalid JSON: ${line}${stderr}`));
      }
    };
    child.stdout.on("data", onData);
    void exited.then(({ code }) => {
      clearTimeout(timer);
      reject(new Error(`setup console exited ${code} before starting: ${stdout}${stderr}`));
    });
  });
  return { child, ready, exited, output: () => stdout + stderr };
}

async function runOnce(environment, cwd) {
  const child = spawn(
    process.execPath,
    [cliEntry, "setup", "console", "--json", "--repository", REPOSITORY, "--repository-id", REPOSITORY_ID],
    { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  return { code, output: JSON.parse(stdout.split("\n")[0]) };
}

async function filesContaining(directory, marker) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    if ((await readFile(file)).includes(marker)) found.push(file);
  }
  return found;
}

async function main() {
  const browserPath = locateBrowser();
  if (browserPath === undefined) {
    blocked(
      "no Chromium-compatible browser was found (set INARI_SETUP_BROWSER, PLAYWRIGHT_BROWSERS_PATH, or install google-chrome/chromium)",
    );
  }
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    blocked("the playwright-core browser driver is not installed (run pnpm install)");
  }
  for (const file of [
    cliEntry,
    ...["index.html", "setup-console.js", "styles.css"].map((name) =>
      path.join(repoRoot, "dist", "setup-console", name),
    ),
  ]) {
    if (!existsSync(file))
      throw new Error(`built product file is missing: ${path.relative(repoRoot, file)}; run pnpm run build`);
  }
  const packagedAssets = readFileSync(path.join(repoRoot, "dist", "setup-console", "setup-console.js"), "utf8");

  const workspace = await mkdtemp(path.join(tmpdir(), "inari-setup-browser-"));
  const configHome = path.join(workspace, "config");
  const environment = { ...process.env, INARI_CONFIG_HOME: configHome, NO_COLOR: "1" };
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "INARI_GITHUB_APP_PRIVATE_KEY", "INARI_GITHUB_APP_PRIVATE_KEY_FILE"])
    delete environment[name];
  let host;
  let browser;
  try {
    host = startConsole(environment, workspace);
    const started = await host.ready;
    check(
      started.ok === true && started.reused === false,
      "setup console started on a clean configuration (no key, trust or Runtime)",
    );
    const origin = started.endpoint;
    check(/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin), `console bound a dynamic loopback origin (${origin})`);
    const discovery = JSON.parse(await readFile(path.join(configHome, "runtime", "endpoints", "setup.json"), "utf8"));
    check(
      discovery.endpoint === origin && discovery.id.startsWith("stp_"),
      "setup host announced itself through local discovery",
    );

    const repeated = await runOnce(environment, workspace);
    check(
      repeated.code === 0 && repeated.output.reused === true && repeated.output.endpoint === origin,
      "repeated start reuses the running host instead of starting another",
    );

    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext();
    const page = await context.newPage();
    const bootstrapResponse = page.waitForResponse((response) => response.url() === `${origin}/api/setup/bootstrap`);
    await page.goto(`${origin}/`);
    const bootstrap = await (await bootstrapResponse).json();
    check(
      typeof bootstrap.bearer === "string" && bootstrap.apiOrigin === origin,
      "page obtained the operator bootstrap from its own host",
    );
    await page.waitForSelector('[data-stage="clean"]', { timeout: 20_000 });
    check(true, "served console rendered the canonical clean setup state");
    const receiving = await page.textContent("[data-receiving-machine]");
    check(typeof receiving === "string" && receiving.trim().length > 0, "receiving machine is shown");

    const leaks = await page.evaluate(
      ({ bearer, csrf }) => ({
        url: location.href.includes(bearer) || location.href.includes(csrf),
        dom: document.documentElement.outerHTML.includes(bearer) || document.documentElement.outerHTML.includes(csrf),
        local: localStorage.length,
        session: sessionStorage.length,
        cookie: document.cookie,
      }),
      { bearer: bootstrap.bearer, csrf: bootstrap.csrf },
    );
    check(!leaks.url && !leaks.dom, "bearer/CSRF never appear in the URL or DOM");
    check(
      leaks.local === 0 && leaks.session === 0 && leaks.cookie === "",
      "bearer/CSRF are not persisted in storage or cookies",
    );
    check(!packagedAssets.includes(bootstrap.bearer), "static assets carry no operator credential");

    const crossSite = await fetch(`${origin}/api/setup/bootstrap`, {
      method: "POST",
      headers: { origin: "http://evil.example", "x-inari-setup-bootstrap": "1" },
    });
    const noHeader = await fetch(`${origin}/api/setup/bootstrap`, { method: "POST", headers: { origin } });
    const noBearer = await fetch(`${origin}/api/setup/state`);
    check(
      crossSite.status === 403 && noHeader.status === 403 && noBearer.status === 403,
      "cross-origin bootstrap, header-less bootstrap and unauthenticated API calls are refused",
    );

    const hostId = (await (await fetch(`${origin}/api/setup/host`)).json()).id;
    await page.reload();
    await page.waitForSelector('[data-stage="clean"]', { timeout: 20_000 });
    const afterReload = (await (await fetch(`${origin}/api/setup/host`)).json()).id;
    check(
      afterReload === hostId && hostId === discovery.id,
      "browser refresh reconnects to the same owned host instance",
    );

    // Real file chooser/upload through the enrollment transport; the owner must reject non-key bytes.
    const marker = `inari-browser-not-a-key-${Date.now()}`;
    await page.fill('input[data-input-kind="text"]', "123456");
    await page.setInputFiles('input[type="file"]', {
      name: "issuer.pem",
      mimeType: "application/x-pem-file",
      buffer: Buffer.from(marker),
    });
    await page.check("input[data-acknowledge]");
    await page.click('button[type="submit"]');
    await page.waitForSelector("[data-outcome]", { timeout: 30_000 });
    const outcome = await page.getAttribute("[data-outcome]", "data-outcome");
    const resultText = ((await page.textContent("#setup-result")) ?? "").replace(/\s+/gu, " ").trim();
    check(
      outcome === "failed" && resultText.includes("SETUP_ENROLLMENT_REJECTED"),
      `file chooser upload reached the Executor enrollment owner, which rejected non-key bytes (${resultText})`,
    );
    const pageText = await page.evaluate(() => document.documentElement.outerHTML);
    check(!pageText.includes(marker), "uploaded bytes are never rendered");
    check((await filesContaining(configHome, marker)).length === 0, "rejected upload bytes were not stored anywhere");

    await browser.close();
    browser = undefined;
    host.child.kill("SIGTERM");
    const exit = await host.exited;
    check(exit.code === 0 || exit.signal === "SIGTERM", "setup console shut down on SIGTERM");
    check(
      !existsSync(path.join(configHome, "runtime", "endpoints", "setup.json")),
      "shutdown removed only its own announcement",
    );
    const refused = await fetch(`${origin}/api/setup/host`).then(
      () => false,
      () => true,
    );
    check(refused, "shutdown closed the loopback listener");
    console.log(`setup browser tests: PASS (${checks} checks) using ${browserPath}`);
  } finally {
    await browser?.close().catch(() => undefined);
    if (host !== undefined && host.child.exitCode === null && host.child.signalCode === null)
      host.child.kill("SIGKILL");
    await rm(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`setup browser tests: FAIL - ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT_FAIL);
  });
}
