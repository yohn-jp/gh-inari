import assert from "node:assert/strict";
import test from "node:test";
import { exportsTargetPaths } from "./run-package-suite.mjs";

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
