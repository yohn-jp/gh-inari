import assert from "node:assert/strict";
import { globSync } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function shellWords(command) {
  const words = [];
  const wordPattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/gu;
  for (const match of command.matchAll(wordPattern)) words.push(match[1] ?? match[2] ?? match[3]);
  return words;
}

function testSelectors(script) {
  return shellWords(script).filter((word) => !word.startsWith("-") && word.includes(".test."));
}

function discoveredTests(script) {
  return testSelectors(script).flatMap((selector) =>
    globSync(selector, { cwd: repositoryRoot }).map((file) => file.split(path.sep).join("/")),
  );
}

function testFilesIn(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return testFilesIn(entryPath);
      if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
        return [path.relative(repositoryRoot, entryPath).split(path.sep).join("/")];
      }
      return [];
    })
    .sort();
}

test("routine discovery owns every Dashboard script guard test exactly once", () => {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  const dashboardPackage = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "apps/dashboard/package.json"), "utf8"),
  );
  const dashboardGuardTests = testFilesIn(path.join(repositoryRoot, "apps/dashboard/scripts"));
  const rootDiscovery = discoveredTests(rootPackage.scripts.test);
  const dashboardDiscovery = discoveredTests(dashboardPackage.scripts.test);

  assert.ok(dashboardGuardTests.length > 0, "Dashboard script guard test family must remain present");
  for (const guardTest of dashboardGuardTests) {
    assert.equal(
      rootDiscovery.filter((discoveredTest) => discoveredTest === guardTest).length,
      1,
      `${guardTest} must be discovered exactly once by the root routine test selector`,
    );
    assert.equal(
      dashboardDiscovery.includes(guardTest),
      false,
      `${guardTest} must keep the root selector as its only routine test owner`,
    );
  }
});
