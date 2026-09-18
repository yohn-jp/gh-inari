import { spawnSync } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
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
import {
  compileRepositoryEffectiveIssueContract,
  compileRepositoryEffectiveBranchContract,
  compileRepositoryEffectivePullRequestContract,
} from "./artifact-contract-governance.js";
import {
  effectiveFieldConstraints,
  projectContract,
  type CanonicalContract,
  SemanticValidationError,
} from "./contract/index.js";
import { tryMaterializeSemanticArtifact } from "./contract/semantic-artifact.js";
import { createActionsChangeExecutionAdapter, GitHubAdapter, isGitHubAdapterError } from "./github/index.js";
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
  projectRemediationRouting,
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
  SKILL_MODEL_VERSION,
  SKILL_SCENARIOS,
} from "./skill.js";
import {
  AGENT_INVOCATION_CONTRACT,
  COMMAND_CONTRACT_VERSION,
  COMMAND_OPTIONS,
  INARI_COMMANDS,
  RUNTIME_CAPABILITIES,
  commandExample,
  commandInvocation,
  commandRecoveryInvocation,
  commandTemplateSchemaInvocation,
  commandUsage,
  getCommand,
  getCommandForPositionals,
  getDomainCommands,
  getOption,
  optionSyntax,
  projectCommandHelp,
  tokenizeCommandArgv,
  type CommandDefinition,
  type CommandId,
  type OptionId,
} from "./command-contract.js";
import {
  changeMutationRequest,
  changeReadRequest,
  executeChangeMutationResult,
  readChangeProjection,
  type ChangeExecutionPort,
  type ChangeExecutionPortOptions,
  type ChangeMutation,
} from "./change-execution-port.js";
import { tryProjectImplementationHandoff } from "./change-handoff.js";
import { tryProjectGoldenPathEntry } from "./golden-path-entry.js";
import { GOLDEN_PATH_STATUS_VERSION } from "./golden-path-status.js";
import { projectSelfDogfoodIssueMarker } from "./self-dogfood-marker.js";
import type { TemplateResolverDependencies } from "./template-resolver.js";
import { tryPlanSemanticPullRequest, tryProjectSemanticPullRequest } from "./semantic-pr-projection.js";
import {
  GITHUB_ISSUE_PROJECTION_CAPABILITIES,
  tryPlanSemanticIssue,
  tryProjectSemanticIssue,
} from "./semantic-issue-projection.js";
import { tryProjectSemanticBranch } from "./semantic-branch-projection.js";
import {
  canonicalDelegatorPublicKeyJson,
  defaultDelegatorPrivateKeyPath,
  generateAndPersistDelegatorKeyPair,
  loadDelegatorKeyPair,
} from "./agent-authority/delegator-key.js";
import {
  checkDelegatorRotationOrder,
  createDelegatorRecord,
  createDelegatorSignedChangeProvenanceRecord,
  createLocalDelegatorSignedChangeProvenanceRecord,
  deriveDelegatorIdentity,
  verifyDelegatorReadiness,
  type DelegatorPublicKeyInput,
  type DelegatorRotationPhase,
} from "./agent-authority/delegator-operations.js";
import { DELEGATOR_ARTIFACT_DIRECTORY } from "./agent-authority/delegator.js";
import { renderDelegatorArtifact } from "./agent-authority/delegator-trust.js";
import type { CapabilityKind } from "./agent-authority/capability.js";
import { registerDelegator, revokeDelegator, rotateDelegator } from "./agent-authority/delegator-lifecycle.js";
import {
  createSessionCredentialBundle,
  inspectSessionCredentialBundle,
  loadSessionCredentialBundle,
  parseSessionCredentialBundle,
  persistSessionCredentialBundle,
} from "./agent-authority/session-bundle.js";
import {
  createDirectAppChangeExecutionAdapter,
  loadDirectAppSession,
  resolveAppEndpoint,
  sendDirectAppBranchAdvance,
} from "./agent-authority/direct-app-client.js";
import {
  validateBranchAdvanceSemanticRequest,
  type BranchAdvanceSemanticRequest,
} from "./agent-authority/branch-advance.js";
import { projectPublishTreeDelta, resolveLocalRepositoryNameWithOwner } from "./change-publish-projection.js";
import {
  compareSemanticIssueProjection,
  tryObserveSemanticIssue,
  type SemanticIssueRelationEvidenceInput,
} from "./semantic-issue-observation.js";
import { compareSemanticPullRequestProjection, tryObserveSemanticPullRequest } from "./semantic-pr-observation.js";
import {
  tryObserveOperationalIssue,
  tryObserveOperationalPullRequest,
  type OperationalDiagnostic,
} from "./operational-observation.js";
import {
  SEMANTIC_PULL_REQUEST_MUTATION_CONTRACT_VERSION,
  SemanticPullRequestMutationError,
  LocalSemanticPullRequestMutationExecutor,
  type SemanticPullRequestMutationExecutionPort,
  type SemanticPullRequestMutationOperation,
  type SemanticPullRequestRepositoryIdentity,
  tryPlanSemanticPullRequestMutation,
} from "./semantic-pr-mutation.js";
import { compareSemanticBranchProjection, tryObserveSemanticBranch } from "./semantic-branch-observation.js";
import { GitHubIssueRelationObservationAdapter } from "./github/issue-relation-observation-adapter.js";
import {
  LocalSemanticPullRequestExecutor,
  type SemanticPullRequestExecutionPort,
  type SemanticPullRequestExecutorOptions,
  SEMANTIC_PULL_REQUEST_EXECUTOR_CONTRACT_VERSION,
} from "./semantic-pr-executor.js";
import {
  LocalSemanticIssueRelationExecutor,
  SemanticIssueRelationExecutorError,
  planExistingIssueRelationReconciliation,
  SEMANTIC_ISSUE_RELATION_EXECUTOR_CONTRACT_VERSION,
  type SemanticIssueRelationExecutionPort,
  type SemanticIssueRelationExecutorOptions,
} from "./semantic-issue-relation-executor.js";
import {
  IssueRelationshipExecutorError,
  LocalIssueRelationshipExecutor,
  type IssueRelationshipMutationRequest,
} from "./issue-relationship-executor.js";
import { GitHubIssueRelationMutationAdapter } from "./github/issue-relation-mutation-adapter.js";
import {
  IMPLEMENTATION_CONTRACT_VERSION,
  IMPLEMENTATION_KIND,
  implementationIssueBodyDigest,
  parseImplementationIssueBody,
} from "./implementation-contract.js";
import {
  inspectImplementationLifecycle,
  tryAuthorizeImplementation,
  tryVerifyImplementationAuthorization,
  validateImplementationAuthorizationRecord,
} from "./implementation-authorization.js";
import { tryVerifyImplementationConformance } from "./implementation-conformance.js";
import type { IssueReference } from "./contract/issue-reference.js";

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
const {
  extensionInstall: INSTALL_COMMAND,
  extensionUpdate: UPDATE_COMMAND,
  fallback: FALLBACK_COMMAND,
} = AGENT_INVOCATION_CONTRACT;
const CANONICAL_INVOCATION = AGENT_INVOCATION_CONTRACT.canonical;

interface RuntimeInfo {
  readonly name: string;
  readonly version: string;
  readonly protocol: number;
  readonly commandContractVersion: string;
  readonly capabilities: readonly string[];
  readonly invocation: {
    readonly canonical: string;
    readonly compatibility: string;
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

interface RuntimeDiagnostic {
  readonly status: "ready" | "missing" | "stale" | "unavailable";
  readonly version?: string;
  readonly capabilities?: readonly string[];
  readonly missingCapabilities?: readonly string[];
  readonly detail?: string;
  readonly recovery: string;
}

export interface CliDependencies {
  readonly repositoryRoot?: string;
  /** Environment seam for explicit runtime-signing readiness checks. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly createAdapter?: (options: ConstructorParameters<typeof GitHubAdapter>[0]) => GitHubAdapter;
  readonly packageMetadata?: PackageMetadata;
  readonly runDiagnosticCommand?: (args: readonly string[]) => DiagnosticCommandResult;
  readonly runGhFallback?: (argv: readonly string[]) => number;
  readonly templateResolver?: TemplateResolverDependencies;
  /** Injectable semantic executor; it never carries App credentials. */
  readonly changeExecutor?: ChangeExecutionPort;
  /** Factory seam for a repository-scoped transport implementation. */
  readonly createChangeExecutor?: (options: ChangeExecutionPortOptions) => ChangeExecutionPort;
  /** Injectable local Semantic PR Executor; it never carries App credentials. */
  readonly semanticPullRequestExecutor?: SemanticPullRequestExecutionPort;
  /** Factory seam for a repository-scoped Semantic PR Executor. */
  readonly createSemanticPullRequestExecutor?: (
    options: SemanticPullRequestExecutorOptions,
  ) => SemanticPullRequestExecutionPort;
  /** Injectable governed PR comment/review/merge executor. */
  readonly semanticPullRequestMutationExecutor?: SemanticPullRequestMutationExecutionPort;
  /** Factory seam for the governed PR mutation executor. */
  readonly createSemanticPullRequestMutationExecutor?: (options: {
    readonly adapter: GitHubAdapter;
  }) => SemanticPullRequestMutationExecutionPort;
  /** Injectable Semantic Issue Relation Executor; it never carries App credentials. */
  readonly semanticIssueRelationExecutor?: SemanticIssueRelationExecutionPort;
  /** Factory seam for a repository-scoped Semantic Issue Relation Executor. */
  readonly createSemanticIssueRelationExecutor?: (
    options: SemanticIssueRelationExecutorOptions,
  ) => SemanticIssueRelationExecutionPort;
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
  "replace",
  "environment",
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
  "privateKey",
  "publicKey",
  "authorityId",
  "output",
  "notBefore",
  "notAfter",
  "maxSessionTtlSeconds",
  "probeIssue",
  "sessionTtlSeconds",
  "expectedHead",
  "expectedBase",
  "reviewIntent",
  "mergeStrategy",
  "retry",
  "pullRequest",
]);

const METADATA_OPTION_KEYS = ["title", "head", "base", "draft", "maintainerCanModify"] as const;

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
  /** Core projection capability identifiers, preserved in argv order. */
  readonly capabilities: readonly string[];
}

interface CliErrorShape {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly details?: unknown;
  readonly violations?: unknown;
  readonly diagnostics?: unknown;
  readonly evidence?: unknown;
}

