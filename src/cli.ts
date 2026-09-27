import { spawnSync } from "node:child_process";
import { cliFailure, jsonOutput, textOutput, type CliOutcome } from "@yohn-jp/cli-canon";
import { runNodeCli, type CliResult } from "@yohn-jp/cli-canon/node";
import packageJson from "../package.json" with { type: "json" };
import type { ProductPackageIdentity } from "@yohn-jp/cli-canon";
import {
  AGENT_INVOCATION_CONTRACT,
  getCommandForPositionals,
  getOptionForToken,
  tokenizeCommandArgv,
} from "./command-contract.js";
import { runCli as runCoreCli, versionAtLeast, type CliDependencies as CoreCliDependencies } from "./cli-core.js";
import {
  commandRequiredOptionIds,
  compileInariCliProduct,
  createLegacyDelegatedCommandSource,
} from "./cli-composition.js";
import type { ArtifactReconciliationResult } from "./artifact-reconciliation-executor.js";

interface DiagnosticCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

interface RuntimeProbeInfo {
  readonly version?: string;
  readonly commandContractVersion?: string;
  readonly capabilities?: readonly string[];
  readonly invocation?: { readonly canonical?: string };
}

interface CanonicalDiagnosticProjection {
  readonly invocation: string;
  readonly status: "ready" | "missing" | "stale" | "unavailable";
  readonly version?: string;
  readonly capabilities?: readonly string[];
  readonly missingCapabilities?: readonly string[];
  readonly detail?: string;
  readonly recovery: string;
}

export interface CliDependencies extends CoreCliDependencies {
  /** Test seam for probing the canonical standalone `inari` executable. */
  readonly runCanonicalDiagnosticCommand?: (args: readonly string[]) => DiagnosticCommandResult;
  /** Test seam for capturing the terminal result of the public Canon shell. */
  readonly writeResult?: (result: CliResult) => void;
}

/**
 * #1194 classifies --diagnose and --doctor as transition-only root aliases.
 * Route those existing product aliases through their named commands while the
 * named diagnose/doctor routes remain delegated to the product readiness code.
 */
function namedDiagnosticAliasArgv(argv: readonly string[]): readonly string[] {
  if (argv.some((token) => token === "--help" || token.startsWith("--help="))) return argv;
  const tokenized = tokenizeCommandArgv(argv);
  if (tokenized.positionals.length !== 0) return argv;
  if (tokenized.options.some((option) => option.definition?.id === "version")) return argv;

  const aliases = tokenized.options.filter(
    (option) =>
      (option.definition?.id === "diagnose" || option.definition?.id === "doctor") &&
      (option.value === undefined || option.value === "true"),
  );
  if (aliases.length === 0) return argv;

  const route = aliases.some((option) => option.definition?.id === "doctor") ? "doctor" : "diagnose";
  const aliasTokens = new Set(aliases.map((option) => option.rawToken));
  const aliasIndexes = new Set<number>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") break;
    if (token !== undefined && aliasTokens.has(token)) {
      aliasIndexes.add(index);
      continue;
    }
    const option = token === undefined ? undefined : getOptionForToken(token);
    if (
      option?.arity === "required" &&
      token?.includes("=") !== true &&
      argv[index + 1] !== undefined &&
      !argv[index + 1]!.startsWith("--")
    ) {
      index += 1;
    }
  }
  return [route, ...argv.filter((_token, index) => !aliasIndexes.has(index))];
}

/**
 * CLI Canon 0.2.0's delegated request carries only argv following the selected
 * route. Preserve the currently supported known option-before-route forms by
 * moving that complete option prefix after the contract-resolved route before
 * Canon claims the invocation. Unknown or incomplete prefixes are left to
 * Canon's normal fail-closed shell. Retire this transition when Canon can
 * forward and certify leading option occurrences for delegated routes.
 */
