#!/usr/bin/env node
// Runtime component dependency-boundary guard (#1098 / #1105).
//
// Module identities are resolved with the TypeScript module resolver against
// the repository tsconfig (NodeNext), never with path regexes alone. For every
// module owned by a Runtime role the guard walks the value-import closure
// (static imports, side-effect imports, `export ... from` re-exports — which is
// how barrels load their targets — `import x = require()` and literal dynamic
// `import()`) and reports each forbidden private module that the role can load,
// directly or transitively. Type-only imports are erased at runtime; they are
// checked separately against the approved neutral type catalog.
//
// Non-literal dynamic imports and unresolvable relative specifiers inside a
// role's closure cannot be proven safe and always fail. Historical violations
// may be admitted only as exact `from` -> `to` pairs owned by the migration
// leaves #1106/#1107/#1108/#1109. The ledger only shrinks: wildcards,
// directories, unknown owners and pairs outside the frozen baseline fail.
import { builtinModules } from "node:module";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Role ownership. A prefix ending in "/" owns every non-test module below it;
 * any other entry is one exact module. Ownership prefixes are not exceptions.
 */
export const RUNTIME_ROLE_OWNERSHIP = Object.freeze({
  "runtime-contracts": Object.freeze(["src/runtime-contracts/"]),
  "setup-application": Object.freeze(["src/application/setup/"]),
  cli: Object.freeze([
    "src/cli/",
    "src/local-control/admission-client.ts",
    "src/local-control/session-launcher.ts",
    "src/local-application-state.ts",
  ]),
  console: Object.freeze(["src/local-control/console-server.ts"]),
  admission: Object.freeze([
    "src/admission/",
    "src/local-control/admission-server.ts",
    "src/local-control/session-store.ts",
  ]),
  executor: Object.freeze(["src/executor/", "src/local-control/executor-server.ts"]),
  authority: Object.freeze(["src/authority/"]),
  composition: Object.freeze(["src/composition/", "src/local-control/supervisor.ts"]),
});

/** Private module groups: code that acquires, holds or uses a component secret or private state. */
export const PRIVATE_MODULE_GROUPS = Object.freeze({
  "issuer-custody": Object.freeze([
    "src/executor/",
    "src/local-control/executor-server.ts",
    "src/relay/local-runtime-config.ts",
    "src/github/app-installation-credential-broker.ts",
  ]),
  "app-user-credential": Object.freeze([
    "src/github/app-user-credential.ts",
    "src/github/app-user-credential-store.ts",
    "src/github/app-user-credential-broker.ts",
    "src/github/gh-auth-credential.ts",
    "src/github/user-credential.ts",
  ]),
  "authority-signing": Object.freeze(["src/authority/", "src/agent-authority/delegator-operations.ts"]),
  "admission-private": Object.freeze([
    "src/admission/",
    "src/local-control/admission-server.ts",
    "src/local-control/session-store.ts",
  ]),
});

/**
 * Neutral roles may value-import only their own modules and the listed neutral
 * roles; every other value edge is forbidden. Other roles are denied the listed
 * private groups (their own group excepted).
 */
export const NEUTRAL_ROLE_VALUE_SCOPE = Object.freeze({
  "runtime-contracts": Object.freeze(["runtime-contracts"]),
  "setup-application": Object.freeze(["setup-application", "runtime-contracts"]),
});

export const ROLE_DENIED_GROUPS = Object.freeze({
  cli: Object.freeze(["issuer-custody", "admission-private"]),
  console: Object.freeze(["issuer-custody", "admission-private", "authority-signing"]),
  admission: Object.freeze(["issuer-custody", "app-user-credential", "authority-signing"]),
  executor: Object.freeze(["app-user-credential", "authority-signing", "admission-private"]),
  authority: Object.freeze(["issuer-custody", "app-user-credential", "admission-private"]),
  composition: Object.freeze([]),
});

/**
 * Approved public neutral types. Neutral roles may type-import only these
 * symbols from outside their value scope; other roles may type-import these
 * symbols (and only these) from a denied private group.
 */
export const APPROVED_NEUTRAL_TYPES = Object.freeze({
  "src/authorized-execution.ts": Object.freeze([
    "AuthorizedExecution",
    "AuthorizedExecutionOperation",
    "AuthorizedExecutionResult",
  ]),
  "src/github/effect-authorizer.ts": Object.freeze(["RepositoryIdentity"]),
  "src/agent-authority/delegator.ts": Object.freeze(["Delegator"]),
  "src/change-provenance-record.ts": Object.freeze(["SignedChangeProvenanceRecord"]),
  "src/local-control/session-binding.ts": Object.freeze(["LocalSessionBinding"]),
  "src/local-control/execution-intent.ts": Object.freeze(["ExecutionIntent"]),
});

