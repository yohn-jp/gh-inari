import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMPLEMENTATION_CONTRACT_VERSION,
  IMPLEMENTATION_KIND,
  parseImplementationContract,
  renderImplementationIssueBody,
} from "./implementation-contract.js";
import {
  authorizeImplementation,
  implementationIssueBodyDigest,
  type ImplementationAuthorizationRecord,
} from "./implementation-authorization.js";
import {
  IMPLEMENTATION_SCOPE_PROJECTION_KIND,
  IMPLEMENTATION_SCOPE_PROJECTION_SCHEMA,
  IMPLEMENTATION_SCOPE_PROJECTION_VERSION,
  deserializeImplementationScopeProjection,
  implementationScopeProjectionPaths,
  isImplementationScopeProjectionPathAllowed,
  isImplementationScopeProjectionPathDenied,
  projectImplementationScope,
  projectImplementationScopeSchema,
  serializeImplementationScopeProjection,
  tryProjectImplementationScope,
  validateImplementationScopeProjection,
} from "./implementation-scope-projection.js";

const repository = {
  repositoryHost: "github.com",
  repositoryId: "415000001",
  repository: "yohn-jp/gh-inari",
} as const;
const implementation = { ...repository, number: 572 } as const;
const source = { ...repository, number: 568 } as const;
const base = { branch: "main", revision: "a".repeat(40), freshness: "fresh-1" } as const;

function contract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: IMPLEMENTATION_CONTRACT_VERSION,
    kind: IMPLEMENTATION_KIND,
    repository,
    sources: [source],
    objective: "Project one bounded execution scope.",
    nonGoals: ["Runtime-specific adapters"],
    architecture: {
      decision: "Keep projection at the authorization boundary.",
      affectedComponents: ["Implementation Core"],
      invariants: ["The projection cannot widen authorization."],
      compatibilityConstraints: [],
    },
    scope: {
      readOnly: ["src/**"],
      write: ["src/**"],
      create: ["docs/**"],
      delete: ["tmp/**"],
      deny: ["src/private/**"],
    },
    constraints: {
      prohibitedOperations: ["Do not grant unspecified mutation operations."],
      immutableAreas: ["The authorization record"],
      prerequisites: ["A current authorization is required."],
    },
    verification: {
      acceptanceCriteria: ["The projection is deterministic."],
      targetedTests: ["pnpm test"],
      requiredChecks: ["pnpm run verify"],
      postconditions: ["Only authorized scope is exposed."],
    },
    execution: {
      baseBranch: base.branch,
      baseRevision: base.revision,
      baseFreshness: base.freshness,
      branch: "feat/574-implementation-scope-projection",
      dependencies: [source],
    },
    ...overrides,
  };
}

const body = renderImplementationIssueBody(parseImplementationContract(contract()));

function authorization(): ImplementationAuthorizationRecord {
  return authorizeImplementation({ implementation, body, repository, base, authorizedAt: "2026-09-16T00:00:00.000Z" });
}

function projectionInput(record = authorization(), bodyValue = body): Record<string, unknown> {
  return { authorization: record, implementation, body: bodyValue, repository, base };
}

test("projects only the current authorization and preserves every distinct scope", () => {
  const result = tryProjectImplementationScope(projectionInput());
  assert.equal(result.valid, true);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.projection?.scope, {
    readOnly: ["src/**"],
    write: ["src/**"],
    create: ["docs/**"],
    delete: ["tmp/**"],
    deny: ["src/private/**"],
  });
  assert.equal(result.projection?.version, IMPLEMENTATION_SCOPE_PROJECTION_VERSION);
  assert.equal(result.projection?.kind, IMPLEMENTATION_SCOPE_PROJECTION_KIND);
  assert.deepEqual(result.projection?.authorization.implementation, implementation);
  assert.equal(result.projection?.authorization.governedBodyDigest, implementationIssueBodyDigest(body));
  assert.deepEqual(result.projection?.repository, repository);
  assert.deepEqual(result.projection?.base, base);
  assert.equal(Object.isFrozen(result.projection), true);
  assert.equal(Object.isFrozen(result.projection?.scope), true);
});

test("does not widen authorization and applies DENY before every operation allowlist", () => {
  const projection = projectImplementationScope(projectionInput());
  assert.deepEqual(implementationScopeProjectionPaths(projection, "READONLY"), ["src/**"]);
  assert.deepEqual(implementationScopeProjectionPaths(projection, "WRITE"), ["src/**"]);
  assert.deepEqual(implementationScopeProjectionPaths(projection, "CREATE"), ["docs/**"]);
  assert.deepEqual(implementationScopeProjectionPaths(projection, "DELETE"), ["tmp/**"]);
  assert.deepEqual(implementationScopeProjectionPaths(projection, "DENY"), ["src/private/**"]);

  assert.equal(isImplementationScopeProjectionPathAllowed(projection, "READONLY", "src/index.ts"), true);
  assert.equal(isImplementationScopeProjectionPathAllowed(projection, "WRITE", "src/index.ts"), true);
  assert.equal(isImplementationScopeProjectionPathAllowed(projection, "WRITE", "src/private/key.ts"), false);
  assert.equal(isImplementationScopeProjectionPathAllowed(projection, "CREATE", "docs/new.md"), true);
  assert.equal(isImplementationScopeProjectionPathAllowed(projection, "CREATE", "src/new.ts"), false);
  assert.equal(isImplementationScopeProjectionPathAllowed(projection, "DELETE", "tmp/old.txt"), true);
  assert.equal(isImplementationScopeProjectionPathAllowed(projection, "DELETE", "src/old.ts"), false);
  assert.equal(isImplementationScopeProjectionPathDenied(projection, "src/private/key.ts"), true);

  // U+FF41 FULLWIDTH LATIN SMALL LETTER A NFKC-normalizes to ASCII "a"; this
  // candidate path is byte-distinct from "src/index.ts" and must not inherit
  // its authority just because NFKC would collapse the two together.
  assert.equal(isImplementationScopeProjectionPathAllowed(projection, "WRITE", "src/ａndex.ts"), false);

  const attemptedOverride = tryProjectImplementationScope({ ...projectionInput(), scope: { write: ["**"] } });
  assert.equal(attemptedOverride.valid, false);
  assert.ok(
    attemptedOverride.violations.some(
      (violation) => violation.code === "IMPLEMENTATION_AUTHORIZATION_UNKNOWN_PROPERTY",
    ),
  );
});

