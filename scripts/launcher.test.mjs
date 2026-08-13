import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcherSource = fs.readFileSync(path.join(repoRoot, "gh-inari"), "utf8");

function writeFixtureFile(filePath, contents, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  if (mode !== undefined) fs.chmodSync(filePath, mode);
}

function createFixture({ cliSource, npmAction }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gh-inari-launcher-"));
  const binDirectory = path.join(directory, "bin");
  fs.mkdirSync(binDirectory, { recursive: true });
  writeFixtureFile(path.join(directory, "gh-inari"), launcherSource, 0o755);
  if (cliSource !== undefined) writeFixtureFile(path.join(directory, "dist", "index.js"), cliSource);

  const fakeNpm = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.env.GH_INARI_TEST_ROOT;
fs.appendFileSync(path.join(root, "npm-invocations.log"), JSON.stringify(process.argv.slice(2)) + "\\n");
switch (process.env.GH_INARI_TEST_NPM_ACTION) {
  case "install-runtime": {
    const packageDirectory = path.join(root, "node_modules", "runtime-dependency");
    fs.mkdirSync(packageDirectory, { recursive: true });
    fs.writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(path.join(packageDirectory, "index.js"), "export const loaded = true;\\n");
    process.stdout.write("npm stdout noise\\n");
    break;
  }
  case "fail":
    process.stderr.write("simulated npm failure\\n");
    process.exit(17);
  case "noop":
    process.stdout.write("npm stdout noise\\n");
    break;
  default:
    process.stderr.write("unknown fake npm action\\n");
    process.exit(2);
}
`;
  writeFixtureFile(path.join(binDirectory, "npm"), fakeNpm, 0o755);

  return {
    directory,
    env: {
      ...process.env,
      GH_INARI_TEST_ROOT: directory,
      GH_INARI_TEST_NPM_ACTION: npmAction,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

function runFixture(fixture) {
  const result = spawnSync(process.execPath, [path.join(fixture.directory, "gh-inari")], {
    cwd: fixture.directory,
    env: fixture.env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function invocationCount(fixture) {
  const logPath = path.join(fixture.directory, "npm-invocations.log");
  if (!fs.existsSync(logPath)) return 0;
  return fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).length;
}

function withFixture(options, callback) {
  const fixture = createFixture(options);
  try {
    return callback(fixture);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
}

test("bootstraps a missing runtime dependency once and keeps JSON stdout clean", () => {
  withFixture(
    {
      cliSource: `import "runtime-dependency";
export async function runCli() {
  process.stdout.write(JSON.stringify({ ok: true }));
  return 0;
}
`,
      npmAction: "install-runtime",
    },
    (fixture) => {
      const result = runFixture(fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '{"ok":true}');
      assert.equal(invocationCount(fixture), 1);
    },
  );
});

test("fails closed for a missing dist entry without bootstrapping", () => {
  withFixture({ npmAction: "install-runtime" }, (fixture) => {
    const result = runFixture(fixture);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /packaged distribution is missing or corrupt/);
    assert.match(result.stderr, /dist[\\/]index\.js/);
    assert.equal(invocationCount(fixture), 0);
  });
});

test("fails closed for a missing internal dist module without bootstrapping", () => {
  withFixture(
    {
      cliSource: `import "./missing-internal.js";
export async function runCli() {
  return 0;
}
`,
      npmAction: "install-runtime",
    },
    (fixture) => {
      const result = runFixture(fixture);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /packaged distribution is missing or corrupt/);
      assert.match(result.stderr, /missing-internal\.js/);
      assert.equal(invocationCount(fixture), 0);
    },
  );
});

test("reports a failed dependency install without re-executing", () => {
  withFixture(
    {
      cliSource: `import "runtime-dependency";
export async function runCli() {
  return 0;
}
`,
      npmAction: "fail",
    },
    (fixture) => {
      const result = runFixture(fixture);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /unable to install runtime dependencies/);
      assert.equal(invocationCount(fixture), 1);
    },
  );
});

test("uses the bootstrap sentinel to bound a persistent dependency failure", () => {
  withFixture(
    {
      cliSource: `import "runtime-dependency";
export async function runCli() {
  return 0;
}
`,
      npmAction: "noop",
    },
    (fixture) => {
      const result = runFixture(fixture);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /still missing after one bootstrap attempt/);
      assert.equal(invocationCount(fixture), 1);
    },
  );
});
