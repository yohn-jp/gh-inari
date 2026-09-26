import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { locateBrowser } from "../scripts/run-setup-browser-tests.mjs";
import { installPackedCli } from "./fixtures/setup/packed-cli.mjs";

function start(entry, cwd, env, args) {
  const child = spawn(process.execPath, [entry, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Installed setup console did not start.")), 20_000);
    child.stdout.on("data", () => {
      const line = stdout.split("\n")[0];
      if (!stdout.includes("\n")) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error("Installed setup console returned invalid startup metadata."));
      }
    });
    void exited.then(({ code }) => {
      clearTimeout(timer);
      reject(new Error(`Installed setup console exited before listening (${code}).`));
    });
  });
  return { child, ready, exited, stderr: () => stderr };
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

function keygen(file) {
  const result = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file], { encoding: "utf8" });
  assert.equal(result.status, 0, "isolated SSH certification key generation failed");
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit").catch(() => undefined);
}

function requestOverForward(localPort, destinationPort) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: localPort,
        path: "/",
        headers: { host: `127.0.0.1:${destinationPort}` },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8").on("data", (chunk) => (body += chunk));
        response.once("end", () => resolve({ status: response.statusCode, body }));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function startSshForward(root, destinationPort) {
  const hostKey = path.join(root, "sshd-host-key");
  const clientKey = path.join(root, "ssh-client-key");
  const authorizedKeys = path.join(root, "authorized_keys");
  const config = path.join(root, "sshd_config");
  keygen(hostKey);
  keygen(clientKey);
  await writeFile(authorizedKeys, await readFile(`${clientKey}.pub`, "utf8"), { mode: 0o600 });
  const sshdPort = await freePort();
  const localPort = await freePort();
  await writeFile(
    config,
    [
      `Port ${sshdPort}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${hostKey}`,
      `PidFile ${path.join(root, "sshd.pid")}`,
      `AuthorizedKeysFile ${authorizedKeys}`,
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PermitRootLogin no",
      "AllowTcpForwarding local",
      "StrictModes no",
      "UsePAM no",
      "UseDNS no",
      "LogLevel QUIET",
    ].join("\n"),
  );
  const validConfig = spawnSync("sshd", ["-t", "-f", config], { encoding: "utf8" });
  assert.equal(
    validConfig.status,
    0,
    `isolated sshd configuration rejected (${validConfig.status}): ${validConfig.stderr.trim()}`,
  );
  const sshdPath = spawnSync("which", ["sshd"], { encoding: "utf8" }).stdout.trim();
  assert.ok(path.isAbsolute(sshdPath), "sshd must resolve to an absolute executable path");
  const daemon = spawn(sshdPath, ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "pipe"] });
  let daemonDiagnostic = "";
  daemon.stderr.setEncoding("utf8").on("data", (chunk) => (daemonDiagnostic += chunk));
  const tunnel = spawn(
    "ssh",
    [
      "-N",
      "-p",
      String(sshdPort),
      "-L",
      `${localPort}:127.0.0.1:${destinationPort}`,
      "-i",
      clientKey,
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      `${os.userInfo().username}@127.0.0.1`,
    ],
    { stdio: "ignore" },
  );
  try {
    let lastError;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (daemon.exitCode !== null || tunnel.exitCode !== null) {
        throw new Error(
          `isolated SSH processes exited before forwarding (sshd=${daemon.exitCode}, ssh=${tunnel.exitCode}; ${daemonDiagnostic.trim().slice(0, 500)})`,
        );
      }
      try {
        const response = await requestOverForward(localPort, destinationPort);
        if (response.status === 200 && response.body.includes("Inari local setup")) {
          return {
            localPort,
            async close() {
              await Promise.all([stopChild(tunnel), stopChild(daemon)]);
            },
          };
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`isolated SSH forwarding did not reach the setup host (${lastError?.name ?? "timeout"})`);
  } catch (error) {
    await Promise.all([stopChild(tunnel), stopChild(daemon)]);
    throw error;
  }
}

