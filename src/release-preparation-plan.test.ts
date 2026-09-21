import assert from "node:assert/strict";
import test from "node:test";
import {
  parseReleasePreparationPlan,
  planReleasePreparation,
  planReleasePreparationFromHistory,
  serializeReleasePreparationPlan,
  tryPlanReleasePreparation,
  type ReleaseHistoryEvidence,
  type ReleasePreparationPlanInput,
} from "./release-preparation-plan.js";

const previousRevision = "a".repeat(40);
const targetRevision = "b".repeat(40);
const mergeRevision = "c".repeat(40);

function history(): ReleaseHistoryEvidence {
  return {
    previousRelease: { tag: "v0.14.1", version: "0.14.1", sourceRevision: previousRevision },
    targetSource: { ref: "main", sourceRevision: targetRevision },
    includedChanges: [
      {
        number: 927,
        title: "Add governed release planning",
        mergeCommitSha: mergeRevision,
        mergedAt: "2026-09-21T15:00:00Z",
        governed: true,
        sourceIssueNumbers: [912],
      },
    ],
  };
}

function input(intent: ReleasePreparationPlanInput["intent"] = "patch"): ReleasePreparationPlanInput {
  return {
    history: history(),
    intent,
    repository: {
      packageName: "gh-inari",
      currentVersion: "0.14.1",
      versionBearingArtifacts: [
        { path: "package.json", kind: "package", field: "version", currentValue: "0.14.1", format: "exact" },
        {
          path: "pnpm-lock.yaml",
          kind: "lockfile",
          field: "importers..version",
          currentValue: "0.14.1",
          format: "exact",
        },
        {
          path: ".codex-plugin/plugin.json",
          kind: "codex-plugin",
          field: "version",
          currentValue: "0.14.1",
          format: "exact",
        },
        {
          path: ".agents/plugins/marketplace.json",
          kind: "marketplace",
          field: "plugins[0].source.version",
          currentValue: "^0.14.1",
          format: "caret",
        },
      ],
      releaseDocumentDirectory: "docs/releases",
      verification: { command: "pnpm", args: ["run", "verify"] },
      publication: { kind: "governed-pull-request", sourceIssue: 911 },
    },
  };
}

test("explicit bump and exact intents project one target version", () => {
  assert.equal(planReleasePreparation(input("patch")).identity.targetVersion, "0.14.2");
  assert.equal(planReleasePreparation(input("minor")).identity.targetVersion, "0.15.0");
  assert.equal(planReleasePreparation(input("major")).identity.targetVersion, "1.0.0");
  const exact = planReleasePreparation(input({ kind: "exact", version: "0.20.0" }));
  assert.equal(exact.identity.targetVersion, "0.20.0");
  assert.equal(exact.versionArtifacts.find((artifact) => artifact.kind === "marketplace")?.targetValue, "^0.20.0");
  assert.equal(exact.releaseDocument.path, "docs/releases/0.20.0.md");
});

test("history, bounded governed changes, and verification/publication prerequisites are explicit", () => {
  const plan = planReleasePreparation(input());
  assert.deepEqual(plan.identity.previousRelease, history().previousRelease);
  assert.deepEqual(plan.identity.targetSource, history().targetSource);
  assert.deepEqual(plan.includedChanges[0]?.sourceIssueNumbers, [912]);
  assert.deepEqual(plan.verification, { command: "pnpm", args: ["run", "verify"] });
  assert.deepEqual(plan.publication, { kind: "governed-pull-request", sourceIssue: 911 });
});

test("identical history and intent are idempotent and transport-safe", () => {
  const first = planReleasePreparation(input());
  const second = planReleasePreparation(input());
  assert.deepEqual(first, second);
  const serialized = serializeReleasePreparationPlan(first);
  assert.deepEqual(parseReleasePreparationPlan(serialized), first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.versionArtifacts), true);
});

test("missing history and conflicting prepared state fail closed", () => {
  const missing = tryPlanReleasePreparation({ ...input(), history: undefined });
  assert.equal(missing.valid, false);
  const conflict = tryPlanReleasePreparation({
    ...input(),
    existingPreparedRelease: { targetVersion: "0.14.3", sourceRevision: targetRevision },
  });
  assert.equal(conflict.valid, false);
  assert.ok(conflict.violations.some((violation) => violation.code === "TARGET_CONFLICT"));
});

test("planning through an injected history port does not mutate provider evidence", async () => {
  let reads = 0;
  const evidence = history();
  const plan = await planReleasePreparationFromHistory(
    {
      async readReleaseHistory() {
        reads += 1;
        return evidence;
      },
    },
    { intent: "patch", repository: input().repository },
  );
  assert.equal(reads, 1);
  assert.equal(plan.identity.targetSource.sourceRevision, targetRevision);
  assert.equal(evidence.targetSource.sourceRevision, targetRevision);
});
