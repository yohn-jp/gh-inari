import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import prettier from "prettier";
import {
  createChangeProvenanceRecord,
  renderChangeProvenanceRecord,
  verifyChangeProvenanceRecord,
} from "../../src/change-provenance-record.ts";
import { assertRuntimeAuthority } from "../../src/agent-authority/runtime-authority.ts";
import { generateRuntimeAuthorityKeyPair } from "../../src/agent-authority/runtime-key.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("generated canonical provenance artifacts are ignored by Prettier and verify canonically", async () => {
  const pair = generateRuntimeAuthorityKeyPair();
  const trusted = assertRuntimeAuthority({
    version: 1,
    kind: "runtime-authority",
    id: "runtime-change",
    key: pair.publicKeyJwk,
    status: "active",
    notBefore: "2026-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement"],
  });
  const rendered = renderChangeProvenanceRecord(
    createChangeProvenanceRecord({
      rootIssue: 742,
      runtimeAuthority: trusted,
      runtimeKey: pair,
      now: new Date("2026-09-13T00:00:00.000Z"),
    }),
  );
  const artifactPath = path.join(repositoryRoot, ".inari", "provenance", "742.json");
  const fileInfo = await prettier.getFileInfo(artifactPath, {
    ignorePath: path.join(repositoryRoot, ".prettierignore"),
  });

  assert.equal(fileInfo.ignored, true);
  assert.equal(rendered, `${JSON.stringify(JSON.parse(rendered))}\n`);
  assert.deepEqual(verifyChangeProvenanceRecord(rendered, trusted).rootIssue, 742);
});
