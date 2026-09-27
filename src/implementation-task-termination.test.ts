import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImplementationAuthorizationRecord } from "./implementation-authorization.js";
import {
  IMPLEMENTATION_TASK_TERMINATION_KIND,
  IMPLEMENTATION_TASK_TERMINATION_VERSION,
  MAX_IMPLEMENTATION_TASK_TERMINATION_PROVENANCE_LABEL_LENGTH,
  MAX_IMPLEMENTATION_TASK_TERMINATION_OBSERVATION_RECORD_BYTES,
  MAX_IMPLEMENTATION_TASK_TERMINATION_RECORDS,
  MAX_IMPLEMENTATION_TASK_TERMINATION_RECORD_BYTES,
  observeImplementationTaskTermination,
  validateImplementationTaskTerminationRecord,
} from "./implementation-task-termination.js";

const repository = {
  repositoryHost: "github.com",
  repositoryId: "415000001",
  repository: "yohn-jp/gh-inari",
} as const;
const implementation = { ...repository, number: 1251 } as const;
const base = { branch: "main", revision: "a".repeat(40), freshness: "fresh-1" } as const;

const authorization = {
  version: 1,
  kind: "implementation-authorization",
  implementation,
  contractVersion: 1,
  repository,
  base,
  governedBodyDigest: "b".repeat(64),
} satisfies ImplementationAuthorizationRecord;

function termination(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: IMPLEMENTATION_TASK_TERMINATION_VERSION,
    kind: IMPLEMENTATION_TASK_TERMINATION_KIND,
    repository,
    implementation,
    authorizationDigest: authorization.governedBodyDigest,
    base,
    ...overrides,
  };
}

function read(
  records: readonly { readonly record: unknown; readonly provenance: unknown }[],
  provenance: unknown = { source: "repository", revision: "snapshot-1" },
): Record<string, unknown> {
  return { status: "authoritative", provenance, records };
}

test("validates a termination record against the exact current authorization identity", () => {
  const result = validateImplementationTaskTerminationRecord(termination(), authorization);
  assert.equal(result.valid, true);
  assert.deepEqual(result.record, termination());
  assert.equal(Object.isFrozen(result.record), true);
  assert.equal(Object.isFrozen(result.record?.base), true);
});

test("rejects wrong record version, repository, Implementation, authorization digest, base, and unknown fields", () => {
  const cases: readonly [string, Record<string, unknown>, string][] = [
    ["version", termination({ version: 2 }), "IMPLEMENTATION_TASK_TERMINATION_VERSION_UNSUPPORTED"],
    [
      "repository",
      termination({ repository: { ...repository, repositoryId: "415000002" } }),
      "IMPLEMENTATION_TASK_TERMINATION_REPOSITORY_MISMATCH",
    ],
    [
      "Implementation",
      termination({ implementation: { ...implementation, number: 1252 } }),
      "IMPLEMENTATION_TASK_TERMINATION_IMPLEMENTATION_MISMATCH",
    ],
    [
      "authorization digest",
      termination({ authorizationDigest: "c".repeat(64) }),
      "IMPLEMENTATION_TASK_TERMINATION_AUTHORIZATION_MISMATCH",
    ],
    [
      "accepted base",
      termination({ base: { ...base, revision: "d".repeat(40) } }),
      "IMPLEMENTATION_TASK_TERMINATION_BASE_MISMATCH",
    ],
    ["unknown property", termination({ actor: "operator" }), "IMPLEMENTATION_TASK_TERMINATION_RECORD_UNKNOWN_PROPERTY"],
  ];

  for (const [name, value, code] of cases) {
    const result = validateImplementationTaskTerminationRecord(value, authorization);
    assert.equal(result.valid, false, `${name} should fail validation`);
    assert.ok(
      result.violations.some((violation) => violation.code === code),
      `${name} should report ${code}`,
    );
  }
});

