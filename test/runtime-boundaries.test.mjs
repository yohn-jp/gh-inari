import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  HISTORICAL_MIGRATION_EDGES,
  MIGRATION_EDGE_OWNERS,
  evaluateRuntimeBoundaries,
  validateMigrationLedger,
} from "../scripts/check-runtime-boundaries.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Frozen baseline ledger at 569c2399 (#1105). Migration leaves may only remove
 * entries from the guard; any entry outside this list fails.
 */
const FROZEN_BASELINE_LEDGER = Object.freeze(
  [
    ["src/local-control/executor-server.ts", "src/github/app-user-credential.ts", "#1106"],
    ["src/local-control/executor-server.ts", "src/github/app-user-credential-broker.ts", "#1106"],
    ["src/local-control/executor-server.ts", "src/github/app-user-credential-store.ts", "#1106"],
    ["src/local-control/executor-server.ts", "src/github/gh-auth-credential.ts", "#1106"],
    ["src/local-control/executor-server.ts", "src/github/user-credential.ts", "#1106"],
    ["src/local-control/admission-client.ts", "src/local-control/admission-server.ts", "#1108"],
    ["src/local-control/admission-client.ts", "src/local-control/session-store.ts", "#1108"],
    ["src/local-application-state.ts", "src/github/app-installation-credential-broker.ts", "#1108"],
    ["src/local-application-state.ts", "src/local-control/admission-server.ts", "#1108"],
    ["src/local-application-state.ts", "src/local-control/executor-server.ts", "#1108"],
    ["src/local-application-state.ts", "src/local-control/session-store.ts", "#1108"],
    ["src/local-application-state.ts", "src/relay/local-runtime-config.ts", "#1108"],
    ["src/local-control/console-server.ts", "src/github/app-installation-credential-broker.ts", "#1109"],
    ["src/local-control/console-server.ts", "src/local-control/admission-server.ts", "#1109"],
    ["src/local-control/console-server.ts", "src/local-control/executor-server.ts", "#1109"],
    ["src/local-control/console-server.ts", "src/local-control/session-store.ts", "#1109"],
    ["src/local-control/console-server.ts", "src/relay/local-runtime-config.ts", "#1109"],
  ].map(([from, to, owner]) => Object.freeze({ from, to, owner })),
);

const fixtureRoots = [];
test.after(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-boundaries-"));
  fixtureRoots.push(root);
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, rootDir: "./src" },
      include: ["src/**/*"],
    }),
  );
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

function pairs(findings) {
  return findings.map((finding) => `${finding.rule} ${finding.from} -> ${finding.to}`).sort();
}

const SECRET_MODULES = {
  "src/github/app-installation-credential-broker.ts": "export const installationToken = 1;\n",
  "src/github/app-user-credential.ts":
    "export const userToken = 1;\nexport interface UserCredential { readonly v: string }\n",
  "src/relay/local-runtime-config.ts": "export const readAppPrivateKey = () => 'pem';\n",
  "src/github/effect-authorizer.ts": "export interface RepositoryIdentity { readonly repositoryId: string }\n",
  "src/authorized-execution.ts": "export const AUTHORIZED = 1;\n",
};

test("the repository satisfies the boundary guard with only frozen, owner-bound exceptions", () => {
  const result = evaluateRuntimeBoundaries(repoRoot);
  assert.deepEqual(result.ledgerProblems, []);
  assert.deepEqual(pairs(result.violations), []);
  const baseline = new Set(FROZEN_BASELINE_LEDGER.map((entry) => `${entry.from} ${entry.to} ${entry.owner}`));
  for (const entry of HISTORICAL_MIGRATION_EDGES) {
    assert.ok(baseline.has(`${entry.from} ${entry.to} ${entry.owner}`), `${entry.from} -> ${entry.to} is not frozen`);
  }
  for (const finding of result.excused) assert.ok(MIGRATION_EDGE_OWNERS.includes(finding.owner));
});

