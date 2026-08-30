import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ArtifactInputError,
  ArtifactPreparationError,
  loadCanonicalArtifact,
  parseArtifactInputDocument,
  prepareIssueArtifact,
  preparePullRequestArtifact,
  projectExistingArtifact,
  renderIssueArtifact,
  renderPullRequestArtifact,
  type ArtifactInputDocument,
} from "./artifact.js";
import { projectContract, type CanonicalContract, SemanticValidationError } from "./contract/index.js";
import { GitHubAdapter, isGitHubAdapterError } from "./github/index.js";
import {
  assertPullRequestSyncInputComplete,
  parsePullRequestSyncInput,
  projectPullRequestSyncInput,
  renderPullRequestSyncInputHelp,
} from "./pr-sync-input.js";
import {
  compileLocalGovernedContract,
  compileRepositoryGovernedContract,
  createGovernedIssue,
  createGovernedPullRequest,
  discoverRepositoryTemplates,
  rejectGovernedPolicyOverride,
} from "./governance.js";
import { discoverTemplates, type TemplateSelector } from "./template-discovery.js";
import type {
  GitHubIssue,
  GitHubPullRequest,
  ValidatedRenderedIssueArtifact,
  ValidatedRenderedPullRequestArtifact,
} from "./github/types.js";
import {
  applySemanticPatch,
  assessExistingArtifact,
  currentArtifactInput,
  diffArtifact,
  prepareRemediationArtifact,
  prepareSyncInput,
  remediationDiagnosticReport,
  remediationFailureDetails,
  readGovernedExistingArtifact,
  RemediationError,
  translateRemediationFailure,
  updateGovernedExistingArtifact,
} from "./reconciliation.js";
import {
  discoverSemanticTemplates,
  importNativeTemplate,
  renderSemanticCompactSchema,
  syncSemanticTemplates,
  SEMANTIC_ISSUE_DIRECTORY,
  SEMANTIC_PULL_REQUEST_FILE,
  SEMANTIC_TEMPLATE_DIRECTORY,
} from "./semantic-template.js";
import {
  findSkillScenario,
  MAX_SKILL_OUTPUT_BYTES,
  projectSkillIndexToJson,
  projectSkillIndexToText,
  projectSkillScenarioToJson,
  projectSkillScenarioToText,
  SKILL_SCENARIOS,
} from "./skill.js";

const EXIT_USAGE = 1;
const EXIT_VALIDATION = 2;
const EXIT_REMOTE = 3;
const EXIT_INTERNAL = 4;

interface PackageMetadata {
  readonly name: string;
  readonly version: string;
  readonly description: string;
}

const DIAGNOSTIC_PROTOCOL_VERSION = 1;
const RUNTIME_CAPABILITIES = [
  "canonical-invocation",
  "machine-readable-version",
  "capability-diagnostics",
  "extension-bootstrap",
] as const;
const CANONICAL_INVOCATION = "gh inari";
const KNOWN_ARTIFACT_COMMANDS = new Set([
  "schema",
  "validate",
  "render",
  "create",
  "explain",
  "get",
  "check",
  "edit",
  "normalize",
  "sync",
]);
const KNOWN_TEMPLATE_COMMANDS = new Set(["list", "sync", "import"]);
/** issue/pr commands that resolve an ArtifactInputDocument and therefore accept --field; every other command must reject it explicitly rather than silently ignore it. */
const FIELD_CAPABLE_ARTIFACT_COMMANDS = new Set(["validate", "render", "create", "edit", "sync"]);
const INSTALL_COMMAND = "gh extension install yohn-jp/gh-inari";
const UPDATE_COMMAND = "gh extension upgrade inari";
const FALLBACK_COMMAND = "npx --yes gh-inari";

interface RuntimeInfo {
  readonly name: string;
  readonly version: string;
  readonly protocol: number;
  readonly capabilities: readonly string[];
  readonly invocation: {
    readonly canonical: string;
    readonly direct: string;
    readonly fallback: string;
  };
}

interface DiagnosticCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

interface CanonicalDiagnostic {
  readonly status: "ready" | "missing" | "stale" | "unavailable";
  readonly version?: string;
  readonly capabilities?: readonly string[];
  readonly missingCapabilities?: readonly string[];
  readonly detail?: string;
  readonly recovery: string;
}

export interface CliDependencies {
  readonly repositoryRoot?: string;
  readonly createAdapter?: (options: ConstructorParameters<typeof GitHubAdapter>[0]) => GitHubAdapter;
  readonly packageMetadata?: PackageMetadata;
  readonly runDiagnosticCommand?: (args: readonly string[]) => DiagnosticCommandResult;
  readonly runGhFallback?: (argv: readonly string[]) => number;
}

const BOOLEAN_OPTIONS = new Set([
  "help",
  "json",
  "version",
  "diagnose",
  "doctor",
  "draft",
  "maintainerCanModify",
  "compact",
  "check",
  "dryRun",
]);
const VALUE_OPTIONS = new Set([
  "from",
  "template",
  "policy",
  "repository",
  "title",
  "head",
  "base",
  "to",
  "requireCapability",
  "minimumVersion",
]);

/** One `--field <name>=<value>` occurrence in argv order, before contract-aware resolution. */
interface RawFieldEntry {
  readonly name: string;
  readonly value: string;
}

interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, string | boolean>>;
  /** Raw `--field` occurrences, preserved in argv order for deterministic repeated-value semantics. */
  readonly fields: readonly RawFieldEntry[];
}

interface CliErrorShape {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly details?: unknown;
  readonly violations?: unknown;
  readonly diagnostics?: unknown;
}

/** The installed gh-inari executable entrypoint. */
export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const metadata = dependencies.packageMetadata ?? readPackageMetadata();
  if (!isOwnedInvocation(argv)) return runGhFallback(argv, dependencies);
  let parsed: ParsedArgs;
  try {
    parsed = parseArguments(argv);
  } catch (error: unknown) {
    const shape = toErrorShape(error);
    const json = argv.some((token) => token === "--json" || token === "--json=true");
    if (json || isMachineCommandTokens(argv)) console.log(JSON.stringify({ ok: false, error: shape }));
    else console.error(`${shape.code}: ${shape.message}`);
    return classifyExitCode(error);
  }
  const diagnosticRequested =
    parsed.options.diagnose === true ||
    parsed.options.doctor === true ||
    parsed.positionals[0] === "diagnose" ||
    parsed.positionals[0] === "doctor";
  const versionRequested = parsed.options.version === true || parsed.positionals[0] === "version";
  const helpRequested = parsed.options.help !== undefined && parsed.options.help !== false;
  if (helpRequested || (parsed.positionals.length === 0 && !versionRequested && !diagnosticRequested)) {
    printHelpFor(parsed.positionals, parsed.options.help);
    return parsed.positionals.length === 0 && !helpRequested ? EXIT_USAGE : 0;
  }
  const json = parsed.options.json === true;
  try {
    if (versionRequested) return runVersion(metadata, parsed.options, json);
    if (diagnosticRequested) return runDiagnostic(metadata, parsed.options, json, dependencies);

    const root = path.resolve(dependencies.repositoryRoot ?? process.cwd());
    const [domain, command, ...rest] = parsed.positionals;
    if (parsed.fields.length > 0 && !isFieldCapableCommand(domain, command)) {
      throw fieldUnsupportedCommandError(parsed.positionals);
    }
    if (domain === "template" && command === "list") {
      return await runTemplateList(root, parsed.options.repository, dependencies);
    }
    if (domain === "template" && command === "sync") {
      return await runTemplateSync(root, parsed.options.check === true);
    }
    if (domain === "template" && command === "import") {
      return await runTemplateImport(root, rest, parsed, json);
    }
    if (domain === "issue" || domain === "pr") {
      return await runArtifactCommand(domain, command, rest, parsed, root, dependencies, json);
    }
    if (domain === "skill") {
      return runSkillCommand(command, json);
    }
    throw new CliError("UNKNOWN_COMMAND", `Unknown command "${parsed.positionals.join(" ")}".`);
  } catch (error: unknown) {
    const shape = toErrorShape(error);
    if (json || isMachineCommand(parsed.positionals)) console.log(JSON.stringify({ ok: false, error: shape }));
    else console.error(`${shape.code}: ${shape.message}`);
    return classifyExitCode(error);
  }
}

