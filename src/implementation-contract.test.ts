import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMPLEMENTATION_CONTRACT_SCHEMA,
  IMPLEMENTATION_KIND,
  IMPLEMENTATION_CONTRACT_VERSION,
  canonicalizeImplementationScopePath,
  implementationContractDigest,
  implementationContractFromIssueFields,
  implementationIssueFieldsFromContract,
  isImplementationPathAllowed,
  parseImplementationContract,
  parseImplementationIssueBody,
  projectImplementationSchema,
  renderImplementationIssueBody,
  serializeImplementationContract,
  validateImplementationGitPathIdentity,
  validateImplementationContract,
} from "./implementation-contract.js";

const SOURCE = {
  repositoryHost: "github.com",
  repositoryId: "415000001",
  repository: "yohn-jp/gh-inari",
  number: 571,
} as const;

function validContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: IMPLEMENTATION_CONTRACT_VERSION,
    kind: IMPLEMENTATION_KIND,
    repository: {
      repositoryHost: "github.com",
      repositoryId: "415000001",
      repository: "yohn-jp/gh-inari",
    },
    sources: [SOURCE],
    objective: "Add a canonical Implementation execution contract.",
    nonGoals: ["Authorization lifecycle", "PR conformance"],
    architecture: {
      decision: "Keep the domain contract separate from the GitHub Issue adapter.",
      affectedComponents: ["Core contract", "Issue Form adapter"],
      invariants: ["WRITE is an explicit allowlist.", "Issue metadata is not semantic body identity."],
      compatibilityConstraints: ["Existing Issue and PR template behavior remains unchanged."],
    },
    scope: {
      readOnly: ["src/**", ".github/inari/**"],
      write: ["src/implementation-contract.ts", "src/implementation-contract.test.ts"],
      create: [".github/ISSUE_TEMPLATE/implementation.yml"],
      delete: [],
      deny: ["src/private/**"],
    },
    constraints: {
      prohibitedOperations: ["Do not mutate GitHub from Core."],
      immutableAreas: ["Authorization and session lifecycle"],
      prerequisites: ["Issue #571 is accepted."],
    },
    verification: {
      acceptanceCriteria: ["Canonical serialization is deterministic."],
      targetedTests: ["pnpm test -- src/implementation-contract.test.ts"],
      requiredChecks: ["pnpm run verify"],
      postconditions: ["The Implementation body can be round-tripped."],
    },
    execution: {
      baseBranch: "main",
      baseRevision: "a".repeat(40),
      baseFreshness: "resolved at session start",
      branch: "feat/571-implementation-contract",
      dependencies: [SOURCE],
    },
    ...overrides,
  };
}

test("validates a versioned Implementation contract and applies safe defaults", () => {
  const input = validContract({
    scope: { readOnly: ["src/**"], write: ["src/implementation-contract.ts"] },
  });
  const result = validateImplementationContract(input);
  assert.equal(result.valid, true);
  assert.deepEqual(result.contract?.scope, {
    readOnly: ["src/**"],
    write: ["src/implementation-contract.ts"],
    create: [],
    delete: [],
    deny: [],
  });
  assert.equal(result.contract?.kind, "implementation");
});

test("rejects missing and ambiguous semantic fields with bounded diagnostics", () => {
  const missing = validContract();
  delete missing.objective;
  const missingResult = validateImplementationContract(missing);
  assert.equal(missingResult.valid, false);
  assert.ok(missingResult.violations.some((violation) => violation.path === "$.objective"));

  const unknown = validContract({ unexpected: true });
  const unknownResult = validateImplementationContract(unknown);
  assert.equal(unknownResult.valid, false);
  assert.ok(unknownResult.violations.some((violation) => violation.code === "IMPLEMENTATION_UNKNOWN_PROPERTY"));

  const ambiguous = validContract({ scope: { readOnly: ["/src/**"] } });
  const ambiguousResult = validateImplementationContract(ambiguous);
  assert.equal(ambiguousResult.valid, false);
  assert.ok(ambiguousResult.violations.some((violation) => violation.code === "IMPLEMENTATION_SCOPE_INVALID_PATH"));
  assert.throws(() => parseImplementationContract(ambiguous));

  const malformedRepository = validContract({
    repository: { repositoryHost: "github.com\nattacker", repositoryId: "415000001" },
  });
  assert.equal(validateImplementationContract(malformedRepository).valid, false);
});

test("READONLY, WRITE, CREATE, DELETE, and DENY remain distinct", () => {
  const contract = validContract({
    scope: {
      readOnly: ["src/**"],
      write: ["src/**"],
      create: ["docs/**"],
      delete: ["tmp/**"],
      deny: ["src/private/**"],
    },
  });
  assert.equal(isImplementationPathAllowed(contract, "READONLY", "src/index.ts"), true);
  assert.equal(isImplementationPathAllowed(contract, "WRITE", "src/index.ts"), true);
  assert.equal(isImplementationPathAllowed(contract, "WRITE", "src/private/key.ts"), false);
  assert.equal(isImplementationPathAllowed(contract, "CREATE", "docs/new.md"), true);
  assert.equal(isImplementationPathAllowed(contract, "CREATE", "src/new.ts"), false);
  assert.equal(isImplementationPathAllowed(contract, "DELETE", "tmp/old.txt"), true);
  assert.equal(isImplementationPathAllowed(contract, "DELETE", "src/old.ts"), false);
});

