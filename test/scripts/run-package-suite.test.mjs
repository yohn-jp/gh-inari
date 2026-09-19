import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportsTargetPaths, validateCodexPluginMetadata } from "../../scripts/run-package-suite.mjs";
import {
  CERTIFICATION_ENTRY_COMMANDS,
  REQUIRED_BIN_NAMES,
  freshEnvironment,
  validatePreflightOutput,
  validateSkillIndex,
  validateVersionOutput,
} from "../../scripts/smoke-test.mjs";

const packageJson = { name: "gh-inari", version: "0.7.0" };
const manifest = { name: "inari", version: "0.7.0", skills: "skills/inari" };
const marketplace = {
  name: "gh-inari",
  interface: { displayName: "Inari" },
  plugins: [
    {
      name: "inari",
      source: {
        source: "npm",
        package: "gh-inari",
        version: "^0.7.0",
        registry: "https://registry.npmjs.org",
      },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    },
  ],
};

test("Codex marketplace metadata matches the package, manifest, and Skill path", () => {
  assert.doesNotThrow(() => validateCodexPluginMetadata(packageJson, manifest, marketplace));
});

for (const [label, mutate] of [
  ["plugin name", (value) => ({ ...value, plugins: [{ ...value.plugins[0], name: "other" }] })],
  [
    "npm source kind",
    (value) => ({
      ...value,
      plugins: [{ ...value.plugins[0], source: { ...value.plugins[0].source, source: "local" } }],
    }),
  ],
  [
    "npm package",
    (value) => ({
      ...value,
      plugins: [{ ...value.plugins[0], source: { ...value.plugins[0].source, package: "other" } }],
    }),
  ],
  [
    "npm version",
    (value) => ({
      ...value,
      plugins: [{ ...value.plugins[0], source: { ...value.plugins[0].source, version: "^0.8.0" } }],
    }),
  ],
  [
    "npm registry",
    (value) => ({
      ...value,
      plugins: [
        { ...value.plugins[0], source: { ...value.plugins[0].source, registry: "https://registry.example.com" } },
      ],
    }),
  ],
]) {
  test(`rejects ${label} drift`, () => {
    assert.throws(() => validateCodexPluginMetadata(packageJson, manifest, mutate(marketplace)));
  });
}

test("rejects manifest version drift", () => {
  assert.throws(() => validateCodexPluginMetadata(packageJson, { ...manifest, version: "0.8.0" }, marketplace));
});

test("rejects manifest name drift", () => {
  assert.throws(() => validateCodexPluginMetadata(packageJson, { ...manifest, name: "other" }, marketplace));
});

test("rejects Skill path drift", () => {
  assert.throws(() => validateCodexPluginMetadata(packageJson, { ...manifest, skills: "skills/other" }, marketplace));
});

test("collects a direct string export target", () => {
  assert.deepEqual(exportsTargetPaths({ exports: "./dist/index.js" }), ["dist/index.js"]);
});

test("collects targets from a flat conditions object", () => {
  assert.deepEqual(
    exportsTargetPaths({ exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } } }).sort(),
    ["dist/index.d.ts", "dist/index.js"],
  );
});

test("collects targets from an array fallback list", () => {
  assert.deepEqual(exportsTargetPaths({ exports: { ".": ["./dist/index.mjs", "./dist/index.cjs"] } }).sort(), [
    "dist/index.cjs",
    "dist/index.mjs",
  ]);
});

test("collects targets from nested condition objects", () => {
  assert.deepEqual(
    exportsTargetPaths({
      exports: { ".": { node: { import: "./dist/index.node.mjs" }, default: "./dist/index.js" } },
    }).sort(),
    ["dist/index.js", "dist/index.node.mjs"],
  );
});

test("returns an empty list when exports is missing", () => {
  assert.deepEqual(exportsTargetPaths({}), []);
});

test("packed certification covers both executable names and the preflight entry boundary", () => {
  assert.deepEqual(REQUIRED_BIN_NAMES, ["inari", "gh-inari"]);
  assert.deepEqual(
    CERTIFICATION_ENTRY_COMMANDS.map(({ args }) => args),
    [
      ["--version", "--json"],
      ["--diagnose", "--json"],
      ["skill", "--json"],
    ],
  );
});

test("packed certification rejects runtime, preflight, and Skill contract drift", () => {
  const expected = { name: "gh-inari", version: "0.7.0" };
  assert.doesNotThrow(() => validateVersionOutput({ ok: true, ...expected, capabilities: ["runtime"] }, expected));
  assert.doesNotThrow(() =>
    validatePreflightOutput(
      {
        ok: true,
        ...expected,
        capabilities: ["runtime"],
        requiredCapabilities: ["runtime"],
        canonical: { invocation: "inari", status: "ready" },
      },
      expected,
    ),
  );
  assert.doesNotThrow(() => validateSkillIndex({ version: "1", scenarios: [{ id: "inspect" }] }));
  assert.throws(() =>
    validateVersionOutput({ ok: true, ...expected, capabilities: [] }, { ...expected, version: "0.8.0" }),
  );
  assert.throws(() =>
    validatePreflightOutput(
      {
        ok: true,
        ...expected,
        capabilities: ["runtime"],
        requiredCapabilities: ["runtime"],
        canonical: { status: "missing" },
      },
      expected,
    ),
  );
  assert.throws(() => validateSkillIndex({ version: "1", scenarios: [] }));
});

test("packed certification has no checked-out source execution path", () => {
  const script = fs.readFileSync(
    path.join(import.meta.dirname, "..", "..", "scripts", "package-runtime-certification.mjs"),
    "utf8",
  );
  assert.match(script, /run\("npm", \["pack"/u);
  assert.match(script, /--omit=dev/u);
  assert.match(script, /--diagnose/u);
  assert.doesNotMatch(script, /src[\\/]index\.ts|sourceEntry|workspace:\s/u);
});

test("package certification uses an HTTP provider and excludes Change/Golden Path authority", () => {
  const runtimeScript = fs.readFileSync(
    path.join(import.meta.dirname, "..", "..", "scripts", "package-runtime-certification.mjs"),
    "utf8",
  );
  assert.match(runtimeScript, /controlled-github\.mjs/u);
  assert.match(runtimeScript, /spawn\(process\.execPath, \[providerScript, "--server"\]/u);
  assert.match(runtimeScript, /issue", "check"/u);
  assert.match(runtimeScript, /issue", "get"/u);
  assert.match(runtimeScript, /PACKED_POISON_GH_INVOKED/u);
  assert.match(runtimeScript, /gh must be unavailable/u);
  assert.doesNotMatch(runtimeScript, /installControlledGh|certifyCompleteGoldenPath|inari_golden_path_/u);
  assert.doesNotMatch(runtimeScript, /\["change",/u);
});

test("packed certification isolates ambient GitHub Actions requester context", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inari-packed-environment-test-"));
  try {
    const environment = freshEnvironment(root, path.join(root, "bin"), [], {
      ...process.env,
      GITHUB_ACTIONS: "true",
      GITHUB_ACTOR: "ambient-host-actor",
      GITHUB_TRIGGERING_ACTOR: "ambient-triggering-actor",
    });
    assert.equal(environment.GITHUB_ACTIONS, undefined);
    assert.equal(environment.GITHUB_ACTOR, undefined);
    assert.equal(environment.GITHUB_TRIGGERING_ACTOR, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