function routeFirstTransitionArgv(argv: readonly string[]): readonly string[] {
  if (
    argv.some((token) => {
      const name = token?.split("=", 1)[0];
      return name === "--help" || name === "-h" || name === "--version";
    })
  ) {
    return argv;
  }

  const tokenized = tokenizeCommandArgv(argv);
  const command = getCommandForPositionals(tokenized.positionals);
  if (command === undefined || command.path.length === 0) return argv;

  for (let index = 1; index + command.path.length <= argv.length; index += 1) {
    if (!command.path.every((segment, routeIndex) => argv[index + routeIndex] === segment)) continue;
    const prefix = argv.slice(0, index);
    const parsedPrefix = tokenizeCommandArgv(prefix);
    if (
      parsedPrefix.positionals.length !== 0 ||
      parsedPrefix.options.length === 0 ||
      parsedPrefix.options.some(
        (option) =>
          option.definition === undefined ||
          option.definition.id === "version" ||
          option.definition.id === "help" ||
          !command.optionIds.includes(option.definition.id) ||
          (option.definition.arity === "required" && option.value === undefined),
      )
    )
      continue;

    return [...command.path, ...prefix, ...argv.slice(index + command.path.length)];
  }
  return argv;
}

/**
 * CLI Canon 0.2 cannot parse product options before a command route. Preserve
 * only branch observation prefixes whose flags come from that compiled
 * command's fields; unknown, incomplete, duplicate, or ambiguous prefixes
 * stay in place for Canon to reject.
 */
function branchPrefixTransitionArgv(
  argv: readonly string[],
  product: ReturnType<typeof compileInariCliProduct>,
): readonly string[] | undefined {
  const branchCommands = product.commands.filter(
    (command) => command.id === "branch.check" || command.id === "branch.semantic.check",
  );
  const matches = branchCommands.flatMap((command) =>
    argv.flatMap((_token, index) =>
      command.route.every((segment, routeIndex) => argv[index + routeIndex] === segment) ? [{ command, index }] : [],
    ),
  );
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) return argv;
  const match = matches[0];
  if (match === undefined || match.index === 0) return argv;

  if (
    argv.includes("--") ||
    argv.some((token) => {
      const name = token?.split("=", 1)[0];
      return name === "--help" || name === "-h" || name === "--version";
    })
  ) {
    return argv;
  }

  const prefix = argv.slice(0, match.index);
  const flags = new Map<string, (typeof match.command.fields)[number]>();
  for (const field of match.command.fields) {
    if ((field.kind !== "option" && field.kind !== "flag") || field.flag === undefined) continue;
    for (const candidate of [field.flag, ...(field.aliases ?? [])]) {
      if (flags.has(candidate)) return argv;
      flags.set(candidate, field);
    }
  }

  const occurrences = new Map<string, number>();
  for (let index = 0; index < prefix.length; index += 1) {
    const token = prefix[index];
    if (token === undefined || !token.startsWith("-") || token === "-") return argv;
    const equals = token.indexOf("=");
    const flag = equals < 0 ? token : token.slice(0, equals);
    const field = flags.get(flag);
    if (field === undefined) return argv;
    const optionKey = field.key === "repositoryAlias" ? "repository" : field.key;
    const count = (occurrences.get(optionKey) ?? 0) + 1;
    if (count > 1 && field.repeatable !== true) return argv;
    occurrences.set(optionKey, count);

    if (field.kind === "flag") {
      if (equals >= 0) return argv;
      continue;
    }
    if (equals >= 0) continue;
    if (prefix[index + 1] === undefined) return argv;
    index += 1;
  }

  return [...match.command.route, ...prefix, ...argv.slice(match.index + match.command.route.length)];
}

/**
 * Canon 0.2 cannot own an executable command and child group at `setup`.
 * Keep only the validated root.setup invocation (including `setup --json`)
 * in the bounded legacy owner; Help and nested routes enter Canon. Retire
 * this when Canon can represent and certify executable parents with children.
 */
function isValidatedSetupParentTransition(argv: readonly string[]): boolean {
  if (
    argv.includes("--") ||
    argv.some((token) => {
      const name = token?.split("=", 1)[0];
      return name === "--help" || name === "-h" || name === "--version";
    })
  ) {
    return false;
  }

  const tokenized = tokenizeCommandArgv(argv);
  const command = getCommandForPositionals(tokenized.positionals);
  if (
    command?.id !== "root.setup" ||
    tokenized.positionals.length !== command.path.length ||
    !command.path.every((segment, index) => tokenized.positionals[index] === segment)
  ) {
    return false;
  }

  const applicableOptions = new Set<string>(command.optionIds);
  if (
    tokenized.options.some(
      (option) =>
        option.definition === undefined ||
        !applicableOptions.has(option.definition.id) ||
        (option.definition.arity === "required" && option.value === undefined),
    )
  ) {
    return false;
  }

  const presentOptions = new Set<string>(
    tokenized.options.flatMap((option) => (option.definition === undefined ? [] : [option.definition.id])),
  );
  return [...commandRequiredOptionIds(command)].every((optionId) => presentOptions.has(optionId));
}

