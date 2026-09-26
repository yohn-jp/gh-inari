import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { localExecutorAppId, localExecutorIssuerKeyStatus } from "../../local-control/executor-server.js";
import { publishLocalRuntimeEndpoint } from "../../local-control/runtime-discovery.js";
import {
  localExecutorAppIdReference,
  localExecutorIssuerKeyReferenceStatus,
  probeLocalRuntimeRoleHealth,
} from "./role-status.js";

const ENVIRONMENTS: readonly NodeJS.ProcessEnv[] = [
  {},
  { INARI_GITHUB_APP_ID: "12345" },
  { INARI_GITHUB_APP_ID: " 12345 " },
  { GITHUB_APP_ID: "678" },
  { INARI_GITHUB_APP_ID: "0" },
  { INARI_GITHUB_APP_ID: "abc", GITHUB_APP_ID: "9" },
  { INARI_GITHUB_APP_PRIVATE_KEY_FILE: "/nonexistent/issuer.pem" },
  { GITHUB_APP_PRIVATE_KEY_FILE: "  " },
  { GITHUB_APP_PRIVATE_KEY_FILE: "/nonexistent/issuer.pem" },
  { INARI_GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\ninline\n-----END PRIVATE KEY-----\n" },
  { GITHUB_APP_PRIVATE_KEY: "inline" },
];

test("public Executor role status matches the Executor owner without loading its credential code", () => {
  for (const environment of ENVIRONMENTS) {
    assert.equal(
      localExecutorAppIdReference(environment),
      localExecutorAppId(environment),
      JSON.stringify(environment),
    );
    assert.equal(
      localExecutorIssuerKeyReferenceStatus(environment),
      localExecutorIssuerKeyStatus(environment),
      JSON.stringify(environment),
    );
  }
});

test("Runtime role health is reported in the health setup dimension vocabulary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-role-status-"));
  const environment = { INARI_CONFIG_HOME: path.join(root, "config") };
  let body: unknown = { readiness: "ready" };
  let status = 200;
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  try {
    assert.equal(await probeLocalRuntimeRoleHealth("executor", environment), "not-running");
    assert.equal(await probeLocalRuntimeRoleHealth("admission", environment), "not-running");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    publishLocalRuntimeEndpoint("admission", "adm_0123456789abcdef", port, environment);
    assert.equal(await probeLocalRuntimeRoleHealth("admission", environment), "healthy");
    body = { readiness: "starting" };
    assert.equal(await probeLocalRuntimeRoleHealth("admission", environment), "unhealthy");
    status = 503;
    body = { readiness: "ready" };
    assert.equal(await probeLocalRuntimeRoleHealth("admission", environment), "unhealthy");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
