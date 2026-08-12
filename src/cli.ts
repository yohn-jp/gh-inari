import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ArtifactInputError,
  parseArtifactInputDocument,
  prepareIssueArtifact,
  preparePullRequestArtifact,
  projectExistingArtifact,
  renderIssueArtifact,
  renderPullRequestArtifact,
  selectExistingArtifactCandidate,
  validateExistingIssueArtifact,
  validateExistingPullRequestArtifact,
  type ArtifactInputDocument,
  type ExistingArtifactValidationResult,
} from "./artifact.js";
import {
  projectContract,
  type CanonicalContract,
  SemanticValidationError,
  validateSemanticInput,
} from "./contract/index.js";
import { GitHubAdapter, isGitHubAdapterError } from "./github/index.js";
import {
  compileLocalGovernedContract,
  compileRepositoryGovernedContract,
  compileRepositoryGovernedContracts,
  createGovernedIssue,
  createGovernedPullRequest,
  discoverRepositoryTemplates,
  rejectGovernedPolicyOverride,
} from "./governance.js";
import { discoverTemplates, type TemplateSelector } from "./template-discovery.js";
import type { GitHubIssue, GitHubPullRequest } from "./github/types.js";

const EXIT_USAGE = 1;
const EXIT_VALIDATION = 2;
const EXIT_REMOTE = 3;
const EXIT_INTERNAL = 4;

interface PackageMetadata {
  readonly name: string;
  readonly version: string;
  readonly description: string;
}

export interface CliDependencies {
  readonly repositoryRoot?: string;
  readonly createAdapter?: (options: ConstructorParameters<typeof GitHubAdapter>[0]) => GitHubAdapter;
  readonly packageMetadata?: PackageMetadata;
}

const BOOLEAN_OPTIONS = new Set(["help", "json", "version", "draft", "maintainerCanModify"]);
const VALUE_OPTIONS = new Set(["from", "template", "policy", "repository", "title", "head", "base"]);

interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, string | boolean>>;
}

interface CliErrorShape {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly details?: unknown;
  readonly violations?: unknown;
}