function runCanonicalDiagnosticCommand(args: readonly string[]): DiagnosticCommandResult {
  try {
    const result = spawnSync(AGENT_INVOCATION_CONTRACT.canonical, [...args], {
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
      error: error instanceof Error ? error.message : "unable to execute inari",
    };
  }
}

function detailFrom(result: DiagnosticCommandResult): string | undefined {
  const detail = (result.error ?? result.stderr).trim().split(/\r?\n/u)[0];
  return detail === "" ? undefined : detail.slice(0, 240);
}

function projectCanonicalRuntime(
  result: DiagnosticCommandResult,
  expected: Record<string, unknown>,
): CanonicalDiagnosticProjection {
  const recovery = AGENT_INVOCATION_CONTRACT.fallback;
  if (result.status === null) {
    const detail = detailFrom(result);
    return {
      invocation: AGENT_INVOCATION_CONTRACT.canonical,
      status: detail?.includes("ENOENT") === true ? "missing" : "unavailable",
      ...(detail === undefined ? {} : { detail }),
      recovery,
    };
  }
  if (result.status !== 0) {
    const detail = detailFrom(result);
    return {
      invocation: AGENT_INVOCATION_CONTRACT.canonical,
      status: "stale",
      ...(detail === undefined ? {} : { detail }),
      recovery,
    };
  }

  let parsed: RuntimeProbeInfo;
  try {
    parsed = JSON.parse(result.stdout.trim()) as RuntimeProbeInfo;
  } catch {
    return {
      invocation: AGENT_INVOCATION_CONTRACT.canonical,
      status: "stale",
      detail: "the canonical inari executable does not support machine-readable version output",
      recovery,
    };
  }
  if (
    typeof parsed.version !== "string" ||
    !Array.isArray(parsed.capabilities) ||
    parsed.capabilities.some((capability) => typeof capability !== "string")
  ) {
    return {
      invocation: AGENT_INVOCATION_CONTRACT.canonical,
      status: "stale",
      detail: "the canonical inari executable returned an incompatible version contract",
      recovery,
    };
  }

  const expectedCanonical =
    typeof (expected.invocation as Record<string, unknown> | undefined)?.canonical === "string"
      ? ((expected.invocation as Record<string, unknown>).canonical as string)
      : AGENT_INVOCATION_CONTRACT.canonical;
  const expectedContract =
    typeof expected.commandContractVersion === "string" ? expected.commandContractVersion : undefined;
  const requiredCapabilities = Array.isArray(expected.requiredCapabilities)
    ? expected.requiredCapabilities.filter((value): value is string => typeof value === "string")
    : [];
  const minimumVersion = typeof expected.minimumVersion === "string" ? expected.minimumVersion : undefined;
  const missingCapabilities = requiredCapabilities.filter((capability) => !parsed.capabilities?.includes(capability));

  const problems: string[] = [];
  if (parsed.invocation?.canonical !== expectedCanonical)
    problems.push(
      `canonical invocation is ${JSON.stringify(parsed.invocation?.canonical ?? "unknown")}, expected ${JSON.stringify(expectedCanonical)}`,
    );
  if (expectedContract !== undefined && parsed.commandContractVersion !== expectedContract)
    problems.push(`command contract is ${parsed.commandContractVersion ?? "unknown"}, expected ${expectedContract}`);
  if (missingCapabilities.length > 0) problems.push(`missing capability ${missingCapabilities.join(", ")}`);
  if (minimumVersion !== undefined && !versionAtLeast(parsed.version, minimumVersion))
    problems.push(`version ${parsed.version} is older than required ${minimumVersion}`);

  if (problems.length > 0) {
    return {
      invocation: AGENT_INVOCATION_CONTRACT.canonical,
      status: "stale",
      version: parsed.version,
      capabilities: parsed.capabilities,
      ...(missingCapabilities.length === 0 ? {} : { missingCapabilities }),
      detail: problems.join("; "),
      recovery,
    };
  }
  return {
    invocation: AGENT_INVOCATION_CONTRACT.canonical,
    status: "ready",
    version: parsed.version,
    capabilities: parsed.capabilities,
    recovery,
  };
}

async function runDiagnosticWithCanonicalProbe(argv: string[], dependencies: CliDependencies): Promise<number> {
  const execute = dependencies.runCanonicalDiagnosticCommand ?? runCanonicalDiagnosticCommand;
  // Bare CLI Canon version output is package identity only. The existing named
  // product route keeps the runtime contract and capabilities needed by
  // diagnose; retire this probe when #1194 adds a canonical readiness handshake.
  const canonicalProbe = execute(["version", "--json"]);
  const jsonArgv = argv.some((token) => token === "--json" || token === "--json=true")
    ? [...argv]
    : [...argv, "--json"];
  const lines: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (line: string) => lines.push(line);
    await runCoreCli(jsonArgv, dependencies);
  } finally {
    console.log = originalLog;
  }
  const coreLine = lines.at(-1);
  if (coreLine === undefined) return 4;
  const output = JSON.parse(coreLine) as Record<string, unknown>;
  const canonical = projectCanonicalRuntime(canonicalProbe, output);
  output.canonical = canonical;
  output.ok = canonical.status === "ready";

  const json = argv.some((token) => token === "--json" || token === "--json=true");
  if (json) console.log(JSON.stringify(output));
  else {
    console.log(`${String(output.name ?? "gh-inari")} ${String(output.version ?? "unknown")}`);
    if (canonical.status === "ready")
      console.log(`${canonical.invocation}: ready (${canonical.version ?? "unknown version"})`);
    else {
      console.error(`${canonical.invocation}: ${canonical.detail ?? `the canonical runtime is ${canonical.status}`}`);
      console.error(`Action: ${canonical.recovery}`);
    }
  }
  return canonical.status === "ready" ? 0 : 2;
}