export const MIGRATION_EDGE_OWNERS = Object.freeze(["#1106", "#1107", "#1108", "#1109"]);

/**
 * Historical migration ledger. Each entry is one exact role-owned module and
 * one exact forbidden module it can load at baseline 569c2399. Entries are
 * removed by their owner leaf (#1109 clears the ledger); none may be added.
 */
export const HISTORICAL_MIGRATION_EDGES = Object.freeze([
  // #1106 D1: the Executor server loads App-user/user credential modules through the provider barrel.
  edge("src/local-control/executor-server.ts", "src/github/app-user-credential.ts", "#1106"),
  edge("src/local-control/executor-server.ts", "src/github/app-user-credential-broker.ts", "#1106"),
  edge("src/local-control/executor-server.ts", "src/github/app-user-credential-store.ts", "#1106"),
  edge("src/local-control/executor-server.ts", "src/github/gh-auth-credential.ts", "#1106"),
  edge("src/local-control/executor-server.ts", "src/github/user-credential.ts", "#1106"),
  // #1108 D3: the CLI Admission client imports the Admission server for protocol constants.
  edge("src/local-control/admission-client.ts", "src/local-control/admission-server.ts", "#1108"),
  edge("src/local-control/admission-client.ts", "src/local-control/session-store.ts", "#1108"),
  // #1108 D3: the state projector imports Executor/Admission servers for status and health paths.
  edge("src/local-application-state.ts", "src/github/app-installation-credential-broker.ts", "#1108"),
  edge("src/local-application-state.ts", "src/local-control/admission-server.ts", "#1108"),
  edge("src/local-application-state.ts", "src/local-control/executor-server.ts", "#1108"),
  edge("src/local-application-state.ts", "src/local-control/session-store.ts", "#1108"),
  edge("src/local-application-state.ts", "src/relay/local-runtime-config.ts", "#1108"),
  // #1109 D4: the console server reaches private roles through the state projector.
  edge("src/local-control/console-server.ts", "src/github/app-installation-credential-broker.ts", "#1109"),
  edge("src/local-control/console-server.ts", "src/local-control/admission-server.ts", "#1109"),
  edge("src/local-control/console-server.ts", "src/local-control/executor-server.ts", "#1109"),
  edge("src/local-control/console-server.ts", "src/local-control/session-store.ts", "#1109"),
  edge("src/local-control/console-server.ts", "src/relay/local-runtime-config.ts", "#1109"),
]);

function edge(from, to, owner) {
  return Object.freeze({ from, to, owner });
}

const EXACT_MODULE_PATH = /^src\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.ts$/u;
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function matchesEntry(relativePath, entry) {
  return entry.endsWith("/") ? relativePath.startsWith(entry) : relativePath === entry;
}

function isGovernedSource(relativePath) {
  return (
    relativePath.startsWith("src/") &&
    relativePath.endsWith(".ts") &&
    !relativePath.endsWith(".d.ts") &&
    !relativePath.endsWith(".test.ts") &&
    !relativePath.endsWith("/fixtures.ts")
  );
}

export function roleOf(relativePath, ownership = RUNTIME_ROLE_OWNERSHIP) {
  for (const [role, entries] of Object.entries(ownership)) {
    if (entries.some((entry) => matchesEntry(relativePath, entry))) return role;
  }
  return undefined;
}

export function privateGroupsOf(relativePath, groups = PRIVATE_MODULE_GROUPS) {
  return Object.entries(groups)
    .filter(([, entries]) => entries.some((entry) => matchesEntry(relativePath, entry)))
    .map(([group]) => group);
}

