import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const provider = path.join(import.meta.dirname, "..", "..", "scripts", "controlled-github.mjs");

function withProviderState(state, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inari-controlled-artifact-"));
  const statePath = path.join(root, "state.json");
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");
  try {
    return run(statePath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function downloadArtifact(statePath, artifactId) {
  const args = [provider, "api", `repos/yohn-jp/gh-inari/actions/artifacts/${artifactId}/zip`, "--method", "GET"];
  return spawnSync(process.execPath, args, {
    env: { ...process.env, INARI_PACKED_PROVIDER_STATE: statePath },
    maxBuffer: 1024 * 1024,
  });
}

test("controlled Actions artifact download emits the exact ZIP bytes on stdout", () => {
  const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x80]);
  withProviderState(
    {
      artifacts: {
        correlation: { id: 2000, runId: 1000, bytes: archive.toString("base64") },
      },
    },
    (statePath) => {
      const result = downloadArtifact(statePath, 2000);
      assert.equal(result.status, 0, result.stderr.toString("utf8"));
      assert.deepEqual(result.stdout, archive);
      assert.equal(result.stderr.length, 0);
    },
  );
});

test("controlled Actions artifact download fails closed for an unknown artifact id", () => {
  withProviderState({ artifacts: {} }, (statePath) => {
    const result = downloadArtifact(statePath, 9999);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.length, 0);
    assert.match(result.stderr.toString("utf8"), /Actions artifact not found/u);
  });
});
