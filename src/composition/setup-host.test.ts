import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OperatorSession } from "../console/operator-session.js";
import { SETUP_CONSOLE_ASSETS } from "../console/public-assets.js";
import {
  localRuntimeDiscoveryPath,
  publishLocalRuntimeEndpoint,
  readLocalRuntimeEndpoint,
} from "../local-control/runtime-discovery.js";
import {
  LocalRuntimeSupervisorError,
  type LocalRuntimeProbe,
  type SupervisedLocalRuntime,
} from "../local-control/supervisor.js";
import { LocalRuntimeProfileStore } from "../local-runtime-profile.js";
import { MAX_SECRET_ENROLLMENT_BYTES, SETUP_CONTRACT_VERSION } from "../runtime-contracts/index.js";
import {
  SETUP_HOST_BOOTSTRAP_HEADER,
  SETUP_HOST_BOOTSTRAP_PATH,
  SetupHostError,
  createFileEnrollmentSource,
  createLocalSetupApplication,
  createObservedRuntimeLifecycle,
  createOwnedRuntimeLifecycle,
  findLiveSetupHost,
  resolveSetupRepository,
  startSetupHost,
} from "./setup-host.js";

const repository = { repositoryHost: "github.com", repositoryId: "1330755860", nameWithOwner: "yohn-jp/gh-inari" };
const generation = { repository, configuration: "cfg-0123456789abcdef" };
const request = { operationId: "op-1", generation };

