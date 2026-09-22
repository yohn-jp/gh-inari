import assert from "node:assert/strict";
import test from "node:test";
import { runCertification } from "../scripts/release-preparation-certification.mjs";

test("release-preparation Golden Path certifies realistic history, preparation, publication, and fail-closed evidence", async () => {
  const report = await runCertification();
  assert.equal(report.ok, true);
  assert.deepEqual(report.history.includedChanges, [959, 960, 961]);
  assert.equal(report.preparation.targetVersion, "0.14.2");
  assert.equal(report.preparation.idempotentRetry, true);
  assert.deepEqual(report.publication, { first: "created", retry: "returned-existing", creates: 1 });
  assert.deepEqual(
    report.negatives.map(({ name, passed }) => [name, passed]),
    [
      ["non-ancestor", true],
      ["pagination-truncation", true],
      ["ungoverned-pr", true],
      ["unassociated-commit", true],
      ["conflicting-associated-pr", true],
      ["wrong-source", true],
      ["wrong-head", true],
      ["wrong-base", true],
      ["wrong-version", true],
      ["post-create-uncertainty", true],
    ],
  );
});
