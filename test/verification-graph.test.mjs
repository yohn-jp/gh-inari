import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));

function commandSteps(command) {
  return command.split("&&").map((step) => step.trim());
}

test("routine verification serializes Dashboard output before package consumers", () => {
  const verifyDependencies = packageManifest.wireit.verify.dependencies;

  assert.equal(verifyDependencies.includes("dashboard:build"), false);
  assert.ok(verifyDependencies.includes("test"), "root routine tests must remain in verify");
  assert.ok(verifyDependencies.includes("dashboard:test"), "Dashboard tests must remain in verify");
  assert.ok(verifyDependencies.includes("verify:package"), "package certification must remain in verify");

  const buildSteps = commandSteps(packageManifest.scripts.build);
  assert.equal(
    buildSteps.at(-1),
    "pnpm --dir apps/dashboard build",
    "the root build must finish Dashboard output before package certification starts",
  );

  assert.equal(packageManifest.wireit["verify:package"].command, "pnpm run test:package");
  assert.deepEqual(commandSteps(packageManifest.scripts["test:package"]), [
    "pnpm run build",
    "node scripts/run-package-suite.mjs",
  ]);

  const packageSuite = fs.readFileSync(path.join(repositoryRoot, "scripts/run-package-suite.mjs"), "utf8");
  const dashboardOutputCheck = packageSuite.indexOf("Dashboard build output is missing apps/dashboard/dist/${file}");
  const installedPackageCertification = packageSuite.indexOf('scripts/package-runtime-certification.mjs", "--tarball"');
  const endpointCertification = packageSuite.indexOf('scripts/endpoint-dashboard-certification.mjs"]');

  assert.notEqual(dashboardOutputCheck, -1, "package suite must reject missing Dashboard build output");
  assert.ok(installedPackageCertification > dashboardOutputCheck);
  assert.ok(endpointCertification > dashboardOutputCheck);
});