/** The installed gh-inari executable entrypoint. */
export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const metadata = dependencies.packageMetadata ?? readPackageMetadata();
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
  if (parsed.options.help === true || (parsed.positionals.length === 0 && parsed.options.version !== true)) {
    printHelp();
    return parsed.positionals.length === 0 && parsed.options.help !== true ? EXIT_USAGE : 0;
  }
  if (parsed.options.version === true) {
    console.log(`${metadata.name} ${metadata.version}`);
    return 0;
  }

  const root = path.resolve(dependencies.repositoryRoot ?? process.cwd());
  const json = parsed.options.json === true;
  try {
    const [domain, command, ...rest] = parsed.positionals;
    if (domain === "template" && command === "list") {
      return await runTemplateList(root, parsed.options.repository, dependencies);
    }
    if (domain === "issue" || domain === "pr") {
      return await runArtifactCommand(domain, command, rest, parsed, root, dependencies, json);
    }
    throw new CliError("UNKNOWN_COMMAND", `Unknown command "${parsed.positionals.join(" ")}".`);
  } catch (error: unknown) {
    const shape = toErrorShape(error);
    if (json || isMachineCommand(parsed.positionals)) console.log(JSON.stringify({ ok: false, error: shape }));
    else console.error(`${shape.code}: ${shape.message}`);
    return classifyExitCode(error);
  }
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
  console.log(JSON.stringify({ templates: discovery.templates }));
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
    console.log(JSON.stringify({ contract, template: contract.templateIdentity, ...projection }));
    return 0;
  }
  if (command === "validate" || command === "render" || command === "create") {
    if (
      command === "validate" &&
      rest[0] !== undefined &&
      isPositiveInteger(rest[0]) &&
      parsed.options.from === undefined
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
      const document = await readInputDocument(parsed.options.from);
      const preparedDocument = mergeOptionMetadata(document, parsed.options);
      if (command === "validate") {
        const validation = validateSemanticInput(contract, preparedDocument.fields);
        console.log(
          JSON.stringify({ valid: validation.valid, violations: validation.violations, values: validation.values }),
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
    const document = await readInputDocument(parsed.options.from);
    const preparedDocument = mergeOptionMetadata(document, parsed.options);
    const adapter = createAdapter(dependencies, root, parsed.options.repository);
    await adapter.resolveRepositoryContext();
    const contract = await compileRepositoryGovernedContract(adapter, domain, templateSelector(parsed, rest[0]));
    if (domain === "issue") {
      const prepared = prepareIssueArtifact(contract, preparedDocument);
      const created = await createGovernedIssue(adapter, prepared.artifact);
      console.log(JSON.stringify({ ok: true, artifact: created }));
      return 0;
    }
    const prepared = preparePullRequestArtifact(contract, preparedDocument);
    const created = await createGovernedPullRequest(adapter, prepared.artifact);
    console.log(JSON.stringify({ ok: true, artifact: created }));
    return 0;
  }
  if (
    (command === "validate" || command === "explain") &&
    rest[0] !== undefined &&
    isPositiveInteger(rest[0]) &&
    parsed.options.from === undefined
  ) {
    return runExistingValidation(domain, Number(rest[0]), parsed, root, dependencies, true);
  }
  if (command === "get" && rest[0] !== undefined && isPositiveInteger(rest[0])) {
    return runExistingGet(domain, Number(rest[0]), parsed, root, dependencies);
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
  const read = await readExistingArtifact(domain, number, parsed, root, dependencies);
  const { remote, result } = read;
  const projection = projectExistingArtifact(result);
  const output = {
    valid: projection.valid,
    classification: projection.classification,
    number,
    url: remote.url,
    diagnostics: projection.diagnostics,
    violations: projection.violations,
  };
  console.log(JSON.stringify(output));
  return result.valid ? 0 : EXIT_VALIDATION;
}

interface ExistingArtifactRead {
  readonly remote: GitHubIssue | GitHubPullRequest;
  readonly contract?: CanonicalContract;
  readonly result: ExistingArtifactValidationResult;
}

async function runExistingGet(
  domain: "issue" | "pr",
  number: number,
  parsed: ParsedArgs,
  root: string,
  dependencies: CliDependencies,
): Promise<number> {
  rejectGovernedPolicyOverride(parsed.options.policy);
  const { remote, contract, result } = await readExistingArtifact(domain, number, parsed, root, dependencies);
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
    violations: projection.violations,
  };
  console.log(JSON.stringify(output));
  return result.valid ? 0 : EXIT_VALIDATION;
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
  };
}

async function readExistingArtifact(
  domain: "issue" | "pr",
  number: number,
  parsed: ParsedArgs,
  root: string,
  dependencies: CliDependencies,
): Promise<ExistingArtifactRead> {
  const adapter = createAdapter(dependencies, root, parsed.options.repository);
  await adapter.resolveRepositoryContext();
  const selector = templateSelector(parsed, undefined);
  const contracts =
    selector === undefined
      ? await compileRepositoryGovernedContracts(adapter, domain)
      : [await compileRepositoryGovernedContract(adapter, domain, selector)];
  const remote = domain === "issue" ? await adapter.getIssue(number) : await adapter.getPullRequest(number);
  const candidates = contracts.map((contract) => ({
    contract,
    result:
      domain === "issue"
        ? validateExistingIssueArtifact(contract, remote.body)
        : validateExistingPullRequestArtifact(contract, remote.body),
  }));
  const selected = selectExistingArtifactCandidate(candidates);
  return { remote, contract: selected.contract, result: selected.result };
}

function createAdapter(
  dependencies: CliDependencies,
  root: string,
  repository: string | boolean | undefined,
): GitHubAdapter {
  const factory = dependencies.createAdapter ?? ((options) => new GitHubAdapter(options));
  return factory({ cwd: root, ...(typeof repository === "string" ? { repository } : {}) });
}

async function readInputDocument(value: string | boolean | undefined): Promise<ArtifactInputDocument> {
  if (typeof value !== "string" || value.length === 0)
    throw new CliError("INPUT_REQUIRED", "Use --from <file.json>.", "--from");
  let source: string;
  if (value === "-") source = await readStdin();
  else {
    try {
      source = await readFile(value, "utf8");
    } catch (cause: unknown) {
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
  return parseArtifactInputDocument(parsed);
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

function templateSelector(parsed: ParsedArgs, positional: string | undefined): string | undefined {
  return typeof parsed.options.template === "string" ? parsed.options.template : positional;
}

function parseArguments(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equalIndex = token.indexOf("=");
    const rawKey = equalIndex >= 0 ? token.slice(2, equalIndex) : token.slice(2);
    const key = rawKey.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
    if (BOOLEAN_OPTIONS.has(key)) {
      if (equalIndex < 0) {
        options[key] = true;
        continue;
      }
      const booleanValue = token.slice(equalIndex + 1);
      if (booleanValue !== "true" && booleanValue !== "false")
        throw new CliError("INVALID_OPTION", `Option --${rawKey} must be true or false.`);
      options[key] = booleanValue === "true";
      continue;
    }
    if (!VALUE_OPTIONS.has(key)) throw new CliError("INVALID_OPTION", `Unknown option --${rawKey}.`);
    const value = equalIndex >= 0 ? token.slice(equalIndex + 1) : argv[++index];
    if (value === undefined || (equalIndex < 0 && value.startsWith("--")))
      throw new CliError("INVALID_OPTION", `Option --${rawKey} requires a value.`);
    options[key] = value;
  }
  return { positionals, options };
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
    return { code: "SEMANTIC_VALIDATION_FAILED", message: error.message, violations: error.violations };
  if (error instanceof ArtifactInputError) return { code: error.code, message: error.message, path: error.path };
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
  if (error instanceof SemanticValidationError || error instanceof ArtifactInputError) return EXIT_VALIDATION;
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
      error.code === "INPUT_READ_FAILED")
  )
    return EXIT_USAGE;
  if (error instanceof CliError && error.code === "INPUT_INVALID_JSON") return EXIT_VALIDATION;
  if (isObjectWithCode(error) && error.code === "GOVERNANCE_POLICY_OVERRIDE_FORBIDDEN") return EXIT_VALIDATION;
  if (isObjectWithCode(error) && error.code.startsWith("GOVERNANCE_")) return EXIT_REMOTE;
  if (isObjectWithCode(error) && /^(?:ISSUE_FORM|PR_TEMPLATE|IR_|CONTRACT_)/u.test(error.code)) return EXIT_VALIDATION;
  return EXIT_INTERNAL;
}

function isMachineCommand(positionals: readonly string[]): boolean {
  return (
    positionals.length >= 2 &&
    (positionals[1] === "schema" ||
      positionals[1] === "validate" ||
      positionals[1] === "render" ||
      positionals[1] === "create" ||
      positionals[1] === "explain" ||
      positionals[1] === "get")
  );
}

function isMachineCommandTokens(argv: readonly string[]): boolean {
  const domainIndex = argv.findIndex((token) => token === "issue" || token === "pr");
  if (domainIndex < 0) return false;
  const command = argv[domainIndex + 1];
  return (
    command === "schema" ||
    command === "validate" ||
    command === "render" ||
    command === "create" ||
    command === "explain" ||
    command === "get"
  );
}

function isPositiveInteger(value: string): boolean {
  return /^[1-9]\d*$/u.test(value);
}

function isObjectWithCode(
  value: unknown,
): value is { code: string; message?: unknown; path?: unknown; details?: unknown; violations?: unknown } {
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
  const chunks: string[] = [];
  const reader = createInterface({ input: process.stdin });
  for await (const line of reader) chunks.push(line);
  return chunks.join("\n");
}

function printHelp(): void {
  console.log(`Usage: gh-inari <command> [options]

Commands:
  template list
  issue schema [template]
  issue validate --template <template> --from <file.json>
  issue render --template <template> --from <file.json>
  issue create --template <template> --from <file.json>
  issue validate <number> [--template <template>]
  issue explain <number> [--template <template>]
  issue get <number> [--template <template>] --json
  pr schema [template]
  pr validate --template <template> --from <file.json>
  pr render --template <template> --from <file.json>
  pr create --template <template> --from <file.json>
  pr validate <number> [--template <template>]
  pr explain <number> [--template <template>]
  pr get <number> [--template <template>] --json

Options:
  --from <path>       JSON input file, or - for stdin
  --template <id>     Repository-native template id, path, or unique name
  --policy <path>     Local PR policy for schema/validate/render --from workflows; forbidden for governed remote operations
  --repository <r>    GitHub repository override; governed commands use its default-branch governance
  --title <title>     Issue/PR title for create
  --head <branch>     PR head branch for create
  --base <branch>     PR base branch for create
  --draft             Create the PR as a draft
  --maintainer-can-modify
                      Allow maintainer edits on the PR
  --json              Emit structured JSON output
  --version           Print package version
  --help              Print this help

Create always validates and renders before invoking gh. Schema, validate, and render never mutate GitHub.`);
}