function writeCliResult(result: CliResult, dependencies: CliDependencies): void {
  if (dependencies.writeResult !== undefined) {
    dependencies.writeResult(result);
    return;
  }
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
}

function projectArtifactReconciliationResult(result: ArtifactReconciliationResult): CliOutcome {
  const output = jsonOutput({ operation: `${result.domain}.reconcile`, ...result });
  if (output.status === "failure" || result.outcome === "unchanged" || result.outcome === "reconciled") {
    return output;
  }
  return cliFailure("domain", output.output, result.outcome === "blocked" ? 2 : 3, "stdout");
}

/** The public CLI enters the compiled CLI Canon product and its standard shell. */
export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const namedArgv = namedDiagnosticAliasArgv(argv);
  const metadata = (dependencies.packageMetadata ?? packageJson) as ProductPackageIdentity;
  const product = compileInariCliProduct(metadata, packageJson.description, dependencies);
  const branchArgv = branchPrefixTransitionArgv(namedArgv, product);
  const normalizedArgv = branchArgv ?? routeFirstTransitionArgv(namedArgv);
  if (isValidatedSetupParentTransition(normalizedArgv)) return runCoreCli([...normalizedArgv], dependencies);

  const delegated = createLegacyDelegatedCommandSource(async (request) => {
    const delegatedArgv = [...request.route, ...request.argv];
    if (request.presentation === "machine") delegatedArgv.push("--json");

    const exitCode =
      request.commandId === "root.diagnose" || request.commandId === "root.doctor"
        ? await runDiagnosticWithCanonicalProbe(delegatedArgv, dependencies)
        : await runCoreCli(delegatedArgv, dependencies);
    return { exitCode, stdout: "", stderr: "" };
  });
  const result = await runNodeCli(product, normalizedArgv, {
    delegatedSources: [delegated],
    resultPresenter: {
      success: (execution) => {
        if (execution.commandId === "branch.check" || execution.commandId === "branch.semantic.check") {
          return execution.result === 0 ? textOutput("") : cliFailure("domain", "", execution.result, "stdout");
        }
        return projectArtifactReconciliationResult(execution.result as ArtifactReconciliationResult);
      },
    },
  });
  writeCliResult(result, dependencies);
  return result.exitCode;
}