test("the command-line guard exits zero on the repository", () => {
  const run = spawnSync(process.execPath, [path.join(repoRoot, "scripts/check-runtime-boundaries.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Runtime boundaries OK/u);
});

test("direct, barrel-mediated and transitive value imports are denied", () => {
  const root = fixture({
    ...SECRET_MODULES,
    "src/github/index.ts": 'export * from "./app-installation-credential-broker.js";\n',
    "src/neutral/helper.ts":
      'import { readAppPrivateKey } from "../relay/local-runtime-config.js";\nexport const h = readAppPrivateKey;\n',
    "src/neutral/reexport.ts": 'export { userToken } from "../github/app-user-credential.js";\n',
    "src/admission/direct.ts":
      'import { userToken } from "../github/app-user-credential.js";\nexport const d = userToken;\n',
    "src/admission/barrel.ts":
      'import { installationToken } from "../github/index.js";\nexport const b = installationToken;\n',
    "src/admission/transitive.ts": 'import { h } from "../neutral/helper.js";\nexport const t = h;\n',
    "src/admission/re-exported.ts": 'export * from "../neutral/reexport.js";\n',
    "src/admission/side-effect.ts": 'import "../relay/local-runtime-config.js";\n',
  });
  const { violations } = evaluateRuntimeBoundaries(root, { ledger: [], baseline: [] });
  assert.deepEqual(pairs(violations), [
    "app-user-credential src/admission/direct.ts -> src/github/app-user-credential.ts",
    "app-user-credential src/admission/re-exported.ts -> src/github/app-user-credential.ts",
    "issuer-custody src/admission/barrel.ts -> src/github/app-installation-credential-broker.ts",
    "issuer-custody src/admission/side-effect.ts -> src/relay/local-runtime-config.ts",
    "issuer-custody src/admission/transitive.ts -> src/relay/local-runtime-config.ts",
  ]);
  const barrel = violations.find((finding) => finding.from === "src/admission/barrel.ts");
  assert.deepEqual(barrel.via, [
    "src/admission/barrel.ts",
    "src/github/index.ts",
    "src/github/app-installation-credential-broker.ts",
  ]);
});

test("role-private modules are denied across roles but allowed to their owner", () => {
  const root = fixture({
    ...SECRET_MODULES,
    "src/executor/server.ts":
      'import { readAppPrivateKey } from "../relay/local-runtime-config.js";\nexport const s = readAppPrivateKey;\n',
    "src/cli/runtime/status.ts": 'import { s } from "../../executor/server.js";\nexport const x = s;\n',
    "src/authority/index.ts": "export const sign = 1;\n",
    "src/executor/signing.ts": 'import { sign } from "../authority/index.js";\nexport const y = sign;\n',
  });
  const { violations } = evaluateRuntimeBoundaries(root, { ledger: [], baseline: [] });
  assert.deepEqual(pairs(violations), [
    "authority-signing src/executor/signing.ts -> src/authority/index.ts",
    "issuer-custody src/cli/runtime/status.ts -> src/executor/server.ts",
    "issuer-custody src/cli/runtime/status.ts -> src/relay/local-runtime-config.ts",
  ]);
});

test("literal dynamic imports resolve; non-literal and unresolved imports fail closed", () => {
  const root = fixture({
    ...SECRET_MODULES,
    "src/admission/literal.ts": 'export async function load() { return import("../relay/local-runtime-config.js"); }\n',
    "src/admission/computed.ts": "export async function load(name: string) { return import(`../relay/${name}.js`); }\n",
    "src/neutral/indirect.ts": "export async function load(name: string) { return import(name); }\n",
    "src/admission/indirect.ts": 'export { load } from "../neutral/indirect.js";\n',
    "src/admission/missing.ts": 'import { gone } from "./gone.js";\nexport const m = gone;\n',
    "src/neutral/free.ts": "export async function load(name: string) { return import(name); }\n",
  });
  const findings = evaluateRuntimeBoundaries(root, { ledger: [], baseline: [] }).violations;
  assert.deepEqual(findings.map((finding) => `${finding.rule} ${finding.from}`).sort(), [
    "issuer-custody src/admission/literal.ts",
    "unanalyzable-dynamic-import src/admission/computed.ts",
    "unanalyzable-dynamic-import src/admission/indirect.ts",
    "unresolved-import src/admission/missing.ts",
  ]);
  // A dynamic import outside every role closure is not a Runtime boundary concern.
  assert.equal(
    findings.some((finding) => finding.from === "src/neutral/free.ts"),
    false,
  );
  const dynamicLedger = [{ from: "src/admission/computed.ts", to: "src/admission/computed.ts:1", owner: "#1107" }];
  const excused = evaluateRuntimeBoundaries(root, { ledger: dynamicLedger, baseline: dynamicLedger });
  assert.ok(excused.violations.some((finding) => finding.rule === "unanalyzable-dynamic-import"));
});

test("type-only imports are limited to approved neutral types", () => {
  const root = fixture({
    ...SECRET_MODULES,
    "src/runtime-contracts/ok.ts":
      'import type { RepositoryIdentity } from "../github/effect-authorizer.js";\nexport type R = RepositoryIdentity;\n',
    "src/runtime-contracts/bad-type.ts":
      'import type { UserCredential } from "../github/app-user-credential.js";\nexport type U = UserCredential;\n',
    "src/runtime-contracts/bad-value.ts":
      'import { AUTHORIZED } from "../authorized-execution.js";\nexport const a = AUTHORIZED;\n',
    "src/executor/types.ts":
      'import { type UserCredential } from "../github/app-user-credential.js";\nexport type U = UserCredential;\n',
    "src/admission/neutral.ts":
      'import type { RepositoryIdentity } from "../github/effect-authorizer.js";\nexport type R = RepositoryIdentity;\n',
  });
  const { violations } = evaluateRuntimeBoundaries(root, { ledger: [], baseline: [] });
  assert.deepEqual(pairs(violations), [
    "runtime-contracts-value-scope src/runtime-contracts/bad-value.ts -> src/authorized-execution.ts",
    "unapproved-type-import src/executor/types.ts -> src/github/app-user-credential.ts",
    "unapproved-type-import src/runtime-contracts/bad-type.ts -> src/github/app-user-credential.ts",
  ]);
});

test("exact baseline exceptions excuse only their own pair and retire when the edge disappears", () => {
  const root = fixture({
    ...SECRET_MODULES,
    "src/admission/direct.ts":
      'import { userToken } from "../github/app-user-credential.js";\nexport const d = userToken;\n',
    "src/admission/other.ts":
      'import { userToken } from "../github/app-user-credential.js";\nexport const o = userToken;\n',
  });
  const ledger = [
    { from: "src/admission/direct.ts", to: "src/github/app-user-credential.ts", owner: "#1107" },
    { from: "src/admission/removed.ts", to: "src/github/app-user-credential.ts", owner: "#1107" },
  ];
  const result = evaluateRuntimeBoundaries(root, { ledger, baseline: ledger });
  assert.equal(result.ok, false);
  assert.deepEqual(pairs(result.violations), [
    "app-user-credential src/admission/other.ts -> src/github/app-user-credential.ts",
  ]);
  assert.deepEqual(
    result.excused.map((finding) => finding.owner),
    ["#1107"],
  );
  assert.deepEqual(result.retired, [ledger[1]]);
});

test("frozen cross-role facade edges stop caller traversal at the historical boundary", () => {
  const root = fixture({
    ...SECRET_MODULES,
    "src/local-control/admission-client.ts":
      'import { admission } from "./admission-server.js";\nexport const client = admission;\n',
    "src/local-control/admission-server.ts": 'export { admission } from "../admission/server.js";\n',
    "src/admission/server.ts": "export const admission = 1;\n",
    "src/local-application-state.ts":
      'import { admission } from "./local-control/admission-server.js";\nexport const state = admission;\n',
  });
  const ledger = [
    {
      from: "src/local-control/admission-client.ts",
      to: "src/local-control/admission-server.ts",
      owner: "#1108",
    },
  ];
  const result = evaluateRuntimeBoundaries(root, { ledger, baseline: ledger });
  assert.deepEqual(pairs(result.violations), [
    "admission-private src/local-application-state.ts -> src/local-control/admission-server.ts",
  ]);
  assert.ok(
    result.excused.some(
      (finding) =>
        finding.from === "src/local-control/admission-client.ts" &&
        finding.to === "src/local-control/admission-server.ts",
    ),
  );
  assert.equal(
    result.violations.some(
      (finding) => finding.from === "src/local-control/admission-client.ts" && finding.to === "src/admission/server.ts",
    ),
    false,
  );
});

test("same-role extraction inherits only the frozen source targets", () => {
  const root = fixture({
    ...SECRET_MODULES,
    "src/github/app-user-credential-store.ts": "export const store = 1;\n",
    "src/local-control/executor-server.ts": 'export { execute } from "../executor/execution.js";\n',
    "src/executor/execution.ts":
      'import { userToken } from "../github/app-user-credential.js";\nimport { store } from "../github/app-user-credential-store.js";\nexport const execute = [userToken, store];\n',
    "src/executor/other.ts":
      'import { userToken } from "../github/app-user-credential.js";\nexport const other = userToken;\n',
  });
  const ledger = [
    {
      from: "src/local-control/executor-server.ts",
      to: "src/github/app-user-credential.ts",
      owner: "#1106",
    },
  ];
  const result = evaluateRuntimeBoundaries(root, { ledger, baseline: ledger });
  assert.ok(
    result.excused.some(
      (finding) =>
        finding.from === "src/executor/execution.ts" &&
        finding.to === "src/github/app-user-credential.ts" &&
        finding.historicalFrom === "src/local-control/executor-server.ts",
    ),
  );
  assert.deepEqual(pairs(result.violations), [
    "app-user-credential src/executor/execution.ts -> src/github/app-user-credential-store.ts",
    "app-user-credential src/executor/other.ts -> src/github/app-user-credential.ts",
    "app-user-credential src/local-control/executor-server.ts -> src/github/app-user-credential-store.ts",
  ]);
});

test("new, wildcard, directory and unowned exceptions fail", () => {
  const baseline = [{ from: "src/admission/direct.ts", to: "src/github/app-user-credential.ts", owner: "#1107" }];
  assert.deepEqual(validateMigrationLedger(baseline, baseline), []);
  const problems = (entry) => validateMigrationLedger([entry], [...baseline, entry]);
  assert.match(
    problems({ from: "src/admission/*.ts", to: "src/github/app-user-credential.ts", owner: "#1107" }).join(),
    /exact/u,
  );
  assert.match(
    problems({ from: "src/admission/**", to: "src/github/app-user-credential.ts", owner: "#1107" }).join(),
    /exact/u,
  );
  assert.match(
    problems({ from: "src/admission/", to: "src/github/app-user-credential.ts", owner: "#1107" }).join(),
    /exact/u,
  );
  assert.match(problems({ from: "src/admission/direct.ts", to: "src/github/*", owner: "#1107" }).join(), /exact/u);
  assert.match(problems({ from: "src/admission/direct.ts", to: "src/github/x.ts", owner: "#1110" }).join(), /owner/u);
  assert.match(
    problems({ from: "src/admission/direct.ts", to: "src/github/x.ts", owner: "#1107", reason: "x" }).join(),
    /exactly/u,
  );
  const added = { from: "src/admission/direct.ts", to: "src/github/new.ts", owner: "#1107" };
  assert.match(validateMigrationLedger([added], baseline).join(), /new exceptions are forbidden/u);
  assert.match(validateMigrationLedger([baseline[0], baseline[0]], baseline).join(), /duplicate/u);
  // The shipped ledger itself cannot grow beyond the frozen baseline.
  const grown = [
    ...HISTORICAL_MIGRATION_EDGES,
    { from: "src/admission/server.ts", to: "src/relay/local-runtime-config.ts", owner: "#1107" },
  ];
  assert.match(validateMigrationLedger(grown).join(), /new exceptions are forbidden/u);
});
