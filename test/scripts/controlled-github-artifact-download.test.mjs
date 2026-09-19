import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const provider = path.join(import.meta.dirname, "..", "..", "scripts", "controlled-github.mjs");

async function withProviderState(state, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inari-controlled-http-artifact-"));
  const statePath = path.join(root, "state.json");
  const consumerRoot = path.join(root, "consumer");
  fs.mkdirSync(path.join(consumerRoot, ".github"), { recursive: true });
  fs.writeFileSync(path.join(consumerRoot, ".github", "README.md"), "controlled HTTP provider\n", "utf8");
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");
  const child = spawn(process.execPath, [provider, "--server"], {
    env: {
      ...process.env,
      INARI_PACKED_PROVIDER_STATE: statePath,
      INARI_PACKED_CONSUMER_ROOT: consumerRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const url = await new Promise((resolve, reject) => {
      let output = "";
      const stderr = [];
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.once("error", reject);
      child.once("exit", (status) =>
        reject(
          new Error(
            `HTTP provider exited before binding (${String(status)}): ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        ),
      );
      child.stdout.on("data", (chunk) => {
        output += chunk.toString("utf8");
        const line = output.split(/\r?\n/u, 1)[0]?.trim() ?? "";
        if (line.length > 0) resolve(line);
      });
    });
    return await run(url);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function downloadArtifact(providerUrl, artifactId) {
  const initial = await fetch(`${providerUrl}/repos/yohn-jp/gh-inari/actions/artifacts/${artifactId}/zip`, {
    redirect: "manual",
    headers: { authorization: "Bearer bounded-http-fixture-token" },
  });
  const location = initial.headers.get("location");
  if (initial.status !== 302) {
    const bytes = Buffer.from(await initial.arrayBuffer());
    return { initial, status: initial.status, bytes, text: bytes.toString("utf8") };
  }
  assert.ok(location);
  const response = await fetch(new URL(location, providerUrl), {
    headers: { authorization: "Bearer bounded-http-fixture-token" },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { initial, status: response.status, bytes, text: bytes.toString("utf8") };
}

test("controlled Actions artifact download emits exact ZIP bytes through native HTTP", async () => {
  const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x80]);
  await withProviderState(
    {
      artifacts: [{ correlation: "correlation", id: 2000, runId: 1000, bytes: archive.toString("base64") }],
    },
    async (providerUrl) => {
      const result = await downloadArtifact(providerUrl, 2000);
      assert.equal(
        result.initial.headers.get("location"),
        "/repos/yohn-jp/gh-inari/actions/artifacts/2000/zip?download=1",
      );
      assert.equal(result.status, 200);
      assert.deepEqual(result.bytes, archive);
      assert.equal(result.text.length, archive.length);
    },
  );
});

test("controlled Actions artifact download fails closed for an unknown artifact id", async () => {
  await withProviderState({ artifacts: [] }, async (providerUrl) => {
    const result = await downloadArtifact(providerUrl, 9999);
    assert.equal(result.status, 404);
    assert.deepEqual(JSON.parse(result.text), { message: "Actions artifact not found" });
  });
});