function runVersion(
  metadata: PackageMetadata,
  options: Readonly<Record<string, string | boolean>>,
  json: boolean,
): number {
  const info = runtimeInfo(metadata);
  const requirements = runtimeRequirements(options, false);
  const missingCapabilities = requirements.capabilities.filter((capability) => !info.capabilities.includes(capability));
  const versionSupported =
    requirements.minimumVersion === undefined || versionAtLeast(info.version, requirements.minimumVersion);
  const ok = missingCapabilities.length === 0 && versionSupported;
  if (json) {
    console.log(
      JSON.stringify({
        ok,
        ...info,
        ...(ok
          ? {}
          : {
              error: {
                code: "RUNTIME_REQUIREMENT_UNMET",
                message: runtimeRequirementMessage(info, missingCapabilities, requirements.minimumVersion),
                ...(missingCapabilities.length === 0 ? {} : { missingCapabilities }),
                ...(requirements.minimumVersion === undefined ? {} : { minimumVersion: requirements.minimumVersion }),
                recovery: FALLBACK_COMMAND,
              },
            }),
      }),
    );
  } else {
    console.log(`${metadata.name} ${metadata.version}`);
    if (!ok)
      console.error(`gh-inari: ${runtimeRequirementMessage(info, missingCapabilities, requirements.minimumVersion)}`);
  }
  return ok ? 0 : EXIT_VALIDATION;
}

function runDiagnostic(
  metadata: PackageMetadata,
  options: Readonly<Record<string, string | boolean>>,
  json: boolean,
  dependencies: CliDependencies,
): number {
  const info = runtimeInfo(metadata);
  const requirements = runtimeRequirements(options, true);
  const canonical = probeCanonicalExtension(requirements, dependencies.runDiagnosticCommand);
  const ok = canonical.status === "ready";
  const output = {
    ok,
    ...info,
    requiredCapabilities: requirements.capabilities,
    ...(requirements.minimumVersion === undefined ? {} : { minimumVersion: requirements.minimumVersion }),
    canonical: {
      invocation: CANONICAL_INVOCATION,
      status: canonical.status,
      ...(canonical.version === undefined ? {} : { version: canonical.version }),
      ...(canonical.capabilities === undefined ? {} : { capabilities: canonical.capabilities }),
      ...(canonical.missingCapabilities === undefined ? {} : { missingCapabilities: canonical.missingCapabilities }),
      ...(canonical.detail === undefined ? {} : { detail: canonical.detail }),
      recovery: canonical.recovery,
    },
  };
  if (json) console.log(JSON.stringify(output));
  else {
    console.log(`${metadata.name} ${metadata.version}`);
    if (ok) console.log(`${CANONICAL_INVOCATION}: ready (${canonical.version ?? "unknown version"})`);
    else {
      console.error(`gh-inari: ${canonicalDiagnosticMessage(canonical)}`);
      console.error(`Action: ${canonical.recovery}`);
    }
  }
  return ok ? 0 : EXIT_VALIDATION;
}

function runtimeInfo(metadata: PackageMetadata): RuntimeInfo {
  return {
    name: metadata.name,
    version: metadata.version,
    protocol: DIAGNOSTIC_PROTOCOL_VERSION,
    capabilities: [...RUNTIME_CAPABILITIES],
    invocation: {
      canonical: CANONICAL_INVOCATION,
      direct: "gh-inari",
      fallback: FALLBACK_COMMAND,
    },
  };
}

function runtimeRequirements(
  options: Readonly<Record<string, string | boolean>>,
  defaultCapabilities: boolean,
): { readonly capabilities: readonly string[]; readonly minimumVersion?: string } {
  const requestedCapability = options.requireCapability;
  const capabilities =
    typeof requestedCapability === "string"
      ? [requestedCapability]
      : defaultCapabilities
        ? [...RUNTIME_CAPABILITIES]
        : [];
  const requestedMinimum = options.minimumVersion;
  if (requestedMinimum !== undefined && typeof requestedMinimum !== "string")
    throw new CliError("INVALID_OPTION", "Option --minimum-version requires a version value.", "--minimum-version");
  if (typeof requestedMinimum === "string" && parseVersion(requestedMinimum) === undefined)
    throw new CliError(
      "INVALID_OPTION",
      `Option --minimum-version must be a semantic version (received "${requestedMinimum}").`,
      "--minimum-version",
    );
  return {
    capabilities,
    ...(typeof requestedMinimum === "string" ? { minimumVersion: requestedMinimum } : {}),
  };
}

function probeCanonicalExtension(
  requirements: { readonly capabilities: readonly string[]; readonly minimumVersion?: string },
  runCommand: CliDependencies["runDiagnosticCommand"],
): CanonicalDiagnostic {
  const execute = runCommand ?? runGhDiagnosticCommand;
  const list = execute(["extension", "list"]);
  if (list.status !== 0) {
    return {
      status: "unavailable",
      detail: diagnosticProcessDetail(list),
      recovery: FALLBACK_COMMAND,
    };
  }
  if (!hasInariExtension(list.stdout)) return { status: "missing", recovery: INSTALL_COMMAND };

  const version = execute(["inari", "--version", "--json"]);
  if (version.status !== 0) {
    return {
      status: "stale",
      detail: diagnosticProcessDetail(version),
      recovery: UPDATE_COMMAND,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(version.stdout.trim()) as unknown;
  } catch {
    return {
      status: "stale",
      detail: "the installed extension does not support machine-readable version output",
      recovery: UPDATE_COMMAND,
    };
  }
  if (!isRuntimeInfo(parsed)) {
    return {
      status: "stale",
      detail: "the installed extension returned an incompatible version contract",
      recovery: UPDATE_COMMAND,
    };
  }
  if (parsed.protocol !== DIAGNOSTIC_PROTOCOL_VERSION) {
    return {
      status: "stale",
      version: parsed.version,
      capabilities: parsed.capabilities,
      detail: `the installed extension uses diagnostic protocol ${parsed.protocol}; expected ${DIAGNOSTIC_PROTOCOL_VERSION}`,
      recovery: UPDATE_COMMAND,
    };
  }
  const missingCapabilities = requirements.capabilities.filter(
    (capability) => !parsed.capabilities.includes(capability),
  );
  if (
    missingCapabilities.length > 0 ||
    (requirements.minimumVersion !== undefined && !versionAtLeast(parsed.version, requirements.minimumVersion))
  ) {
    return {
      status: "stale",
      version: parsed.version,
      capabilities: parsed.capabilities,
      ...(missingCapabilities.length === 0 ? {} : { missingCapabilities }),
      detail: runtimeRequirementMessage(parsed, missingCapabilities, requirements.minimumVersion),
      recovery: UPDATE_COMMAND,
    };
  }
  return { status: "ready", version: parsed.version, capabilities: parsed.capabilities, recovery: UPDATE_COMMAND };
}

function runGhDiagnosticCommand(args: readonly string[]): DiagnosticCommandResult {
  try {
    const result = spawnSync("gh", [...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 3_000,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error === undefined ? {} : { error: result.error.message }),
    };
  } catch (error: unknown) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error.message : "unable to execute gh",
    };
  }
}

/** Delegates argv gh-inari does not own to the real `gh` binary, so `gh inari` is a strict superset of `gh`. */
function runGhFallback(argv: readonly string[], dependencies: CliDependencies): number {
  const execute = dependencies.runGhFallback ?? runGhPassthroughCommand;
  return execute(argv);
}

function runGhPassthroughCommand(argv: readonly string[]): number {
  const result = spawnSync("gh", [...argv], { stdio: "inherit" });
  if (result.error) throw new CliError("GH_FALLBACK_FAILED", `Cannot execute gh: ${result.error.message}.`);
  return result.status ?? EXIT_INTERNAL;
}

function hasInariExtension(output: string): boolean {
  return output.split(/\r?\n/u).some((line) => /^\s*gh\s+inari(?:\s|$)/u.test(line));
}

function isRuntimeInfo(value: unknown): value is RuntimeInfo {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const invocation = candidate.invocation;
  return (
    candidate.ok !== false &&
    typeof candidate.name === "string" &&
    candidate.name === "gh-inari" &&
    typeof candidate.version === "string" &&
    typeof candidate.protocol === "number" &&
    Array.isArray(candidate.capabilities) &&
    candidate.capabilities.every((capability) => typeof capability === "string") &&
    typeof invocation === "object" &&
    invocation !== null &&
    typeof (invocation as Record<string, unknown>).canonical === "string" &&
    typeof (invocation as Record<string, unknown>).direct === "string" &&
    typeof (invocation as Record<string, unknown>).fallback === "string"
  );
}