test("projection scope validation reuses the authored path canonicalization rule", () => {
  const projection = projectImplementationScope(projectionInput());
  const normalized = validateImplementationScopeProjection({
    ...projection,
    scope: {
      readOnly: [" src\\** "],
      write: ["src\\**"],
      create: ["docs//**"],
      delete: [" tmp//** "],
      deny: ["src\\private//**"],
    },
  });
  assert.equal(normalized.valid, true);
  assert.deepEqual(normalized.projection?.scope, {
    readOnly: ["src/**"],
    write: ["src/**"],
    create: ["docs/**"],
    delete: ["tmp/**"],
    deny: ["src/private/**"],
  });

  const exactCandidates = [
    "src\\index.ts",
    " src/index.ts",
    "src/index.ts ",
    "src//index.ts",
    "./src/index.ts",
    "src/ｉndex.ts",
    "src/../index.ts",
    "/src/index.ts",
  ];
  for (const path of exactCandidates)
    assert.equal(isImplementationScopeProjectionPathAllowed(projection, "WRITE", path), false, path);
  assert.equal(isImplementationScopeProjectionPathAllowed(projection, "WRITE", "src/index.ts"), true);
});

test("invalidated and stale authorization cannot produce execution authority", () => {
  const changedBody = renderImplementationIssueBody(
    parseImplementationContract(contract({ objective: "A different authorized objective." })),
  );
  const bodyDrift = tryProjectImplementationScope(projectionInput(authorization(), changedBody));
  assert.equal(bodyDrift.valid, false);
  assert.equal(bodyDrift.projection, undefined);
  assert.ok(bodyDrift.violations.some((violation) => violation.code === "IMPLEMENTATION_MODIFIED_AFTER_AUTHORIZATION"));

  const stale = tryProjectImplementationScope({
    ...projectionInput(),
    base: { ...base, revision: "b".repeat(40) },
  });
  assert.equal(stale.valid, false);
  assert.equal(stale.projection, undefined);
  assert.ok(stale.violations.some((violation) => violation.code === "IMPLEMENTATION_AUTHORIZATION_BINDING_DRIFT"));

  const completed = tryProjectImplementationScope({ ...projectionInput(), completed: true });
  assert.equal(completed.valid, false);
  assert.equal(completed.projection, undefined);
});

test("projection output is deterministic, canonical, and schema-versioned", () => {
  const first = projectImplementationScope(projectionInput());
  const equivalentBody = `<!-- metadata is outside the governed contract -->\n${body.replaceAll("\n", "\r\n")}`;
  const second = projectImplementationScope(projectionInput(authorization(), equivalentBody));
  const firstSerialized = serializeImplementationScopeProjection(first);
  assert.equal(firstSerialized, serializeImplementationScopeProjection(second));
  assert.equal(
    deserializeImplementationScopeProjection(`${firstSerialized}\n`).kind,
    IMPLEMENTATION_SCOPE_PROJECTION_KIND,
  );
  assert.deepEqual(deserializeImplementationScopeProjection(firstSerialized), first);
  assert.equal(IMPLEMENTATION_SCOPE_PROJECTION_SCHEMA.$id, "urn:inari:implementation-scope-projection:1.0.0");
  assert.deepEqual(projectImplementationScopeSchema(), IMPLEMENTATION_SCOPE_PROJECTION_SCHEMA);
  assert.deepEqual(IMPLEMENTATION_SCOPE_PROJECTION_SCHEMA.properties?.scope?.required, [
    "readOnly",
    "write",
    "create",
    "delete",
    "deny",
  ]);

  const tampered = JSON.parse(firstSerialized) as Record<string, unknown>;
  (tampered.scope as Record<string, unknown>).write = ["**"];
  assert.equal(validateImplementationScopeProjection(tampered).valid, true);
  assert.notEqual(serializeImplementationScopeProjection(tampered), firstSerialized);
});

test("omitted mutation lists stay empty and cannot become inferred authority", () => {
  const bodyWithoutMutations = renderImplementationIssueBody(
    parseImplementationContract(
      contract({ scope: { readOnly: ["src/**"], write: [], create: [], delete: [], deny: [] } }),
    ),
  );
  const record = authorizeImplementation({ implementation, body: bodyWithoutMutations, repository, base });
  const projection = projectImplementationScope(projectionInput(record, bodyWithoutMutations));
  assert.deepEqual(projection.scope, { readOnly: ["src/**"], write: [], create: [], delete: [], deny: [] });
  assert.equal(isImplementationScopeProjectionPathAllowed(projection, "WRITE", "src/index.ts"), false);
  assert.equal(isImplementationScopeProjectionPathAllowed(projection, "CREATE", "src/new.ts"), false);
  assert.equal(isImplementationScopeProjectionPathAllowed(projection, "DELETE", "src/old.ts"), false);
});
