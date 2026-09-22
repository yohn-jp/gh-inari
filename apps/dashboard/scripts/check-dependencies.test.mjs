import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertDashboardDependencies, findDashboardDependencyViolations } from "./check-dependencies.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

test("Dashboard source stays inside its presentation and public Endpoint boundaries", () => {
  assert.doesNotThrow(() => assertDashboardDependencies());
});

test("Dashboard dependency guard rejects root-domain implementation imports", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(repositoryRoot, ".dashboard-dependency-test-"));
  try {
    const fixture = path.join(temporaryDirectory, "browser.ts");
    const forbidden = path.relative(path.dirname(fixture), path.join(repositoryRoot, "src/github/index.js"));
    fs.writeFileSync(fixture, `import forbidden from ${JSON.stringify(forbidden)};\n`);
    const violations = findDashboardDependencyViolations(temporaryDirectory);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].specifier, forbidden);
    assert.throws(() => assertDashboardDependencies(temporaryDirectory), /root-domain implementation imports/u);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("Dashboard dependency guard rejects frontend framework imports", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "inari-dashboard-dependency-test-"));
  try {
    fs.writeFileSync(path.join(temporaryDirectory, "browser.ts"), 'import { createApp } from "vue";\n');
    assert.throws(() => assertDashboardDependencies(temporaryDirectory), /frontend framework imports/u);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