test("authored scope paths have one canonical representation", () => {
  assert.equal(canonicalizeImplementationScopePath("  ./src\\ａ//allowed.ts  "), "src/a/allowed.ts");
  assert.equal(canonicalizeImplementationScopePath("src/normal.ts"), "src/normal.ts");
  assert.equal(canonicalizeImplementationScopePath("src/../outside.ts"), undefined);
  assert.equal(canonicalizeImplementationScopePath("/src/absolute.ts"), undefined);

  const result = validateImplementationContract(
    validContract({
      scope: {
        readOnly: ["  ./src\\ａ//allowed.ts  "],
        write: ["src/normal.ts"],
        create: [],
        delete: [],
        deny: [],
      },
    }),
  );
  assert.equal(result.valid, true);
  assert.deepEqual(result.contract?.scope, {
    readOnly: ["src/a/allowed.ts"],
    write: ["src/normal.ts"],
    create: [],
    delete: [],
    deny: [],
  });

  const duplicate = validateImplementationContract(
    validContract({
      scope: {
        readOnly: ["src/allowed.ts", " ./src\\allowed.ts "],
        write: [],
        create: [],
        delete: [],
        deny: [],
      },
    }),
  );
  assert.equal(duplicate.valid, false);
  assert.ok(duplicate.violations.some((violation) => violation.code === "IMPLEMENTATION_SCOPE_DUPLICATE"));
});

test("scope matching never rewrites a candidate Git path identity", () => {
  const contract = validContract({
    scope: {
      readOnly: ["src/**"],
      write: ["src/allowed.ts"],
      create: [],
      delete: [],
      deny: [],
    },
  });
  const variants = [
    "src\\allowed.ts",
    " src/allowed.ts",
    "src/allowed.ts ",
    "src//allowed.ts",
    "./src/allowed.ts",
    "src/ａllowed.ts",
    "src/../allowed.ts",
    "/src/allowed.ts",
  ];
  for (const path of variants) assert.equal(isImplementationPathAllowed(contract, "WRITE", path), false, path);
  assert.equal(isImplementationPathAllowed(contract, "WRITE", "src/allowed.ts"), true);
  assert.equal(validateImplementationGitPathIdentity("src/allowed.ts"), "src/allowed.ts");
  assert.equal(validateImplementationGitPathIdentity("src\\allowed.ts"), "src\\allowed.ts");
});

test("canonical serialization is stable for equivalent object-key order and changes for semantic edits", () => {
  const first = validContract();
  const second = JSON.parse(JSON.stringify(first)) as Record<string, unknown>;
  const secondArchitecture = second.architecture as Record<string, unknown>;
  secondArchitecture.invariants = [...(secondArchitecture.invariants as string[])].reverse();
  const firstCanonical = serializeImplementationContract(first);
  const secondCanonical = serializeImplementationContract(second);
  assert.equal(firstCanonical, secondCanonical);
  assert.equal(implementationContractDigest(first), implementationContractDigest(second));

  const changed = validContract({ objective: "A materially different objective." });
  assert.notEqual(serializeImplementationContract(first), serializeImplementationContract(changed));
  assert.notEqual(implementationContractDigest(first), implementationContractDigest(changed));
});

test("Issue Form fields and canonical body round-trip without metadata", () => {
  const contract = parseImplementationContract(validContract());
  const fields = implementationIssueFieldsFromContract(contract);
  const fromFields = implementationContractFromIssueFields(fields);
  assert.equal(fromFields.valid, true);
  assert.equal(serializeImplementationContract(fromFields.contract), serializeImplementationContract(contract));

  const body = renderImplementationIssueBody(contract);
  const parsed = parseImplementationIssueBody(`${body}\n<!-- title: changed labels: changed comments: ignored -->\n`);
  assert.equal(parsed.valid, true);
  assert.equal(serializeImplementationContract(parsed.contract), serializeImplementationContract(contract));
  assert.equal(body.includes("READONLY scope"), true);
  assert.equal(body.includes("WRITE scope"), true);
  assert.equal(body.includes("CREATE scope"), true);
  assert.equal(body.includes("DELETE scope"), true);
  assert.equal(body.includes("DENY / exclusions"), true);
});

test("the public schema is versioned and defaults do not grant WRITE", () => {
  assert.equal(IMPLEMENTATION_CONTRACT_SCHEMA.$id, "urn:inari:implementation-contract:1.0.0");
  assert.deepEqual(projectImplementationSchema(), IMPLEMENTATION_CONTRACT_SCHEMA);
  assert.deepEqual(IMPLEMENTATION_CONTRACT_SCHEMA.properties?.scope?.required, ["readOnly"]);
  const omittedWrite = validContract({ scope: { readOnly: ["src/**"] } });
  assert.equal(parseImplementationContract(omittedWrite).scope.write.length, 0);
});

test("schema-facing and production validation agree on an omitted mutation scope", () => {
  const ajvLikeRequired = new Set(IMPLEMENTATION_CONTRACT_SCHEMA.properties?.scope?.required ?? []);
  const fixture = validContract({ scope: { readOnly: ["src/**"] } });
  const scopeFixture = fixture.scope as Record<string, unknown>;

  const missingFromSchemaBoundary = ["write", "create", "delete", "deny"].filter(
    (key) => ajvLikeRequired.has(key) && !Object.hasOwn(scopeFixture, key),
  );
  assert.deepEqual(
    missingFromSchemaBoundary,
    [],
    "schema requires a scope property the fixture omits: production and schema validation would disagree",
  );

  const result = validateImplementationContract(fixture);
  assert.equal(result.valid, true);
  assert.deepEqual(result.contract?.scope.write, []);
  assert.deepEqual(result.contract?.scope.create, []);
  assert.deepEqual(result.contract?.scope.delete, []);
  assert.deepEqual(result.contract?.scope.deny, []);
});