function loadCompilerOptions(root) {
  const configPath = path.join(root, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  return { ...parsed.options, noEmit: true };
}

function isStringLiteralLike(node) {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
}

/**
 * Extracts module references from one source file. `kind` is "value" for any
 * reference that loads the target at runtime and "type" for erased imports.
 */
export function extractModuleReferences(fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const references = [];
  const add = (specifier, kind, node, symbols = []) =>
    references.push({
      specifier,
      kind,
      symbols,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      const specifier = node.moduleSpecifier.text;
      if (clause === undefined) {
        add(specifier, "value", node);
      } else if (clause.isTypeOnly) {
        add(specifier, "type", node, importedNames(clause));
      } else {
        const bindings = clause.namedBindings;
        const allTypeOnly =
          clause.name === undefined &&
          bindings !== undefined &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 &&
          bindings.elements.every((element) => element.isTypeOnly);
        add(specifier, allTypeOnly ? "type" : "value", node, importedNames(clause));
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      if (!isStringLiteralLike(node.moduleSpecifier)) {
        add(undefined, "value", node);
      } else {
        const clause = node.exportClause;
        const allTypeOnly =
          node.isTypeOnly ||
          (clause !== undefined &&
            ts.isNamedExports(clause) &&
            clause.elements.length > 0 &&
            clause.elements.every((element) => element.isTypeOnly));
        const symbols =
          clause !== undefined && ts.isNamedExports(clause)
            ? clause.elements.map((element) => (element.propertyName ?? element.name).text)
            : [];
        add(node.moduleSpecifier.text, allTypeOnly ? "type" : "value", node, symbols);
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      add(isStringLiteralLike(expression) ? expression.text : undefined, node.isTypeOnly ? "type" : "value", node);
    } else if (ts.isCallExpression(node)) {
      const [argument] = node.arguments;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(isStringLiteralLike(argument) ? argument.text : undefined, "value", node);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        add(isStringLiteralLike(argument) ? argument.text : undefined, "value", node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

function importedNames(clause) {
  const names = [];
  if (clause.name !== undefined) names.push("default");
  const bindings = clause.namedBindings;
  if (bindings === undefined) return names;
  if (ts.isNamespaceImport(bindings)) return [...names, "*"];
  return [...names, ...bindings.elements.map((element) => (element.propertyName ?? element.name).text)];
}

function createResolver(root, compilerOptions) {
  const cache = new Map();
  return (specifier, containingFile) => {
    const key = `${containingFile}\0${specifier}`;
    if (cache.has(key)) return cache.get(key);
    const resolved = ts.resolveModuleName(specifier, containingFile, compilerOptions, ts.sys).resolvedModule;
    let result;
    if (resolved === undefined) {
      result = BUILTINS.has(specifier) ? { kind: "external" } : { kind: "unresolved" };
    } else if (resolved.isExternalLibraryImport) {
      result = { kind: "external" };
    } else {
      const relative = toPosix(path.relative(root, resolved.resolvedFileName));
      result =
        relative.startsWith("../") || path.isAbsolute(relative)
          ? { kind: "external" }
          : { kind: "internal", path: relative };
    }
    cache.set(key, result);
    return result;
  };
}

function listGovernedSources(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (isGovernedSource(toPosix(path.relative(root, absolute))))
        files.push(toPosix(path.relative(root, absolute)));
    }
  };
  walk(path.join(root, "src"));
  return files.sort();
}

/** Builds the resolved module graph for every governed source under `src/`. */
export function buildModuleGraph(root = defaultRoot, options = {}) {
  const compilerOptions = options.compilerOptions ?? loadCompilerOptions(root);
  const resolve = createResolver(root, compilerOptions);
  const graph = new Map();
  const load = (relativePath) => {
    if (graph.has(relativePath)) return graph.get(relativePath);
    const absolute = path.join(root, relativePath);
    const text = fs.readFileSync(absolute, "utf8");
    const references = extractModuleReferences(absolute, text).map((reference) => {
      if (reference.specifier === undefined) return { ...reference, target: { kind: "dynamic" } };
      return { ...reference, target: resolve(reference.specifier, absolute) };
    });
    const node = { path: relativePath, references };
    graph.set(relativePath, node);
    return node;
  };
  for (const file of options.files ?? listGovernedSources(root)) load(file);
  return { graph, load };
}

function deniedGroupsFor(role) {
  const own = new Set(privateGroupsForRole(role));
  return (ROLE_DENIED_GROUPS[role] ?? []).filter((group) => !own.has(group));
}

function privateGroupsForRole(role) {
  const entries = RUNTIME_ROLE_OWNERSHIP[role] ?? [];
  return Object.entries(PRIVATE_MODULE_GROUPS)
    .filter(([, groupEntries]) => groupEntries.some((entry) => entries.includes(entry)))
    .map(([group]) => group);
}

function forbiddenValueTarget(role, targetPath) {
  const scope = NEUTRAL_ROLE_VALUE_SCOPE[role];
  if (scope !== undefined) {
    const targetRole = roleOf(targetPath);
    return targetRole !== undefined && scope.includes(targetRole) ? undefined : `${role}-value-scope`;
  }
  const denied = deniedGroupsFor(role);
  return privateGroupsOf(targetPath).find((group) => denied.includes(group));
}

function approvedType(targetPath, symbols) {
  const approved = APPROVED_NEUTRAL_TYPES[targetPath];
  return approved !== undefined && symbols.length > 0 && symbols.every((symbol) => approved.includes(symbol));
}

/**
 * Maps a frozen historical edge onto modules reached by owner-internal extraction.
 * The target and owner never change: only the source may move along value-import
 * edges that remain inside the same Runtime role as the frozen source.
 */
function buildMigrationInheritance(graph, load, ledger) {
  const inherited = new Map();
  for (const entry of ledger) {
    const role = roleOf(entry.from);
    if (role === undefined || !graph.has(entry.from)) continue;
    const queue = [entry.from];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const current = queue.shift();
      const key = `${current}\0${entry.to}`;
      const existing = inherited.get(key);
      if (existing === undefined) inherited.set(key, entry);
      else if (existing.from !== entry.from || existing.owner !== entry.owner) inherited.set(key, null);

      for (const reference of load(current).references) {
        if (reference.kind !== "value" || reference.target.kind !== "internal") continue;
        const target = reference.target.path;
        if (seen.has(target) || roleOf(target) !== role) continue;
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return inherited;
}

/**
 * Checks every role-owned module. Returns raw findings before the migration
 * ledger is applied.
 */
export function collectBoundaryFindings(root = defaultRoot, options = {}) {
  const { graph, load } = buildModuleGraph(root, options);
  const ledger = options.ledger ?? HISTORICAL_MIGRATION_EDGES;
  const exactLedger = new Map(ledger.map((entry) => [`${entry.from}\0${entry.to}`, entry]));
  const inheritedLedger = buildMigrationInheritance(graph, load, ledger);
  const findings = [];
  const roots = [...graph.keys()].filter((file) => roleOf(file) !== undefined).sort();
  for (const from of roots) {
    const role = roleOf(from);
    const typeRules = checkTypeImports(role, graph.get(from));
    findings.push(...typeRules.map((finding) => ({ ...finding, role, from })));

    // Breadth-first value closure keeps the shortest witness path per target.
    const parents = new Map([[from, undefined]]);
    const queue = [from];
    const reported = new Set();
    while (queue.length > 0) {
      const current = queue.shift();
      for (const reference of load(current).references) {
        if (reference.kind !== "value") continue;
        const via = witness(parents, current);
        if (reference.target.kind === "dynamic") {
          findings.push({
            rule: "unanalyzable-dynamic-import",
            role,
            from,
            to: `${current}:${reference.line}`,
            via,
          });
          continue;
        }
        if (reference.target.kind === "unresolved") {
          findings.push({
            rule: "unresolved-import",
            role,
            from,
            to: `${current}:${reference.line}:${reference.specifier}`,
            via,
          });
          continue;
        }
        if (reference.target.kind !== "internal") continue;
        const target = reference.target.path;
        if (parents.has(target)) continue;
        parents.set(target, current);
        const rule = forbiddenValueTarget(role, target);
        const exactException = exactLedger.get(`${from}\0${target}`);
        const inheritedException = inheritedLedger.get(`${from}\0${target}`) ?? undefined;
        if (rule !== undefined) {
          if (!reported.has(target)) {
            reported.add(target);
            findings.push({
              rule,
              role,
              from,
              to: target,
              via: witness(parents, target),
              ...(inheritedException === undefined
                ? {}
                : { historicalFrom: inheritedException.from, historicalOwner: inheritedException.owner }),
            });
          }
        }

        // A frozen cross-role edge is the historical boundary itself. Do not
        // attribute the target role's private closure to the caller as new
        // violations; that target is independently checked under its own role.
        const targetRole = roleOf(target);
        const historicalRoleBoundary =
          rule !== undefined && exactException !== undefined && targetRole !== undefined && targetRole !== role;
        if (isGovernedSource(target) && !historicalRoleBoundary) queue.push(target);
      }
    }
  }
  return findings;
}

function witness(parents, target) {
  const chain = [];
  for (let node = target; node !== undefined; node = parents.get(node)) chain.unshift(node);
  return chain;
}

function checkTypeImports(role, node) {
  const findings = [];
  const scope = NEUTRAL_ROLE_VALUE_SCOPE[role];
  for (const reference of node.references) {
    if (reference.kind !== "type" || reference.target.kind !== "internal") continue;
    const target = reference.target.path;
    let restricted;
    if (scope !== undefined) {
      const targetRole = roleOf(target);
      restricted = !(targetRole !== undefined && scope.includes(targetRole));
    } else {
      restricted = forbiddenValueTarget(role, target) !== undefined;
    }
    if (restricted && !approvedType(target, reference.symbols)) {
      findings.push({
        rule: "unapproved-type-import",
        to: target,
        symbols: reference.symbols,
        via: [node.path, target],
      });
    }
  }
  return findings;
}

/** Validates the migration ledger shape: exact, owner-bound, unique, baseline-only. */
export function validateMigrationLedger(ledger, baseline = HISTORICAL_MIGRATION_EDGES) {
  const problems = [];
  const baselineKeys = new Set(baseline.map((entry) => `${entry.from}\0${entry.to}\0${entry.owner}`));
  const seen = new Set();
  for (const entry of ledger) {
    const label = `${entry?.from} -> ${entry?.to}`;
    if (entry === null || typeof entry !== "object" || Object.keys(entry).sort().join(",") !== "from,owner,to") {
      problems.push(`${label}: exception must contain exactly from, to and owner`);
      continue;
    }
    for (const side of ["from", "to"]) {
      if (typeof entry[side] !== "string" || !EXACT_MODULE_PATH.test(entry[side]) || entry[side].includes("..")) {
        problems.push(`${label}: ${side} must be one exact repository module path (no wildcard or directory)`);
      }
    }
    if (!MIGRATION_EDGE_OWNERS.includes(entry.owner)) {
      problems.push(`${label}: owner ${String(entry.owner)} is not one of ${MIGRATION_EDGE_OWNERS.join(", ")}`);
    }
    const key = `${entry.from}\0${entry.to}\0${entry.owner}`;
    if (seen.has(`${entry.from}\0${entry.to}`)) problems.push(`${label}: duplicate exception`);
    seen.add(`${entry.from}\0${entry.to}`);
    if (!baselineKeys.has(key))
      problems.push(`${label}: not in the frozen historical baseline; new exceptions are forbidden`);
  }
  return problems;
}

/**
 * Applies the ledger. Only role-owned value findings can be excused; dynamic,
 * unresolved and type findings never are.
 */
export function evaluateRuntimeBoundaries(root = defaultRoot, options = {}) {
  const ledger = options.ledger ?? HISTORICAL_MIGRATION_EDGES;
  const ledgerProblems = validateMigrationLedger(ledger, options.baseline ?? HISTORICAL_MIGRATION_EDGES);
  const findings = collectBoundaryFindings(root, options);
  const excusable = new Set(["unanalyzable-dynamic-import", "unresolved-import", "unapproved-type-import"]);
  const ledgerKeys = new Map(ledger.map((entry) => [`${entry.from}\0${entry.to}`, entry]));
  const violations = [];
  const excused = [];
  for (const finding of findings) {
    const exception = excusable.has(finding.rule)
      ? undefined
      : (ledgerKeys.get(`${finding.from}\0${finding.to}`) ??
        (finding.historicalFrom === undefined
          ? undefined
          : ledgerKeys.get(`${finding.historicalFrom}\0${finding.to}`)));
    if (exception === undefined) violations.push(finding);
    else excused.push({ ...finding, owner: exception.owner, historicalFrom: exception.from });
  }
  const usedKeys = new Set(excused.map((finding) => `${finding.historicalFrom ?? finding.from}\0${finding.to}`));
  const retired = ledger.filter((entry) => !usedKeys.has(`${entry.from}\0${entry.to}`));
  return { ok: violations.length === 0 && ledgerProblems.length === 0, violations, excused, retired, ledgerProblems };
}

function formatFinding(finding) {
  const symbols = finding.symbols?.length ? ` {${finding.symbols.join(", ")}}` : "";
  return `  [${finding.rule}] ${finding.role}: ${finding.from} -> ${finding.to}${symbols}\n    via ${finding.via.join(" -> ")}`;
}

function main() {
  const result = evaluateRuntimeBoundaries(defaultRoot);
  for (const problem of result.ledgerProblems) console.error(`ledger: ${problem}`);
  if (result.violations.length > 0) {
    console.error(`Runtime boundary violations (${result.violations.length}):`);
    for (const finding of result.violations) console.error(formatFinding(finding));
  }
  if (result.retired.length > 0) {
    console.log(`Retired migration exceptions awaiting ledger cleanup (#1109): ${result.retired.length}`);
    for (const entry of result.retired) console.log(`  ${entry.owner}: ${entry.from} -> ${entry.to}`);
  }
  if (!result.ok) {
    process.exitCode = 1;
    return;
  }
  console.log(`Runtime boundaries OK: ${result.excused.length} historical migration edge(s) within the frozen ledger.`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