/** The installed gh-inari executable entrypoint. */
export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const metadata = dependencies.packageMetadata ?? readPackageMetadata();
  if (!isOwnedInvocation(argv)) return runGhFallback(argv, dependencies);
  let parsed: ParsedArgs;
  try {
    parsed = parseArguments(argv);
  } catch (error: unknown) {
    const reportedError = intentAwareCreateOptionError(argv, error) ?? error;
    const shape = toErrorShape(reportedError);
    const json = argv.some((token) => token === "--json" || token === "--json=true");
    if (json) console.log(JSON.stringify({ ok: false, error: shape }));
    else if (reportedError instanceof CliError && reportedError.code === "GOVERNED_CREATE_OPTION")
      console.error(`${shape.code}: ${shape.message}`);
    else if (isMachineCommandTokens(argv)) console.log(JSON.stringify({ ok: false, error: shape }));
    else console.error(`${shape.code}: ${shape.message}`);
    return classifyExitCode(reportedError);
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
    if (domain === "change") {
      return await runChangeCommand(command, rest, parsed, root, dependencies, json);
    }
    if (domain === "authority") {
      return await runAuthorityCommand(command, rest, parsed, root, dependencies, json);
    }
    if (domain === "session") {
      return await runSessionCommand(command, rest, parsed, root, json);
    }
    if (domain === "mcp") {
      return await runMcpCommand(command, rest, parsed, root);
    }
    if (domain === "impl") {
      return await runImplementationCommand(command, rest, parsed, root, dependencies, json);
    }
    if (domain === "issue" || domain === "pr") {
      return await runArtifactCommand(domain, command, rest, parsed, root, dependencies, json);
    }
    if (domain === "branch") {
      return await runSemanticBranchObservationCommand(command, rest, parsed, root, dependencies);
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
  const canonical = diagnoseCanonicalRuntime(info, requirements);
  const compatibility = probeCompatibilityExtension(requirements, dependencies.runDiagnosticCommand);
  const ok = canonical.status === "ready";
  const output = {
    ok,
    ...info,
    requiredCapabilities: requirements.capabilities,
    ...(requirements.minimumVersion === undefined ? {} : { minimumVersion: requirements.minimumVersion }),
    canonical: projectRuntimeDiagnostic(CANONICAL_INVOCATION, canonical),
    compatibility: projectRuntimeDiagnostic(AGENT_INVOCATION_CONTRACT.compatibility, compatibility, "extension"),
  };
  if (json) console.log(JSON.stringify(output));
  else {
    console.log(`${metadata.name} ${metadata.version}`);
    if (ok) console.log(`${CANONICAL_INVOCATION}: ready (${canonical.version ?? "unknown version"})`);
    else {
      console.error(`${CANONICAL_INVOCATION}: ${runtimeDiagnosticMessage(canonical, "canonical runtime")}`);
      console.error(`Action: ${canonical.recovery}`);
    }
    if (compatibility.status !== "ready") {
      console.error(
        `${AGENT_INVOCATION_CONTRACT.compatibility} (compatibility): ${runtimeDiagnosticMessage(
          compatibility,
          "extension",
        )}`,
      );
      console.error(`Action: ${compatibility.recovery}`);
    }
  }
  return ok ? 0 : EXIT_VALIDATION;
}

function runtimeInfo(metadata: PackageMetadata): RuntimeInfo {
  return {
    name: metadata.name,
    version: metadata.version,
    protocol: DIAGNOSTIC_PROTOCOL_VERSION,
    commandContractVersion: COMMAND_CONTRACT_VERSION,
    capabilities: [...RUNTIME_CAPABILITIES],
    invocation: {
      canonical: CANONICAL_INVOCATION,
      compatibility: AGENT_INVOCATION_CONTRACT.compatibility,
      direct: AGENT_INVOCATION_CONTRACT.direct,
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

function diagnoseCanonicalRuntime(
  info: RuntimeInfo,
  requirements: { readonly capabilities: readonly string[]; readonly minimumVersion?: string },
): RuntimeDiagnostic {
  const missingCapabilities = requirements.capabilities.filter((capability) => !info.capabilities.includes(capability));
  if (
    missingCapabilities.length > 0 ||
    (requirements.minimumVersion !== undefined && !versionAtLeast(info.version, requirements.minimumVersion))
  ) {
    return {
      status: "stale",
      version: info.version,
      capabilities: info.capabilities,
      ...(missingCapabilities.length === 0 ? {} : { missingCapabilities }),
      detail: runtimeRequirementMessage(info, missingCapabilities, requirements.minimumVersion),
      recovery: FALLBACK_COMMAND,
    };
  }
  return { status: "ready", version: info.version, capabilities: info.capabilities, recovery: FALLBACK_COMMAND };
}

function probeCompatibilityExtension(
  requirements: { readonly capabilities: readonly string[]; readonly minimumVersion?: string },
  runCommand: CliDependencies["runDiagnosticCommand"],
): RuntimeDiagnostic {
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
  if (parsed.invocation.canonical !== CANONICAL_INVOCATION) {
    return {
      status: "stale",
      version: parsed.version,
      capabilities: parsed.capabilities,
      detail: `the installed extension reports "${parsed.invocation.canonical}" as canonical; expected "${CANONICAL_INVOCATION}"`,
      recovery: UPDATE_COMMAND,
    };
  }
  if (parsed.commandContractVersion !== COMMAND_CONTRACT_VERSION) {
    return {
      status: "stale",
      version: parsed.version,
      capabilities: parsed.capabilities,
      detail: `the installed extension uses command contract ${parsed.commandContractVersion ?? "unknown"}; expected ${COMMAND_CONTRACT_VERSION}`,
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
    (candidate.commandContractVersion === undefined || typeof candidate.commandContractVersion === "string") &&
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

function projectRuntimeDiagnostic(
  invocation: string,
  diagnostic: RuntimeDiagnostic,
  kind?: "extension",
): Record<string, unknown> {
  return {
    invocation,
    ...(kind === undefined ? {} : { kind }),
    status: diagnostic.status,
    ...(diagnostic.version === undefined ? {} : { version: diagnostic.version }),
    ...(diagnostic.capabilities === undefined ? {} : { capabilities: diagnostic.capabilities }),
    ...(diagnostic.missingCapabilities === undefined ? {} : { missingCapabilities: diagnostic.missingCapabilities }),
    ...(diagnostic.detail === undefined ? {} : { detail: diagnostic.detail }),
    recovery: diagnostic.recovery,
  };
}

function runtimeDiagnosticMessage(diagnostic: RuntimeDiagnostic, subject: string): string {
  if (diagnostic.status === "missing") return `the ${subject} is not installed`;
  if (diagnostic.status === "unavailable") return diagnostic.detail ?? "the GitHub CLI could not be executed";
  if (diagnostic.status === "stale") return diagnostic.detail ?? `the ${subject} is stale`;
  return `the ${subject} is ready`;
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

type GovernedCreateDomain = "issue" | "pr";

interface CreateRecoveryAction {
  readonly action: "discover-template" | "inspect-schema" | "create";
  readonly command: string;
}

const CREATE_RECOVERY_ACTIONS = 3;
type GovernedCreateOption = string;

/**
 * Recognized gh-compatible create guidance is intentionally narrow. In
 * particular, the body value is never parsed, echoed, or accepted as an
 * alternate governed input path.
 */
function intentAwareCreateOptionError(argv: readonly string[], error: unknown): CliError | undefined {
  if (
    !(error instanceof CliError) ||
    error.code !== "INVALID_OPTION" ||
    !getOption("rawBody").aliases.some((option) => error.message === `Unknown option ${option}.`)
  )
    return undefined;
  const domain = governedCreateDomain(argv);
  const option = findGovernedCreateOption(argv);
  if (domain === undefined || option === undefined || error.message !== `Unknown option ${option}.`) return undefined;

  const recovery = createRecoveryActions(domain);
  return new CliError(
    "GOVERNED_CREATE_OPTION",
    `Option ${option} is a gh-compatible raw Markdown input, but governed ${domain} creation requires Inari's canonical structured input. ` +
      `Use ${recovery[0]?.command}, then ${recovery[1]?.command}, and create with ${recovery[2]?.command}.`,
    "$argv",
    {
      option,
      domain,
      operation: "create",
      recovery,
    },
  );
}

function createRecoveryActions(domain: GovernedCreateDomain): readonly CreateRecoveryAction[] {
  const actions: readonly CreateRecoveryAction[] = [
    { action: "discover-template", command: commandInvocation("template.list") },
    { action: "inspect-schema", command: commandTemplateSchemaInvocation(domain) },
    {
      action: "create",
      command: commandRecoveryInvocation(`${domain}.create` as "issue.create" | "pr.create"),
    },
  ];
  return actions.slice(0, CREATE_RECOVERY_ACTIONS);
}

function findGovernedCreateOption(argv: readonly string[]): GovernedCreateOption | undefined {
  return tokenizeCommandArgv(argv).options.find((occurrence) => occurrence.definition?.id === "rawBody")?.rawName;
}

/** Locate only the governed domain/create positionals; option values are never treated as commands. */
function governedCreateDomain(argv: readonly string[]): GovernedCreateDomain | undefined {
  const { positionals } = tokenizeCommandArgv(argv);
  const domain = positionals[0];
  return (domain === "issue" || domain === "pr") && positionals[1] === "create" ? domain : undefined;
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

function rejectUnsupportedAuthorityOptions(
  command: "generate" | "bootstrap" | "readiness",
  options: Readonly<Record<string, string | boolean>>,
  capabilities: readonly string[],
): void {
  const definition = getCommand(
    `authority.${command}` as "authority.generate" | "authority.bootstrap" | "authority.readiness",
  );
  if (capabilities.length > 0 && !definition.optionIds.includes("capability")) {
    throw new CliError("INVALID_OPTION", "Option --capability is not supported by authority commands.", "--capability");
  }
  const unsupported = Object.keys(options).find((id) => !definition.optionIds.includes(id as OptionId));
  if (unsupported === undefined) return;
  const option = getOption(unsupported as OptionId);
  throw new CliError(
    "INVALID_OPTION",
    `Option ${option.aliases[0] ?? `--${option.key}`} is not supported by authority ${command}.`,
    "$argv",
    { command: `authority ${command}`, option: option.id },
  );
}

async function runAuthorityCommand(
  command: string | undefined,
  rest: readonly string[],
  parsed: ParsedArgs,
  root: string,
  dependencies: CliDependencies,
  json: boolean,
): Promise<number> {
  if (
    (command !== "generate" &&
      command !== "bootstrap" &&
      command !== "readiness" &&
      command !== "register" &&
      command !== "rotate" &&
      command !== "revoke") ||
    (command !== "revoke" && command !== "readiness" && rest.length > 0) ||
    (command === "readiness" && rest.length > 0) ||
    (command === "revoke" && rest.length !== 1)
  ) {
    throw new CliError("UNKNOWN_COMMAND", `Unknown authority command "${command ?? ""}".`);
  }

  if (command === "generate") {
    rejectUnsupportedAuthorityOptions(command, parsed.options, parsed.capabilities);
    const requestedPath = parsed.options.privateKey;
    const privateKeyPath =
      typeof requestedPath === "string" ? path.resolve(root, requestedPath) : defaultDelegatorPrivateKeyPath();
    const pair = generateAndPersistDelegatorKeyPair(privateKeyPath, {
      replace: parsed.options.replace === true,
    });
    const output = {
      ok: true,
      operation: "authority.generate",
      privateKeyPath,
      publicKey: pair.publicKeyJwk,
      publicKeyJson: canonicalDelegatorPublicKeyJson(pair.publicKeyJwk),
      repositoryTrustChanged: false,
    } as const;
    if (json) console.log(JSON.stringify(output));
    else {
      console.log("Generated local Runtime Authority keypair.");
      console.log(`Private key: ${privateKeyPath}`);
      console.log(`Public key: ${output.publicKeyJson}`);
      console.log("Repository trust was not modified.");
    }
    return 0;
  }

  if (command === "bootstrap") {
    rejectUnsupportedAuthorityOptions(command, parsed.options, parsed.capabilities);
    const authorityId = requiredAuthorityOption(parsed, "authorityId", "--authority-id <id>");
    const outputValue = requiredAuthorityOption(parsed, "output", "--output <authority.json>");
    const ttlValue = requiredAuthorityOption(parsed, "maxSessionTtlSeconds", "--max-session-ttl-seconds <seconds>");
    if (parsed.capabilities.length === 0) {
      throw new CliError("INPUT_REQUIRED", "Use at least one --capability <id>.", "--capability");
    }
    const privateKeyValue = parsed.options.privateKey;
    const publicKeyValue = parsed.options.publicKey;
    if ((typeof privateKeyValue === "string") === (typeof publicKeyValue === "string")) {
      throw new CliError(
        "INVALID_OPTION",
        "Use exactly one of --private-key <path> or --public-key <path>.",
        "--private-key",
      );
    }
    const outputPath = path.resolve(root, outputValue);
    const privateKeyPath = typeof privateKeyValue === "string" ? path.resolve(root, privateKeyValue) : undefined;
    if (privateKeyPath !== undefined && privateKeyPath === outputPath) {
      throw new CliError(
        "INVALID_OPTION",
        "The public authority output cannot overwrite the private key file.",
        "--output",
      );
    }
    const outputRelative = path.relative(root, outputPath).split(path.sep).join("/");
    const trustRootPrefix = `${DELEGATOR_ARTIFACT_DIRECTORY}/`;
    if (outputRelative === DELEGATOR_ARTIFACT_DIRECTORY || outputRelative.startsWith(trustRootPrefix)) {
      throw new CliError(
        "INVALID_OPTION",
        "Bootstrap output must stay outside the canonical trust-root directory; use authority register for materialization.",
        "--output",
      );
    }
    const maxSessionTtlSeconds = parseAuthorityInteger(ttlValue, "--max-session-ttl-seconds");
    const key =
      privateKeyPath === undefined
        ? await readJsonValue(authorityInputPath(root, publicKeyValue as string))
        : loadDelegatorKeyPair(privateKeyPath);
    const authority = createDelegatorRecord({
      id: authorityId,
      key: key as DelegatorPublicKeyInput,
      ...(typeof parsed.options.notBefore === "string" ? { notBefore: parsed.options.notBefore } : {}),
      ...(typeof parsed.options.notAfter === "string" ? { notAfter: parsed.options.notAfter } : {}),
      maxSessionTtlSeconds,
      capabilityCeiling: parsed.capabilities as CapabilityKind[],
    });
    const rendered = renderDelegatorArtifact(authority);
    await writeBootstrapAuthorityOutput(outputPath, rendered.content);
    const output = {
      ok: true,
      operation: "authority.bootstrap",
      outputPath,
      artifactPath: rendered.path,
      authority,
      publicKeyJson: canonicalDelegatorPublicKeyJson(authority.key),
      publicKeyFingerprint: deriveDelegatorIdentity(authority.id, authority.key).publicKeyFingerprint,
      repositoryTrustChanged: false,
      deploymentBindingChanged: false,
    } as const;
    if (json) console.log(JSON.stringify(output));
    else {
      console.log("Constructed canonical Runtime Authority public record.");
      console.log(`Record: ${outputPath}`);
      console.log(`Trust artifact to register: ${rendered.path}`);
      console.log("Repository trust and deployment binding were not modified.");
    }
    return 0;
  }

  if (command === "readiness") {
    rejectUnsupportedAuthorityOptions(command, parsed.options, parsed.capabilities);
    const environment = dependencies.environment ?? process.env;
    const fromEnvironment = parsed.options.environment === true;
    if (fromEnvironment && (parsed.options.authorityId !== undefined || parsed.options.privateKey !== undefined)) {
      throw new CliError(
        "INVALID_OPTION",
        "Use --environment alone, or provide --authority-id and --private-key explicitly.",
        "--environment",
      );
    }
    const authorityId = fromEnvironment
      ? environment.INARI_RUNTIME_AUTHORITY_ID
      : typeof parsed.options.authorityId === "string"
        ? parsed.options.authorityId
        : undefined;
    const privateKeyPem = fromEnvironment ? environment.INARI_RUNTIME_AUTHORITY_PRIVATE_KEY : undefined;
    const privateKeyPath = fromEnvironment
      ? undefined
      : typeof parsed.options.privateKey === "string"
        ? path.resolve(root, parsed.options.privateKey)
        : undefined;
    const rotationPhase = parsed.options.rotationPhase;
    if (rotationPhase !== undefined && rotationPhase !== "activate" && rotationPhase !== "revoke") {
      throw new CliError(
        "INVALID_OPTION",
        "Option --rotation-phase must be exactly activate or revoke.",
        "--rotation-phase",
      );
    }
    const currentAuthorityId = parsed.options.currentAuthorityId;
    if (rotationPhase === undefined && currentAuthorityId !== undefined) {
      throw new CliError(
        "INVALID_OPTION",
        "Option --current-authority-id requires --rotation-phase.",
        "--current-authority-id",
      );
    }
    if (rotationPhase !== undefined && typeof currentAuthorityId !== "string") {
      throw new CliError(
        "INPUT_REQUIRED",
        "Use --current-authority-id <id> with --rotation-phase.",
        "--current-authority-id",
      );
    }
    const adapter = createAdapter(dependencies, root, parsed.options.repository);
    const result = await verifyDelegatorReadiness(adapter, {
      authorityId,
      ...(privateKeyPem === undefined ? {} : { privateKey: privateKeyPem }),
      ...(privateKeyPath === undefined ? {} : { privateKeyPath }),
      ...(typeof parsed.options.probeIssue === "string"
        ? { probeIssue: parseAuthorityInteger(parsed.options.probeIssue, "--probe-issue") }
        : {}),
      ...(typeof parsed.options.sessionTtlSeconds === "string"
        ? { sessionTtlSeconds: parseAuthorityInteger(parsed.options.sessionTtlSeconds, "--session-ttl-seconds") }
        : {}),
      ...(parsed.capabilities.length === 0 ? {} : { capabilities: parsed.capabilities }),
    });
    const rotationOrder =
      rotationPhase === undefined || typeof currentAuthorityId !== "string"
        ? undefined
        : checkDelegatorRotationOrder({
            currentAuthorityId,
            nextAuthorityId: authorityId ?? "",
            phase: rotationPhase as DelegatorRotationPhase,
            signerAuthorityId: authorityId,
            nextReadiness: result,
          });
    if (json) console.log(JSON.stringify(rotationOrder === undefined ? result : { ...result, rotationOrder }));
    else {
      console.log(`Runtime Authority readiness: ${result.state}.`);
      if (result.authorityId !== undefined) console.log(`Authority ID: ${result.authorityId}`);
      if (result.publicKeyFingerprint !== undefined)
        console.log(`Public key fingerprint: ${result.publicKeyFingerprint}`);
      for (const item of result.diagnostics) console.log(`Diagnostic: ${item.code}: ${item.message}`);
      if (rotationOrder !== undefined) {
        console.log(`Rotation order: ${rotationOrder.state}.`);
        if (rotationOrder.diagnostic !== undefined) {
          console.log(`Diagnostic: ${rotationOrder.diagnostic.code}: ${rotationOrder.diagnostic.message}`);
        }
      }
    }
    return result.ok && (rotationOrder === undefined || rotationOrder.ok) ? 0 : EXIT_VALIDATION;
  }

  rejectUnsupportedAuthorityLifecycleOptions(command, parsed.options, parsed.capabilities);
  const result =
    command === "revoke"
      ? revokeDelegator(root, rest[0] as string)
      : command === "register"
        ? registerDelegator(root, await readJsonValue(authorityInputPath(root, requiredAuthorityFrom(parsed))))
        : rotateDelegator(root, await readJsonValue(authorityInputPath(root, requiredAuthorityFrom(parsed))));
  const output = { ...result } as const;
  if (json) console.log(JSON.stringify(output));
  else {
    if (command === "register") console.log("Registered a Runtime Authority trust record.");
    else if (command === "rotate") console.log("Added a Runtime Authority trust record for overlap rotation.");
    else if (result.changed) console.log("Disabled the Runtime Authority trust record.");
    else console.log("Runtime Authority trust record is already disabled.");
    console.log(`Artifact: ${path.join(root, result.path)}`);
  }
  return 0;
}

function requiredAuthorityOption(
  parsed: ParsedArgs,
  key: "authorityId" | "output" | "maxSessionTtlSeconds",
  usage: string,
): string {
  const value = parsed.options[key];
  if (typeof value !== "string" || value.length === 0) throw new CliError("INPUT_REQUIRED", `Use ${usage}.`, usage);
  return value;
}

function parseAuthorityInteger(value: string, option: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new CliError("INVALID_OPTION", `${option} must be a positive integer.`, option);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new CliError("INVALID_OPTION", `${option} is too large.`, option);
  return parsed;
}

async function writeBootstrapAuthorityOutput(outputPath: string, content: string): Promise<void> {
  try {
    await writeFile(outputPath, content, { encoding: "utf8", mode: 0o644, flag: "wx" });
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new CliError(
        "OUTPUT_EXISTS",
        "Bootstrap output already exists; choose a new public record path.",
        "--output",
      );
    }
    throw new CliError("OUTPUT_WRITE_FAILED", "Unable to write the canonical public authority record.", "--output");
  }
}

function requiredAuthorityFrom(parsed: ParsedArgs): string {
  const value = parsed.options.from;
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError("INPUT_REQUIRED", "Use --from <authority.json>.", "--from");
  }
  return value;
}

function authorityInputPath(root: string, value: string): string {
  return value === "-" ? value : path.resolve(root, value);
}

function rejectUnsupportedAuthorityLifecycleOptions(
  command: "register" | "rotate" | "revoke",
  options: Readonly<Record<string, string | boolean>>,
  capabilities: readonly string[],
): void {
  if (capabilities.length > 0) {
    throw new CliError("INVALID_OPTION", "Option --capability is not supported by authority commands.", "--capability");
  }
  const definition = getCommand(
    `authority.${command}` as "authority.register" | "authority.rotate" | "authority.revoke",
  );
  const unsupported = Object.keys(options).find((id) => !definition.optionIds.includes(id as OptionId));
  if (unsupported === undefined) return;
  const option = getOption(unsupported as OptionId);
  throw new CliError(
    "INVALID_OPTION",
    `Option ${option.aliases[0] ?? `--${option.key}`} is not supported by authority ${command}.`,
    "$argv",
    { command: `authority ${command}`, option: option.id },
  );
}

function requiredSessionOption(
  options: Readonly<Record<string, string | boolean>>,
  key: "from" | "privateKey" | "to",
): string {
  const value = options[key];
  if (typeof value !== "string" || value.length === 0) {
    const option = getOption(key);
    throw new CliError(
      "INPUT_REQUIRED",
      `Use ${option.aliases[0]} <${option.placeholder ?? "path"}>.`,
      option.aliases[0],
    );
  }
  return value;
}

function rejectUnsupportedSessionOptions(command: "issue" | "inspect", parsed: ParsedArgs): void {
  const definition = getCommand(command === "issue" ? "session.issue" : "session.inspect");
  if (parsed.capabilities.length > 0) {
    throw new CliError("INVALID_OPTION", "Option --capability is not supported by Session commands.", "--capability");
  }
  const unsupported = Object.keys(parsed.options).find((id) => !definition.optionIds.includes(id as OptionId));
  if (unsupported === undefined) return;
  const option = getOption(unsupported as OptionId);
  throw new CliError(
    "INVALID_OPTION",
    `Option ${option.aliases[0] ?? `--${option.key}`} is not supported by session ${command}.`,
    "$argv",
    { command: `session ${command}`, option: option.id },
  );
}

async function runSessionCommand(
  command: string | undefined,
  rest: readonly string[],
  parsed: ParsedArgs,
  root: string,
  json: boolean,
): Promise<number> {
  if ((command !== "issue" && command !== "inspect") || rest.length > 0) {
    throw new CliError("UNKNOWN_COMMAND", `Unknown session command "${command ?? ""}".`);
  }
  rejectUnsupportedSessionOptions(command, parsed);

  if (command === "issue") {
    const from = requiredSessionOption(parsed.options, "from");
    const privateKey = requiredSessionOption(parsed.options, "privateKey");
    const to = requiredSessionOption(parsed.options, "to");
    const request = await readJsonValue(from === "-" ? from : path.resolve(root, from));
    const runtimeKey = loadDelegatorKeyPair(path.resolve(root, privateKey));
    const created = createSessionCredentialBundle({ request, runtimeKey });
    const bundlePath = persistSessionCredentialBundle(path.resolve(root, to), created.bundle);
    const safe = inspectSessionCredentialBundle(created);
    const output = {
      ok: true,
      operation: "session.issue" as const,
      bundlePath,
      bundle: safe.bundle,
      repository: safe.repository,
      ...(safe.task === undefined ? {} : { task: safe.task }),
      capabilities: safe.capabilities,
      expiry: safe.expiry,
      runtime: safe.runtime,
      session: safe.session,
      certificate: safe.certificate,
      ...(safe.agent === undefined ? {} : { agent: safe.agent }),
    };
    if (json) console.log(JSON.stringify(output));
    else {
      console.log("Issued a short-lived Session credential bundle.");
      console.log(`Bundle: ${bundlePath}`);
      console.log(`Session: ${safe.session.id}`);
      console.log(`Runtime Authority: ${safe.runtime.authorityId}`);
      console.log(`Expires: ${safe.expiry.exp}`);
    }
    return 0;
  }

  const from = requiredSessionOption(parsed.options, "from");
  const bundle =
    from === "-"
      ? parseSessionCredentialBundle(await readJsonValue(from))
      : loadSessionCredentialBundle(path.resolve(root, from));
  const output = inspectSessionCredentialBundle(bundle);
  if (json) console.log(JSON.stringify(output));
  else {
    console.log("Session credential bundle is valid.");
    console.log(`Session: ${output.session.id}`);
    console.log(`Certificate: ${output.session.certificateId}`);
    console.log(`Runtime Authority: ${output.runtime.authorityId}`);
    console.log(`Repository: ${output.repository.name} (${output.repository.id})`);
    if (output.task !== undefined) console.log(`Task: ${output.task.kind} #${output.task.number}`);
    console.log(`Capabilities: ${output.capabilities.map((claim) => claim.kind).join(", ")}`);
    console.log(`Expires: ${output.expiry.exp}`);
  }
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

function invalidChangeNumberError(value: string | undefined): CliError {
  const message =
    value === undefined
      ? "A Change root Issue number is required."
      : `"${value}" is not a valid Change root Issue number. Use a positive integer.`;
  return new CliError("INVALID_CHANGE_NUMBER", message, "$argv[1]", { value });
}

function rejectPartialSessionTransportOptions(
  sessionCredential: string | boolean | undefined,
  appEndpoint: string | boolean | undefined,
): void {
  if ((sessionCredential === undefined) === (appEndpoint === undefined)) return;
  throw new CliError(
    "INVALID_OPTION",
    "Use --session-credential together with --app-endpoint to select the direct App transport.",
    sessionCredential === undefined ? "--app-endpoint" : "--session-credential",
  );
}

/** Selects the direct App transport when both Session options are supplied; otherwise the existing Actions/gh path. */
function createChangeExecutor(
  dependencies: CliDependencies,
  root: string,
  repository: string | boolean | undefined,
  sessionOptions: { readonly sessionCredential?: string | boolean; readonly appEndpoint?: string | boolean } = {},
  adapter?: GitHubAdapter,
): ChangeExecutionPort {
  if (dependencies.changeExecutor !== undefined) return dependencies.changeExecutor;
  rejectPartialSessionTransportOptions(sessionOptions.sessionCredential, sessionOptions.appEndpoint);
  if (typeof sessionOptions.sessionCredential === "string" && typeof sessionOptions.appEndpoint === "string") {
    const { session, agent } = loadDirectAppSession(path.resolve(root, sessionOptions.sessionCredential));
    const endpoint = resolveAppEndpoint(sessionOptions.appEndpoint);
    return createDirectAppChangeExecutionAdapter({ endpoint, session, ...(agent === undefined ? {} : { agent }) });
  }
  const factory =
    dependencies.createChangeExecutor ??
    ((options: ChangeExecutionPortOptions) => {
      const transportAdapter =
        adapter ??
        (dependencies.createAdapter ?? ((adapterOptions) => new GitHubAdapter(adapterOptions)))({
          cwd: options.cwd,
          ...(options.repository === undefined ? {} : { repository: options.repository }),
        });
      return createActionsChangeExecutionAdapter({
        ...options,
        api: transportAdapter,
      });
    });
  return factory({ cwd: root, ...(typeof repository === "string" ? { repository } : {}) });
}

function projectChangeCommandResult(
  operation: string,
  issue: number,
  projection: Awaited<ReturnType<typeof readChangeProjection>>,
  evidence: Awaited<ReturnType<typeof executeChangeMutationResult>>["evidence"] = undefined,
): Readonly<Record<string, unknown>> {
  const change = projection.change;
  const changeProjection = change?.projection;
  return {
    ok: projection.valid,
    operation: `change.${operation}`,
    change: change?.identity.rootIssue ?? issue,
    issue,
    status: projection.status,
    ...(change === undefined ? {} : { state: change.state }),
    ...(projection.canonicalBranch === undefined ? {} : { canonicalBranch: projection.canonicalBranch }),
    ...(projection.canonicalBaseBranch === undefined ? {} : { canonicalBaseBranch: projection.canonicalBaseBranch }),
    ...(changeProjection?.branch === undefined ? {} : { branch: changeProjection.branch }),
    ...(changeProjection?.pullRequest === undefined ? {} : { pullRequest: changeProjection.pullRequest }),
    contractVersions: {
      goldenPath: String(GOLDEN_PATH_STATUS_VERSION),
      statusRecovery: String(GOLDEN_PATH_STATUS_VERSION),
      skill: SKILL_MODEL_VERSION,
    },
    ...(evidence === undefined ? {} : { evidence }),
    projection,
  };
}

function projectChangeHandoffCommandResult(
  issue: number,
  projection: Awaited<ReturnType<typeof readChangeProjection>>,
  options: { readonly repositoryNameWithOwner?: string } = {},
): Readonly<Record<string, unknown>> {
  const handoff = tryProjectImplementationHandoff(projection, options);
  return {
    ...projectChangeCommandResult("handoff", issue, projection),
    ok: handoff.valid,
    valid: handoff.valid,
    diagnostics: handoff.diagnostics,
    ...(handoff.handoff === undefined ? {} : { handoff: handoff.handoff }),
  };
}

function rejectUnsupportedChangeOptions(command: string, options: Readonly<Record<string, string | boolean>>): void {
  const definition = getCommandForPositionals(["change", command]);
  if (definition === undefined) return;
  const unsupported = Object.keys(options).find((id) => !definition.optionIds.includes(id as OptionId));
  if (unsupported === undefined) return;
  const option = getOption(unsupported as OptionId);
  throw new CliError(
    "INVALID_OPTION",
    `Option ${option.aliases[0] ?? `--${option.key}`} is not supported by change ${command}.`,
    "$argv",
    { command: `change ${command}`, option: option.id },
  );
}

/**
 * `change publish` derives the bounded tree delta from a local commit and
 * submits the exact canonical #466 `branch.advance` request through the
 * Session/App path (#467). It never performs a raw `git push` and never
 * duplicates #466's branch validation, Git mutation, or provenance authority.
 */
async function runChangePublishCommand(
  issue: number,
  parsed: ParsedArgs,
  root: string,
  dependencies: CliDependencies,
): Promise<number> {
  const sessionCredential = parsed.options.sessionCredential;
  const appEndpoint = parsed.options.appEndpoint;
  if (typeof sessionCredential !== "string" || typeof appEndpoint !== "string") {
    throw new CliError(
      "INPUT_REQUIRED",
      "change publish requires --session-credential <path> and --app-endpoint <https-url>.",
      "--session-credential",
    );
  }
  const commitRev = typeof parsed.options.commit === "string" ? parsed.options.commit : "HEAD";

  const { session, agent } = loadDirectAppSession(path.resolve(root, sessionCredential));
  const endpoint = resolveAppEndpoint(appEndpoint);

  // #467 requires verifying the local repository identity before publishing:
  // an ancestor/CAS check alone proves nothing about which repository this
  // workspace actually is, only that some commit chain exists locally.
  const certificateRepository = session.certificate?.payload.repository.name;
  const localRepository = resolveLocalRepositoryNameWithOwner(root);
  if (
    certificateRepository === undefined ||
    localRepository === undefined ||
    localRepository !== certificateRepository
  ) {
    throw new CliError(
      "CHANGE_PUBLISH_REPOSITORY_MISMATCH",
      `Local repository origin ("${localRepository ?? "unknown"}") does not match the Session-authorized repository ("${certificateRepository ?? "unknown"}").`,
    );
  }

  const executor = createChangeExecutor(dependencies, root, parsed.options.repository, {
    sessionCredential,
    appEndpoint,
  });
  const projection = await readChangeProjection(executor, changeReadRequest(issue));
  const canonicalBranch = projection.canonicalBranch;
  if (canonicalBranch === undefined) {
    throw new CliError(
      "CHANGE_PUBLISH_BRANCH_UNAVAILABLE",
      `Change #${issue} has no canonical implementation branch to publish to.`,
    );
  }
  const branchCandidate = projection.candidates.branches.find(
    (candidate) => candidate.candidate.name === canonicalBranch,
  );
  const expectedHead = branchCandidate?.candidate.sha;
  if (expectedHead === undefined) {
    throw new CliError(
      "CHANGE_PUBLISH_HEAD_UNAVAILABLE",
      `Could not determine the current authoritative head of "${canonicalBranch}" through the App path.`,
    );
  }

  const treeDelta = projectPublishTreeDelta({ cwd: root, commit: commitRev, expectedHead });

  const compiled: BranchAdvanceSemanticRequest = {
    version: 1,
    issue,
    branch: canonicalBranch,
    expectedHead,
    changes: treeDelta.changes,
    commit: treeDelta.commitMetadata,
    ...(agent === undefined ? {} : { agent }),
  };
  const validated = validateBranchAdvanceSemanticRequest(compiled);
  if (!validated.valid || validated.value === undefined) {
    throw new CliError(
      "CHANGE_PUBLISH_REQUEST_INVALID",
      "The compiled branch.advance request does not satisfy the canonical #466 contract.",
      "$request",
      { diagnostics: validated.diagnostics },
    );
  }

  const result = await sendDirectAppBranchAdvance({ endpoint, session, request: validated.value });
  const resultBranch = result.branch ?? canonicalBranch;
  const resultExpectedHead = result.expectedHead ?? expectedHead;
  if (result.status !== "succeeded" || result.resultingHead === undefined) {
    console.log(
      JSON.stringify({
        ok: false,
        operation: "change.publish",
        issue,
        branch: resultBranch,
        expectedHead: resultExpectedHead,
        commit: treeDelta.commit,
        outcome: result.outcome,
        ...(result.resultingHead === undefined ? {} : { resultingHead: result.resultingHead }),
      }),
    );
    return EXIT_REMOTE;
  }

  // #467 requires an authoritative reread/verification of the resulting
  // remote head through the Session/App path before reporting success; the
  // branch.advance response alone is never sufficient (#466 already proves
  // its own postcondition, but this leaf's own success report must not rely
  // on that response without independently rereading it).
  const verification = await readChangeProjection(executor, changeReadRequest(issue));
  const verifiedBranch = verification.candidates.branches.find(
    (candidate) => candidate.candidate.name === resultBranch,
  );
  if (verifiedBranch?.candidate.sha !== result.resultingHead) {
    throw new CliError(
      "CHANGE_PUBLISH_VERIFICATION_FAILED",
      `Could not verify the published branch head through the App path (expected ${result.resultingHead}, observed ${verifiedBranch?.candidate.sha ?? "unknown"}).`,
    );
  }

  console.log(
    JSON.stringify({
      ok: true,
      operation: "change.publish",
      issue,
      branch: resultBranch,
      expectedHead: resultExpectedHead,
      commit: treeDelta.commit,
      outcome: result.outcome,
      resultingHead: result.resultingHead,
      verified: true,
    }),
  );
  return 0;
}

async function runChangeCommand(
  command: string | undefined,
  rest: readonly string[],
  parsed: ParsedArgs,
  root: string,
  dependencies: CliDependencies,
  json: boolean,
): Promise<number> {
  void json;
  const definition = command === undefined ? undefined : getCommandForPositionals(["change", command]);
  if (definition === undefined || definition.domain !== "change") {
    throw new CliError("UNKNOWN_COMMAND", `Unknown change command "${command ?? ""}".`);
  }
  if (rest.length !== 1 || !isPositiveInteger(rest[0])) throw invalidChangeNumberError(rest[0]);
  rejectUnsupportedChangeOptions(definition.operation, parsed.options);
  if (definition.operation === "publish") {
    return await runChangePublishCommand(Number(rest[0]), parsed, root, dependencies);
  }

  const issue = Number(rest[0]);
  const sessionCredential = parsed.options.sessionCredential;
  const appEndpoint = parsed.options.appEndpoint;
  rejectPartialSessionTransportOptions(sessionCredential, appEndpoint);
  const usesDirectAppTransport = typeof sessionCredential === "string" && typeof appEndpoint === "string";

  let runtimeTrustAdapter: GitHubAdapter | undefined;
  let signedProvenanceRecord: Awaited<ReturnType<typeof createDelegatorSignedChangeProvenanceRecord>> | undefined;
  if (definition.operation === "issue") {
    const environment = dependencies.environment ?? process.env;
    if (usesDirectAppTransport) {
      // Direct App Session selection: canonical Delegator trust is resolved
      // and verified inside trusted execution (App-scoped read capability)
      // before any effect. Caller-side signing here uses only local
      // Delegator signing material and never reads GitHub.
      signedProvenanceRecord = await createLocalDelegatorSignedChangeProvenanceRecord(issue, {
        authorityId: environment.INARI_RUNTIME_AUTHORITY_ID,
        privateKey: environment.INARI_RUNTIME_AUTHORITY_PRIVATE_KEY,
      });
    } else {
      runtimeTrustAdapter = createAdapter(dependencies, root, parsed.options.repository);
      signedProvenanceRecord = await createDelegatorSignedChangeProvenanceRecord(runtimeTrustAdapter, issue, {
        authorityId: environment.INARI_RUNTIME_AUTHORITY_ID,
        privateKey: environment.INARI_RUNTIME_AUTHORITY_PRIVATE_KEY,
      });
    }
  }
  const executor = createChangeExecutor(
    dependencies,
    root,
    parsed.options.repository,
    { sessionCredential, appEndpoint },
    runtimeTrustAdapter,
  );
  const result =
    definition.operation === "show" || definition.operation === "handoff"
      ? { projection: await readChangeProjection(executor, changeReadRequest(issue)) }
      : await executeChangeMutationResult(
          executor,
          changeMutationRequest(definition.operation as ChangeMutation, issue, undefined, signedProvenanceRecord),
        );
  const projection = result.projection;
  if (definition.operation === "handoff") {
    let repositoryNameWithOwner: string | undefined;
    // Resolve a locator only when an adapter is actually available: either the
    // caller injected one directly, or no changeExecutor override exists (the
    // default path already builds a real adapter). Avoids a spurious `gh`
    // call when a caller/test stubs only the Change transport.
    if (dependencies.createAdapter !== undefined || dependencies.changeExecutor === undefined) {
      try {
        const context = await createAdapter(dependencies, root, parsed.options.repository).getRepositoryContext();
        repositoryNameWithOwner = context.nameWithOwner;
      } catch {
        repositoryNameWithOwner = undefined;
      }
    }
    const handoffResult = projectChangeHandoffCommandResult(issue, projection, { repositoryNameWithOwner });
    console.log(JSON.stringify(handoffResult));
    return handoffResult.ok === true ? 0 : EXIT_VALIDATION;
  }
  const commandResult = projectChangeCommandResult(definition.operation, issue, projection, result.evidence);
  const entry =
    definition.operation === "issue"
      ? tryProjectGoldenPathEntry({
          projection,
          requireGovernedIssue: false,
          ...(result.evidence?.outcome === undefined ? {} : { executionOutcome: result.evidence.outcome }),
        })
      : undefined;
  console.log(JSON.stringify({ ...commandResult, ...(entry === undefined ? {} : { entry }) }));
  const executionSucceeded =
    result.evidence === undefined ||
    result.evidence.outcome === "verified" ||
    result.evidence.outcome === "returned-existing";
  return projection.valid && executionSucceeded && (entry === undefined || entry.valid) ? 0 : EXIT_VALIDATION;
}

async function runMcpCommand(
  command: string | undefined,
  rest: readonly string[],
  parsed: ParsedArgs,
  root: string,
): Promise<number> {
  if (command !== "serve" || rest.length > 0) {
    throw new CliError("UNKNOWN_COMMAND", `Unknown MCP command "${command ?? ""}".`);
  }
  const unsupported = Object.keys(parsed.options).find((key) => key !== "repository");
  if (unsupported !== undefined) {
    const option = getOption(unsupported as OptionId);
    throw new CliError(
      "INVALID_OPTION",
      `Option ${option.aliases[0] ?? `--${option.key}`} is not supported by the MCP server command.`,
      "$argv",
      { command: "mcp serve", option: option.id },
    );
  }
  const { startInariMcpStdio } = await import("./mcp/stdio.js");
  await startInariMcpStdio({
    repositoryRoot: root,
    ...(typeof parsed.options.repository === "string" ? { repository: parsed.options.repository } : {}),
  });
  return 0;
}

interface ImplementationIssueEvidence {
  readonly adapter: GitHubAdapter;
  readonly context: Awaited<ReturnType<GitHubAdapter["getRepositoryContext"]>>;
  readonly issue: GitHubIssue;
  readonly reference: IssueReference;
  readonly repository: {
    readonly repositoryHost: string;
    readonly repositoryId: string;
    readonly repository: string;
  };
  readonly body: string;
}

interface ImplementationInputEvidence {
  readonly authorization?: unknown;
  readonly base?: unknown;
  readonly supersession?: unknown;
  readonly completed?: boolean;
}

function implementationIssueEvidence(
  adapter: GitHubAdapter,
  context: Awaited<ReturnType<GitHubAdapter["getRepositoryContext"]>>,
  issue: GitHubIssue,
  number: number,
): ImplementationIssueEvidence {
  const repositoryId = issue.repositoryId ?? context.repositoryId;
  if (repositoryId === undefined) {
    throw new CliError(
      "IMPLEMENTATION_EVIDENCE_UNAVAILABLE",
      "A repository database identity is required for Implementation evidence.",
      "$.repository.repositoryId",
    );
  }
  const repository = {
    repositoryHost: (issue.repositoryHost ?? context.hostname).toLocaleLowerCase("en-US"),
    repositoryId,
    repository: context.nameWithOwner.toLocaleLowerCase("en-US"),
  };
  const reference = { ...repository, number };
  return {
    adapter,
    context,
    issue,
    reference,
    repository,
    body: issue.body ?? "",
  };
}

async function readImplementationIssue(
  number: number,
  parsed: ParsedArgs,
  root: string,
  dependencies: CliDependencies,
): Promise<ImplementationIssueEvidence> {
  const adapter = createAdapter(dependencies, root, parsed.options.repository);
  const context = await adapter.getRepositoryContext();
  const issue = await adapter.getIssue(number);
  return implementationIssueEvidence(adapter, context, issue, number);
}

function implementationBodyProjection(body: string): Record<string, unknown> {
  const parsed = parseImplementationIssueBody(body);
  return {
    valid: parsed.valid,
    ...(parsed.contract === undefined
      ? {}
      : { contract: parsed.contract, digest: implementationIssueBodyDigest(body) }),
    ...(parsed.fields === undefined ? {} : { fields: parsed.fields }),
    violations: parsed.violations,
  };
}

function implementationInputEvidence(value: unknown): ImplementationInputEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { authorization: value };
  const record = value as Record<string, unknown>;
  if (record.kind === "implementation-authorization") return { authorization: value };
  const envelope =
    Object.prototype.hasOwnProperty.call(record, "authorization") ||
    Object.prototype.hasOwnProperty.call(record, "base") ||
    Object.prototype.hasOwnProperty.call(record, "supersession") ||
    Object.prototype.hasOwnProperty.call(record, "completed");
  if (!envelope) return { authorization: value };
  const authorization = record.authorization;
  const authorizationRecord =
    typeof authorization === "object" && authorization !== null && !Array.isArray(authorization)
      ? (authorization as Record<string, unknown>).record
      : undefined;
  return {
    ...(Object.prototype.hasOwnProperty.call(record, "authorization")
      ? { authorization: authorizationRecord ?? authorization }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, "base") ? { base: record.base } : {}),
    ...(Object.prototype.hasOwnProperty.call(record, "supersession") ? { supersession: record.supersession } : {}),
    ...(typeof record.completed === "boolean" ? { completed: record.completed } : {}),
  };
}

function implementationRelationCapabilities(capabilities: readonly string[]): {
  readonly parent: boolean;
  readonly blockedBy: false;
  readonly children: boolean;
} {
  const parent = nativeParentCapability(capabilities);
  return { parent, blockedBy: false, children: parent };
}

async function observeImplementationRelationships(
  evidence: ImplementationIssueEvidence,
  capabilities: readonly string[],
): Promise<Record<string, unknown>> {
  const relationAdapter = new GitHubIssueRelationObservationAdapter(
    evidence.adapter,
    evidence.context,
    implementationRelationCapabilities(capabilities),
  );
  const [parent, children] = await Promise.all([
    relationAdapter.observeParent(evidence.issue.number),
    relationAdapter.observeChildren(evidence.issue.number),
  ]);
  return {
    authority: "github.issue.parent.native",
    parent,
    children,
  };
}

async function implementationBaseEvidence(
  evidence: ImplementationIssueEvidence,
  contract: Record<string, unknown> | undefined,
  supplied: unknown,
): Promise<unknown> {
  if (supplied !== undefined) return supplied;
  if (contract === undefined) return undefined;
  const execution = contract.execution;
  if (typeof execution !== "object" || execution === null || Array.isArray(execution)) return undefined;
  const branchName = (execution as Record<string, unknown>).baseBranch;
  if (typeof branchName !== "string" || branchName.length === 0) return undefined;
  const branch = await evidence.adapter.findBranch(branchName);
  if (branch === undefined || typeof branch.sha !== "string" || branch.sha.length === 0) return undefined;
  return { branch: branch.name, revision: branch.sha, freshness: branch.sha };
}

async function implementationAuthorizedBaseEvidence(
  evidence: ImplementationIssueEvidence,
  authorization: unknown,
): Promise<unknown> {
  const validated = validateImplementationAuthorizationRecord(authorization);
  const branchName = validated.record?.base.branch;
  if (!validated.valid || branchName === undefined) return undefined;
  const branch = await evidence.adapter.findBranch(branchName);
  if (branch === undefined || branch.sha.length === 0) return undefined;
  return { branch: branch.name, revision: branch.sha, freshness: branch.sha };
}

function implementationLifecycle(
  evidence: ImplementationIssueEvidence,
  body: string,
  input: ImplementationInputEvidence,
  base: unknown,
): Record<string, unknown> {
  const result =
    input.authorization === undefined
      ? inspectImplementationLifecycle({
          body,
          implementation: evidence.reference,
          repository: evidence.repository,
          ...(base === undefined ? {} : { base }),
        })
      : tryVerifyImplementationAuthorization({
          authorization: input.authorization,
          issue: { reference: evidence.reference, body },
          repository: evidence.repository,
          ...(base === undefined ? {} : { base }),
          ...(input.supersession === undefined ? {} : { supersession: input.supersession }),
          ...(input.completed === undefined ? {} : { completed: input.completed }),
        });
  return {
    status: result.status,
    authorized: result.authorized,
    current: result.current,
    ...(result.authorization === undefined ? {} : { record: result.authorization }),
    ...(result.governedBodyDigest === undefined ? {} : { governedBodyDigest: result.governedBodyDigest }),
    violations: result.violations,
  };
}

function implementationCurrent(evidence: ImplementationIssueEvidence): Record<string, unknown> {
  return {
    issue: {
      number: evidence.issue.number,
      title: evidence.issue.title,
      state: evidence.issue.state,
      url: evidence.issue.url,
      metadata: {
        labels: evidence.issue.labels,
        assignees: evidence.issue.assignees,
      },
    },
    body: evidence.body,
  };
}

function sourceChecklist(body: string): readonly string[] {
  const values: string[] = [];
  for (const line of body.split(/\r?\n/u)) {
    const match = /^\s*-\s*\[[ xX]\]\s+(.+?)\s*$/u.exec(line);
    if (match !== null && match[1] !== undefined && match[1].length > 0) values.push(match[1]);
    if (values.length === 256) break;
  }
  return values;
}

function implementationPlanRecommendations(evidence: ImplementationIssueEvidence): Record<string, unknown> {
  return {
    authoritative: false,
    repository: evidence.repository,
    sources: [evidence.reference],
    objective: evidence.issue.title,
    verification: {
      acceptanceCriteria: sourceChecklist(evidence.body),
      targetedTests: [],
      requiredChecks: [],
      postconditions: [],
    },
    scope: { readOnly: [], write: [], create: [], delete: [], deny: [] },
    missing: [
      "nonGoals",
      "architecture.decision",
      "architecture.affectedComponents",
      "architecture.invariants",
      "execution.baseBranch",
      "verification.targetedTests",
      "verification.requiredChecks",
      "verification.postconditions",
    ],
  };
}

function printImplementationResult(result: Record<string, unknown>, json: boolean): void {
  console.log(JSON.stringify(result, null, json ? 0 : 2));
}

async function runImplementationCommand(
  command: string | undefined,
  rest: readonly string[],
  parsed: ParsedArgs,
  root: string,
  dependencies: CliDependencies,
  json: boolean,
): Promise<number> {
  if (
    command !== "plan" &&
    command !== "show" &&
    command !== "validate" &&
    command !== "authorize" &&
    command !== "inspect" &&
    command !== "verify"
  )
    throw new CliError("UNKNOWN_COMMAND", `Unknown Implementation command "${command ?? ""}".`);
  const definition = getCommandForPositionals(["impl", command]);
  if (definition === undefined) throw new CliError("UNKNOWN_COMMAND", `Unknown Implementation command "${command}".`);
  if (rest.length !== 1 || !isPositiveInteger(rest[0])) throw invalidArtifactNumberError("issue", rest[0]);
  const unsupported = Object.keys(parsed.options).find((key) => !definition.optionIds.includes(key as OptionId));
  if (unsupported !== undefined) {
    const option = getOption(unsupported as OptionId);
    throw new CliError(
      "INVALID_OPTION",
      `Option ${option.aliases[0] ?? `--${option.key}`} is not supported by impl ${command}.`,
      "$argv",
      { command: `impl ${command}`, option: option.id },
    );
  }
  const number = Number(rest[0]);
  const evidence = await readImplementationIssue(number, parsed, root, dependencies);
  const bodyProjection = implementationBodyProjection(evidence.body);
  const from = parsed.options.from === undefined ? undefined : await readJsonValue(parsed.options.from);
  const input = from === undefined ? {} : implementationInputEvidence(from);

  if (command === "verify") {
    const pullRequestValue = parsed.options.pullRequest;
    if (typeof pullRequestValue !== "string" || !isPositiveInteger(pullRequestValue))
      throw new CliError("INPUT_REQUIRED", "Use --pr <number>.", "--pr");
    const executionEvidence =
      parsed.options.executionEvidence === undefined
        ? undefined
        : await readJsonValue(parsed.options.executionEvidence, "--execution-evidence");
    const pullRequest = await evidence.adapter.observePullRequest(Number(pullRequestValue));
    const base = await implementationAuthorizedBaseEvidence(evidence, input.authorization);
    const conformance = tryVerifyImplementationConformance({
      authorization: input.authorization,
      issue: { reference: evidence.reference, body: evidence.body },
      repository: evidence.repository,
      base,
      pullRequestNumber: Number(pullRequestValue),
      pullRequest,
      ...(input.supersession === undefined ? {} : { supersession: input.supersession }),
      ...(input.completed === undefined ? {} : { completed: input.completed }),
      ...(executionEvidence === undefined ? {} : { executionEvidence }),
    });
    printImplementationResult(
      {
        ok: conformance.valid,
        valid: conformance.valid,
        status: conformance.status,
        operation: "impl.verify",
        kind: IMPLEMENTATION_KIND,
        implementation: evidence.reference,
        authorization: conformance.authorization,
        ...(conformance.binding === undefined ? {} : { binding: conformance.binding }),
        ...(conformance.pullRequest === undefined ? {} : { pullRequest: conformance.pullRequest }),
        changes: conformance.changes,
        verification: conformance.verification,
        diagnostics: conformance.diagnostics,
        mutation: false,
      },
      json,
    );
    return conformance.valid ? 0 : EXIT_VALIDATION;
  }

  if (command === "plan") {
    const relationships = await observeImplementationRelationships(evidence, parsed.capabilities);
    const result = {
      ok: true,
      valid: true,
      operation: "impl.plan",
      kind: IMPLEMENTATION_KIND,
      version: IMPLEMENTATION_CONTRACT_VERSION,
      source: evidence.reference,
      sourceEvidence: { title: evidence.issue.title, body: evidence.body },
      recommendations: implementationPlanRecommendations(evidence),
      relationships,
      authorization: { status: "draft", authorized: false, current: false, inferred: false, violations: [] },
      preview: true,
      mutation: false,
    };
    printImplementationResult(result, json);
    return 0;
  }

  const contract = bodyProjection.contract as Record<string, unknown> | undefined;
  const base =
    command === "authorize" || input.authorization !== undefined
      ? await implementationBaseEvidence(evidence, contract, input.base)
      : undefined;
  if (command === "validate") {
    const result = {
      ok: bodyProjection.valid === true,
      valid: bodyProjection.valid === true,
      operation: "impl.validate",
      kind: IMPLEMENTATION_KIND,
      implementation: evidence.reference,
      current: implementationCurrent(evidence),
      canonical: bodyProjection,
      mutation: false,
    };
    printImplementationResult(result, json);
    return bodyProjection.valid === true ? 0 : EXIT_VALIDATION;
  }

  const lifecycle = implementationLifecycle(evidence, evidence.body, input, base);
  if (command === "show") {
    const result = {
      ok: bodyProjection.valid === true && lifecycle.status !== "invalidated" && lifecycle.status !== "superseded",
      valid: bodyProjection.valid === true,
      operation: "impl.show",
      kind: IMPLEMENTATION_KIND,
      implementation: evidence.reference,
      current: implementationCurrent(evidence),
      canonical: bodyProjection,
      authorization: lifecycle,
      mutation: false,
    };
    printImplementationResult(result, json);
    return result.ok ? 0 : EXIT_VALIDATION;
  }

  if (command === "inspect") {
    const relationships = await observeImplementationRelationships(evidence, parsed.capabilities);
    const result = {
      ok: bodyProjection.valid === true && lifecycle.status !== "invalidated" && lifecycle.status !== "superseded",
      valid: bodyProjection.valid === true,
      operation: "impl.inspect",
      kind: IMPLEMENTATION_KIND,
      implementation: evidence.reference,
      current: implementationCurrent(evidence),
      canonical: bodyProjection,
      authorization: lifecycle,
      relationships,
      mutation: false,
    };
    printImplementationResult(result, json);
    return result.ok ? 0 : EXIT_VALIDATION;
  }

  const authorization = tryAuthorizeImplementation({
    issue: { reference: evidence.reference, body: evidence.body },
    repository: evidence.repository,
    ...(base === undefined ? {} : { base }),
    ...(input.authorization === undefined ? {} : { existingAuthorization: input.authorization }),
  });
  const result = {
    ok: authorization.valid,
    valid: authorization.valid,
    operation: "impl.authorize",
    kind: IMPLEMENTATION_KIND,
    implementation: evidence.reference,
    current: implementationCurrent(evidence),
    canonical: bodyProjection,
    authorization: {
      status: authorization.status,
      authorized: authorization.valid && authorization.status === "authorized",
      current: authorization.valid && authorization.status === "authorized",
      ...(authorization.authorization === undefined ? {} : { record: authorization.authorization }),
      ...(authorization.governedBodyDigest === undefined
        ? {}
        : { governedBodyDigest: authorization.governedBodyDigest }),
      violations: authorization.violations,
    },
    base: base === undefined ? { available: false } : { available: true, evidence: base },
    mutation: false,
  };
  printImplementationResult(result, json);
  return authorization.valid ? 0 : EXIT_VALIDATION;
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
  if (domain === "issue" && (command === "relations" || command === "relationships")) {
    return runIssueRelationsCommand(rest, parsed, root, dependencies);
  }
  if (domain === "issue") {
    const semantic = semanticIssueOperation(command, rest);
    if (semantic !== undefined) {
      return runSemanticIssueCommand(semantic.operation, semantic.rest, parsed, root, dependencies, json);
    }
  }
  if (domain === "pr") {
    if (command === "comment" || command === "review" || command === "merge") {
      return runPullRequestMutationCommand(command, rest, parsed, root, dependencies);
    }
    const semantic = semanticPullRequestOperation(command, rest);
    if (semantic !== undefined) {
      return runSemanticPullRequestCommand(semantic.operation, semantic.rest, parsed, root, dependencies, json);
    }
  }
  if (command === "observe") {
    if (rest.length !== 1 || !isPositiveInteger(rest[0])) throw invalidArtifactNumberError(domain, rest[0]);
    return runOperationalObservationCommand(domain, Number(rest[0]), parsed, root, dependencies);
  }
  if (
    command === "check" &&
    typeof parsed.options.from === "string" &&
    rest.length === 1 &&
    isPositiveInteger(rest[0])
  ) {
    return runSemanticObservationCheckCommand(domain, Number(rest[0]), parsed, root, dependencies);
  }
  if (parsed.capabilities.length > 0) {
    throw new CliError(
      "INVALID_OPTION",
      "Option --capability is only supported by semantic artifact commands.",
      "--capability",
    );
  }
  if (command === "schema") {
    let contract: CanonicalContract;
    if (typeof parsed.options.repository === "string") {
      rejectGovernedPolicyOverride(parsed.options.policy);
      const adapter = createAdapter(dependencies, root, parsed.options.repository);
      await adapter.resolveRepositoryContext();
      contract = await compileRepositoryGovernedContract(adapter, domain, templateSelector(parsed, rest[0]), {
        templateResolver: dependencies.templateResolver,
      });
    } else {
      contract = await compileLocalGovernedContract(
        domain,
        root,
        templateSelector(parsed, rest[0]),
        parsed.options.policy,
        { templateResolver: dependencies.templateResolver },
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
        contract = await compileRepositoryGovernedContract(adapter, domain, templateSelector(parsed, rest[0]), {
          templateResolver: dependencies.templateResolver,
        });
      } else {
        contract = await compileLocalGovernedContract(
          domain,
          root,
          templateSelector(parsed, rest[0]),
          parsed.options.policy,
          { templateResolver: dependencies.templateResolver },
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
            ...(domain === "issue" && validation.dependencies === undefined
              ? {}
              : { dependencies: validation.dependencies }),
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
          ? renderIssueArtifact(contract, preparedDocument)
          : renderPullRequestArtifact(contract, preparedDocument.fields);
      if (json) console.log(JSON.stringify({ valid: true, body }));
      else process.stdout.write(body);
      return 0;
    }

    rejectGovernedPolicyOverride(parsed.options.policy);
    const adapter = createAdapter(dependencies, root, parsed.options.repository);
    await adapter.resolveRepositoryContext();
    const contract = await compileRepositoryGovernedContract(adapter, domain, templateSelector(parsed, rest[0]), {
      templateResolver: dependencies.templateResolver,
    });
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

interface OperationalSemanticOverlay {
  readonly status: "valid" | "invalid" | "unavailable";
  readonly diagnostics: readonly unknown[];
  readonly classification?: string;
}

async function projectOperationalSemanticOverlay(
  domain: "issue" | "pr",
  number: number,
  adapter: GitHubAdapter,
): Promise<OperationalSemanticOverlay> {
  try {
    const read = await readGovernedExistingArtifact(adapter, domain, number);
    const projection = projectExistingArtifact(read.result);
    const unavailable = new Set(["wrong-template", "unparseable", "ambiguous", "unsupported"]);
    return {
      status: projection.valid ? "valid" : unavailable.has(read.result.classification) ? "unavailable" : "invalid",
      diagnostics: projection.diagnostics,
      classification: read.result.classification,
    };
  } catch {
    const diagnostic: OperationalDiagnostic = {
      code: "SEMANTIC_PROJECTION_UNAVAILABLE",
      path: "$.semantic",
      message: "Semantic Artifact projection read failed closed; observed provider state remains available.",
    };
    return { status: "unavailable", diagnostics: [diagnostic] };
  }
}

/** Project the canonical Operational Observation surface for CLI callers. */
async function runOperationalObservationCommand(
  domain: "issue" | "pr",
  number: number,
  parsed: ParsedArgs,
  root: string,
  dependencies: CliDependencies,
): Promise<number> {
  const unsupported = Object.keys(parsed.options).find((key) => !["json", "repository"].includes(key));
  if (unsupported !== undefined) {
    const option = getOption(unsupported as OptionId);
    throw new CliError(
      "INVALID_OPTION",
      `Option ${option.aliases[0] ?? `--${option.key}`} is not supported by Operational Observation.`,
      "$argv",
    );
  }
  if (parsed.fields.length > 0 || parsed.capabilities.length > 0) {
    throw new CliError(
      "INVALID_OPTION",
      "Operational Observation is provider evidence and does not accept semantic field or capability input.",
      "$argv",
    );
  }
  const adapter = createAdapter(dependencies, root, parsed.options.repository);
  const evidence = domain === "issue" ? await adapter.observeIssue(number) : await adapter.observePullRequest(number);
  const observedResult =
    domain === "issue"
      ? tryObserveOperationalIssue({ issue: evidence })
      : tryObserveOperationalPullRequest({ pullRequest: evidence });
  if (!observedResult.valid || observedResult.observation === undefined) {
    console.log(
      JSON.stringify({
        ok: false,
        valid: false,
        operation: `${domain}.observe`,
        kind: domain === "issue" ? "issue" : "pull_request",
        number,
        phase: "observation",
        diagnostics: observedResult.violations,
        violations: observedResult.violations,
      }),
    );
    return EXIT_VALIDATION;
  }
  const semantic = await projectOperationalSemanticOverlay(domain, number, adapter);
  console.log(
    JSON.stringify({
      ok: true,
      valid: true,
      operation: `${domain}.observe`,
      kind: domain === "issue" ? "issue" : "pull_request",
      version: observedResult.observation.version,
      number,
      observed: observedResult.observation,
      semantic,
      mutation: false,
    }),
  );
  return 0;
}

type SemanticIssueOperation = "contract" | "materialize" | "plan" | "check";

function semanticIssueOperation(
  command: string | undefined,
  rest: readonly string[],
): { readonly operation: SemanticIssueOperation; readonly rest: readonly string[] } | undefined {
  if (command === "contract" || command === "materialize" || command === "plan") {
    return { operation: command, rest };
  }
  if (command !== "semantic") return undefined;
  const nested = rest[0];
  if (nested === "schema") return { operation: "contract", rest: rest.slice(1) };
  if (nested === "validate" || nested === "materialize") return { operation: "materialize", rest: rest.slice(1) };
  if (nested === "plan") return { operation: "plan", rest: rest.slice(1) };
  if (nested === "check") return { operation: "check", rest: rest.slice(1) };
  throw new CliError("UNKNOWN_COMMAND", `Unknown Issue semantic command "${nested ?? ""}".`);
}

function rejectSemanticIssueOptions(operation: SemanticIssueOperation, parsed: ParsedArgs): void {
  const allowed = new Set(
    operation === "contract"
      ? ["json", "template", "repository"]
      : ["json", "template", "repository", "from", "capability"],
  );
  const unsupported = Object.keys(parsed.options).find((key) => !allowed.has(key));
  if (unsupported !== undefined) {
    const option = getOption(unsupported as OptionId);
    throw new CliError(
      "INVALID_OPTION",
      `Option ${option.aliases[0] ?? `--${option.key}`} is not supported by the semantic Issue ${operation} command.`,
      "$argv",
      { command: `issue ${operation}`, option: option.id },
    );
  }
  if (parsed.fields.length > 0) {
    throw new CliError(
      "INVALID_OPTION",
      "Semantic Issue commands accept caller input only through --from; --field is not a Core semantic input adapter.",
      "--field",
    );
  }
}

async function runSemanticIssueCommand(
  operation: SemanticIssueOperation,
  rest: readonly string[],
  parsed: ParsedArgs,
  root: string,
  dependencies: CliDependencies,
  _json: boolean,
): Promise<number> {
  rejectSemanticIssueOptions(operation, parsed);
  if (rest.length > 1) {
    throw new CliError("UNKNOWN_COMMAND", `Unexpected Issue semantic argument "${rest[1] ?? ""}".`);
  }
  if (operation === "check") {
    if (rest.length !== 1 || !isPositiveInteger(rest[0])) throw invalidArtifactNumberError("issue", rest[0]);
    return runSemanticObservationCheckCommand("issue", Number(rest[0]), parsed, root, dependencies);
  }
  const selector = templateSelector(parsed, rest[0]);
  const adapter = createAdapter(dependencies, root, parsed.options.repository);
  const effectiveContract = await compileRepositoryEffectiveIssueContract(adapter, selector, {
    capabilities: parsed.capabilities,
  });
  const contractProjection = {
    ok: true,
    version: effectiveContract.version,
    artifactContractVersion: effectiveContract.artifactContractVersion,
    kind: effectiveContract.kind,
    id: effectiveContract.id,
    contract: effectiveContract.contract,
    effectiveContract,
    inputSchema: effectiveContract.inputSchema,
    properties: effectiveContract.properties,
    ...(effectiveContract.fields === undefined ? {} : { fields: effectiveContract.fields }),
    derivations: effectiveContract.derivations,
    dependencyGraph: effectiveContract.dependencyGraph,
    evaluationOrder: effectiveContract.evaluationOrder,
    provenance: effectiveContract.provenance,
    generation: effectiveContract.generation,
    capabilities: effectiveContract.capabilities,
  };
  if (operation === "contract") {
    console.log(JSON.stringify(contractProjection));
    return 0;
  }

  const input = await readJsonValue(parsed.options.from);
  const materialization = tryMaterializeSemanticArtifact(effectiveContract, input);
  if (!materialization.valid || materialization.artifact === undefined) {
    console.log(JSON.stringify(semanticFailure("materialization", materialization.violations, effectiveContract)));
    return EXIT_VALIDATION;
  }
  if (operation === "materialize") {
    console.log(
      JSON.stringify({
        ok: true,
        valid: true,
        effectiveContract,
        artifact: materialization.artifact,
        provenance: materialization.artifact.provenance,
        generation: materialization.artifact.generation,
      }),
    );
    return 0;
  }

  const plan = tryPlanSemanticIssue({
    artifact: materialization.artifact,
    capabilities: effectiveContract.capabilities,
  });
  if (!plan.valid || plan.plan === undefined) {
    console.log(JSON.stringify(semanticFailure("projection", plan.violations, effectiveContract)));
    return EXIT_VALIDATION;
  }
  console.log(
    JSON.stringify({
      ok: true,
      valid: true,
      effectiveContract,
      artifact: materialization.artifact,
      plan: plan.plan,
      provenance: plan.plan.provenance,
      generation: plan.plan.generation,
      preview: true,
      mutation: false,
    }),
  );
  return 0;
}

async function runIssueRelationsCommand(
  rest: readonly string[],
  parsed: ParsedArgs,
  root: string,
  dependencies: CliDependencies,
): Promise<number> {
  const operation = rest[0];
  if (
    operation !== "plan" &&
    operation !== "execute" &&
    operation !== "inspect" &&
    operation !== "inspect-parent" &&
    operation !== "inspect-children" &&
    operation !== "parent" &&
    operation !== "children" &&
    operation !== "attach" &&
    operation !== "detach" &&
    operation !== "reparent"
  )
    throw new CliError("UNKNOWN_COMMAND", `Unknown Issue relations command "${operation ?? ""}".`);
  if (rest.length !== 2 || !isPositiveInteger(rest[1])) throw invalidArtifactNumberError("issue", rest[1]);

  if (
    operation === "inspect" ||
    operation === "inspect-parent" ||
    operation === "inspect-children" ||
    operation === "parent" ||
    operation === "children" ||
    operation === "attach" ||
    operation === "detach" ||
    operation === "reparent"
  )
    return runGenericIssueRelationshipCommand(operation, Number(rest[1]), parsed, root, dependencies);

  const allowed = new Set(["json", "repository", "from", "capability"]);
  const unsupported = Object.keys(parsed.options).find((key) => !allowed.has(key));
  if (unsupported !== undefined) {
    const option = getOption(unsupported as OptionId);
    throw new CliError(
      "INVALID_OPTION",
      `Option ${option.aliases[0] ?? `--${option.key}`} is not supported by the Issue relations ${operation} command.`,
      "$argv",
      { command: `issue relations ${operation}`, option: option.id },
    );
  }
  if (parsed.fields.length > 0) {
    throw new CliError(
      "INVALID_OPTION",
      "Issue relations commands accept caller input only through --from; --field is not a Core semantic input adapter.",
      "--field",
    );
  }

  const subjectNumber = Number(rest[1]);
  const input = await readJsonValue(parsed.options.from);
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new CliError(
      "INVALID_INPUT",
      'Issue relations input must be a JSON object with a "desired" property.',
      "--from",
    );
  const desired = (input as Record<string, unknown>).desired;
  const graph = (input as Record<string, unknown>).graph;

  const adapter = createAdapter(dependencies, root, parsed.options.repository);
  const planResult = await planExistingIssueRelationReconciliation(adapter, {
    subjectNumber,
    desired,
    ...(graph === undefined ? {} : { graph }),
    capabilities: parsed.capabilities,
  });
  if (!planResult.valid || planResult.plan === undefined) {
    console.log(
      JSON.stringify({
        ok: false,
        valid: false,
        operation: `issue.relations.${operation}`,
        issue: subjectNumber,
        diagnostics: planResult.diagnostics,
        violations: planResult.diagnostics,
      }),
    );
    return EXIT_VALIDATION;
  }
  if (operation === "plan") {
    console.log(
      JSON.stringify({
        ok: true,
        valid: true,
        operation: "issue.relations.plan",
        issue: subjectNumber,
        plan: planResult.plan,
        preview: true,
        mutation: false,
      }),
    );
    return 0;
  }

  const executor =
    dependencies.semanticIssueRelationExecutor ??
    (
      dependencies.createSemanticIssueRelationExecutor ?? ((options) => new LocalSemanticIssueRelationExecutor(options))
    )({
      adapter: createAdapter(dependencies, root, parsed.options.repository),
      capabilities: parsed.capabilities,
    });
  try {
    const execution = await executor.execute({
      version: SEMANTIC_ISSUE_RELATION_EXECUTOR_CONTRACT_VERSION,
      plan: planResult.plan,
      capabilities: parsed.capabilities,
    });
    console.log(
      JSON.stringify({
        ok: true,
        valid: true,
        operation: "issue.relations.execute",
        issue: subjectNumber,
        plan: execution.plan,
        observed: execution.observed,
        evidence: execution.evidence,
        preview: false,
        mutation: true,
      }),
    );
    return 0;
  } catch (error: unknown) {
    if (error instanceof SemanticIssueRelationExecutorError) {
      console.log(
        JSON.stringify({
          ok: false,
          valid: false,
          operation: "issue.relations.execute",
          issue: subjectNumber,
          diagnostics: error.diagnostics,
          violations: error.diagnostics,
          ...(error.evidence === undefined ? {} : { evidence: error.evidence }),
        }),
      );
      return EXIT_VALIDATION;
    }
    throw error;
  }
}

type GenericIssueRelationshipOperation =
  "inspect" | "inspect-parent" | "inspect-children" | "parent" | "children" | "attach" | "detach" | "reparent";

function nativeParentCapability(capabilities: readonly string[]): boolean {
  return capabilities.some(
    (entry) =>
      entry === GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeParentRelation ||
      entry === "issue.parent.native" ||
      entry === "github.issue.sub-issues.native" ||
      entry === "github.issue.sub_issues.native",
  );
}

function relationshipInputReference(input: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (input[key] !== undefined) return input[key];
  }
  return undefined;
}

async function runGenericIssueRelationshipCommand(
  operation: GenericIssueRelationshipOperation,
  issueNumber: number,
  parsed: ParsedArgs,
  root: string,
  dependencies: CliDependencies,
): Promise<number> {
  const allowed = new Set(["json", "repository", "from", "capability"]);
  const unsupported = Object.keys(parsed.options).find((key) => !allowed.has(key));
  if (unsupported !== undefined) {
    const option = getOption(unsupported as OptionId);
    throw new CliError(
      "INVALID_OPTION",
      `Option ${option.aliases[0] ?? `--${option.key}`} is not supported by the Issue relationship ${operation} command.`,
      "$argv",
      { command: `issue relations ${operation}`, option: option.id },
    );
  }
  if (parsed.fields.length > 0)
    throw new CliError(
      "INVALID_OPTION",
      "Issue relationship commands accept caller input only through --from; --field is not a Core semantic input adapter.",
      "--field",
    );

  const input = parsed.options.from === undefined ? {} : await readJsonValue(parsed.options.from);
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new CliError("INVALID_INPUT", "Issue relationship input must be a JSON object.", "--from");
  const inputRecord = input as Record<string, unknown>;
  const adapter = createAdapter(dependencies, root, parsed.options.repository);
  const context = await adapter.getRepositoryContext();
  const relationAdapter = new GitHubIssueRelationMutationAdapter(adapter, context, {
    parent: nativeParentCapability(parsed.capabilities),
    blockedBy: false,
    children: nativeParentCapability(parsed.capabilities),
  });
  const executor = new LocalIssueRelationshipExecutor({ adapter: relationAdapter, context });
  const subject = issueNumber;
  let result: unknown;
  try {
    if (operation === "inspect" || operation === "inspect-parent" || operation === "parent") {
      const requestedView =
        operation === "inspect" ? relationshipInputReference(inputRecord, ["view", "relation"]) : "parent";
      if (requestedView !== undefined && requestedView !== "parent")
        throw new CliError("INVALID_INPUT", 'Relationship inspect view must be "parent".', "$.view");
      result = await executor.inspectParent(subject);
    } else if (operation === "inspect-children" || operation === "children") {
      result = await executor.inspectChildren(subject);
    } else {
      const child = relationshipInputReference(inputRecord, ["child"]) ?? subject;
      const parent = relationshipInputReference(inputRecord, ["parent", "to", "newParent"]);
      const previousParent = relationshipInputReference(inputRecord, ["previousParent", "from", "oldParent"]);
      if (operation !== "detach" && parent === undefined)
        throw new CliError("INVALID_INPUT", `Issue relationship ${operation} requires a parent in --from.`, "$.parent");
      if (operation === "reparent" && previousParent === undefined)
        throw new CliError(
          "INVALID_INPUT",
          "Issue relationship reparent requires the old parent in --from.",
          "$.previousParent",
        );
      const request: IssueRelationshipMutationRequest = {
        operation: operation as IssueRelationshipMutationRequest["operation"],
        child: child as IssueRelationshipMutationRequest["child"],
        ...(parent === undefined ? {} : { parent: parent as IssueRelationshipMutationRequest["parent"] }),
        ...(previousParent === undefined
          ? {}
          : { previousParent: previousParent as IssueRelationshipMutationRequest["previousParent"] }),
      };
      result = await executor.execute(request);
    }
  } catch (error: unknown) {
    if (error instanceof IssueRelationshipExecutorError) {
      console.log(
        JSON.stringify({
          ok: false,
          valid: false,
          operation: `issue.relations.${operation}`,
          issue: issueNumber,
          diagnostics: error.diagnostics,
          violations: error.diagnostics,
          ...(error.evidence === undefined ? {} : { evidence: error.evidence }),
        }),
      );
      return EXIT_VALIDATION;
    }
    throw error;
  }
  if (result !== undefined && typeof result === "object" && result !== null) {
    const value = result as Record<string, unknown>;
    const mutation = operation === "attach" || operation === "detach" || operation === "reparent";
    console.log(
      JSON.stringify({
        ok: true,
        valid: true,
        issue: issueNumber,
        ...value,
        operation: `issue.relations.${operation}`,
        mutation,
      }),
    );
  }
  return 0;
}

type SemanticPullRequestOperation = "contract" | "materialize" | "plan" | "execute" | "check";

function pullRequestMutationRepository(
  context: Awaited<ReturnType<GitHubAdapter["getRepositoryContext"]>>,
): SemanticPullRequestRepositoryIdentity {
  return {
    hostname: context.hostname,
    nameWithOwner: context.nameWithOwner,
    ...(context.repositoryId === undefined ? {} : { repositoryId: context.repositoryId }),
  };
}

function pullRequestMutationExitCode(code: string, outcome: string): number {
  if (
    outcome === "stale" ||
    outcome === "blocked" ||
    code === "PR_MUTATION_EXECUTION_REQUEST_INVALID" ||
    code === "PR_MUTATION_EXECUTION_PLAN_INVALID" ||
    code === "PR_MUTATION_REPOSITORY_MISMATCH" ||
    code === "PR_MUTATION_DUPLICATE_REVIEW" ||
    code === "PR_MUTATION_DRAFT" ||
    code === "PR_MUTATION_NOT_OPEN" ||
    code === "PR_MUTATION_MERGE_BLOCKED"
  )
    return EXIT_VALIDATION;
  return EXIT_REMOTE;
}

async function runPullRequestMutationCommand(
  command: string,
  rest: readonly string[],
  parsed: ParsedArgs,
  root: string,
  dependencies: CliDependencies,
): Promise<number> {
  const operation = command as SemanticPullRequestMutationOperation;
  const definition = getCommandForPositionals(["pr", command]);
  if (definition === undefined || definition.domain !== "pr")
    throw new CliError("UNKNOWN_COMMAND", `Unknown PR mutation command "${command}".`);
  if (rest.length !== 1 || !isPositiveInteger(rest[0])) throw invalidArtifactNumberError("pr", rest[0]);
  const unsupported = Object.keys(parsed.options).find((key) => !definition.optionIds.includes(key as OptionId));
  if (unsupported !== undefined) {
    const option = getOption(unsupported as OptionId);
    throw new CliError(
      "INVALID_OPTION",
      `Option ${option.aliases[0] ?? `--${option.key}`} is not supported by pr ${operation}.`,
      "$argv",
      { command: `pr ${operation}`, option: option.id },
    );
  }
  if (parsed.fields.length > 0 || parsed.capabilities.length > 0)
    throw new CliError("INVALID_OPTION", `PR ${operation} does not accept --field or --capability.`, "$argv");

  try {
    const adapter = createAdapter(dependencies, root, parsed.options.repository);
    const context = await adapter.getRepositoryContext();
    const common = {
      version: SEMANTIC_PULL_REQUEST_MUTATION_CONTRACT_VERSION,
      operation,
      repository: pullRequestMutationRepository(context),
      pullRequest: Number(rest[0]),
    };
    const request: unknown =
      operation === "comment"
        ? {
            ...common,
            ...(typeof parsed.options.rawBody === "string" ? { body: parsed.options.rawBody } : {}),
            ...(typeof parsed.options.expectedHead === "string" ? { expectedHead: parsed.options.expectedHead } : {}),
          }
        : operation === "review"
          ? {
              ...common,
              ...(typeof parsed.options.expectedHead === "string" ? { expectedHead: parsed.options.expectedHead } : {}),
              ...(typeof parsed.options.reviewIntent === "string" ? { intent: parsed.options.reviewIntent } : {}),
              ...(typeof parsed.options.rawBody === "string" ? { body: parsed.options.rawBody } : {}),
              ...(typeof parsed.options.retry === "string" ? { retry: parsed.options.retry } : {}),
            }
          : {
              ...common,
              ...(typeof parsed.options.expectedHead === "string" ? { expectedHead: parsed.options.expectedHead } : {}),
              ...(typeof parsed.options.expectedBase === "string" ? { expectedBase: parsed.options.expectedBase } : {}),
              ...(typeof parsed.options.mergeStrategy === "string" ? { strategy: parsed.options.mergeStrategy } : {}),
            };
    const planned = tryPlanSemanticPullRequestMutation(request);
    if (!planned.valid || planned.plan === undefined) {
      console.log(
        JSON.stringify({
          ok: false,
          valid: false,
          operation: `pr.${operation}`,
          outcome: "failed",
          diagnostics: planned.violations,
          violations: planned.violations,
          mutation: false,
        }),
      );
      return EXIT_VALIDATION;
    }
    const executor =
      dependencies.semanticPullRequestMutationExecutor ??
      (
        dependencies.createSemanticPullRequestMutationExecutor ??
        ((options) => new LocalSemanticPullRequestMutationExecutor(options))
      )({
        adapter,
      });
    const execution = await executor.execute({
      version: SEMANTIC_PULL_REQUEST_MUTATION_CONTRACT_VERSION,
      plan: planned.plan,
    });
    console.log(
      JSON.stringify({
        ok: true,
        valid: true,
        operation: `pr.${operation}`,
        outcome: execution.outcome,
        plan: execution.plan,
        evidence: execution.evidence,
        current: execution.current,
        ...(execution.resource === undefined ? {} : { resource: execution.resource }),
        mutation: execution.outcome === "succeeded",
      }),
    );
    return 0;
  } catch (error: unknown) {
    if (error instanceof SemanticPullRequestMutationError) {
      console.log(
        JSON.stringify({
          ok: false,
          valid: false,
          operation: `pr.${operation}`,
          outcome: error.outcome,
          code: error.code,
          diagnostics: error.diagnostics,
          violations: error.diagnostics,
          evidence: error.evidence,
          ...(error.plan === undefined ? {} : { plan: error.plan }),
          mutation: false,
        }),
      );
      return pullRequestMutationExitCode(error.code, error.outcome);
    }
    const provider = isGitHubAdapterError(error);
    console.log(
      JSON.stringify({
        ok: false,
        valid: false,
        operation: `pr.${operation}`,
        outcome: "failed",
        code: provider ? error.code : "PR_MUTATION_TARGET_READ_FAILED",
        diagnostics: [
          {
            code: provider ? error.code : "PR_MUTATION_TARGET_READ_FAILED",
            path: "$.pullRequest",
            message: provider
              ? "The bounded GitHub provider operation failed before verified mutation completion."
              : "The governed PR mutation could not establish verified execution evidence.",
          },
        ],
        violations: [
          {
            code: provider ? error.code : "PR_MUTATION_TARGET_READ_FAILED",
            path: "$.pullRequest",
            message: provider
              ? "The bounded GitHub provider operation failed before verified mutation completion."
              : "The governed PR mutation could not establish verified execution evidence.",
          },
        ],
        mutation: false,
      }),
    );
    return EXIT_REMOTE;
  }
}

function semanticPullRequestOperation(
  command: string | undefined,
  rest: readonly string[],
): { readonly operation: SemanticPullRequestOperation; readonly rest: readonly string[] } | undefined {
  if (command === "contract" || command === "materialize" || command === "plan" || command === "execute") {
    return { operation: command, rest };
  }
  if (command !== "semantic") return undefined;
  const nested = rest[0];
  if (nested === "schema") return { operation: "contract", rest: rest.slice(1) };
  if (nested === "validate" || nested === "materialize") return { operation: "materialize", rest: rest.slice(1) };
  if (nested === "plan") return { operation: "plan", rest: rest.slice(1) };
  if (nested === "execute") return { operation: "execute", rest: rest.slice(1) };
  if (nested === "check") return { operation: "check", rest: rest.slice(1) };
  throw new CliError("UNKNOWN_COMMAND", `Unknown PR semantic command "${nested ?? ""}".`);
}

function rejectSemanticPullRequestOptions(operation: SemanticPullRequestOperation, parsed: ParsedArgs): void {
  const allowed = new Set(
    operation === "contract"
      ? ["json", "template", "repository"]
      : ["json", "template", "repository", "from", "capability"],
  );
  const unsupported = Object.keys(parsed.options).find((key) => !allowed.has(key));
  if (unsupported !== undefined) {
    const option = getOption(unsupported as OptionId);
    throw new CliError(
      "INVALID_OPTION",
      `Option ${option.aliases[0] ?? `--${option.key}`} is not supported by the semantic PR ${operation} command.`,
      "$argv",
      { command: `pr ${operation}`, option: option.id },
    );
  }
  if (parsed.fields.length > 0) {
    throw new CliError(
      "INVALID_OPTION",
      "Semantic PR commands accept caller input only through --from; --field is not a Core semantic input adapter.",
      "--field",
    );
  }
}

function semanticFailure(
  phase: string,
  diagnostics: readonly unknown[],
  effectiveContract?: unknown,
): Readonly<Record<string, unknown>> {
  return {
    ok: false,
    valid: false,
    phase,
    diagnostics,
    // Keep the existing machine-readable validation convention while retaining
    // the exact Core diagnostic objects without translation.
    violations: diagnostics,
    ...(effectiveContract === undefined ? {} : { effectiveContract }),
  };
}

async function runSemanticPullRequestCommand(
  operation: SemanticPullRequestOperation,
  rest: readonly string[],
  parsed: ParsedArgs,
  root: string,
  dependencies: CliDependencies,
  _json: boolean,
): Promise<number> {
  rejectSemanticPullRequestOptions(operation, parsed);
  if (rest.length > 1) {
    throw new CliError("UNKNOWN_COMMAND", `Unexpected PR semantic argument "${rest[1] ?? ""}".`);
  }
  if (operation === "check") {
    if (rest.length !== 1 || !isPositiveInteger(rest[0])) throw invalidArtifactNumberError("pr", rest[0]);
    return runSemanticObservationCheckCommand("pr", Number(rest[0]), parsed, root, dependencies);
  }
  const selector = templateSelector(parsed, rest[0]);
  const adapter = createAdapter(dependencies, root, parsed.options.repository);
  const effectiveContract = await compileRepositoryEffectivePullRequestContract(adapter, selector, {
    capabilities: parsed.capabilities,
  });
  const contractProjection = {
    ok: true,
    version: effectiveContract.version,
    artifactContractVersion: effectiveContract.artifactContractVersion,
    kind: effectiveContract.kind,
    id: effectiveContract.id,
    contract: effectiveContract.contract,
    effectiveContract,
    inputSchema: effectiveContract.inputSchema,
    properties: effectiveContract.properties,
    ...(effectiveContract.fields === undefined ? {} : { fields: effectiveContract.fields }),
    derivations: effectiveContract.derivations,
    dependencyGraph: effectiveContract.dependencyGraph,
    evaluationOrder: effectiveContract.evaluationOrder,
    provenance: effectiveContract.provenance,
    generation: effectiveContract.generation,
    capabilities: effectiveContract.capabilities,
  };
  if (operation === "contract") {
    console.log(JSON.stringify(contractProjection));
    return 0;
  }

  const input = await readJsonValue(parsed.options.from);
  const materialization = tryMaterializeSemanticArtifact(effectiveContract, input);
  if (!materialization.valid || materialization.artifact === undefined) {
    console.log(JSON.stringify(semanticFailure("materialization", materialization.violations, effectiveContract)));
    return EXIT_VALIDATION;
  }
  if (operation === "materialize") {
    console.log(
      JSON.stringify({
        ok: true,
        valid: true,
        effectiveContract,
        artifact: materialization.artifact,
        provenance: materialization.artifact.provenance,
        generation: materialization.artifact.generation,
      }),
    );
    return 0;
  }

  const plan = tryPlanSemanticPullRequest({
    artifact: materialization.artifact,
    capabilities: effectiveContract.capabilities,
  });
  if (!plan.valid || plan.plan === undefined) {
    console.log(JSON.stringify(semanticFailure("projection", plan.violations, effectiveContract)));
    return EXIT_VALIDATION;
  }
  if (operation === "execute") {
    const executor =
      dependencies.semanticPullRequestExecutor ??
      (dependencies.createSemanticPullRequestExecutor ?? ((options) => new LocalSemanticPullRequestExecutor(options)))({
        adapter: createAdapter(dependencies, root, parsed.options.repository),
        ...(selector === undefined ? {} : { selector }),
        capabilities: effectiveContract.capabilities,
      });
    const execution = await executor.execute({
      version: SEMANTIC_PULL_REQUEST_EXECUTOR_CONTRACT_VERSION,
      plan: plan.plan,
      artifact: materialization.artifact,
      input,
      ...(selector === undefined ? {} : { selector }),
      capabilities: effectiveContract.capabilities,
    });
    console.log(
      JSON.stringify({
        ok: true,
        valid: true,
        effectiveContract,
        artifact: materialization.artifact,
        plan: execution.plan,
        projection: execution.projection,
        evidence: execution.evidence,
        provenance: execution.plan.provenance,
        generation: execution.plan.generation,
        preview: false,
        mutation: true,
      }),
    );
    return 0;
  }
  console.log(
    JSON.stringify({
      ok: true,
      valid: true,
      effectiveContract,
      artifact: materialization.artifact,
      plan: plan.plan,
      provenance: plan.plan.provenance,
      generation: plan.plan.generation,
      preview: true,
      mutation: false,
    }),
  );
  return 0;
}

type SemanticObservationDomain = "issue" | "pr";

function semanticObservationRepository(context: Awaited<ReturnType<GitHubAdapter["getRepositoryContext"]>>) {
  return {
    host: context.hostname,
    repositoryId: context.repositoryId,
    repository: context.nameWithOwner,
  };
}

function projectSemanticObservationFailure(
  phase: "materialization" | "projection" | "observation",
  diagnostics: readonly unknown[],
  effectiveContract: unknown,
  artifact?: unknown,
  desired?: unknown,
): Readonly<Record<string, unknown>> {
  return {
    ok: false,
    valid: false,
    phase,
    effectiveContract,
    ...(artifact === undefined ? {} : { artifact }),
    ...(desired === undefined ? {} : { desired }),
    diagnostics,
    violations: diagnostics,
  };
}

async function runSemanticObservationCheckCommand(
  domain: SemanticObservationDomain,
  number: number,
  parsed: ParsedArgs,
  root: string,
  dependencies: CliDependencies,
): Promise<number> {
  const input = await readJsonValue(parsed.options.from);
  const adapter = createAdapter(dependencies, root, parsed.options.repository);
  const selector = templateSelector(parsed, undefined);
  const effectiveContract =
    domain === "issue"
      ? await compileRepositoryEffectiveIssueContract(adapter, selector, { capabilities: parsed.capabilities })
      : await compileRepositoryEffectivePullRequestContract(adapter, selector, {
          capabilities: parsed.capabilities,
        });
  const materialization = tryMaterializeSemanticArtifact(effectiveContract, input);
  if (!materialization.valid || materialization.artifact === undefined) {
    console.log(
      JSON.stringify(
        projectSemanticObservationFailure("materialization", materialization.violations, effectiveContract),
      ),
    );
    return EXIT_VALIDATION;
  }

  const artifact = materialization.artifact;
  const desiredResult =
    domain === "issue"
      ? tryProjectSemanticIssue({ artifact, capabilities: effectiveContract.capabilities })
      : tryProjectSemanticPullRequest({ artifact, capabilities: effectiveContract.capabilities });
  if (!desiredResult.valid || desiredResult.projection === undefined) {
    console.log(
      JSON.stringify(
        projectSemanticObservationFailure("projection", desiredResult.violations, effectiveContract, artifact),
      ),
    );
    return EXIT_VALIDATION;
  }
  const context = await adapter.getRepositoryContext();
  const repository = semanticObservationRepository(context);
  let observedResult: ReturnType<typeof tryObserveSemanticIssue> | ReturnType<typeof tryObserveSemanticPullRequest>;
  const observationDiagnostics: unknown[] = [];

  if (domain === "issue") {
    const issue = await adapter.readIssue(number);
    const relationAdapter = new GitHubIssueRelationObservationAdapter(adapter, context, {
      parent: effectiveContract.capabilities.includes(GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeParentRelation),
      blockedBy: effectiveContract.capabilities.some(
        (capability) =>
          capability === GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeBlockedByRelation ||
          capability === GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeDependsOnRelation,
      ),
    });
    const relationEvidence: {
      parent?: SemanticIssueRelationEvidenceInput;
      dependsOn?: SemanticIssueRelationEvidenceInput;
    } = {};
    if (effectiveContract.capabilities.includes(GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeParentRelation)) {
      const parent = await relationAdapter.observeParent(number);
      observationDiagnostics.push(...parent.diagnostics);
      if (parent.kind === "present" && parent.reference !== undefined)
        relationEvidence.parent = { native: parent.reference };
      else if (parent.kind === "empty") relationEvidence.parent = { native: [] };
    }
    if (
      effectiveContract.capabilities.includes(GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeBlockedByRelation) ||
      effectiveContract.capabilities.includes(GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeDependsOnRelation)
    ) {
      const dependsOn = await relationAdapter.observeBlockedBy(number);
      observationDiagnostics.push(...dependsOn.diagnostics);
      if (dependsOn.kind === "present" || dependsOn.kind === "empty")
        relationEvidence.dependsOn = { native: dependsOn.references };
    }
    observedResult = tryObserveSemanticIssue({ issue, repository, relations: relationEvidence });
  } else {
    const pullRequest = await adapter.readPullRequest(number);
    observedResult = tryObserveSemanticPullRequest({ pullRequest, repository });
  }

  if (!observedResult.valid || observedResult.projection === undefined) {
    const output = projectSemanticObservationFailure(
      "observation",
      observedResult.violations,
      effectiveContract,
      artifact,
      desiredResult.projection,
    );
    console.log(
      JSON.stringify({
        ...output,
        number,
        operation: `${domain}.semantic.check`,
        ...(observationDiagnostics.length === 0 ? {} : { observationDiagnostics }),
      }),
    );
    return EXIT_VALIDATION;
  }

  const comparison =
    domain === "issue"
      ? compareSemanticIssueProjection(desiredResult.projection, observedResult.projection)
      : compareSemanticPullRequestProjection(desiredResult.projection, observedResult.projection);
  console.log(
    JSON.stringify({
      ok: comparison.valid,
      valid: comparison.valid,
      operation: `${domain}.semantic.check`,
      kind: domain === "issue" ? "issue" : "pull_request",
      number,
      effectiveContract,
      artifact,
      desired: desiredResult.projection,
      observed: observedResult.projection,
      diagnostics: comparison.diagnostics,
      drift: comparison.drift,
      ...(observationDiagnostics.length === 0 ? {} : { observationDiagnostics }),
    }),
  );
  return comparison.valid ? 0 : EXIT_VALIDATION;
}

async function runSemanticBranchObservationCommand(
  command: string | undefined,
  rest: readonly string[],
  parsed: ParsedArgs,
  root: string,
  dependencies: CliDependencies,
): Promise<number> {
  const branchCheck =
    command === "check" ? rest : command === "semantic" && rest[0] === "check" ? rest.slice(1) : undefined;
  if (branchCheck === undefined) {
    throw new CliError("UNKNOWN_COMMAND", `Unknown branch command "${command ?? ""}".`);
  }
  if (branchCheck.length !== 1) throw new CliError("INVALID_BRANCH_NAME", "Branch name is required.", "$argv[2]");
  const branchName = branchCheck[0];
  const operation = command === "check" ? "branch.check" : "branch.semantic.check";
  if (branchName.length === 0 || branchName.length > 512 || /[\u0000-\u001F\u007F]/u.test(branchName)) {
    throw new CliError("INVALID_BRANCH_NAME", "Branch name is invalid.", "$argv[2]");
  }
  const unsupported = Object.keys(parsed.options).find(
    (key) => !["json", "template", "repository", "from"].includes(key),
  );
  if (unsupported !== undefined) {
    const option = getOption(unsupported as OptionId);
    throw new CliError(
      "INVALID_OPTION",
      `Option ${option.aliases[0] ?? `--${option.key}`} is not supported by semantic Branch check.`,
      "$argv",
    );
  }
  if (parsed.capabilities.length > 0 || parsed.fields.length > 0) {
    throw new CliError("INVALID_OPTION", "Semantic Branch check does not accept capability or field input.", "$argv");
  }
  const input = await readJsonValue(parsed.options.from);
  const adapter = createAdapter(dependencies, root, parsed.options.repository);
  const effectiveContract = await compileRepositoryEffectiveBranchContract(
    adapter,
    templateSelector(parsed, undefined),
  );
  const materialization = tryMaterializeSemanticArtifact(effectiveContract, input);
  if (!materialization.valid || materialization.artifact === undefined) {
    console.log(
      JSON.stringify(
        projectSemanticObservationFailure("materialization", materialization.violations, effectiveContract),
      ),
    );
    return EXIT_VALIDATION;
  }
  const artifact = materialization.artifact;
  const desiredResult = tryProjectSemanticBranch({ artifact });
  if (!desiredResult.valid || desiredResult.projection === undefined) {
    console.log(
      JSON.stringify(
        projectSemanticObservationFailure("projection", desiredResult.violations, effectiveContract, artifact),
      ),
    );
    return EXIT_VALIDATION;
  }
  const branch = await adapter.findBranch(branchName);
  const observedResult =
    branch === undefined
      ? tryObserveSemanticBranch(undefined)
      : tryObserveSemanticBranch({
          ref: { ref: branch.ref, object: { type: "commit", sha: branch.sha } },
          source: desiredResult.projection.source,
          generation: effectiveContract.generation,
        });
  if (!observedResult.valid || observedResult.projection === undefined) {
    console.log(
      JSON.stringify({
        ...projectSemanticObservationFailure(
          "observation",
          observedResult.violations,
          effectiveContract,
          artifact,
          desiredResult.projection,
        ),
        operation,
        kind: "branch",
        branch: branchName,
      }),
    );
    return EXIT_VALIDATION;
  }
  const comparison = compareSemanticBranchProjection(desiredResult.projection, observedResult.projection);
  console.log(
    JSON.stringify({
      ok: comparison.valid,
      valid: comparison.valid,
      operation,
      kind: "branch",
      branch: branchName,
      effectiveContract,
      artifact,
      desired: desiredResult.projection,
      observed: observedResult.projection,
      diagnostics: comparison.diagnostics,
      drift: comparison.drift,
    }),
  );
  return comparison.valid ? 0 : EXIT_VALIDATION;
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
  const assessment = assessExistingArtifact(domain, read);
  const projection = projectExistingArtifact(result);
  const output = {
    valid: projection.valid,
    classification: projection.classification,
    status: assessment.status,
    normalizable: assessment.normalizable,
    recovery: projectRemediationRouting(domain, read, assessment),
    number,
    url: remote.url,
    diagnostics: projection.diagnostics,
    ...(projection.violations === undefined ? {} : { violations: projection.violations }),
    ...(projection.dependencies === undefined ? {} : { dependencies: projection.dependencies }),
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
    ...(projection.dependencies === undefined ? {} : { dependencies: projection.dependencies }),
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
  rejectUnsupportedRemediationMetadata(domain, operation, parsed.options);
  rejectGovernedPolicyOverride(parsed.options.policy);
  const adapter = createAdapter(dependencies, root, parsed.options.repository);
  await adapter.resolveRepositoryContext();
  const read = await readGovernedExistingArtifact(adapter, domain, number, templateSelector(parsed, undefined));
  const assessment = assessExistingArtifact(domain, read);
  const disposableMarker = domain === "issue" ? projectSelfDogfoodIssueMarker(read.remote.body) : undefined;
  const base = {
    operation,
    kind: domain === "issue" ? "issue" : "pull_request",
    number: read.remote.number,
    url: read.remote.url,
    ...(read.contract === undefined ? {} : { template: read.contract.templateIdentity }),
    ...(disposableMarker === undefined ? {} : { disposableMarker }),
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
        recovery: projectRemediationRouting(domain, read, assessment),
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
    if (operation === "edit" || operation === "normalize" || operation === "sync") {
      throw translateRemediationFailure(domain, operation, read, error);
    }
    throw error;
  }

  let desired: ReturnType<typeof prepareRemediationArtifact>;
  try {
    desired = prepareRemediationArtifact(domain, read.contract, desiredInput);
  } catch (error: unknown) {
    if (operation === "edit" || operation === "normalize" || operation === "sync") {
      throw translateRemediationFailure(domain, operation, read, error, desiredInput);
    }
    throw error;
  }
  const diff = diffArtifact(domain, read, desired, operation === "sync");
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
  const loaded = loadCanonicalArtifact(contract, input);
  const fields = loaded.canonical;
  if (domain === "issue") {
    const issue = artifact as ValidatedRenderedIssueArtifact;
    return {
      fields,
      metadata: {
        title: issue.title,
        ...(issue.labels === undefined ? {} : { labels: issue.labels }),
        ...(issue.assignees === undefined ? {} : { assignees: issue.assignees }),
      },
      ...(loaded.dependencies === undefined ? {} : { dependencies: loaded.dependencies }),
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
  return parser(await readJsonValue(value));
}

/** Read one bounded JSON value without adapting its shape for Core. */
async function readJsonValue(value: string | boolean | undefined, optionFlag = "--from"): Promise<unknown> {
  if (typeof value !== "string" || value.length === 0)
    throw new CliError("INPUT_REQUIRED", `Use ${optionFlag} <file.json>.`, optionFlag);
  let source: string;
  if (value === "-") source = await readStdin();
  else {
    try {
      const handle = await open(value, "r");
      try {
        const stats = await handle.stat();
        if (stats.size > MAX_INPUT_BYTES) throw inputTooLargeError(stats.size);
        source = await handle.readFile("utf8");
        if (Buffer.byteLength(source, "utf8") > MAX_INPUT_BYTES)
          throw inputTooLargeError(Buffer.byteLength(source, "utf8"));
      } finally {
        await handle.close();
      }
    } catch (cause: unknown) {
      if (cause instanceof CliError) throw cause;
      // Execution-evidence input is post-authorization runtime evidence, not
      // an authored path the caller chose to disclose; the file path itself
      // must never surface in error output.
      const message =
        optionFlag === "--execution-evidence"
          ? "Cannot read the execution-evidence input file."
          : `Cannot read input file "${value}".`;
      const error = new CliError("INPUT_READ_FAILED", message, optionFlag);
      if (cause instanceof Error) error.cause = cause;
      throw error;
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (cause: unknown) {
    const error = new CliError("INPUT_INVALID_JSON", "Input file must contain valid JSON.", optionFlag);
    if (cause instanceof Error) error.cause = cause;
    throw error;
  }
  return parsed;
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
  return {
    fields: document.fields,
    metadata,
    ...(document.dependencies === undefined ? {} : { dependencies: document.dependencies }),
  };
}

function hasEditMetadataOption(options: Readonly<Record<string, string | boolean>>): boolean {
  return METADATA_OPTION_KEYS.some((key) => Object.prototype.hasOwnProperty.call(options, key));
}

function rejectUnsupportedRemediationMetadata(
  domain: "issue" | "pr",
  operation: "check" | "edit" | "normalize" | "sync",
  options: Readonly<Record<string, string | boolean>>,
): void {
  if (operation === "edit") return;
  const supplied = METADATA_OPTION_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(options, key));
  if (supplied.length === 0) return;
  const flags = supplied.map((key) => (key === "maintainerCanModify" ? "--maintainer-can-modify" : `--${key}`));
  const label = flags.length === 1 ? "flag" : "flags";
  const verb = flags.length === 1 ? "is" : "are";
  const guidance =
    operation === "sync"
      ? "use the documented --from input contract for metadata changes"
      : "this remediation command does not accept metadata mutation flags";
  throw new CliError(
    "METADATA_UNSUPPORTED_COMMAND",
    `${flags.join(", ")} ${label} ${verb} not accepted by ${domain} ${operation}; ${guidance}.`,
    `$.metadata.${supplied[0]}`,
    {
      command: `${domain} ${operation}`,
      metadata: supplied,
      flags,
    },
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
  if (domain !== "issue" && domain !== "pr") return false;
  const definition = getCommandForPositionals([domain, command ?? ""]);
  return definition?.optionIds.includes("field") === true;
}

function fieldUnsupportedCommandError(positionals: readonly string[]): CliError {
  const label = positionals.length === 0 ? "this command" : `"${positionals.join(" ")}"`;
  const supported = getDomainCommands("issue")
    .filter((entry) => entry.optionIds.includes("field"))
    .map((entry) => entry.operation)
    .sort(compareStrings);
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
  return contract.sections
    .flatMap((section) => section.fields)
    .sort((left, right) => compareStrings(left.id, right.id))
    .map((field) => {
      const repeatable = field.type === "array" || field.type === "checklist";
      const required = effectiveFieldConstraints(contract, field).required;
      return {
        name: field.id,
        type: repeatable ? "array" : "string",
        required,
        repeatable,
        cliSyntax:
          field.type === "checklist"
            ? `--field ${field.id}=<option-id> (repeatable)`
            : repeatable
              ? `--field ${field.id}=<value> (repeatable)`
              : `--field ${field.id}=<value>`,
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
  return {
    fields: { ...document.fields, ...directFields },
    metadata: document.metadata,
    ...(document.dependencies === undefined ? {} : { dependencies: document.dependencies }),
  };
}

/**
 * Resolve one artifact input document from the input modes exposed by the
 * selected command, sharing the same candidate/normalization/validation path
 * regardless of source. At least one input source is required; when both are
 * present, `--from` supplies the base document and direct fields are merged
 * in under a conflict rule that never depends on which flag appeared first in
 * argv.
 */
async function resolveArtifactInputDocument(
  parsed: ParsedArgs,
  contract: CanonicalContract,
  requirePullRequestSyncInput = false,
  allowEmpty = false,
): Promise<ArtifactInputDocument> {
  const hasFrom = typeof parsed.options.from === "string";
  if (!hasFrom && parsed.fields.length === 0 && !allowEmpty) {
    throw new CliError(
      "INPUT_REQUIRED",
      requirePullRequestSyncInput ? "Use --from <file.json>." : "Use --from <file.json> or --field <name>=<value>.",
      "--from",
    );
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
  const options: Record<string, string | boolean> = {};
  const fields: RawFieldEntry[] = [];
  const capabilities: string[] = [];
  const tokenized = tokenizeCommandArgv(argv);
  for (const occurrence of tokenized.options) {
    const option = occurrence.definition;
    if (option === undefined) {
      if (occurrence.rawName.startsWith("--")) {
        throw new CliError("INVALID_OPTION", `Unknown option ${occurrence.rawName}.`);
      }
      throw new CliError("INVALID_OPTION", `Unknown option ${occurrence.rawName}.`);
    }
    if (
      option.id === "rawBody" &&
      !(
        tokenized.positionals[0] === "pr" &&
        (tokenized.positionals[1] === "comment" || tokenized.positionals[1] === "review")
      )
    )
      throw new CliError("INVALID_OPTION", `Unknown option ${occurrence.rawName}.`);
    if (option.arity === "required" && occurrence.value === undefined) {
      throw new CliError("INVALID_OPTION", `Option ${occurrence.rawName} requires a value.`);
    }
    if (option.id === "help") {
      if (occurrence.value === undefined) {
        options.help = true;
        continue;
      }
      if (occurrence.value !== "full" && occurrence.value !== "json")
        throw new CliError("INVALID_OPTION", `Option ${occurrence.rawName} accepts only full or json.`);
      options.help = occurrence.value;
      continue;
    }
    if (option.id === "field") {
      const raw = occurrence.value;
      if (raw === undefined) throw new CliError("INVALID_OPTION", "Option --field requires a value.");
      const separatorIndex = raw.indexOf("=");
      if (separatorIndex <= 0)
        throw new CliError("INVALID_OPTION", 'Option --field requires "<name>=<value>" syntax.', "--field");
      fields.push({ name: raw.slice(0, separatorIndex), value: raw.slice(separatorIndex + 1) });
      continue;
    }
    if (option.id === "capability") {
      const capability = occurrence.value;
      if (capability === undefined || capability.length === 0)
        throw new CliError("INVALID_OPTION", `Option ${occurrence.rawName} requires a value.`);
      capabilities.push(capability);
      continue;
    }
    const key = option.id;
    if (option.valueType === "boolean") {
      if (occurrence.value === undefined) {
        options[key] = true;
        continue;
      }
      if (occurrence.value !== "true" && occurrence.value !== "false")
        throw new CliError("INVALID_OPTION", `Option ${occurrence.rawName} must be true or false.`);
      options[key] = occurrence.value === "true";
      continue;
    }
    if (occurrence.value === undefined || occurrence.value.length === 0)
      throw new CliError("INVALID_OPTION", `Option ${occurrence.rawName} requires a value.`);
    options[key] = occurrence.value;
  }
  return { positionals: tokenized.positionals, options, fields, capabilities };
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
      ...(Array.isArray(error.diagnostics) ? { diagnostics: error.diagnostics } : {}),
      ...(typeof error.evidence === "object" && error.evidence !== null ? { evidence: error.evidence } : {}),
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
      error.code === "FIELD_UNSUPPORTED_COMMAND" ||
      error.code === "METADATA_UNSUPPORTED_COMMAND" ||
      error.code === "GOVERNED_CREATE_OPTION")
  )
    return EXIT_USAGE;
  if (
    error instanceof CliError &&
    (error.code === "INPUT_INVALID_JSON" ||
      error.code === "INPUT_TOO_LARGE" ||
      error.code === "INVALID_ARTIFACT_NUMBER" ||
      error.code === "INVALID_CHANGE_NUMBER" ||
      error.code === "UNKNOWN_SKILL_SCENARIO" ||
      error.code === "SKILL_OUTPUT_EXCEEDS_BUDGET" ||
      error.code === "FIELD_UNKNOWN" ||
      error.code === "FIELD_DUPLICATE" ||
      error.code === "FIELD_CONFLICT")
  )
    return EXIT_VALIDATION;
  if (isObjectWithCode(error) && error.code === "GOVERNANCE_POLICY_OVERRIDE_FORBIDDEN") return EXIT_VALIDATION;
  if (isObjectWithCode(error) && error.code.startsWith("ARTIFACT_CONTRACT_")) return EXIT_VALIDATION;
  if (isObjectWithCode(error) && error.code.startsWith("CHANGE_REMOTE_")) return EXIT_REMOTE;
  if (isObjectWithCode(error) && error.code.startsWith("CHANGE_EXECUTION_")) return EXIT_REMOTE;
  if (
    isObjectWithCode(error) &&
    (error.code === "SEMANTIC_PR_EXECUTION_EFFECT_FAILED" || error.code === "SEMANTIC_PR_EXECUTION_READ_FAILED")
  )
    return EXIT_REMOTE;
  if (isObjectWithCode(error) && error.code.startsWith("SEMANTIC_PR_EXECUTION_")) return EXIT_VALIDATION;
  if (isObjectWithCode(error) && error.code.startsWith("CHANGE_")) return EXIT_VALIDATION;
  if (
    isObjectWithCode(error) &&
    (error.code.startsWith("SESSION_BUNDLE_") ||
      error.code.startsWith("SESSION_CERTIFICATE_") ||
      error.code.startsWith("SESSION_BOOTSTRAP_") ||
      error.code.startsWith("MANAGED_SESSION_"))
  )
    return EXIT_VALIDATION;
  if (
    isObjectWithCode(error) &&
    (error.code === "SESSION_CREDENTIAL_INVALID" ||
      error.code === "APP_ENDPOINT_INVALID" ||
      error.code === "APP_REQUEST_TOO_LARGE" ||
      error.code.startsWith("PUBLISH_PROJECTION_"))
  )
    return EXIT_VALIDATION;
  if (
    isObjectWithCode(error) &&
    (error.code === "APP_TRANSPORT_FAILED" ||
      error.code === "APP_EXECUTION_FAILED" ||
      error.code === "BRANCH_ADVANCE_REJECTED" ||
      error.code === "BRANCH_ADVANCE_TRANSPORT_FAILED")
  )
    return EXIT_REMOTE;
  if (isObjectWithCode(error) && error.code.startsWith("RUNTIME_AUTHORITY_KEY_")) return EXIT_VALIDATION;
  if (isObjectWithCode(error) && error.code.startsWith("RUNTIME_AUTHORITY_LIFECYCLE_")) return EXIT_VALIDATION;
  if (isObjectWithCode(error) && error.code.startsWith("IMPLEMENTATION_")) return EXIT_VALIDATION;
  if (isObjectWithCode(error) && error.code.startsWith("GOVERNANCE_")) return EXIT_REMOTE;
  if (isObjectWithCode(error) && /^(?:ISSUE_FORM|PR_TEMPLATE|IR_|CONTRACT_)/u.test(error.code)) return EXIT_VALIDATION;
  return EXIT_INTERNAL;
}

/**
 * True when argv targets a command Inari implements; false means it must fall
 * back to the real `gh` binary. The same tokenizer is used by parseArguments,
 * so supported option values cannot become routing positionals.
 */
function isOwnedInvocation(argv: readonly string[]): boolean {
  const { positionals } = tokenizeCommandArgv(argv);
  const first = positionals[0];
  if (first === undefined) return true;
  if (first === "diagnose" || first === "doctor" || first === "version" || first === "help") return true;
  if (first === "skill") return true;
  if (argv.includes("--version") || argv.includes("--diagnose") || argv.includes("--doctor")) return true;
  const helpRequested = argv.some((token) => token === "--help" || token.startsWith("--help="));
  if (
    helpRequested &&
    (first === "issue" ||
      first === "pr" ||
      first === "impl" ||
      first === "branch" ||
      first === "template" ||
      first === "change" ||
      first === "authority" ||
      first === "session" ||
      first === "mcp") &&
    positionals.length === 1
  )
    return true;
  return getCommandForPositionals(positionals) !== undefined;
}

function isMachineCommand(positionals: readonly string[]): boolean {
  return getCommandForPositionals(positionals) !== undefined;
}

function isMachineCommandTokens(argv: readonly string[]): boolean {
  const { positionals } = tokenizeCommandArgv(argv);
  if (
    argv.includes("--diagnose") ||
    argv.includes("--doctor") ||
    positionals[0] === "diagnose" ||
    positionals[0] === "doctor"
  )
    return true;
  if (positionals[0] === "version") return argv.includes("--json");
  return positionals[0] === "skill" || getCommandForPositionals(positionals) !== undefined;
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
  evidence?: unknown;
} {
  return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string";
}

// The precompiled `gh` extension executable (scripts/build-gh-extension-release.sh)
// bundles this module standalone with no sibling package.json on disk, so its
// build step injects this constant via esbuild `--define`. The npm/dist build
// leaves it undefined and this falls back to reading the real package.json.
declare const __GH_INARI_EMBEDDED_METADATA__: PackageMetadata | undefined;

function readPackageMetadata(): PackageMetadata {
  if (typeof __GH_INARI_EMBEDDED_METADATA__ !== "undefined") {
    return __GH_INARI_EMBEDDED_METADATA__;
  }
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

const DOMAIN_PASSTHROUGH_EXAMPLE: Readonly<
  Record<"issue" | "pr" | "impl" | "branch" | "template" | "change" | "authority" | "session" | "mcp", string>
> = {
  issue: "issue list",
  pr: "pr checks",
  impl: "impl show",
  branch: "branch list",
  template: "template view",
  change: "change list",
  authority: "authority generate",
  session: "session issue",
  mcp: "mcp serve",
};

/** Dispatches to root, domain, or leaf help from the canonical command model. */
function printHelpFor(positionals: readonly string[], helpValue: string | boolean | undefined): void {
  if (helpValue === "json") return console.log(JSON.stringify(projectCommandHelp(positionals)));
  if (helpValue === "full") return printFullHelp();
  const [domain, command] = positionals;
  if (
    domain === "issue" ||
    domain === "pr" ||
    domain === "impl" ||
    domain === "branch" ||
    domain === "change" ||
    domain === "authority" ||
    domain === "session" ||
    domain === "mcp"
  ) {
    const definition = command === undefined ? undefined : getCommandForPositionals(positionals);
    if (definition !== undefined && definition.domain === domain) return printLeafHelp(definition);
    return printDomainHelp(domain);
  }
  if (domain === "template") {
    const definition = command === undefined ? undefined : getCommandForPositionals([domain, command]);
    if (definition !== undefined && definition.domain === domain) return printLeafHelp(definition);
    return printDomainHelp("template");
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
  impl       Canonical Implementation planning, validation, and authorization
  branch     Semantic Branch observation and drift checks
  template   Semantic template authoring and native template sync
  change     Semantic Change projection and authoritative lifecycle requests
  authority  Local Runtime Authority key, bootstrap, readiness, and lifecycle operations
  session    Manual short-lived Session credential issuance and inspection
  mcp        Native semantic MCP server over local stdio
  skill      Bounded operational playbooks for common governed workflows

All other commands (e.g. repo, auth, pr list, issue view) are passed through to gh.

Run \`inari <domain> --help\` for that domain's operations.
Run \`inari --help=full\` for the complete command and option reference.
Run \`inari --version\` or \`inari --diagnose\` for machine-readable runtime checks.`);
}

function printDomainHelp(
  domain: "issue" | "pr" | "impl" | "branch" | "template" | "change" | "authority" | "session" | "mcp",
): void {
  const lines = getDomainCommands(domain).map((entry) => `  ${commandUsage(entry)}`);
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
    console.log(`Usage: ${commandInvocation("skill.scenario")} ${scenario.id} --help

${scenario.title}

Run \`${scenario.canonicalEntrypoint}\` for the playbook.`);
    return;
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

function printLeafHelp(command: CommandDefinition): void {
  const options = command.optionIds
    .filter((id) => id !== "help" && id !== "json")
    .map((id) => `  ${optionSyntax(getOption(id))}  ${getOption(id).description}`)
    .join("\n");
  console.log(`Usage: inari ${commandUsage(command)}

${leafSummary(command)}

Example:
  ${commandExample(command.id)}

Options:
${options}

Run \`inari --help=full\` for the complete option reference.`);
}

function printFullHelp(): void {
  const commands = INARI_COMMANDS.filter((entry) => entry.domain !== "root" && entry.domain !== "skill")
    .map((entry) => `  ${commandUsage(entry)}`)
    .join("\n");
  const options = Object.values(COMMAND_OPTIONS)
    .map((option) => `  ${optionSyntax(option)}  ${option.description}`)
    .join("\n");
  console.log(`Usage: inari <command> [options]

Commands:
${commands}
  skill [scenario] [--json]

Options:
${options}

Create always validates and renders before invoking gh. Schema, validate, render, check, and --dry-run remediation never mutate GitHub.
Edit is the primary patch path: it preserves omitted fields and metadata, validates the complete result, and renders canonical Markdown before mutation. Normalize preserves existing semantic values; issue sync preserves omitted current values; pr sync reconciles a complete desired semantic state.
Change commands request semantic lifecycle operations through the configured remote executor; transport and privileged credentials are not CLI inputs. Existing issue/pr artifact commands remain available as migration-compatible direct mutation paths.

All other commands pass through to the real gh binary unchanged.

Canonical invocation: inari
Compatibility invocation: gh inari
Canonical install: npm install --global gh-inari
PATH-independent fallback: npx --yes gh-inari
Extension compatibility path: gh extension install yohn-jp/gh-inari`);
}

function leafSummary(command: CommandDefinition): string {
  if (command.id === "pr.sync") return `${command.summary} ${renderPullRequestSyncInputHelp()}`;
  if (command.id === "issue.validate" || command.id === "pr.validate") {
    const noun = command.domain === "issue" ? "issue" : "pull request";
    return `${command.summary} Run \`${command.domain} schema\` for its contract-derived directFields projection; existing ${noun} validation uses a positive number.`;
  }
  if (command.id === "issue.schema" || command.id === "pr.schema") {
    const noun = command.domain === "issue" ? "issue" : "pull request";
    return `${command.summary} Dynamic --field names, types, requiredness, and checklist option IDs come from the selected ${noun} artifact contract.`;
  }
  return command.summary;
}