function runtimeRequirementMessage(
  info: Pick<RuntimeInfo, "version">,
  missingCapabilities: readonly string[],
  minimumVersion: string | undefined,
): string {
  const requirements: string[] = [];
  if (missingCapabilities.length > 0)
    requirements.push(`missing capability ${missingCapabilities.map((value) => `"${value}"`).join(", ")}`);
  if (minimumVersion !== undefined && !versionAtLeast(info.version, minimumVersion))
    requirements.push(`version ${info.version} is older than required ${minimumVersion}`);
  return requirements.length === 0 ? "runtime requirements are not satisfied" : requirements.join("; ");
}

function canonicalDiagnosticMessage(diagnostic: CanonicalDiagnostic): string {
  if (diagnostic.status === "missing") return "the canonical gh extension is not installed";
  if (diagnostic.status === "unavailable") return diagnostic.detail ?? "the GitHub CLI could not be executed";
  if (diagnostic.status === "stale") return diagnostic.detail ?? "the installed gh extension is stale";
  return "the canonical gh extension is ready";
}

function diagnosticProcessDetail(result: DiagnosticCommandResult): string {
  const detail = (result.error ?? result.stderr ?? "").trim().split(/\r?\n/u)[0];
  return detail === "" ? "the GitHub CLI command failed" : detail.slice(0, 240);
}

function parseVersion(value: string): readonly [number, number, number] | undefined {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = parseVersion(actual);
  const minimumParts = parseVersion(minimum);
  if (actualParts === undefined || minimumParts === undefined) return false;
  for (let index = 0; index < actualParts.length; index += 1) {
    if (actualParts[index] !== minimumParts[index]) return actualParts[index] > minimumParts[index];
  }
  return true;
}

class CliError extends Error {
  readonly code: string;
  readonly path?: string;
  readonly details?: unknown;

  constructor(code: string, message: string, path?: string, details?: unknown) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.path = path;
    this.details = details;
  }
}

/** Bound for local --from <file> and stdin artifact input, independent of semantic field constraints. */
const MAX_INPUT_BYTES = 1_048_576;

function inputTooLargeError(observedBytes: number): CliError {
  return new CliError(
    "INPUT_TOO_LARGE",
    `Input exceeds the maximum allowed size of ${MAX_INPUT_BYTES} bytes.`,
    "--from",
    { limitBytes: MAX_INPUT_BYTES, observedBytes },
  );
}

function skillOutputExceedsBudgetError(scenarioId: string | undefined, observedBytes: number): CliError {
  return new CliError(
    "SKILL_OUTPUT_EXCEEDS_BUDGET",
    `Skill output exceeds the maximum allowed size of ${MAX_SKILL_OUTPUT_BYTES} bytes.`,
    "skill",
    { limitBytes: MAX_SKILL_OUTPUT_BYTES, observedBytes, scenarioId },
  );
}

function unknownSkillScenarioError(scenarioId: string): CliError {
  return new CliError("UNKNOWN_SKILL_SCENARIO", `Unknown skill scenario "${scenarioId}".`, "$argv[1]", {
    scenarioId,
    knownScenarios: SKILL_SCENARIOS.map((scenario) => scenario.id),
  });
}

function runSkillCommand(scenarioId: string | undefined, json: boolean): number {
  const output =
    scenarioId === undefined
      ? json
        ? JSON.stringify(projectSkillIndexToJson())
        : projectSkillIndexToText()
      : (() => {
          const scenario = findSkillScenario(scenarioId);
          if (scenario === undefined) throw unknownSkillScenarioError(scenarioId);
          return json ? JSON.stringify(projectSkillScenarioToJson(scenario)) : projectSkillScenarioToText(scenario);
        })();
  const observedBytes = Buffer.byteLength(output, "utf8");
  if (observedBytes > MAX_SKILL_OUTPUT_BYTES) throw skillOutputExceedsBudgetError(scenarioId, observedBytes);
  console.log(output);
  return 0;
}

function invalidArtifactNumberError(domain: "issue" | "pr", value: string | undefined): CliError {
  const message =
    value === undefined
      ? `A ${domain} number is required.`
      : `"${value}" is not a valid ${domain} number. Use a positive integer.`;
  return new CliError("INVALID_ARTIFACT_NUMBER", message, "$argv[0]", { domain, value });
}

async function runTemplateList(
  root: string,
  repository: string | boolean | undefined,
  dependencies: CliDependencies,
): Promise<number> {
  let discovery;
  if (typeof repository === "string") {
    const adapter = createAdapter(dependencies, root, repository);
    await adapter.resolveRepositoryContext();
    discovery = await discoverRepositoryTemplates(adapter);
  } else {
    discovery = await discoverTemplates(root);
  }
  const semanticTemplates = typeof repository === "string" ? [] : await discoverSemanticTemplates(root);
  const hint =
    semanticTemplates.length === 0 && typeof repository !== "string"
      ? `no semantic templates found under ${SEMANTIC_TEMPLATE_DIRECTORY}/; ` +
        `expected ${SEMANTIC_ISSUE_DIRECTORY}/<id>.json, ${SEMANTIC_PULL_REQUEST_FILE}, ` +
        `or ${SEMANTIC_TEMPLATE_DIRECTORY}/pull-requests/<id>.json`
      : undefined;
  console.log(
    JSON.stringify({
      templates: discovery.templates,
      semanticTemplates,
      ...(hint === undefined ? {} : { semanticTemplatesHint: hint }),
    }),
  );
  return 0;
}

async function runTemplateSync(root: string, check: boolean): Promise<number> {
  const result = await syncSemanticTemplates(root, check);
  console.log(JSON.stringify(result));
  return check && result.changed ? EXIT_VALIDATION : 0;
}

async function runTemplateImport(
  root: string,
  rest: readonly string[],
  parsed: ParsedArgs,
  json: boolean,
): Promise<number> {
  const nativePath = typeof parsed.options.from === "string" ? parsed.options.from : rest[0];
  if (nativePath === undefined)
    throw new CliError("INPUT_REQUIRED", "Use template import --from <native-template>.", "--from");
  const imported = await importNativeTemplate(
    root,
    nativePath,
    typeof parsed.options.to === "string" ? parsed.options.to : undefined,
  );
  if (json) console.log(JSON.stringify({ ok: true, ...imported }));
  else {
    console.log(imported.path);
    if (imported.warning !== undefined) console.error(`warning: ${imported.warning}`);
  }
  return 0;
}

