import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTOR_OBSERVATION_VERSION,
  MAX_EXECUTOR_OBSERVED_APPS,
  MAX_EXECUTOR_OBSERVED_BINDINGS,
  orderExecutorObservation,
  validateExecutorObservation,
} from "./executor-observation.js";

const FINGERPRINT = `sha256:${"a".repeat(64)}`;
const app = (appId: string, source: "app-scoped" | "legacy" = "app-scoped") => ({
  appId,
  generation: `generation-${appId.padStart(8, "0")}`,
  fingerprint: FINGERPRINT,
  providerVerified: true,
  source,
});
const binding = (repositoryId: string, appId = "123") => ({
  repositoryHost: "github.com",
  repositoryId,
  nameWithOwner: `acme/repo-${repositoryId}`,
  appId,
  installationId: "77",
  generation: `generation-${appId.padStart(8, "0")}`,
  fingerprint: FINGERPRINT,
  status: "bound" as const,
  source: "app-scoped" as const,
});
const valid = {
  version: EXECUTOR_OBSERVATION_VERSION,
  executorId: "exec_0123456789abcdef",
  apps: [app("123"), app("456", "legacy")],
  bindings: [binding("101"), binding("202", "456")],
};

test("#1223 a closed, ordered, secret-free observation validates to a frozen copy", () => {
  const observation = validateExecutorObservation(JSON.parse(JSON.stringify(valid)));
  assert.deepEqual(observation, valid);
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(Object.isFrozen(observation.apps[0]), true);
  assert.deepEqual(validateExecutorObservation({ ...valid, apps: [], bindings: [] }).apps, []);
  // Producers get the deterministic order from one helper.
  assert.deepEqual(
    orderExecutorObservation({
      executorId: valid.executorId,
      apps: [app("456", "legacy"), app("123")],
      bindings: [binding("202", "456"), binding("101")],
    }),
    valid,
  );
});

test("#1223 unknown, missing or secret-bearing members and unsupported versions are rejected", () => {
  const rejects = (value: unknown) => assert.throws(() => validateExecutorObservation(value));
  rejects({ ...valid, version: 2 });
  rejects({ ...valid, extra: true });
  const { bindings: _omitted, ...missing } = valid;
  rejects(missing);
  rejects({ ...valid, executorId: "adm_0123456789abcdef" });
  rejects({ ...valid, apps: [{ ...app("123"), file: "issuer-generation.pem" }] });
  rejects({ ...valid, apps: [{ ...app("123"), privateKey: "x" }] });
  rejects({ ...valid, apps: [{ ...app("123"), providerVerified: "yes" }] });
  rejects({ ...valid, apps: [{ ...app("123"), source: "file" }] });
  rejects({ ...valid, bindings: [{ ...binding("101"), status: "unknown" }] });
  rejects({ ...valid, bindings: [{ ...binding("101"), keyPath: "/home/user/.config/inari/executor/apps/123" }] });
  rejects({ ...valid, bindings: [{ ...binding("101"), nameWithOwner: "-----BEGIN PRIVATE KEY-----" }] });
  rejects({ ...valid, bindings: [{ ...binding("101"), repositoryId: "0101" }] });
  rejects({ ...valid, bindings: [{ ...binding("101"), fingerprint: "sha256:ABC" }] });
});

test("#1223 duplicates, disorder and oversized owner state fail closed", () => {
  const rejects = (value: unknown) => assert.throws(() => validateExecutorObservation(value));
  rejects({ ...valid, apps: [app("123"), app("123", "legacy")] });
  rejects({ ...valid, apps: [app("456"), app("123")] });
  rejects({ ...valid, bindings: [binding("202"), binding("101")] });
  rejects({ ...valid, bindings: [binding("101"), binding("101", "456")] });
  rejects({
    ...valid,
    apps: Array.from({ length: MAX_EXECUTOR_OBSERVED_APPS + 1 }, (_, index) => app(String(index + 1))),
  });
  rejects({
    ...valid,
    bindings: Array.from({ length: MAX_EXECUTOR_OBSERVED_BINDINGS + 1 }, (_, index) => binding(String(index + 1))),
  });
});
