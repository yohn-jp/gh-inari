import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "./verify-release-certification.mjs";

const BASE_ARGS = [
  "--source-sha",
  "0123456789abcdef0123456789abcdef01234567",
  "--package-name",
  "gh-inari",
  "--package-version",
  "0.12.0",
  "--tarball-sha256",
  `sha256:${"a".repeat(64)}`,
  "--repository-owner",
  "yohn-jp",
  "--repository-name",
  "gh-inari",
  "--packed-evidence",
  "packed.json",
  "--dogfood-evidence",
  "dogfood.json",
];

test("parses every required option", () => {
  const options = parseArgs(BASE_ARGS);
  assert.deepEqual(options, {
    sourceSha: "0123456789abcdef0123456789abcdef01234567",
    packageName: "gh-inari",
    packageVersion: "0.12.0",
    tarballSha256: `sha256:${"a".repeat(64)}`,
    repositoryOwner: "yohn-jp",
    repositoryName: "gh-inari",
    packedEvidence: "packed.json",
    dogfoodEvidence: "dogfood.json",
  });
});

test("rejects an unknown option", () => {
  assert.throws(() => parseArgs([...BASE_ARGS, "--unknown-flag", "x"]), /unknown option/);
});

test("rejects a duplicate option", () => {
  assert.throws(() => parseArgs([...BASE_ARGS, "--source-sha", "x"]), /duplicate option/);
});

test("rejects a flag with a missing value", () => {
  assert.throws(() => parseArgs(["--source-sha"]), /usage:/);
});