test(
  "packed setup console certifies real Chromium controls, enrollment, refresh, denial, and narrow layout",
  { timeout: 120_000 },
  async () => {
    const browserPath = locateBrowser();
    assert.ok(browserPath, "BLOCKED / NOT CHECKED: no Chromium-compatible browser is installed");
    const { chromium } = await import("playwright-core");
    const packed = await installPackedCli();
    const root = await mkdtemp(path.join(os.tmpdir(), "inari-setup-browser-cert-"));
    const configHome = path.join(root, "config");
    const repository = "alternative-owner/renamed-project";
    const repositoryId = "44332211";
    const environment = { ...process.env, INARI_CONFIG_HOME: configHome, NO_COLOR: "1" };
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "INARI_GITHUB_APP_USER_CREDENTIAL_FILE",
      "INARI_RUNTIME_AUTHORITY_PRIVATE_KEY",
    ])
      delete environment[name];
    let host;
    let browser;
    let sshForward;
    try {
      host = start(packed.entry, root, environment, [
        "setup",
        "console",
        "--json",
        "--repository",
        repository,
        "--repository-id",
        repositoryId,
      ]);
      const started = await host.ready;
      assert.equal(started.operation, "setup.console");
      assert.equal(started.reused, false);
      assert.match(started.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/u);
      sshForward = await startSshForward(root, Number(new URL(started.endpoint).port));

      browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox"] });
      const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
      const page = await context.newPage();
      const bootstrapResponse = page.waitForResponse(
        (response) => response.url() === `${started.endpoint}/api/setup/bootstrap`,
      );
      await page.goto(`${started.endpoint}/`);
      const bootstrap = await (await bootstrapResponse).json();
      assert.equal(bootstrap.apiOrigin, started.endpoint);
      await page.waitForSelector('[data-stage="clean"]', { timeout: 15_000 });
      const narrowLayout = await page.evaluate(() => ({
        viewport: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        overflowing: [...document.querySelectorAll("body *")]
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName.toLowerCase(),
              id: element.id,
              className: typeof element.className === "string" ? element.className : "",
              width: Math.round(rect.width),
              right: Math.round(rect.right),
            };
          })
          .filter((element) => element.right > window.innerWidth)
          .slice(0, 5),
      }));
      assert.equal(await page.getAttribute("[data-stage]", "data-stage"), "clean");

      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("skip-link")), true);
      await page.keyboard.press("Enter");
      const appId = page.getByLabel(/Issuer App ID/u);
      await appId.pressSequentially("4242");

      const upload = page.locator('input[data-input-kind="enrollment"]');
      const chooserEvent = page.waitForEvent("filechooser");
      await upload.click();
      const chooser = await chooserEvent;
      await chooser.setFiles({
        name: "oversized.pem",
        mimeType: "application/x-pem-file",
        buffer: Buffer.alloc(1_048_577, 0x41),
      });
      await page.waitForSelector('[data-notice="enrollment-too-large"]');
      assert.doesNotMatch((await page.textContent(".field-file")) ?? "", /A file is selected/u);

      const validChooserEvent = page.waitForEvent("filechooser");
      await upload.click();
      const validChooser = await validChooserEvent;
      await validChooser.setFiles({
        name: "issuer.pem",
        mimeType: "application/x-pem-file",
        buffer: Buffer.from(
          generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }),
        ),
      });
      assert.match((await page.textContent(".field-file")) ?? "", /A file is selected \(\d+ bytes\)/u);

      const enrollmentResponse = page.waitForResponse(
        (response) => response.url() === `${started.endpoint}/api/setup/enrollment/issuer-key`,
      );
      const acknowledge = page.locator("input[data-acknowledge]");
      await acknowledge.focus();
      await page.keyboard.press("Space");
      await page.locator('button[type="submit"]').focus();
      await page.keyboard.press("Enter");
      const enrollment = await (await enrollmentResponse).json();
      assert.equal(enrollment.outcome, "succeeded", "the Executor enrollment owner accepted the selected PEM");

      const unauthenticated = await fetch(`${started.endpoint}/api/setup/state`);
      assert.equal(unauthenticated.status, 403);
      const refreshedBootstrap = await page.evaluate(async () => {
        const response = await fetch("/api/setup/bootstrap", {
          method: "POST",
          headers: { "x-inari-setup-bootstrap": "1" },
        });
        return response.json();
      });
      const authHeader = {
        authorization: `Bearer ${refreshedBootstrap.bearer}`,
        "x-csrf-token": refreshedBootstrap.csrf,
      };
      const stateResponse = await fetch(`${started.endpoint}/api/setup/state`, { headers: authHeader });
      assert.equal(stateResponse.status, 200, "a fresh browser bootstrap reads the new configuration generation");
      const state = await stateResponse.json();
      assert.deepEqual(state.repository, {
        repositoryHost: "github.com",
        repositoryId,
        nameWithOwner: repository,
      });
      const trust = state.dimensions.find((item) => item.dimension === "repository-trust")?.status;
      assert.notEqual(trust, "trusted", "clean setup does not preseed Authority trust");
      await page.getByRole("button", { name: "Refresh state" }).click();
      await page.waitForFunction(() => document.querySelector('[data-stage="partial"]') !== null);
      await page.reload();
      await page.waitForSelector('[data-stage="partial"]');
      const leaks = await page.evaluate(() => ({
        local: localStorage.length,
        session: sessionStorage.length,
        cookies: document.cookie,
        url: location.href,
      }));
      assert.equal(leaks.local, 0);
      assert.equal(leaks.session, 0);
      assert.equal(leaks.cookies, "");
      assert.equal(leaks.url.includes(refreshedBootstrap.bearer), false);
      await sshForward.close();
      sshForward = undefined;
      console.log("actual SSH forwarding: PASS through an isolated local sshd to the setup host");
      console.log(
        `packed package ${packed.identity.name}@${packed.identity.version}: actual Chromium ${await browser.version()} exercised keyboard controls, oversized-file denial, FileChooser enrollment, refresh, reload, unauthenticated denial, and alternative repository naming; provider trust is UNKNOWN without GitHub credentials; live GitHub/Cloudflare NOT CHECKED`,
      );
      assert.equal(
        narrowLayout.documentWidth <= narrowLayout.viewport,
        true,
        `PRODUCTION_BLOCKER: packed setup console overflows narrow viewport: ${JSON.stringify(narrowLayout)}`,
      );
    } finally {
      await browser?.close().catch(() => undefined);
      await sshForward?.close().catch(() => undefined);
      if (host !== undefined && host.child.exitCode === null && host.child.signalCode === null) {
        host.child.kill("SIGTERM");
        await host.exited;
      }
      assert.ok(host === undefined || host.stderr().length < 256 * 1024, "server diagnostics remained bounded");
      await rm(root, { recursive: true, force: true });
      await packed.cleanup();
    }
  },
);