function world(): { root: string; environment: NodeJS.ProcessEnv; assets: string; cleanup(): void } {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-setup-host-"));
  const assets = path.join(root, "assets");
  mkdirSync(assets);
  for (const item of SETUP_CONSOLE_ASSETS) writeFileSync(path.join(assets, item.file), `asset:${item.file}`);
  return {
    root,
    assets,
    environment: { INARI_CONFIG_HOME: path.join(root, "config") },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

interface FakeRuntime extends SupervisedLocalRuntime {
  readonly stops: () => number;
  crash(component: "executor" | "admission"): void;
}

function fakeRuntime(): FakeRuntime {
  let stops = 0;
  let exit: (value: { component: "executor" | "admission"; code: number | null; signal: null }) => void = () => {};
  const exited = new Promise<{ component: "executor" | "admission"; code: number | null; signal: null }>(
    (resolve) => (exit = resolve),
  );
  return {
    executorId: "exec_0123456789abcdef",
    admissionId: "adm_0123456789abcdef",
    exited,
    stop: async () => {
      stops += 1;
      exit({ component: "executor", code: 0, signal: null });
      return false;
    },
    stops: () => stops,
    crash: (component) => exit({ component, code: 1, signal: null }),
  };
}

function fakeSupervisor(initial: LocalRuntimeProbe["status"] = "not-running") {
  let status: LocalRuntimeProbe["status"] = initial;
  const started: FakeRuntime[] = [];
  return {
    started,
    set: (next: LocalRuntimeProbe["status"]) => (status = next),
    probe: async (): Promise<LocalRuntimeProbe> => ({ status }),
    start: async (): Promise<SupervisedLocalRuntime> => {
      // Yield so concurrent callers would interleave if starts were not serialized.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const runtime = fakeRuntime();
      started.push(runtime);
      status = "healthy";
      return runtime;
    },
  };
}

test("owned Runtime lifecycle starts once, reuses on repeated start and never duplicates children", async () => {
  const supervisor = fakeSupervisor();
  const lifecycle = createOwnedRuntimeLifecycle({ probe: supervisor.probe, start: supervisor.start });
  assert.equal((await lifecycle.observe(generation)).status, "not-running");
  const [first, second] = await Promise.all([lifecycle.start(request), lifecycle.start(request)]);
  assert.equal(first.outcome, "succeeded");
  assert.equal(second.outcome, "succeeded");
  assert.equal(second.diagnostics[0]?.code, "SETUP_RUNTIME_ALREADY_OWNED");
  assert.equal(supervisor.started.length, 1);
  assert.equal(lifecycle.owns(), true);
  const observed = await lifecycle.observe(generation);
  assert.equal(observed.status, "healthy");
  assert.equal(observed.generation, generation.configuration);

  const restarted = await lifecycle.restart(request);
  assert.equal(restarted.outcome, "succeeded");
  assert.equal(supervisor.started.length, 2);
  assert.equal(supervisor.started[0]!.stops(), 1);

  await lifecycle.shutdown();
  assert.equal(supervisor.started[1]!.stops(), 1);
  assert.equal(lifecycle.owns(), false);
  assert.equal((await lifecycle.start(request)).diagnostics[0]?.code, "SETUP_HOST_CLOSED");
  assert.equal(supervisor.started.length, 2);
});

test("owned Runtime lifecycle never adopts, restarts or kills a Runtime it did not start", async () => {
  const healthy = fakeSupervisor("healthy");
  const reuse = createOwnedRuntimeLifecycle({ probe: healthy.probe, start: healthy.start });
  const reused = await reuse.start(request);
  assert.equal(reused.outcome, "succeeded");
  assert.equal(reused.diagnostics[0]?.code, "SETUP_RUNTIME_ALREADY_RUNNING");
  assert.equal(healthy.started.length, 0);
  assert.equal(reuse.owns(), false);
  const restart = await reuse.restart(request);
  assert.equal(restart.outcome, "failed");
  assert.equal(restart.diagnostics[0]?.code, "SETUP_RUNTIME_NOT_OWNED");
  await reuse.shutdown();

  const foreign = fakeSupervisor("unhealthy");
  const blocked = createOwnedRuntimeLifecycle({ probe: foreign.probe, start: foreign.start });
  const refused = await blocked.start(request);
  assert.equal(refused.outcome, "failed");
  assert.equal(refused.diagnostics[0]?.code, "SETUP_RUNTIME_NOT_OWNED");
  assert.equal(foreign.started.length, 0);
});

test("owned Runtime lifecycle reports child crashes and start failures truthfully", async () => {
  const supervisor = fakeSupervisor();
  const lifecycle = createOwnedRuntimeLifecycle({ probe: supervisor.probe, start: supervisor.start });
  await lifecycle.start(request);
  supervisor.set("not-running");
  supervisor.started[0]!.crash("admission");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(lifecycle.owns(), false);
  const observed = await lifecycle.observe(generation);
  assert.equal(observed.status, "not-running");
  assert.equal(observed.diagnostics.at(-1)?.code, "SETUP_RUNTIME_CHILD_EXITED");
  // Recovery: a new start after the crash is permitted and owned again.
  assert.equal((await lifecycle.start(request)).outcome, "succeeded");
  assert.equal(supervisor.started.length, 2);
  await lifecycle.shutdown();

  const failing = createOwnedRuntimeLifecycle({
    probe: async () => ({ status: "not-running" }),
    start: async () => {
      throw new LocalRuntimeSupervisorError("LOCAL_RUNTIME_SUPERVISOR_CHILD_FAILED", "executor failed to start.");
    },
  });
  const failed = await failing.start(request);
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.diagnostics[0]?.code, "LOCAL_RUNTIME_SUPERVISOR_CHILD_FAILED");
  const unconfirmed = createOwnedRuntimeLifecycle({
    probe: async () => ({ status: "not-running" }),
    start: async () => {
      throw new LocalRuntimeSupervisorError("LOCAL_RUNTIME_SUPERVISOR_SHUTDOWN_FAILED", "child did not stop.");
    },
  });
  assert.equal((await unconfirmed.start(request)).outcome, "unknown");
});

test("CLI Runtime lifecycle only observes and names the owning entrypoints", async () => {
  const lifecycle = createObservedRuntimeLifecycle({ probe: async () => ({ status: "not-running" }) });
  const observed = await lifecycle.observe(generation);
  assert.equal(observed.status, "not-running");
  assert.equal(observed.generation, generation.configuration);
  for (const result of [await lifecycle.start(request), await lifecycle.restart(request)]) {
    assert.equal(result.outcome, "failed");
    assert.equal(result.diagnostics[0]?.code, "SETUP_RUNTIME_OWNER_REQUIRED");
    assert.match(result.diagnostics[0]!.message, /inari setup console/u);
  }
});

test("repository identity resolves without credentials: explicit, recorded profile, then public read", async () => {
  const fixture = world();
  try {
    const explicit = await resolveSetupRepository({
      root: fixture.root,
      environment: fixture.environment,
      repository: "yohn-jp/gh-inari",
      repositoryId: "77",
    });
    assert.deepEqual(explicit, { repositoryHost: "github.com", nameWithOwner: "yohn-jp/gh-inari", repositoryId: "77" });
    await assert.rejects(
      resolveSetupRepository({ root: fixture.root, repository: "yohn-jp/gh-inari", repositoryId: "x1" }),
      (error: unknown) => error instanceof SetupHostError && error.code === "SETUP_REPOSITORY_ID_INVALID",
    );

    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const publicFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: 1330755860, full_name: "yohn-jp/gh-inari" }), { status: 200 });
    }) as typeof fetch;
    const read = await resolveSetupRepository({
      root: fixture.root,
      environment: fixture.environment,
      repository: "yohn-jp/gh-inari",
      fetch: publicFetch,
    });
    assert.equal(read.repositoryId, "1330755860");
    assert.equal(requests[0]?.url, "https://api.github.com/repos/yohn-jp/gh-inari");
    assert.equal(new Headers(requests[0]?.init?.headers).has("authorization"), false);

    const denied = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    await assert.rejects(
      resolveSetupRepository({
        root: fixture.root,
        environment: fixture.environment,
        repository: "yohn-jp/private",
        fetch: denied,
      }),
      (error: unknown) => error instanceof SetupHostError && error.code === "SETUP_REPOSITORY_ID_REQUIRED",
    );

    await new LocalRuntimeProfileStore({ environment: fixture.environment }).save({
      version: 1,
      state: "trust-pending",
      endpoint: "https://runtime.example.test",
      relayUrl: "wss://runtime.example.test/relay",
      repository: { repositoryHost: "github.com", repositoryId: "9001", repositoryNameWithOwner: "yohn-jp/private" },
      app: { appId: "4242", installationId: "77" },
      authority: {
        authorityId: "local-authority",
        publicKeyFingerprint: `sha256:${"a".repeat(64)}`,
        privateKeyPath: path.join(fixture.root, "authority.pem"),
      },
    });
    const recorded = await resolveSetupRepository({
      root: fixture.root,
      environment: fixture.environment,
      repository: "yohn-jp/private",
      fetch: denied,
    });
    assert.equal(recorded.repositoryId, "9001");
  } finally {
    fixture.cleanup();
  }
});