test("distinguishes authoritative absence from unavailable reads and valid present records", () => {
  const absence = observeImplementationTaskTermination(read([]), authorization);
  assert.equal(absence.status, "absent");
  assert.deepEqual(absence.provenance, { source: "repository", revision: "snapshot-1" });

  const unavailable = observeImplementationTaskTermination(
    { status: "unavailable", provenance: { source: "repository", result: "read-failed" } },
    authorization,
  );
  assert.equal(unavailable.status, "unavailable");
  assert.deepEqual(unavailable.provenance, { source: "repository", result: "read-failed" });

  const present = observeImplementationTaskTermination(
    read([{ record: termination(), provenance: { path: "termination.json", revision: "snapshot-1" } }]),
    authorization,
  );
  assert.equal(present.status, "present");
  if (present.status === "present") assert.deepEqual(present.record, termination());
});

test("repeated observation of the same event is deterministic and retains every provenance source", () => {
  const records = [
    { record: termination(), provenance: { path: "state/termination.json", revision: "snapshot-1" } },
    { record: termination(), provenance: { path: "state/termination.json", revision: "snapshot-2" } },
  ];
  const first = observeImplementationTaskTermination(read(records), authorization);
  const second = observeImplementationTaskTermination(read([...records].reverse()), authorization);

  assert.equal(first.status, "present");
  assert.deepEqual(first, second);
  assert.deepEqual(first.recordProvenance, [
    { path: "state/termination.json", revision: "snapshot-1" },
    { path: "state/termination.json", revision: "snapshot-2" },
  ]);
});

test("fails closed on distinct, invalid, and lifecycle-proxy records while retaining provenance", () => {
  const ambiguous = observeImplementationTaskTermination(
    read([
      { record: termination(), provenance: { path: "state/termination.json", replica: "one" } },
      {
        record: termination({ repository: { repositoryHost: "github.com", repositoryId: repository.repositoryId } }),
        provenance: { path: "state/termination.json", replica: "two" },
      },
    ]),
    authorization,
  );
  assert.equal(ambiguous.status, "invalid");
  if (ambiguous.status === "invalid")
    assert.ok(
      ambiguous.violations.some((violation) => violation.code === "IMPLEMENTATION_TASK_TERMINATION_RECORDS_AMBIGUOUS"),
    );
  assert.deepEqual(ambiguous.recordProvenance, [
    { path: "state/termination.json", replica: "one" },
    { path: "state/termination.json", replica: "two" },
  ]);

  for (const proxy of [
    { issue: implementation, state: "closed" },
    { source: { ...repository, number: 1250 }, state: "aborted" },
    { session: "session-1", state: "aborted" },
    { taskAborted: true },
  ]) {
    const result = observeImplementationTaskTermination(
      read([{ record: proxy, provenance: { path: "state/termination.json" } }]),
      authorization,
    );
    assert.equal(result.status, "invalid");
  }

  const stale = observeImplementationTaskTermination(
    read([
      { record: termination({ authorizationDigest: "e".repeat(64) }), provenance: { path: "state/termination.json" } },
    ]),
    authorization,
  );
  assert.equal(stale.status, "invalid");
  assert.deepEqual(stale.recordProvenance, [{ path: "state/termination.json" }]);
});

test("an invalid or incomplete observation never becomes authoritative absence", () => {
  const missingRecords = observeImplementationTaskTermination(
    { status: "authoritative", provenance: { provider: "repository" } },
    authorization,
  );
  assert.equal(missingRecords.status, "invalid");

  const notAuthoritative = observeImplementationTaskTermination(
    { status: "partial", provenance: { provider: "repository" }, records: [] },
    authorization,
  );
  assert.equal(notAuthoritative.status, "invalid");

  const unknownReadProperty = observeImplementationTaskTermination(
    { status: "authoritative", provenance: { provider: "repository" }, records: [], issueState: "closed" },
    authorization,
  );
  assert.equal(unknownReadProperty.status, "invalid");
});