test("packed browser recovers a legacy profile and publishes first trust PR", { timeout: 120_000 }, async () => {
  const browserPath = locateBrowser();
  assert.ok(browserPath, "BLOCKED / NOT CHECKED: no Chromium-compatible browser is installed");
  const { chromium } = await import("playwright-core");
  const packed = await installPackedCli();
  const checkout = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const root = await mkdtemp(path.join(path.dirname(checkout), "inari-setup-browser-upgrade-cert-"));
  const workspace = path.join(root, "workspace");
  const configHome = path.join(root, "config");
  const providerState = path.join(root, "provider-state.json");
  const providerLog = path.join(root, "provider-log.jsonl");
  const preload = fileURLToPath(new URL("./fixtures/setup/provider-preload.mjs", import.meta.url));
  const repository = "cert-owner/renamed-project";
  const environment = {
    ...process.env,
    INARI_CONFIG_HOME: configHome,
    INARI_SETUP_PROVIDER_STATE: providerState,
    INARI_SETUP_PROVIDER_LOG: providerLog,
    NODE_OPTIONS: `--import=${preload}`,
    NO_COLOR: "1",
  };
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "INARI_GITHUB_APP_USER_CREDENTIAL_FILE",
    "INARI_RUNTIME_AUTHORITY_PRIVATE_KEY",
  ])
    delete environment[name];
  const run = (...args) => {
    const result = spawnSync(process.execPath, [packed.entry, ...args], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stdout} ${result.stderr}`);
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
  };
  let host;
  let browser;
  try {
    await mkdir(workspace);
    await mkdir(configHome);
    await writeFile(providerState, JSON.stringify({ merged: false, trustUnavailable: true }));
    await writeFile(providerLog, "");
    await writeFile(
      path.join(configHome, "app-user-credential.json"),
      JSON.stringify({
        version: 1,
        access_token: "setup-cert-user-token",
        refresh_token: "setup-cert-refresh-token",
        access_token_expires_at: "2099-01-01T00:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    const templateDirectory = path.join(workspace, ".github", "inari", "pull-requests");
    await mkdir(templateDirectory, { recursive: true });
    await writeFile(
      path.join(templateDirectory, "authority.json"),
      await readFile(path.join(checkout, ".github", "inari", "pull-requests", "authority.json")),
    );
    const privateKey = path.join(configHome, "runtime-keys", "legacy.pem");
    run("authority", "generate", "--json", "--private-key", privateKey);
    run(
      "authority",
      "bootstrap",
      "--json",
      "--authority-id",
      "runtime-browser-upgrade",
      "--private-key",
      privateKey,
      "--output",
      "authority.json",
      "--max-session-ttl-seconds",
      "1800",
      "--capability",
      "change.implement",
    );
    run("authority", "register", "--json", "--from", "authority.json");
    const legacy = run(
      "setup",
      "--json",
      "--repository",
      repository,
      "--endpoint",
      "https://endpoint.example.test",
      "--authority-id",
      "runtime-browser-upgrade",
      "--private-key",
      privateKey,
    );
    assert.equal(legacy.state, "trust-pending");
    assert.equal(legacy.publication, undefined);
    const initialProviderState = JSON.parse(await readFile(providerState, "utf8"));
    assert.equal(initialProviderState.pr, undefined);
    await writeFile(providerState, JSON.stringify({ ...initialProviderState, trustUnavailable: false }));
    const issuer = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const issuerPublicKeyFile = path.join(root, "issuer-public.pem");
    await writeFile(issuerPublicKeyFile, issuer.publicKey.export({ type: "spki", format: "pem" }));
    environment.INARI_SETUP_ISSUER_PUBLIC_KEY = issuerPublicKeyFile;
    host = start(packed.entry, workspace, environment, [
      "setup",
      "console",
      "--json",
      "--repository",
      repository,
      "--repository-id",
      "44332211",
    ]);
    const started = await host.ready;
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${started.endpoint}/`);
    await page.waitForSelector('form.action[data-action-id^="executor.configure:"]');
    await page.getByLabel(/Issuer App ID/u).fill("4242");
    const chooserEvent = page.waitForEvent("filechooser");
    await page.locator('input[data-input-kind="enrollment"]').click();
    await (
      await chooserEvent
    ).setFiles({
      name: "issuer.pem",
      mimeType: "application/x-pem-file",
      buffer: Buffer.from(issuer.privateKey.export({ type: "pkcs8", format: "pem" })),
    });
    await page.locator('form.action[data-action-id^="executor.configure:"] input[data-acknowledge]').check();
    const enrollmentResponse = page.waitForResponse(
      (response) => response.url() === `${started.endpoint}/api/setup/enrollment/issuer-key`,
    );
    await page.locator('form.action[data-action-id^="executor.configure:"] button[type="submit"]').click();
    assert.equal((await (await enrollmentResponse).json()).outcome, "succeeded");
    const complete = page.locator('form.action[data-action-id^="composition.complete-configuration:"]');
    await complete.waitFor();
    const profileDirectory = path.dirname(legacy.profilePath);
    await chmod(profileDirectory, 0o500);
    let interrupted;
    try {
      await complete.locator("input[data-acknowledge]").check();
      const interruptedResponse = page.waitForResponse(
        (response) => response.url() === `${started.endpoint}/api/setup/actions`,
      );
      await complete.locator('button[type="submit"]').click();
      interrupted = await (await interruptedResponse).json();
    } finally {
      await chmod(profileDirectory, 0o700);
    }
    assert.equal(interrupted.outcome, "unknown");
    assert.ok(interrupted.diagnostics.some((item) => item.code === "SETUP_MIGRATION_RECOVERY_REQUIRED"));
    assert.equal(JSON.parse(await readFile(legacy.profilePath, "utf8")).authority.privateKeyPath, privateKey);
    await complete.waitFor();
    await complete.locator("input[data-acknowledge]").check();
    const recoveryResponse = page.waitForResponse(
      (response) => response.url() === `${started.endpoint}/api/setup/actions`,
    );
    await complete.locator('button[type="submit"]').click();
    const recovered = await (await recoveryResponse).json();
    assert.equal(recovered.outcome, "succeeded", JSON.stringify(recovered.diagnostics));
    const profile = JSON.parse(await readFile(legacy.profilePath, "utf8"));
    assert.equal(profile.authority.authorityId, "runtime-browser-upgrade");
    assert.equal(profile.authority.privateKeyPath, path.join(configHome, "authority", "private-key.pem"));
    assert.equal(profile.authority.publicKeyFingerprint, legacy.authority.publicKeyFingerprint);
    await page.reload();
    const bind = page.locator('form.action[data-action-id^="executor.bind-repository:"]');
    await bind.waitFor();
    await bind.locator("input[data-acknowledge]").check();
    const bindResponse = page.waitForResponse((response) => response.url() === `${started.endpoint}/api/setup/actions`);
    await bind.locator('button[type="submit"]').click();
    const binding = await (await bindResponse).json();
    assert.equal(binding.outcome, "succeeded", JSON.stringify(binding.diagnostics));
    const publication = page.locator('form.action[data-action-id^="authority.publish-trust:"]');
    await publication.waitFor();
    const untrustedCli = run("setup", "status", "--json", "--repository", repository, "--repository-id", "44332211");
    assert.equal(
      untrustedCli.state.dimensions.find((item) => item.dimension === "repository-trust")?.status,
      "untrusted",
    );
    await publication.locator("input[data-acknowledge]").check();
    const publicationResponse = page.waitForResponse(
      (response) => response.url() === `${started.endpoint}/api/setup/actions`,
    );
    await publication.locator('button[type="submit"]').click();
    const published = await (await publicationResponse).json();
    assert.equal(published.outcome, "succeeded", JSON.stringify(published.diagnostics));
    assert.ok(published.diagnostics.some((item) => item.code === "SETUP_TRUST_PUBLICATION_PENDING"));
    const pending = JSON.parse(await readFile(providerState, "utf8"));
    assert.equal(pending.pr, true);
    assert.equal(pending.merged, false);
    await page.waitForSelector('[data-stage="pending-human-trust"]');
    await writeFile(providerState, JSON.stringify({ ...pending, merged: true }));
    await page.getByRole("button", { name: "Refresh state" }).click();
    const bootstrap = await page.evaluate(async () =>
      (
        await fetch("/api/setup/bootstrap", {
          method: "POST",
          headers: { "x-inari-setup-bootstrap": "1" },
        })
      ).json(),
    );
    const stateResponse = await fetch(`${started.endpoint}/api/setup/state`, {
      headers: { authorization: `Bearer ${bootstrap.bearer}`, "x-csrf-token": bootstrap.csrf },
    });
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal(state.dimensions.find((item) => item.dimension === "repository-trust")?.status, "trusted");
    const trustedCli = run("setup", "status", "--json", "--repository", repository, "--repository-id", "44332211");
    assert.equal(trustedCli.state.dimensions.find((item) => item.dimension === "repository-trust")?.status, "trusted");
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-stage="pending-human-trust"]') === null);
    console.log(
      "packed Chromium legacy migration, injected partial failure, recovery, first trust publication, and provider-side merge trust recheck: PASS",
    );
  } finally {
    await browser?.close().catch(() => undefined);
    if (host !== undefined && host.child.exitCode === null && host.child.signalCode === null) {
      host.child.kill("SIGTERM");
      await host.exited;
    }
    await rm(root, { recursive: true, force: true });
    await packed.cleanup();
  }
});