async function runArtifactCommand(
  domain: "issue" | "pr",
  command: string | undefined,
  rest: readonly string[],
  parsed: ParsedArgs,
  root: string,
  dependencies: CliDependencies,
  json: boolean,
): Promise<number> {
  if (command === "schema") {
    let contract: CanonicalContract;
    if (typeof parsed.options.repository === "string") {
      rejectGovernedPolicyOverride(parsed.options.policy);
      const adapter = createAdapter(dependencies, root, parsed.options.repository);
      await adapter.resolveRepositoryContext();
      contract = await compileRepositoryGovernedContract(adapter, domain, templateSelector(parsed, rest[0]));
    } else {
      contract = await compileLocalGovernedContract(
        domain,
        root,
        templateSelector(parsed, rest[0]),
        parsed.options.policy,
      );
    }
    const projection = projectContract(contract);
    const syncInput = domain === "pr" ? projectPullRequestSyncInput(contract) : undefined;
    if (parsed.options.compact === true)
      console.log(
        JSON.stringify({
          schema: renderSemanticCompactSchema(contract),
          metadata: projection.metadata,
          ...(syncInput === undefined ? {} : { syncInput }),
        }),
      );
    else
      console.log(
        JSON.stringify({
          contract,
          template: contract.templateIdentity,
          ...projection,
          directFields: projectDirectFieldUsage(contract),
          ...(syncInput === undefined ? {} : { syncInput }),
        }),
      );
    return 0;
  }
  if (command === "validate" || command === "render" || command === "create") {
    if (
      command === "validate" &&
      rest[0] !== undefined &&
      isPositiveInteger(rest[0]) &&
      parsed.options.from === undefined &&
      parsed.fields.length === 0
    ) {
      return runExistingValidation(domain, Number(rest[0]), parsed, root, dependencies, json);
    }
    if (command === "validate" || command === "render") {
      let contract: CanonicalContract;
      if (typeof parsed.options.repository === "string") {
        rejectGovernedPolicyOverride(parsed.options.policy);
        const adapter = createAdapter(dependencies, root, parsed.options.repository);
        await adapter.resolveRepositoryContext();
        contract = await compileRepositoryGovernedContract(adapter, domain, templateSelector(parsed, rest[0]));
      } else {
        contract = await compileLocalGovernedContract(
          domain,
          root,
          templateSelector(parsed, rest[0]),
          parsed.options.policy,
        );
      }
      const document = await resolveArtifactInputDocument(parsed, contract);
      const preparedDocument = mergeOptionMetadata(document, parsed.options);
      if (command === "validate") {
        const validation = loadCanonicalArtifact(contract, preparedDocument);
        console.log(
          JSON.stringify({
            valid: validation.valid,
            violations: validation.violations,
            values: validation.canonical,
            // Progressive --field discovery: each unresolved field's type/required/constraints,
            // reusing the existing #120/#121 partial-classification projection rather than a
            // second field table -- so retrying with more --field values is guided by the same
            // contract metadata resolveDirectFields itself accepts.
            missingFields: validation.missingFields,
            invalidFields: validation.invalidFields,
          }),
        );
        return validation.valid ? 0 : EXIT_VALIDATION;
      }
      const body =
        domain === "issue"
          ? renderIssueArtifact(contract, preparedDocument.fields)
          : renderPullRequestArtifact(contract, preparedDocument.fields);
      if (json) console.log(JSON.stringify({ valid: true, body }));
      else process.stdout.write(body);
      return 0;
    }

    rejectGovernedPolicyOverride(parsed.options.policy);
    const adapter = createAdapter(dependencies, root, parsed.options.repository);
    await adapter.resolveRepositoryContext();
    const contract = await compileRepositoryGovernedContract(adapter, domain, templateSelector(parsed, rest[0]));
    const document = await resolveArtifactInputDocument(parsed, contract);
    const preparedDocument = mergeOptionMetadata(document, parsed.options);
    if (domain === "issue") {
      const prepared = prepareIssueArtifact(contract, preparedDocument);
      const created = await createGovernedIssue(adapter, prepared.artifact);
      console.log(JSON.stringify({ ok: true, artifact: created.artifact, governance: created.governance }));
      return 0;
    }
    const prepared = preparePullRequestArtifact(contract, preparedDocument);
    const created = await createGovernedPullRequest(adapter, prepared.artifact);
    console.log(JSON.stringify({ ok: true, artifact: created.artifact, governance: created.governance }));
    return 0;
  }
  if (command === "check" || command === "edit" || command === "normalize" || command === "sync") {
    if (rest[0] === undefined || !isPositiveInteger(rest[0])) {
      throw invalidArtifactNumberError(domain, rest[0]);
    }
    return runExistingRemediation(domain, command, Number(rest[0]), parsed, root, dependencies, json);
  }
  if (
    (command === "validate" || command === "explain") &&
    rest[0] !== undefined &&
    isPositiveInteger(rest[0]) &&
    parsed.options.from === undefined
  ) {
    return runExistingValidation(domain, Number(rest[0]), parsed, root, dependencies, true);
  }
  if (command === "explain" && (rest[0] === undefined || !isPositiveInteger(rest[0]))) {
    throw invalidArtifactNumberError(domain, rest[0]);
  }
  if (command === "get") {
    if (rest[0] !== undefined && isPositiveInteger(rest[0])) {
      return runExistingGet(domain, Number(rest[0]), parsed, root, dependencies);
    }
    throw invalidArtifactNumberError(domain, rest[0]);
  }
  throw new CliError("UNKNOWN_COMMAND", `Unknown ${domain} command "${command ?? ""}".`);
}

async function runExistingValidation(
  domain: "issue" | "pr",
  number: number,
  parsed: ParsedArgs,
  root: string,
  dependencies: CliDependencies,
  json: boolean,
): Promise<number> {
  rejectGovernedPolicyOverride(parsed.options.policy);
  const adapter = createAdapter(dependencies, root, parsed.options.repository);
  await adapter.resolveRepositoryContext();
  const read = await readGovernedExistingArtifact(adapter, domain, number, templateSelector(parsed, undefined));
  const { remote, result } = read;
  const projection = projectExistingArtifact(result);
  const output = {
    valid: projection.valid,
    classification: projection.classification,
    number,
    url: remote.url,
    diagnostics: projection.diagnostics,
    ...(projection.violations === undefined ? {} : { violations: projection.violations }),
    ...(projection.attemptedTemplates === undefined ? {} : { attemptedTemplates: projection.attemptedTemplates }),
  };
  console.log(JSON.stringify(output));
  return result.valid ? 0 : EXIT_VALIDATION;
}

async function runExistingGet(
  domain: "issue" | "pr",
  number: number,
  parsed: ParsedArgs,
  root: string,
  dependencies: CliDependencies,
): Promise<number> {
  rejectGovernedPolicyOverride(parsed.options.policy);
  const adapter = createAdapter(dependencies, root, parsed.options.repository);
  await adapter.resolveRepositoryContext();
  const { remote, contract, result } = await readGovernedExistingArtifact(
    adapter,
    domain,
    number,
    templateSelector(parsed, undefined),
  );
  const projection = projectExistingArtifact(result);
  const output = {
    valid: projection.valid,
    projection: projection.projection,
    classification: projection.classification,
    kind: domain === "issue" ? "issue" : "pull_request",
    number: remote.number,
    url: remote.url,
    ...(contract === undefined ? {} : { template: contract.templateIdentity }),
    metadata: existingArtifactMetadata(domain, remote),
    ...(projection.fields === undefined ? {} : { fields: projection.fields }),
    diagnostics: projection.diagnostics,
    ...(projection.violations === undefined ? {} : { violations: projection.violations }),
    ...(projection.attemptedTemplates === undefined ? {} : { attemptedTemplates: projection.attemptedTemplates }),
  };
  console.log(JSON.stringify(output));
  return result.valid ? 0 : EXIT_VALIDATION;
}

async function runExistingRemediation(
  domain: "issue" | "pr",
  operation: "check" | "edit" | "normalize" | "sync",
  number: number,
  parsed: ParsedArgs,
  root: string,
  dependencies: CliDependencies,
  json: boolean,
): Promise<number> {
  void json;
  rejectGovernedPolicyOverride(parsed.options.policy);
  const adapter = createAdapter(dependencies, root, parsed.options.repository);
  await adapter.resolveRepositoryContext();
  const read = await readGovernedExistingArtifact(adapter, domain, number, templateSelector(parsed, undefined));
  const assessment = assessExistingArtifact(domain, read);
  const base = {
    operation,
    kind: domain === "issue" ? "issue" : "pull_request",
    number: read.remote.number,
    url: read.remote.url,
    ...(read.contract === undefined ? {} : { template: read.contract.templateIdentity }),
  };

  if (operation === "check") {
    console.log(
      JSON.stringify({
        ok: assessment.status === "valid-current",
        ...base,
        status: assessment.status,
        classification: read.result.classification,
        valid: assessment.status === "valid-current",
        normalizable: assessment.normalizable,
        diagnostics: assessment.diagnostics,
        ...(read.result.classification === "semantic" ? { violations: read.result.violations } : {}),
        ...(read.result.attemptedTemplates === undefined ? {} : { attemptedTemplates: read.result.attemptedTemplates }),
      }),
    );
    return assessment.status === "valid-current" ? 0 : EXIT_VALIDATION;
  }

  if (read.contract === undefined) {
    throw new RemediationError(
      operation === "normalize"
        ? "NORMALIZATION_UNSAFE"
        : operation === "edit"
          ? "SEMANTIC_PATCH_UNSUPPORTED"
          : "SYNC_CURRENT_UNSUPPORTED",
      "No authoritative template could be selected for the existing artifact.",
      "$.template",
      operation === "edit" || operation === "normalize" ? remediationFailureDetails(read) : undefined,
      operation === "edit" || operation === "normalize"
        ? remediationDiagnosticReport(domain, operation, read)
        : undefined,
    );
  }

  let desiredInput: ArtifactInputDocument;
  try {
    if (operation === "normalize") {
      if (!read.result.valid || !read.result.parse.parsed) {
        throw new RemediationError(
          "NORMALIZATION_UNSAFE",
          "Normalization requires a semantically valid artifact whose values can be round-tripped canonically.",
          "$.artifact",
        );
      }
      desiredInput = currentArtifactInput(domain, read);
    } else {
      const input = await resolveArtifactInputDocument(
        parsed,
        read.contract,
        domain === "pr" && operation === "sync",
        operation === "edit" && hasEditMetadataOption(parsed.options),
      );
      desiredInput =
        operation === "edit"
          ? applySemanticPatch(domain, read, mergeOptionMetadata(input, parsed.options))
          : prepareSyncInput(domain, read, input);
    }
  } catch (error: unknown) {
    if (operation === "edit" || operation === "normalize") {
      throw translateRemediationFailure(domain, operation, read, error);
    }
    throw error;
  }

  let desired: ReturnType<typeof prepareRemediationArtifact>;
  try {
    desired = prepareRemediationArtifact(domain, read.contract, desiredInput);
  } catch (error: unknown) {
    if (operation === "edit" || operation === "normalize") {
      throw translateRemediationFailure(domain, operation, read, error, desiredInput);
    }
    throw error;
  }
  const diff = diffArtifact(domain, read, desired);
  const resultBase = {
    ...base,
    changed: diff.changed,
    noOp: !diff.changed,
    diff,
  };
  if (!diff.changed || parsed.options.dryRun === true) {
    console.log(
      JSON.stringify({
        ok: true,
        ...resultBase,
        ...(parsed.options.dryRun === true
          ? {
              dryRun: true,
              mutation: "not-performed",
              ...(operation === "edit"
                ? { resulting: projectRemediationResult(domain, read.contract, desiredInput, desired) }
                : {}),
            }
          : {}),
      }),
    );
    return 0;
  }

  const mutated = await updateGovernedExistingArtifact(adapter, domain, number, desired);
  console.log(
    JSON.stringify({
      ok: true,
      ...resultBase,
      mutation: "applied",
      artifact: { number: mutated.artifact.number, url: mutated.artifact.url },
      governance: mutated.governance,
    }),
  );
  return 0;
}