test("CLI enrollment source streams the file reference opaquely and bounds its size", async () => {
  const fixture = world();
  try {
    const file = path.join(fixture.root, "key.pem");
    writeFileSync(file, "opaque-bytes");
    const source = createFileEnrollmentSource(fixture.root);
    const upload = await source.open("key.pem", {
      id: "issuer-key",
      kind: "enrollment",
      label: "Key",
      required: true,
      enrollment: "executor-issuer-private-key",
    });
    assert.equal(upload.declaredBytes, 12);
    const chunks: Uint8Array[] = [];
    for await (const chunk of upload.stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString("utf8"), "opaque-bytes");
    assert.throws(
      () => source.open(fixture.root, { id: "k", kind: "enrollment", label: "Key", required: true }),
      (error: unknown) => error instanceof SetupHostError && error.code === "SETUP_ENROLLMENT_FILE_UNREADABLE",
    );
    writeFileSync(file, Buffer.alloc(MAX_SECRET_ENROLLMENT_BYTES + 1));
    assert.throws(
      () => source.open("key.pem", { id: "k", kind: "enrollment", label: "Key", required: true }),
      (error: unknown) => error instanceof SetupHostError && error.code === "SETUP_ENROLLMENT_FILE_INVALID",
    );
  } finally {
    fixture.cleanup();
  }
});

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("setup host starts before enrollment/trust/Runtime, serves assets and delivers bootstrap only same-origin", async () => {
  const fixture = world();
  let shutdowns = 0;
  const lifecycle = createObservedRuntimeLifecycle({
    environment: fixture.environment,
    probe: async () => ({ status: "not-running" }),
  });
  const application = createLocalSetupApplication({ environment: fixture.environment, root: fixture.root, lifecycle });
  const host = await startSetupHost({
    application,
    repository,
    environment: fixture.environment,
    assetDirectory: fixture.assets,
    receivingMachine: "operator-box",
    lifecycle: { shutdown: async () => void (shutdowns += 1) },
  });
  try {
    const { origin } = host;
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.deepEqual(readLocalRuntimeEndpoint("setup", fixture.environment), host.announcement);
    assert.deepEqual(await findLiveSetupHost(fixture.environment), host.announcement);

    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "asset:index.html");
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/u);
    assert.equal((await fetch(`${origin}/`, { method: "HEAD" })).status, 200);
    assert.equal((await fetch(`${origin}/unknown`)).status, 404);
    // DNS-rebinding guard: a request carrying a foreign Host is refused.
    const rebound = await new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(`${origin}/`, { headers: { host: "attacker.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      outgoing.once("error", reject);
      outgoing.end();
    });
    assert.equal(rebound, 403);

    const bootstrap = (headers: Record<string, string>) =>
      fetch(`${origin}${SETUP_HOST_BOOTSTRAP_PATH}`, { method: "POST", headers });
    assert.equal((await bootstrap({ origin, [SETUP_HOST_BOOTSTRAP_HEADER]: "0" })).status, 403);
    assert.equal((await bootstrap({ [SETUP_HOST_BOOTSTRAP_HEADER]: "1" })).status, 403);
    assert.equal((await bootstrap({ origin: "http://evil.example", [SETUP_HOST_BOOTSTRAP_HEADER]: "1" })).status, 403);
    assert.equal(
      (await bootstrap({ origin, [SETUP_HOST_BOOTSTRAP_HEADER]: "1", "sec-fetch-site": "cross-site" })).status,
      403,
    );
    assert.equal((await fetch(`${origin}${SETUP_HOST_BOOTSTRAP_PATH}`)).status, 403);

    const granted = await bootstrap({ origin, [SETUP_HOST_BOOTSTRAP_HEADER]: "1", "sec-fetch-site": "same-origin" });
    assert.equal(granted.status, 200);
    assert.equal(granted.headers.get("cache-control"), "no-store");
    const first = (await granted.json()) as Record<string, string>;
    assert.deepEqual(Object.keys(first).sort(), ["apiOrigin", "bearer", "csrf", "receivingMachine"]);
    assert.equal(first.apiOrigin, origin);
    assert.equal(first.receivingMachine, "operator-box");

    const state = await fetch(`${origin}/api/setup/state`, {
      headers: { authorization: `Bearer ${first.bearer}`, "x-csrf-token": first.csrf! },
    });
    assert.equal(state.status, 200);
    const body = (await state.json()) as { stage: string; version: number };
    assert.equal(body.stage, "clean");
    assert.equal(body.version, SETUP_CONTRACT_VERSION);
    assert.equal(JSON.stringify(body).includes(first.bearer!), false);

    // A second tab (or a refresh) gets its own session; the first stays valid.
    const second = (await (await bootstrap({ origin, [SETUP_HOST_BOOTSTRAP_HEADER]: "1" })).json()) as Record<
      string,
      string
    >;
    assert.notEqual(second.bearer, first.bearer);
    for (const session of [first, second]) {
      const response = await fetch(`${origin}/api/setup/state`, {
        headers: { authorization: `Bearer ${session.bearer}`, "x-csrf-token": session.csrf! },
      });
      assert.equal(response.status, 200);
    }
    assert.equal((await fetch(`${origin}/api/setup/state`)).status, 403);
    const forged = new OperatorSession(repository, "cfg-forged");
    assert.equal(
      (
        await fetch(`${origin}/api/setup/state`, {
          headers: { authorization: `Bearer ${forged.context.bearer}`, "x-csrf-token": forged.context.csrf },
        })
      ).status,
      403,
    );
  } finally {
    await host.close();
  }
  assert.equal(shutdowns, 1);
  assert.equal(existsSync(localRuntimeDiscoveryPath("setup", fixture.environment)), false);
  assert.equal(await findLiveSetupHost(fixture.environment), undefined);
  await assert.rejects(fetch(`${host.origin}/`));
  fixture.cleanup();
});