test("invalid provenance is omitted from results and record collections stay bounded", () => {
  const credential = `github_pat_${"A".repeat(32)}`;
  const unsafe = observeImplementationTaskTermination(
    {
      status: "authoritative",
      provenance: { source: "repository", token: credential },
      records: [{ record: termination(), provenance: { source: "repository", locator: credential } }],
    },
    authorization,
  );
  assert.equal(unsafe.status, "invalid");
  assert.equal(JSON.stringify(unsafe).includes(credential), false);
  assert.equal(JSON.stringify(unsafe).includes('"token"'), false);
  assert.equal(unsafe.provenance, undefined);
  assert.deepEqual(unsafe.recordProvenance, [{ valid: false }]);

  const oversizedLabel = "x".repeat(MAX_IMPLEMENTATION_TASK_TERMINATION_PROVENANCE_LABEL_LENGTH + 1);
  const oversized = observeImplementationTaskTermination(read([], { source: oversizedLabel }), authorization);
  assert.equal(oversized.status, "invalid");
  assert.equal(JSON.stringify(oversized).includes(oversizedLabel), false);
  assert.equal(oversized.provenance, undefined);

  const excessiveRecords = observeImplementationTaskTermination(
    read(
      Array.from({ length: MAX_IMPLEMENTATION_TASK_TERMINATION_RECORDS + 1 }, (_, index) => ({
        record: termination(),
        provenance: { source: `copy-${index}` },
      })),
    ),
    authorization,
  );
  assert.equal(excessiveRecords.status, "invalid");
  assert.ok(excessiveRecords.violations.some((violation) => violation.message.includes("record limit")));
});

test("record size is bounded before canonical output", () => {
  const result = validateImplementationTaskTerminationRecord(
    termination({ base: { ...base, freshness: "x".repeat(MAX_IMPLEMENTATION_TASK_TERMINATION_RECORD_BYTES) } }),
    authorization,
  );
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((violation) => violation.code === "IMPLEMENTATION_TASK_TERMINATION_RECORD_INVALID"));
});

test("total provenance serialization is bounded across an observation", () => {
  const largeProvenance = {
    source: "s".repeat(MAX_IMPLEMENTATION_TASK_TERMINATION_PROVENANCE_LABEL_LENGTH),
    location: "l".repeat(MAX_IMPLEMENTATION_TASK_TERMINATION_PROVENANCE_LABEL_LENGTH),
    revision: "r".repeat(MAX_IMPLEMENTATION_TASK_TERMINATION_PROVENANCE_LABEL_LENGTH),
    snapshot: "p".repeat(MAX_IMPLEMENTATION_TASK_TERMINATION_PROVENANCE_LABEL_LENGTH),
  };
  const result = observeImplementationTaskTermination(
    read(
      Array.from({ length: MAX_IMPLEMENTATION_TASK_TERMINATION_RECORDS }, () => ({
        record: termination(),
        provenance: largeProvenance,
      })),
      largeProvenance,
    ),
    authorization,
  );
  assert.equal(result.status, "invalid");
  assert.ok(result.violations.some((violation) => violation.message.includes("total serialized bytes")));
  assert.deepEqual(result.provenance, largeProvenance);
  assert.deepEqual(result.recordProvenance[0], largeProvenance);
});

test("serialized record collections have a total byte bound", () => {
  const records = Array.from({ length: 8 }, (_, index) => ({
    record: termination({
      repository: {
        repositoryHost: repository.repositoryHost,
        repositoryId: repository.repositoryId,
        repository: `owner/${index}${"x".repeat(8_500)}`,
      },
    }),
    provenance: { source: `copy-${index}` },
  }));
  const result = observeImplementationTaskTermination(read(records), authorization);
  assert.equal(result.status, "invalid");
  assert.ok(result.violations.some((violation) => violation.message.includes("total serialized bytes")));
  assert.equal(JSON.stringify(result).includes("x".repeat(64)), false);
});