function existingArtifactMetadata(
  domain: "issue" | "pr",
  remote: GitHubIssue | GitHubPullRequest,
): Readonly<Record<string, unknown>> {
  if (domain === "issue") {
    if (!("labels" in remote) || !("assignees" in remote)) throw new Error("Issue metadata response is invalid.");
    return {
      title: remote.title,
      state: remote.state,
      labels: remote.labels,
      assignees: remote.assignees,
    };
  }
  if (!("draft" in remote) || !("head" in remote) || !("base" in remote))
    throw new Error("Pull request metadata response is invalid.");
  return {
    title: remote.title,
    state: remote.state,
    draft: remote.draft,
    head: remote.head,
    base: remote.base,
    ...(remote.maintainerCanModify === undefined ? {} : { maintainerCanModify: remote.maintainerCanModify }),
  };
}

function projectRemediationResult(
  domain: "issue" | "pr",
  contract: CanonicalContract | undefined,
  input: ArtifactInputDocument,
  artifact: ReturnType<typeof prepareRemediationArtifact>,
): Readonly<Record<string, unknown>> {
  if (contract === undefined) throw new Error("A remediation result requires a selected contract.");
  const fields = loadCanonicalArtifact(contract, input).canonical;
  if (domain === "issue") {
    const issue = artifact as ValidatedRenderedIssueArtifact;
    return {
      fields,
      metadata: {
        title: issue.title,
        ...(issue.labels === undefined ? {} : { labels: issue.labels }),
        ...(issue.assignees === undefined ? {} : { assignees: issue.assignees }),
      },
      body: issue.body,
    };
  }
  const pullRequest = artifact as ValidatedRenderedPullRequestArtifact;
  return {
    fields,
    metadata: {
      title: pullRequest.title,
      head: pullRequest.head,
      base: pullRequest.base,
      ...(pullRequest.draft === undefined ? {} : { draft: pullRequest.draft }),
      ...(pullRequest.maintainerCanModify === undefined
        ? {}
        : { maintainerCanModify: pullRequest.maintainerCanModify }),
    },
    body: pullRequest.body,
  };
}

function createAdapter(
  dependencies: CliDependencies,
  root: string,
  repository: string | boolean | undefined,
): GitHubAdapter {
  const factory = dependencies.createAdapter ?? ((options) => new GitHubAdapter(options));
  return factory({ cwd: root, ...(typeof repository === "string" ? { repository } : {}) });
}

async function readInputDocument(
  value: string | boolean | undefined,
  parser: (input: unknown) => ArtifactInputDocument = parseArtifactInputDocument,
): Promise<ArtifactInputDocument> {
  if (typeof value !== "string" || value.length === 0)
    throw new CliError("INPUT_REQUIRED", "Use --from <file.json>.", "--from");
  let source: string;
  if (value === "-") source = await readStdin();
  else {
    try {
      const stats = await stat(value);
      if (stats.size > MAX_INPUT_BYTES) throw inputTooLargeError(stats.size);
      source = await readFile(value, "utf8");
      if (Buffer.byteLength(source, "utf8") > MAX_INPUT_BYTES)
        throw inputTooLargeError(Buffer.byteLength(source, "utf8"));
    } catch (cause: unknown) {
      if (cause instanceof CliError) throw cause;
      const error = new CliError("INPUT_READ_FAILED", `Cannot read input file "${value}".`, "--from");
      if (cause instanceof Error) error.cause = cause;
      throw error;
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (cause: unknown) {
    const error = new CliError("INPUT_INVALID_JSON", "Input file must contain valid JSON.", "--from");
    if (cause instanceof Error) error.cause = cause;
    throw error;
  }
  return parser(parsed);
}

function mergeOptionMetadata(
  document: ArtifactInputDocument,
  options: Readonly<Record<string, string | boolean>>,
): ArtifactInputDocument {
  const metadata = {
    ...document.metadata,
    ...(typeof options.title === "string" ? { title: options.title } : {}),
    ...(typeof options.head === "string" ? { head: options.head } : {}),
    ...(typeof options.base === "string" ? { base: options.base } : {}),
    ...(typeof options.draft === "boolean" ? { draft: options.draft } : {}),
    ...(typeof options.maintainerCanModify === "boolean" ? { maintainerCanModify: options.maintainerCanModify } : {}),
  };
  return { fields: document.fields, metadata };
}

function hasEditMetadataOption(options: Readonly<Record<string, string | boolean>>): boolean {
  return ["title", "head", "base", "draft", "maintainerCanModify"].some((key) =>
    Object.prototype.hasOwnProperty.call(options, key),
  );
}

/** Bound on how many accepted field names an unknown-field diagnostic lists before truncating. */
const MAX_LISTED_FIELDS = 12;
/** Bound on how many close-name suggestions an unknown-field diagnostic offers. */
const MAX_FIELD_SUGGESTIONS = 3;
/** Suggestions only surface within this edit distance; beyond it a name is not "close". */
const MAX_SUGGESTION_DISTANCE = 3;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function levenshteinDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const previous = new Array<number>(cols);
  const current = new Array<number>(cols);
  for (let column = 0; column < cols; column += 1) previous[column] = column;
  for (let row = 1; row < rows; row += 1) {
    current[0] = row;
    for (let column = 1; column < cols; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) + cost,
      );
    }
    for (let column = 0; column < cols; column += 1) previous[column] = current[column] ?? 0;
  }
  return previous[cols - 1] ?? 0;
}

function unknownFieldError(name: string, allowedFields: readonly string[]): CliError {
  const suggestions = allowedFields
    .map((candidate) => ({ candidate, distance: levenshteinDistance(candidate, name) }))
    .filter((entry) => entry.distance <= MAX_SUGGESTION_DISTANCE)
    .sort((left, right) => left.distance - right.distance || compareStrings(left.candidate, right.candidate))
    .slice(0, MAX_FIELD_SUGGESTIONS)
    .map((entry) => entry.candidate);
  return new CliError("FIELD_UNKNOWN", `Unknown field "${name}" for this template.`, "--field", {
    field: name,
    allowedFields: allowedFields.slice(0, MAX_LISTED_FIELDS),
    allowedFieldCount: allowedFields.length,
    ...(suggestions.length === 0 ? {} : { suggestions }),
  });
}

function duplicateFieldError(name: string, occurrences: number): CliError {
  return new CliError(
    "FIELD_DUPLICATE",
    `Field "${name}" was provided ${occurrences} times as a scalar --field option; a scalar field accepts exactly one value.`,
    "--field",
    { field: name, occurrences },
  );
}

function fieldConflictError(names: readonly string[]): CliError {
  return new CliError(
    "FIELD_CONFLICT",
    `Field(s) ${names.join(", ")} were supplied by both --from and --field; remove one source.`,
    "--field",
    { fields: names },
  );
}

/** True only for the issue/pr commands that actually resolve an ArtifactInputDocument from --field. */
function isFieldCapableCommand(domain: string | undefined, command: string | undefined): boolean {
  return (
    (domain === "issue" || domain === "pr") && command !== undefined && FIELD_CAPABLE_ARTIFACT_COMMANDS.has(command)
  );
}

function fieldUnsupportedCommandError(positionals: readonly string[]): CliError {
  const label = positionals.length === 0 ? "this command" : `"${positionals.join(" ")}"`;
  const supported = [...FIELD_CAPABLE_ARTIFACT_COMMANDS].sort(compareStrings);
  return new CliError(
    "FIELD_UNSUPPORTED_COMMAND",
    `--field is only supported by issue/pr ${supported.join(", ")}; ${label} does not accept direct field input.`,
    "--field",
    { command: positionals.join(" "), supportedCommands: supported },
  );
}