test("setup host shutdown removes only its own announcement; stale announcements are not reused", async () => {
  const fixture = world();
  try {
    const stalePort = await closedPort();
    publishLocalRuntimeEndpoint("setup", "stp_0123456789abcdefgh", stalePort, fixture.environment);
    assert.equal(await findLiveSetupHost(fixture.environment), undefined);

    const application = createLocalSetupApplication({
      environment: fixture.environment,
      root: fixture.root,
      lifecycle: createObservedRuntimeLifecycle({ probe: async () => ({ status: "not-running" }) }),
    });
    const host = await startSetupHost({
      application,
      repository,
      environment: fixture.environment,
      assetDirectory: fixture.assets,
    });
    // Another instance replaced the announcement; this host must not remove it on close.
    const other = publishLocalRuntimeEndpoint("setup", "stp_abcdefghijklmnop0123", stalePort, fixture.environment);
    await host.close();
    assert.deepEqual(readLocalRuntimeEndpoint("setup", fixture.environment), other);

    await assert.rejects(
      startSetupHost({
        application,
        repository,
        environment: fixture.environment,
        assetDirectory: path.join(fixture.root, "missing"),
      }),
      (error: unknown) => error instanceof SetupHostError && error.code === "SETUP_HOST_ASSETS_MISSING",
    );
  } finally {
    fixture.cleanup();
  }
});
