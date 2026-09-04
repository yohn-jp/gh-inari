import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "./cli.js";
import { AGENT_INVOCATION_CONTRACT, COMMAND_CONTRACT_VERSION, RUNTIME_CAPABILITIES } from "./command-contract.js";

function versionOutput(version = "0.9.0"): string {
  return JSON.stringify({
    ok: true,
    name: "gh-inari",
    version,
    protocol: 1,
    commandContractVersion: COMMAND_CONTRACT_VERSION,
    capabilities: [...RUNTIME_CAPABILITIES],
    invocation: AGENT_INVOCATION_CONTRACT,
  });
}

async function captureJson(
  runCanonicalDiagnosticCommand: () => {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: string;
  },
): Promise<{ exitCode: number; output: Record<string, unknown> }> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["diagnose", "--json"], {
      packageMetadata: { name: "gh-inari", version: "0.9.0", description: "" },
      runCanonicalDiagnosticCommand,
      runDiagnosticCommand: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    return { exitCode, output: JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown> };
  } finally {
    console.log = originalLog;
  }
}

test("diagnose fails closed when the canonical inari executable is missing", async () => {
  const result = await captureJson(() => ({
    status: null,
    stdout: "",
    stderr: "",
    error: "spawnSync inari ENOENT",
  }));
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.ok, false);
  const canonical = result.output.canonical as Record<string, unknown>;
  assert.equal(canonical.invocation, "inari");
  assert.equal(canonical.status, "missing");
});

test("diagnose reports ready only after probing the canonical executable contract", async () => {
  const result = await captureJson(() => ({ status: 0, stdout: versionOutput(), stderr: "" }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.ok, true);
  const canonical = result.output.canonical as Record<string, unknown>;
  assert.equal(canonical.invocation, "inari");
  assert.equal(canonical.status, "ready");
  assert.equal(canonical.version, "0.9.0");
});

test("diagnose rejects a stale canonical executable independently of extension health", async () => {
  const stale = JSON.parse(versionOutput("0.8.0")) as Record<string, unknown>;
  stale.commandContractVersion = "0.9.0";
  const result = await captureJson(() => ({ status: 0, stdout: JSON.stringify(stale), stderr: "" }));
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.ok, false);
  const canonical = result.output.canonical as Record<string, unknown>;
  assert.equal(canonical.status, "stale");
  assert.match(String(canonical.detail), /command contract/u);
});