/** One projected `--field` usage entry: what the schema/help surface shows, and what resolveDirectFields enforces. */
interface DirectFieldUsage {
  readonly name: string;
  readonly type: "string" | "array";
  readonly required: boolean;
  readonly repeatable: boolean;
  readonly cliSyntax: string;
}

/**
 * The one field-usage projection shared by direct --field acceptance
 * (resolveDirectFields, below) and discovery/help (the `schema` command's
 * `directFields`, and progressive help via missing/invalid field
 * diagnostics). Both read this same contract-derived list, so the CLI's
 * documented `--field` syntax and its runtime acceptance cannot drift from
 * each other or from the selected canonical contract.
 */
function projectDirectFieldUsage(contract: CanonicalContract): readonly DirectFieldUsage[] {
  const schema = projectContract(contract).schema;
  const required = new Set(schema.required ?? []);
  return Object.keys(schema.properties)
    .sort(compareStrings)
    .map((name) => {
      const repeatable = schema.properties[name]?.type === "array";
      return {
        name,
        type: repeatable ? "array" : "string",
        required: required.has(name),
        repeatable,
        cliSyntax: repeatable ? `--field ${name}=<value> (repeatable)` : `--field ${name}=<value>`,
      };
    });
}

/**
 * Resolve raw `--field` occurrences against the selected canonical contract:
 * `projectDirectFieldUsage` is the only authority for accepted field names,
 * scalar-vs-list shape, and requiredness -- there is no second, handwritten
 * field table here. A repeatable field accumulates every occurrence in argv
 * order (deterministic repeated-value ordering); any other field accepts at
 * most one occurrence.
 */
function resolveDirectFields(
  contract: CanonicalContract,
  entries: readonly RawFieldEntry[],
): Readonly<Record<string, unknown>> {
  const usage = projectDirectFieldUsage(contract);
  const usageByName = new Map(usage.map((entry) => [entry.name, entry]));
  const allowedFields = usage.map((entry) => entry.name);
  const grouped = new Map<string, string[]>();
  for (const entry of entries) {
    if (!usageByName.has(entry.name)) throw unknownFieldError(entry.name, allowedFields);
    const values = grouped.get(entry.name);
    if (values === undefined) grouped.set(entry.name, [entry.value]);
    else values.push(entry.value);
  }
  const fields: Record<string, unknown> = {};
  for (const [name, values] of grouped) {
    if (usageByName.get(name)?.repeatable === true) {
      fields[name] = values;
      continue;
    }
    if (values.length > 1) throw duplicateFieldError(name, values.length);
    fields[name] = values[0];
  }
  return fields;
}

/** Merge direct-field values into a document under a deterministic, order-independent conflict rule. */
function mergeDirectFields(
  document: ArtifactInputDocument,
  directFields: Readonly<Record<string, unknown>>,
): ArtifactInputDocument {
  const directNames = Object.keys(directFields);
  if (directNames.length === 0) return document;
  const conflicts = directNames
    .filter((name) => Object.prototype.hasOwnProperty.call(document.fields, name))
    .sort(compareStrings);
  if (conflicts.length > 0) throw fieldConflictError(conflicts);
  return { fields: { ...document.fields, ...directFields }, metadata: document.metadata };
}

/**
 * Resolve one artifact input document from `--from` and/or `--field`, sharing
 * the same candidate/normalization/validation path regardless of source. At
 * least one of the two is required; when both are present, `--from` supplies
 * the base document and direct fields are merged in under a conflict rule
 * that never depends on which flag appeared first in argv.
 */
async function resolveArtifactInputDocument(
  parsed: ParsedArgs,
  contract: CanonicalContract,
  requirePullRequestSyncInput = false,
  allowEmpty = false,
): Promise<ArtifactInputDocument> {
  const hasFrom = typeof parsed.options.from === "string";
  if (!hasFrom && parsed.fields.length === 0 && !allowEmpty) {
    throw new CliError("INPUT_REQUIRED", "Use --from <file.json> or --field <name>=<value>.", "--from");
  }
  const document = hasFrom
    ? await readInputDocument(parsed.options.from, requirePullRequestSyncInput ? parsePullRequestSyncInput : undefined)
    : { fields: {}, metadata: {} };
  const directFields = resolveDirectFields(contract, parsed.fields);
  const merged = mergeDirectFields(document, directFields);
  return requirePullRequestSyncInput ? assertPullRequestSyncInputComplete(merged) : merged;
}

function templateSelector(parsed: ParsedArgs, positional: string | undefined): string | undefined {
  return typeof parsed.options.template === "string" ? parsed.options.template : positional;
}

function parseArguments(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  const fields: RawFieldEntry[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token === "-R") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--"))
        throw new CliError("INVALID_OPTION", "Option -R requires a value.");
      options.repository = value;
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equalIndex = token.indexOf("=");
    const rawKey = equalIndex >= 0 ? token.slice(2, equalIndex) : token.slice(2);
    const normalizedKey = rawKey === "repo" ? "repository" : rawKey;
    const key = normalizedKey.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
    if (key === "field") {
      const raw = equalIndex >= 0 ? token.slice(equalIndex + 1) : argv[++index];
      if (raw === undefined || (equalIndex < 0 && raw.startsWith("--")))
        throw new CliError("INVALID_OPTION", "Option --field requires a value.");
      const separatorIndex = raw.indexOf("=");
      if (separatorIndex <= 0)
        throw new CliError("INVALID_OPTION", 'Option --field requires "<name>=<value>" syntax.', "--field");
      fields.push({ name: raw.slice(0, separatorIndex), value: raw.slice(separatorIndex + 1) });
      continue;
    }
    if (BOOLEAN_OPTIONS.has(key)) {
      if (equalIndex < 0) {
        options[key] = true;
        continue;
      }
      const rawValue = token.slice(equalIndex + 1);
      if (key === "help" && rawValue === "full") {
        options[key] = rawValue;
        continue;
      }
      if (rawValue !== "true" && rawValue !== "false")
        throw new CliError("INVALID_OPTION", `Option --${rawKey} must be true or false.`);
      options[key] = rawValue === "true";
      continue;
    }
    if (!VALUE_OPTIONS.has(key)) throw new CliError("INVALID_OPTION", `Unknown option --${rawKey}.`);
    const value = equalIndex >= 0 ? token.slice(equalIndex + 1) : argv[++index];
    if (value === undefined || (equalIndex < 0 && value.startsWith("--")))
      throw new CliError("INVALID_OPTION", `Option --${rawKey} requires a value.`);
    options[key] = value;
  }
  return { positionals, options, fields };
}

