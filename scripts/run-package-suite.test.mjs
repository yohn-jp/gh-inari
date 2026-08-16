import assert from "node:assert/strict";
import test from "node:test";
import { exportsTargetPaths, validateCodexPluginMetadata } from "./run-package-suite.mjs";

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