function toErrorShape(error: unknown): CliErrorShape {
  if (error instanceof CliError)
    return {
      code: error.code,
      message: error.message,
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  if (error instanceof SemanticValidationError)
    return {
      code: "SEMANTIC_VALIDATION_FAILED",
      message: error.message,
      violations: error.violations,
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(error.diagnostics === undefined ? {} : { diagnostics: error.diagnostics }),
    };
  if (error instanceof RemediationError)
    return {
      code: error.code,
      message: error.message,
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(error.diagnostics === undefined ? {} : { diagnostics: error.diagnostics }),
    };
  if (error instanceof ArtifactInputError)
    return {
      code: error.code,
      message: error.message,
      path: error.path,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  if (error instanceof ArtifactPreparationError) {
    return { code: error.code, message: error.message, diagnostics: error.diagnostics };
  }
  if (isGitHubAdapterError(error)) return { code: error.code, message: error.message, details: error.details };
  if (isObjectWithCode(error))
    return {
      code: error.code,
      message: typeof error.message === "string" ? error.message : "Operation failed.",
      ...(typeof error.path === "string" ? { path: error.path } : {}),
      ...(typeof error.details === "object" ? { details: error.details } : {}),
      ...(Array.isArray(error.violations) ? { violations: error.violations } : {}),
    };
  return { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Operation failed." };
}

function classifyExitCode(error: unknown): number {
  if (
    error instanceof SemanticValidationError ||
    error instanceof ArtifactInputError ||
    error instanceof RemediationError ||
    error instanceof ArtifactPreparationError
  )
    return EXIT_VALIDATION;
  if (isGitHubAdapterError(error)) return EXIT_REMOTE;
  if (
    isObjectWithCode(error) &&
    typeof error.code === "string" &&
    (error.code.includes("TEMPLATE") || error.code.includes("POLICY"))
  )
    return EXIT_VALIDATION;
  if (
    error instanceof CliError &&
    (error.code === "UNKNOWN_COMMAND" ||
      error.code === "INVALID_OPTION" ||
      error.code === "INPUT_REQUIRED" ||
      error.code === "INPUT_READ_FAILED" ||
      error.code === "FIELD_UNSUPPORTED_COMMAND")
  )
    return EXIT_USAGE;
  if (
    error instanceof CliError &&
    (error.code === "INPUT_INVALID_JSON" ||
      error.code === "INPUT_TOO_LARGE" ||
      error.code === "INVALID_ARTIFACT_NUMBER" ||
      error.code === "UNKNOWN_SKILL_SCENARIO" ||
      error.code === "SKILL_OUTPUT_EXCEEDS_BUDGET" ||
      error.code === "FIELD_UNKNOWN" ||
      error.code === "FIELD_DUPLICATE" ||
      error.code === "FIELD_CONFLICT")
  )
    return EXIT_VALIDATION;
  if (isObjectWithCode(error) && error.code === "GOVERNANCE_POLICY_OVERRIDE_FORBIDDEN") return EXIT_VALIDATION;
  if (isObjectWithCode(error) && error.code.startsWith("GOVERNANCE_")) return EXIT_REMOTE;
  if (isObjectWithCode(error) && /^(?:ISSUE_FORM|PR_TEMPLATE|IR_|CONTRACT_)/u.test(error.code)) return EXIT_VALIDATION;
  return EXIT_INTERNAL;
}

/**
 * True when argv targets a command gh-inari implements; false means it must fall back to the real `gh` binary.
 * `--help` on an unowned domain or subcommand (e.g. `repo view --help`, `pr list --help`) is not claimed here so
 * that help delegates to real `gh` the same way execution does -- Inari does not reproduce upstream help text.
 */
function isPositionalToken(token: string, previous: string | undefined): boolean {
  if (previous === "-R") return false;
  return token !== "-R" && !token.startsWith("--");
}

function isOwnedInvocation(argv: readonly string[]): boolean {
  const first = findPositional(argv);
  if (first === undefined) return true;
  if (first === "diagnose" || first === "doctor" || first === "version" || first === "help") return true;
  if (first === "skill") return true;
  if (argv.includes("--version") || argv.includes("--diagnose") || argv.includes("--doctor")) return true;
  const helpRequested = argv.some((token) => token === "--help" || token.startsWith("--help="));
  if (first === "template") {
    const second = findPositional(argv, argv.indexOf(first) + 1);
    if (helpRequested && second === undefined) return true;
    return second !== undefined && KNOWN_TEMPLATE_COMMANDS.has(second);
  }
  if (first === "issue" || first === "pr") {
    const second = findPositional(argv, argv.indexOf(first) + 1);
    if (helpRequested && second === undefined) return true;
    return second !== undefined && KNOWN_ARTIFACT_COMMANDS.has(second);
  }
  return false;
}

function findPositional(argv: readonly string[], fromIndex = 0): string | undefined {
  for (let index = fromIndex; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== undefined && isPositionalToken(token, index > 0 ? argv[index - 1] : undefined)) return token;
  }
  return undefined;
}

function isMachineCommand(positionals: readonly string[]): boolean {
  return (
    (positionals.length >= 2 && KNOWN_ARTIFACT_COMMANDS.has(positionals[1] ?? "")) ||
    positionals[0] === "diagnose" ||
    positionals[0] === "doctor" ||
    positionals[0] === "version" ||
    positionals[0] === "skill"
  );
}

function isMachineCommandTokens(argv: readonly string[]): boolean {
  if (argv.includes("--diagnose") || argv.includes("--doctor") || argv.includes("diagnose") || argv.includes("doctor"))
    return true;
  if (argv.includes("--version") || argv.includes("version")) return argv.includes("--json");
  if (argv.includes("skill")) return true;
  const domainIndex = argv.findIndex((token) => token === "issue" || token === "pr");
  if (domainIndex < 0) return false;
  const command = argv[domainIndex + 1];
  return command !== undefined && KNOWN_ARTIFACT_COMMANDS.has(command);
}

function isPositiveInteger(value: string): boolean {
  return /^[1-9]\d*$/u.test(value);
}

function isObjectWithCode(value: unknown): value is {
  code: string;
  message?: unknown;
  path?: unknown;
  details?: unknown;
  violations?: unknown;
  diagnostics?: unknown;
} {
  return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string";
}

function readPackageMetadata(): PackageMetadata {
  const packagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const value = JSON.parse(requireFile(packagePath)) as Record<string, unknown>;
  if (typeof value.name !== "string" || typeof value.version !== "string") {
    throw new Error("package.json must define the package name and version.");
  }
  return {
    name: value.name,
    version: value.version,
    description: typeof value.description === "string" ? value.description : "",
  };
}

function requireFile(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_INPUT_BYTES) throw inputTooLargeError(totalBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface LeafHelp {
  readonly usage: string;
  readonly summary: string;
  readonly example: string;
}

const TEMPLATE_LEAVES: Readonly<Record<string, LeafHelp>> = {
  list: {
    usage: "template list",
    summary: "List discovered repository-native and semantic templates.",
    example: "inari template list",
  },
  sync: {
    usage: "template sync [--check]",
    summary: "Regenerate native GitHub templates from semantic template contracts under .github/inari/.",
    example: "inari template sync --check",
  },
  import: {
    usage: "template import --from <native-template> [--to <semantic-file>]",
    summary:
      "Import a native GitHub template into a semantic template contract. Discovered semantic paths: " +
      ".github/inari/issues/<id>.json, .github/inari/pull-request.json (single PR template), or " +
      ".github/inari/pull-requests/<id>.json (multiple PR templates). Other --to paths write successfully " +
      "but are never discovered.",
    example: "inari template import --from .github/ISSUE_TEMPLATE/feature.yml",
  },
};

function artifactLeaves(domain: "issue" | "pr"): Readonly<Record<string, LeafHelp>> {
  const noun = domain === "issue" ? "issue" : "pull request";
  return {
    schema: {
      usage: `${domain} schema [template]`,
      summary: `Print the semantic field schema and required create metadata schema for a ${noun} template.`,
      example: `inari ${domain} schema feature --compact`,
    },
    validate: {
      usage: `${domain} validate --template <template> [--from <file.json>] [--field <name>=<value> ...]`,
      summary:
        `Validate input against a template's schema, from JSON, direct --field values, or both. ` +
        `Run \`${domain} schema\` for its "directFields" projection (name/type/required/repeatable, one entry ` +
        `per accepted --field), or submit a partial set here and read back "missingFields"/"invalidFields" for ` +
        `what still needs a value -- there is no separate field list to consult. ` +
        `To validate an existing ${noun} instead, use \`${domain} validate <number> [--template <template>]\`.`,
      example: `inari ${domain} validate --template feature --field problem="A problem"`,
    },
    render: {
      usage: `${domain} render --template <template> [--from <file.json>] [--field <name>=<value> ...]`,
      summary: `Render validated input into canonical Markdown without mutating GitHub.`,
      example: `inari ${domain} render --template feature --field problem="A problem"`,
    },
    create: {
      usage: `${domain} create --template <template> --title <title> [--from <file.json>] [--field <name>=<value> ...]`,
      summary:
        `Validate, render, and create a governed ${noun} on GitHub. A repeated field's schema type "array" ` +
        `accumulates every --field occurrence in argv order; --from and --field may compose but never name the same field. ` +
        `The caller-supplied title must contain content beyond any fixed native template prefix.`,
      example: `inari ${domain} create --template feature --field problem="A problem" --title "feat: add support"`,
    },
    explain: {
      usage: `${domain} explain <number> [--template <template>]`,
      summary: `Explain why an existing ${noun} does or does not satisfy its governed contract.`,
      example: `inari ${domain} explain 123`,
    },
    get: {
      usage: `${domain} get <number> [--template <template>] --json`,
      summary: `Project an existing ${noun} as its canonical semantic JSON.`,
      example: `inari ${domain} get 123 --json`,
    },
    check: {
      usage: `${domain} check <number> [--template <template>]`,
      summary: `Check whether an existing ${noun} is normalizable without mutating GitHub.`,
      example: `inari ${domain} check 123`,
    },
    edit: {
      usage:
        domain === "issue"
          ? `${domain} edit <number> [--from <file.json>] [--field <name>=<value> ...] [--title <title>] [--dry-run]`
          : `${domain} edit <number> [--from <file.json>] [--field <name>=<value> ...] [--title <title>] [--base <branch>] [--maintainer-can-modify[=true|false]] [--dry-run]`,
      summary:
        domain === "issue"
          ? `Apply a patch to an existing ${noun}; omitted fields and metadata are preserved, and --title is supported.`
          : `Apply a patch to an existing ${noun}; omitted fields and metadata are preserved. Supports --title, --base, and --maintainer-can-modify; --draft is unsupported for edit and is rejected.`,
      example: `inari ${domain} edit 123 --field problem="Updated problem" --dry-run`,
    },
    normalize: {
      usage: `${domain} normalize <number> [--dry-run]`,
      summary: `Repair an existing ${noun}'s native projection while preserving its existing semantic values.`,
      example: `inari ${domain} normalize 123 --dry-run`,
    },
    sync: {
      usage: `${domain} sync <number> [--from <file.json>] [--field <name>=<value> ...] [--dry-run]`,
      summary:
        domain === "pr"
          ? `Reconcile an existing ${noun} to a complete desired semantic state. ${renderPullRequestSyncInputHelp()}`
          : `Reconcile an existing ${noun} to a complete desired semantic state, preserving fields and metadata omitted from the input.`,
      example: `inari ${domain} sync 123 --from desired.json --dry-run`,
    },
  };
}

const GLOBAL_OPTIONS = `  --from <path>       JSON input file, or - for stdin
  --field <name>=<value>
                      Direct semantic field input, repeatable; only accepted on validate, render,
                      create, edit, and sync. Field names/types/requiredness come from the
                      selected template's schema -- see \`schema\`'s "directFields" projection, or
                      submit a partial set and read "missingFields"/"invalidFields" back from
                      validate. A repeatable ("array"-typed) field accumulates every occurrence
                      in argv order; any other field accepts at most one. May compose with
                      --from, but the same field cannot be named by both.
  --template <id>     Repository-native template id, path, or unique name
  --policy <path>     Local PR policy for schema/validate/render --from workflows; forbidden for governed remote operations
  --repository <r>    GitHub repository override; governed commands use its default-branch governance
  --repo <r>, -R <r>  Alias for --repository
  --title <title>     Required Issue/PR title for create; metadata, not a semantic --field
  --head <branch>     PR head branch for create
  --base <branch>     PR base branch for create
  --compact            Emit only semantic fields and constraints for schema
  --check              Check generated native projections without writing
  --dry-run            Show a bounded remediation diff without mutating GitHub
  --draft             Create the PR as a draft
  --maintainer-can-modify
                      Allow maintainer edits on the PR
  --json              Emit structured JSON output
  --version           Print package version
  --diagnose          Check the canonical gh extension and recovery path
  --require-capability <id>
                      Require a capability in --version/--diagnose checks
  --minimum-version <v>
                      Require a minimum semantic version in checks
  --help              Print this help (--help=full for the complete reference)`;

const DOMAIN_PASSTHROUGH_EXAMPLE: Readonly<Record<"issue" | "pr" | "template", string>> = {
  issue: "issue list",
  pr: "pr checks",
  template: "template view",
};

/** Dispatches to root, domain, or leaf help by command depth; positionals are pre-parse-error tokens, so any --help value routes here. */
function printHelpFor(positionals: readonly string[], helpValue: string | boolean | undefined): void {
  if (helpValue === "full") return printFullHelp();
  const [domain, command] = positionals;
  if (domain === "issue" || domain === "pr") {
    if (command !== undefined && command in artifactLeaves(domain))
      return printLeafHelp(artifactLeaves(domain)[command]!);
    return printDomainHelp(domain, artifactLeaves(domain));
  }
  if (domain === "template") {
    if (command !== undefined && command in TEMPLATE_LEAVES) return printLeafHelp(TEMPLATE_LEAVES[command]!);
    return printDomainHelp("template", TEMPLATE_LEAVES);
  }
  if (domain === "skill") return printSkillHelp(command);
  printRootHelp();
}

function printRootHelp(): void {
  console.log(`Usage: inari <command> [...]

A governed GitHub CLI. Issue and PR commands under governed templates run
through Inari; every other command passes through to the real gh binary
with the original argv and exit status.

Domains:
  issue      Governed Issue schema, validation, rendering, and lifecycle
  pr         Governed pull request schema, validation, rendering, and lifecycle
  template   Semantic template authoring and native template sync
  skill      Bounded operational playbooks for common governed workflows

All other commands (e.g. repo, auth, pr list, issue view) are passed through to gh.

Run \`inari <domain> --help\` for that domain's operations.
Run \`inari --help=full\` for the complete command and option reference.
Run \`inari --version\` or \`inari --diagnose\` for machine-readable runtime checks.`);
}

function printDomainHelp(domain: "issue" | "pr" | "template", leaves: Readonly<Record<string, LeafHelp>>): void {
  const lines = Object.values(leaves).map((leaf) => `  ${leaf.usage}`);
  console.log(`Usage: inari ${domain} <command> [...]

Operations:
${lines.join("\n")}

Commands outside this list under "${domain}" (e.g. \`${DOMAIN_PASSTHROUGH_EXAMPLE[domain]}\`) pass through to gh.

Run \`inari ${domain} <command> --help\` for that command's inputs and an example.`);
}

function printSkillHelp(scenarioId: string | undefined): void {
  if (scenarioId !== undefined) {
    const scenario = findSkillScenario(scenarioId);
    if (scenario === undefined) return printSkillHelp(undefined);
    return printLeafHelp({
      usage: `skill ${scenario.id} [--json]`,
      summary: scenario.title,
      example: `inari skill ${scenario.id}`,
    });
  }
  const lines = SKILL_SCENARIOS.map((scenario) => `  skill ${scenario.id} [--json]  - ${scenario.title}`);
  console.log(`Usage: inari skill [scenario] [--json]

Bounded operational playbooks for common governed workflows. \`inari skill\`
lists scenarios; \`inari skill <scenario>\` prints that scenario's playbook.

Scenarios:
${lines.join("\n")}

Run \`inari skill <scenario> --help\` for that scenario's summary.
Run \`inari <domain> --help\` for exact command syntax used by a playbook.`);
}

function printLeafHelp(leaf: LeafHelp): void {
  console.log(`Usage: inari ${leaf.usage}

${leaf.summary}

Example:
  ${leaf.example}

Run \`inari --help=full\` for the complete option reference.`);
}

function printFullHelp(): void {
  console.log(`Usage: inari <command> [options]

Commands:
  template list
  template sync [--check]
  template import --from <native-template> [--to <semantic-file>]
                      Discovered semantic paths: .github/inari/issues/<id>.json,
                      .github/inari/pull-request.json (single PR template), or
                      .github/inari/pull-requests/<id>.json (multiple PR templates).
                      Other --to paths write successfully but are never discovered.
  issue schema [template]
  issue validate --template <template> [--from <file.json>] [--field <name>=<value> ...]
  issue render --template <template> [--from <file.json>] [--field <name>=<value> ...]
  issue create --template <template> [--from <file.json>] [--field <name>=<value> ...]
  issue validate <number> [--template <template>]
  issue explain <number> [--template <template>]
  issue get <number> [--template <template>] --json
  issue check <number> [--template <template>]
  issue edit <number> [--from <file.json>] [--field <name>=<value> ...] [--title <title>] [--dry-run]
  issue normalize <number> [--dry-run]
  issue sync <number> [--from <file.json>] [--field <name>=<value> ...] [--dry-run]
  pr schema [template]
  pr validate --template <template> [--from <file.json>] [--field <name>=<value> ...]
  pr render --template <template> [--from <file.json>] [--field <name>=<value> ...]
  pr create --template <template> [--from <file.json>] [--field <name>=<value> ...]
  pr validate <number> [--template <template>]
  pr explain <number> [--template <template>]
  pr get <number> [--template <template>] --json
  pr check <number> [--template <template>]
  pr edit <number> [--from <file.json>] [--field <name>=<value> ...] [--title <title>] [--base <branch>] [--maintainer-can-modify[=true|false]] [--dry-run]
  pr normalize <number> [--dry-run]
  pr sync <number> [--from <file.json>] [--field <name>=<value> ...] [--dry-run]
  skill [scenario] [--json]

Options:
${GLOBAL_OPTIONS}

Create always validates and renders before invoking gh. Schema, validate, render, check, and --dry-run remediation never mutate GitHub.
Edit is the primary patch path: it preserves omitted fields and metadata, validates the complete result, and renders canonical Markdown before mutation. Normalize preserves existing semantic values; issue sync preserves omitted current values; pr sync reconciles a complete desired semantic state.

All other commands pass through to the real gh binary unchanged.

Canonical install: npm install --global gh-inari
PATH-independent fallback: npx --yes gh-inari
Extension compatibility path: gh extension install yohn-jp/gh-inari`);
}
