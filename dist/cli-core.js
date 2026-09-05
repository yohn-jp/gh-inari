import { spawnSync } from "node:child_process";
import { open } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactInputError, ArtifactPreparationError, loadCanonicalArtifact, parseArtifactInputDocument, prepareIssueArtifact, preparePullRequestArtifact, projectExistingArtifact, renderIssueArtifact, renderPullRequestArtifact, } from "./artifact.js";
import { effectiveFieldConstraints, projectContract, SemanticValidationError, } from "./contract/index.js";
import { createGitHubActionsChangeRemoteExecutor, GitHubAdapter, isGitHubAdapterError } from "./github/index.js";
import { assertPullRequestSyncInputComplete, parsePullRequestSyncInput, projectPullRequestSyncInput, renderPullRequestSyncInputHelp, } from "./pr-sync-input.js";
import { compileLocalGovernedContract, compileRepositoryGovernedContract, createGovernedIssue, createGovernedPullRequest, discoverRepositoryTemplates, rejectGovernedPolicyOverride, } from "./governance.js";
import { discoverTemplates } from "./template-discovery.js";
import { applySemanticPatch, assessExistingArtifact, currentArtifactInput, diffArtifact, prepareRemediationArtifact, prepareSyncInput, remediationDiagnosticReport, remediationFailureDetails, readGovernedExistingArtifact, RemediationError, translateRemediationFailure, updateGovernedExistingArtifact, } from "./reconciliation.js";
import { discoverSemanticTemplates, importNativeTemplate, renderSemanticCompactSchema, syncSemanticTemplates, SEMANTIC_ISSUE_DIRECTORY, SEMANTIC_PULL_REQUEST_FILE, SEMANTIC_TEMPLATE_DIRECTORY, } from "./semantic-template.js";
import { findSkillScenario, MAX_SKILL_OUTPUT_BYTES, projectSkillIndexToJson, projectSkillIndexToText, projectSkillScenarioToJson, projectSkillScenarioToText, SKILL_SCENARIOS, } from "./skill.js";
import { AGENT_INVOCATION_CONTRACT, COMMAND_CONTRACT_VERSION, COMMAND_OPTIONS, INARI_COMMANDS, RUNTIME_CAPABILITIES, commandExample, commandInvocation, commandRecoveryInvocation, commandTemplateSchemaInvocation, commandUsage, getCommandForPositionals, getDomainCommands, getOption, optionSyntax, projectCommandHelp, tokenizeCommandArgv, } from "./command-contract.js";
import { changeRemoteMutationRequest, changeRemoteReadRequest, executeChangeRemoteMutationResult, readChangeRemoteProjection, } from "./change-executor.js";
const EXIT_USAGE = 1;
const EXIT_VALIDATION = 2;
const EXIT_REMOTE = 3;
const EXIT_INTERNAL = 4;
const DIAGNOSTIC_PROTOCOL_VERSION = 1;
const { extensionInstall: INSTALL_COMMAND, extensionUpdate: UPDATE_COMMAND, fallback: FALLBACK_COMMAND, } = AGENT_INVOCATION_CONTRACT;
const CANONICAL_INVOCATION = AGENT_INVOCATION_CONTRACT.canonical;
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
const METADATA_OPTION_KEYS = ["title", "head", "base", "draft", "maintainerCanModify"];
/** The installed gh-inari executable entrypoint. */
export async function runCli(argv, dependencies = {}) {
    const metadata = dependencies.packageMetadata ?? readPackageMetadata();
    if (!isOwnedInvocation(argv))
        return runGhFallback(argv, dependencies);
    let parsed;
    try {
        parsed = parseArguments(argv);
    }
    catch (error) {
        const reportedError = intentAwareCreateOptionError(argv, error) ?? error;
        const shape = toErrorShape(reportedError);
        const json = argv.some((token) => token === "--json" || token === "--json=true");
        if (json)
            console.log(JSON.stringify({ ok: false, error: shape }));
        else if (reportedError instanceof CliError && reportedError.code === "GOVERNED_CREATE_OPTION")
            console.error(`${shape.code}: ${shape.message}`);
        else if (isMachineCommandTokens(argv))
            console.log(JSON.stringify({ ok: false, error: shape }));
        else
            console.error(`${shape.code}: ${shape.message}`);
        return classifyExitCode(reportedError);
    }
    const diagnosticRequested = parsed.options.diagnose === true ||
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
        if (versionRequested)
            return runVersion(metadata, parsed.options, json);
        if (diagnosticRequested)
            return runDiagnostic(metadata, parsed.options, json, dependencies);
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
        if (domain === "issue" || domain === "pr") {
            return await runArtifactCommand(domain, command, rest, parsed, root, dependencies, json);
        }
        if (domain === "skill") {
            return runSkillCommand(command, json);
        }
        throw new CliError("UNKNOWN_COMMAND", `Unknown command "${parsed.positionals.join(" ")}".`);
    }
    catch (error) {
        const shape = toErrorShape(error);
        if (json || isMachineCommand(parsed.positionals))
            console.log(JSON.stringify({ ok: false, error: shape }));
        else
            console.error(`${shape.code}: ${shape.message}`);
        return classifyExitCode(error);
    }
}
function runVersion(metadata, options, json) {
    const info = runtimeInfo(metadata);
    const requirements = runtimeRequirements(options, false);
    const missingCapabilities = requirements.capabilities.filter((capability) => !info.capabilities.includes(capability));
    const versionSupported = requirements.minimumVersion === undefined || versionAtLeast(info.version, requirements.minimumVersion);
    const ok = missingCapabilities.length === 0 && versionSupported;
    if (json) {
        console.log(JSON.stringify({
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
        }));
    }
    else {
        console.log(`${metadata.name} ${metadata.version}`);
        if (!ok)
            console.error(`gh-inari: ${runtimeRequirementMessage(info, missingCapabilities, requirements.minimumVersion)}`);
    }
    return ok ? 0 : EXIT_VALIDATION;
}
function runDiagnostic(metadata, options, json, dependencies) {
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
    if (json)
        console.log(JSON.stringify(output));
    else {
        console.log(`${metadata.name} ${metadata.version}`);
        if (ok)
            console.log(`${CANONICAL_INVOCATION}: ready (${canonical.version ?? "unknown version"})`);
        else {
            console.error(`${CANONICAL_INVOCATION}: ${runtimeDiagnosticMessage(canonical, "canonical runtime")}`);
            console.error(`Action: ${canonical.recovery}`);
        }
        if (compatibility.status !== "ready") {
            console.error(`${AGENT_INVOCATION_CONTRACT.compatibility} (compatibility): ${runtimeDiagnosticMessage(compatibility, "extension")}`);
            console.error(`Action: ${compatibility.recovery}`);
        }
    }
    return ok ? 0 : EXIT_VALIDATION;
}
function runtimeInfo(metadata) {
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
function runtimeRequirements(options, defaultCapabilities) {
    const requestedCapability = options.requireCapability;
    const capabilities = typeof requestedCapability === "string"
        ? [requestedCapability]
        : defaultCapabilities
            ? [...RUNTIME_CAPABILITIES]
            : [];
    const requestedMinimum = options.minimumVersion;
    if (requestedMinimum !== undefined && typeof requestedMinimum !== "string")
        throw new CliError("INVALID_OPTION", "Option --minimum-version requires a version value.", "--minimum-version");
    if (typeof requestedMinimum === "string" && parseVersion(requestedMinimum) === undefined)
        throw new CliError("INVALID_OPTION", `Option --minimum-version must be a semantic version (received "${requestedMinimum}").`, "--minimum-version");
    return {
        capabilities,
        ...(typeof requestedMinimum === "string" ? { minimumVersion: requestedMinimum } : {}),
    };
}
function diagnoseCanonicalRuntime(info, requirements) {
    const missingCapabilities = requirements.capabilities.filter((capability) => !info.capabilities.includes(capability));
    if (missingCapabilities.length > 0 ||
        (requirements.minimumVersion !== undefined && !versionAtLeast(info.version, requirements.minimumVersion))) {
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
function probeCompatibilityExtension(requirements, runCommand) {
    const execute = runCommand ?? runGhDiagnosticCommand;
    const list = execute(["extension", "list"]);
    if (list.status !== 0) {
        return {
            status: "unavailable",
            detail: diagnosticProcessDetail(list),
            recovery: FALLBACK_COMMAND,
        };
    }
    if (!hasInariExtension(list.stdout))
        return { status: "missing", recovery: INSTALL_COMMAND };
    const version = execute(["inari", "--version", "--json"]);
    if (version.status !== 0) {
        return {
            status: "stale",
            detail: diagnosticProcessDetail(version),
            recovery: UPDATE_COMMAND,
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(version.stdout.trim());
    }
    catch {
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
    const missingCapabilities = requirements.capabilities.filter((capability) => !parsed.capabilities.includes(capability));
    if (missingCapabilities.length > 0 ||
        (requirements.minimumVersion !== undefined && !versionAtLeast(parsed.version, requirements.minimumVersion))) {
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
function runGhDiagnosticCommand(args) {
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
    }
    catch (error) {
        return {
            status: null,
            stdout: "",
            stderr: "",
            error: error instanceof Error ? error.message : "unable to execute gh",
        };
    }
}
/** Delegates argv gh-inari does not own to the real `gh` binary, so `gh inari` is a strict superset of `gh`. */
function runGhFallback(argv, dependencies) {
    const execute = dependencies.runGhFallback ?? runGhPassthroughCommand;
    return execute(argv);
}
function runGhPassthroughCommand(argv) {
    const result = spawnSync("gh", [...argv], { stdio: "inherit" });
    if (result.error)
        throw new CliError("GH_FALLBACK_FAILED", `Cannot execute gh: ${result.error.message}.`);
    return result.status ?? EXIT_INTERNAL;
}
function hasInariExtension(output) {
    return output.split(/\r?\n/u).some((line) => /^\s*gh\s+inari(?:\s|$)/u.test(line));
}
function isRuntimeInfo(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const candidate = value;
    const invocation = candidate.invocation;
    return (candidate.ok !== false &&
        typeof candidate.name === "string" &&
        candidate.name === "gh-inari" &&
        typeof candidate.version === "string" &&
        typeof candidate.protocol === "number" &&
        (candidate.commandContractVersion === undefined || typeof candidate.commandContractVersion === "string") &&
        Array.isArray(candidate.capabilities) &&
        candidate.capabilities.every((capability) => typeof capability === "string") &&
        typeof invocation === "object" &&
        invocation !== null &&
        typeof invocation.canonical === "string" &&
        typeof invocation.direct === "string" &&
        typeof invocation.fallback === "string");
}
function runtimeRequirementMessage(info, missingCapabilities, minimumVersion) {
    const requirements = [];
    if (missingCapabilities.length > 0)
        requirements.push(`missing capability ${missingCapabilities.map((value) => `"${value}"`).join(", ")}`);
    if (minimumVersion !== undefined && !versionAtLeast(info.version, minimumVersion))
        requirements.push(`version ${info.version} is older than required ${minimumVersion}`);
    return requirements.length === 0 ? "runtime requirements are not satisfied" : requirements.join("; ");
}
function projectRuntimeDiagnostic(invocation, diagnostic, kind) {
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
function runtimeDiagnosticMessage(diagnostic, subject) {
    if (diagnostic.status === "missing")
        return `the ${subject} is not installed`;
    if (diagnostic.status === "unavailable")
        return diagnostic.detail ?? "the GitHub CLI could not be executed";
    if (diagnostic.status === "stale")
        return diagnostic.detail ?? `the ${subject} is stale`;
    return `the ${subject} is ready`;
}
function diagnosticProcessDetail(result) {
    const detail = (result.error ?? result.stderr ?? "").trim().split(/\r?\n/u)[0];
    return detail === "" ? "the GitHub CLI command failed" : detail.slice(0, 240);
}
function parseVersion(value) {
    const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
    if (match === null)
        return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function versionAtLeast(actual, minimum) {
    const actualParts = parseVersion(actual);
    const minimumParts = parseVersion(minimum);
    if (actualParts === undefined || minimumParts === undefined)
        return false;
    for (let index = 0; index < actualParts.length; index += 1) {
        if (actualParts[index] !== minimumParts[index])
            return actualParts[index] > minimumParts[index];
    }
    return true;
}
class CliError extends Error {
    code;
    path;
    details;
    constructor(code, message, path, details) {
        super(message);
        this.name = "CliError";
        this.code = code;
        this.path = path;
        this.details = details;
    }
}
const CREATE_RECOVERY_ACTIONS = 3;
/**
 * Recognized gh-compatible create guidance is intentionally narrow. In
 * particular, the body value is never parsed, echoed, or accepted as an
 * alternate governed input path.
 */
function intentAwareCreateOptionError(argv, error) {
    if (!(error instanceof CliError) ||
        error.code !== "INVALID_OPTION" ||
        !getOption("rawBody").aliases.some((option) => error.message === `Unknown option ${option}.`))
        return undefined;
    const domain = governedCreateDomain(argv);
    const option = findGovernedCreateOption(argv);
    if (domain === undefined || option === undefined || error.message !== `Unknown option ${option}.`)
        return undefined;
    const recovery = createRecoveryActions(domain);
    return new CliError("GOVERNED_CREATE_OPTION", `Option ${option} is a gh-compatible raw Markdown input, but governed ${domain} creation requires Inari's canonical structured input. ` +
        `Use ${recovery[0]?.command}, then ${recovery[1]?.command}, and create with ${recovery[2]?.command}.`, "$argv", {
        option,
        domain,
        operation: "create",
        recovery,
    });
}
function createRecoveryActions(domain) {
    const actions = [
        { action: "discover-template", command: commandInvocation("template.list") },
        { action: "inspect-schema", command: commandTemplateSchemaInvocation(domain) },
        {
            action: "create",
            command: commandRecoveryInvocation(`${domain}.create`),
        },
    ];
    return actions.slice(0, CREATE_RECOVERY_ACTIONS);
}
function findGovernedCreateOption(argv) {
    return tokenizeCommandArgv(argv).options.find((occurrence) => occurrence.definition?.id === "rawBody")?.rawName;
}
/** Locate only the governed domain/create positionals; option values are never treated as commands. */
function governedCreateDomain(argv) {
    const { positionals } = tokenizeCommandArgv(argv);
    const domain = positionals[0];
    return (domain === "issue" || domain === "pr") && positionals[1] === "create" ? domain : undefined;
}
/** Bound for local --from <file> and stdin artifact input, independent of semantic field constraints. */
const MAX_INPUT_BYTES = 1_048_576;
function inputTooLargeError(observedBytes) {
    return new CliError("INPUT_TOO_LARGE", `Input exceeds the maximum allowed size of ${MAX_INPUT_BYTES} bytes.`, "--from", { limitBytes: MAX_INPUT_BYTES, observedBytes });
}
function skillOutputExceedsBudgetError(scenarioId, observedBytes) {
    return new CliError("SKILL_OUTPUT_EXCEEDS_BUDGET", `Skill output exceeds the maximum allowed size of ${MAX_SKILL_OUTPUT_BYTES} bytes.`, "skill", { limitBytes: MAX_SKILL_OUTPUT_BYTES, observedBytes, scenarioId });
}
function unknownSkillScenarioError(scenarioId) {
    return new CliError("UNKNOWN_SKILL_SCENARIO", `Unknown skill scenario "${scenarioId}".`, "$argv[1]", {
        scenarioId,
        knownScenarios: SKILL_SCENARIOS.map((scenario) => scenario.id),
    });
}
function runSkillCommand(scenarioId, json) {
    const output = scenarioId === undefined
        ? json
            ? JSON.stringify(projectSkillIndexToJson())
            : projectSkillIndexToText()
        : (() => {
            const scenario = findSkillScenario(scenarioId);
            if (scenario === undefined)
                throw unknownSkillScenarioError(scenarioId);
            return json ? JSON.stringify(projectSkillScenarioToJson(scenario)) : projectSkillScenarioToText(scenario);
        })();
    const observedBytes = Buffer.byteLength(output, "utf8");
    if (observedBytes > MAX_SKILL_OUTPUT_BYTES)
        throw skillOutputExceedsBudgetError(scenarioId, observedBytes);
    console.log(output);
    return 0;
}
function invalidArtifactNumberError(domain, value) {
    const message = value === undefined
        ? `A ${domain} number is required.`
        : `"${value}" is not a valid ${domain} number. Use a positive integer.`;
    return new CliError("INVALID_ARTIFACT_NUMBER", message, "$argv[0]", { domain, value });
}
async function runTemplateList(root, repository, dependencies) {
    let discovery;
    if (typeof repository === "string") {
        const adapter = createAdapter(dependencies, root, repository);
        await adapter.resolveRepositoryContext();
        discovery = await discoverRepositoryTemplates(adapter);
    }
    else {
        discovery = await discoverTemplates(root);
    }
    const semanticTemplates = typeof repository === "string" ? [] : await discoverSemanticTemplates(root);
    const hint = semanticTemplates.length === 0 && typeof repository !== "string"
        ? `no semantic templates found under ${SEMANTIC_TEMPLATE_DIRECTORY}/; ` +
            `expected ${SEMANTIC_ISSUE_DIRECTORY}/<id>.json, ${SEMANTIC_PULL_REQUEST_FILE}, ` +
            `or ${SEMANTIC_TEMPLATE_DIRECTORY}/pull-requests/<id>.json`
        : undefined;
    console.log(JSON.stringify({
        templates: discovery.templates,
        semanticTemplates,
        ...(hint === undefined ? {} : { semanticTemplatesHint: hint }),
    }));
    return 0;
}
async function runTemplateSync(root, check) {
    const result = await syncSemanticTemplates(root, check);
    console.log(JSON.stringify(result));
    return check && result.changed ? EXIT_VALIDATION : 0;
}
async function runTemplateImport(root, rest, parsed, json) {
    const nativePath = typeof parsed.options.from === "string" ? parsed.options.from : rest[0];
    if (nativePath === undefined)
        throw new CliError("INPUT_REQUIRED", "Use template import --from <native-template>.", "--from");
    const imported = await importNativeTemplate(root, nativePath, typeof parsed.options.to === "string" ? parsed.options.to : undefined);
    if (json)
        console.log(JSON.stringify({ ok: true, ...imported }));
    else {
        console.log(imported.path);
        if (imported.warning !== undefined)
            console.error(`warning: ${imported.warning}`);
    }
    return 0;
}
function invalidChangeNumberError(value) {
    const message = value === undefined
        ? "A Change root Issue number is required."
        : `"${value}" is not a valid Change root Issue number. Use a positive integer.`;
    return new CliError("INVALID_CHANGE_NUMBER", message, "$argv[1]", { value });
}
function createChangeExecutor(dependencies, root, repository) {
    if (dependencies.changeExecutor !== undefined)
        return dependencies.changeExecutor;
    const factory = dependencies.createChangeExecutor ??
        ((options) => {
            const adapter = (dependencies.createAdapter ?? ((adapterOptions) => new GitHubAdapter(adapterOptions)))({
                cwd: options.cwd,
                ...(options.repository === undefined ? {} : { repository: options.repository }),
            });
            return createGitHubActionsChangeRemoteExecutor({ ...options, api: adapter });
        });
    return factory({ cwd: root, ...(typeof repository === "string" ? { repository } : {}) });
}
function projectChangeCommandResult(operation, issue, projection, evidence = undefined) {
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
        ...(evidence === undefined ? {} : { evidence }),
        projection,
    };
}
function rejectUnsupportedChangeOptions(command, options) {
    const definition = getCommandForPositionals(["change", command]);
    if (definition === undefined)
        return;
    const unsupported = Object.keys(options).find((id) => !definition.optionIds.includes(id));
    if (unsupported === undefined)
        return;
    const option = getOption(unsupported);
    throw new CliError("INVALID_OPTION", `Option ${option.aliases[0] ?? `--${option.key}`} is not supported by change ${command}.`, "$argv", { command: `change ${command}`, option: option.id });
}
async function runChangeCommand(command, rest, parsed, root, dependencies, json) {
    void json;
    const definition = command === undefined ? undefined : getCommandForPositionals(["change", command]);
    if (definition === undefined || definition.domain !== "change") {
        throw new CliError("UNKNOWN_COMMAND", `Unknown change command "${command ?? ""}".`);
    }
    if (rest.length !== 1 || !isPositiveInteger(rest[0]))
        throw invalidChangeNumberError(rest[0]);
    rejectUnsupportedChangeOptions(definition.operation, parsed.options);
    const issue = Number(rest[0]);
    const executor = createChangeExecutor(dependencies, root, parsed.options.repository);
    const result = definition.operation === "show"
        ? { projection: await readChangeRemoteProjection(executor, changeRemoteReadRequest(issue)) }
        : await executeChangeRemoteMutationResult(executor, changeRemoteMutationRequest(definition.operation, issue));
    const projection = result.projection;
    console.log(JSON.stringify(projectChangeCommandResult(definition.operation, issue, projection, result.evidence)));
    const executionSucceeded = result.evidence === undefined ||
        result.evidence.outcome === "verified" ||
        result.evidence.outcome === "returned-existing";
    return projection.valid && executionSucceeded ? 0 : EXIT_VALIDATION;
}
async function runArtifactCommand(domain, command, rest, parsed, root, dependencies, json) {
    if (command === "schema") {
        let contract;
        if (typeof parsed.options.repository === "string") {
            rejectGovernedPolicyOverride(parsed.options.policy);
            const adapter = createAdapter(dependencies, root, parsed.options.repository);
            await adapter.resolveRepositoryContext();
            contract = await compileRepositoryGovernedContract(adapter, domain, templateSelector(parsed, rest[0]), {
                templateResolver: dependencies.templateResolver,
            });
        }
        else {
            contract = await compileLocalGovernedContract(domain, root, templateSelector(parsed, rest[0]), parsed.options.policy, { templateResolver: dependencies.templateResolver });
        }
        const projection = projectContract(contract);
        const syncInput = domain === "pr" ? projectPullRequestSyncInput(contract) : undefined;
        if (parsed.options.compact === true)
            console.log(JSON.stringify({
                schema: renderSemanticCompactSchema(contract),
                metadata: projection.metadata,
                ...(syncInput === undefined ? {} : { syncInput }),
            }));
        else
            console.log(JSON.stringify({
                contract,
                template: contract.templateIdentity,
                ...projection,
                directFields: projectDirectFieldUsage(contract),
                ...(syncInput === undefined ? {} : { syncInput }),
            }));
        return 0;
    }
    if (command === "validate" || command === "render" || command === "create") {
        if (command === "validate" &&
            rest[0] !== undefined &&
            isPositiveInteger(rest[0]) &&
            parsed.options.from === undefined &&
            parsed.fields.length === 0) {
            return runExistingValidation(domain, Number(rest[0]), parsed, root, dependencies, json);
        }
        if (command === "validate" || command === "render") {
            let contract;
            if (typeof parsed.options.repository === "string") {
                rejectGovernedPolicyOverride(parsed.options.policy);
                const adapter = createAdapter(dependencies, root, parsed.options.repository);
                await adapter.resolveRepositoryContext();
                contract = await compileRepositoryGovernedContract(adapter, domain, templateSelector(parsed, rest[0]), {
                    templateResolver: dependencies.templateResolver,
                });
            }
            else {
                contract = await compileLocalGovernedContract(domain, root, templateSelector(parsed, rest[0]), parsed.options.policy, { templateResolver: dependencies.templateResolver });
            }
            const document = await resolveArtifactInputDocument(parsed, contract);
            const preparedDocument = mergeOptionMetadata(document, parsed.options);
            if (command === "validate") {
                const validation = loadCanonicalArtifact(contract, preparedDocument);
                console.log(JSON.stringify({
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
                }));
                return validation.valid ? 0 : EXIT_VALIDATION;
            }
            const body = domain === "issue"
                ? renderIssueArtifact(contract, preparedDocument)
                : renderPullRequestArtifact(contract, preparedDocument.fields);
            if (json)
                console.log(JSON.stringify({ valid: true, body }));
            else
                process.stdout.write(body);
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
    if ((command === "validate" || command === "explain") &&
        rest[0] !== undefined &&
        isPositiveInteger(rest[0]) &&
        parsed.options.from === undefined) {
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
async function runExistingValidation(domain, number, parsed, root, dependencies, json) {
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
        ...(projection.dependencies === undefined ? {} : { dependencies: projection.dependencies }),
        ...(projection.attemptedTemplates === undefined ? {} : { attemptedTemplates: projection.attemptedTemplates }),
    };
    console.log(JSON.stringify(output));
    return result.valid ? 0 : EXIT_VALIDATION;
}
async function runExistingGet(domain, number, parsed, root, dependencies) {
    rejectGovernedPolicyOverride(parsed.options.policy);
    const adapter = createAdapter(dependencies, root, parsed.options.repository);
    await adapter.resolveRepositoryContext();
    const { remote, contract, result } = await readGovernedExistingArtifact(adapter, domain, number, templateSelector(parsed, undefined));
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
async function runExistingRemediation(domain, operation, number, parsed, root, dependencies, json) {
    void json;
    rejectUnsupportedRemediationMetadata(domain, operation, parsed.options);
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
        console.log(JSON.stringify({
            ok: assessment.status === "valid-current",
            ...base,
            status: assessment.status,
            classification: read.result.classification,
            valid: assessment.status === "valid-current",
            normalizable: assessment.normalizable,
            diagnostics: assessment.diagnostics,
            ...(read.result.classification === "semantic" ? { violations: read.result.violations } : {}),
            ...(read.result.attemptedTemplates === undefined ? {} : { attemptedTemplates: read.result.attemptedTemplates }),
        }));
        return assessment.status === "valid-current" ? 0 : EXIT_VALIDATION;
    }
    if (read.contract === undefined) {
        throw new RemediationError(operation === "normalize"
            ? "NORMALIZATION_UNSAFE"
            : operation === "edit"
                ? "SEMANTIC_PATCH_UNSUPPORTED"
                : "SYNC_CURRENT_UNSUPPORTED", "No authoritative template could be selected for the existing artifact.", "$.template", operation === "edit" || operation === "normalize" ? remediationFailureDetails(read) : undefined, operation === "edit" || operation === "normalize"
            ? remediationDiagnosticReport(domain, operation, read)
            : undefined);
    }
    let desiredInput;
    try {
        if (operation === "normalize") {
            if (!read.result.valid || !read.result.parse.parsed) {
                throw new RemediationError("NORMALIZATION_UNSAFE", "Normalization requires a semantically valid artifact whose values can be round-tripped canonically.", "$.artifact");
            }
            desiredInput = currentArtifactInput(domain, read);
        }
        else {
            const input = await resolveArtifactInputDocument(parsed, read.contract, domain === "pr" && operation === "sync", operation === "edit" && hasEditMetadataOption(parsed.options));
            desiredInput =
                operation === "edit"
                    ? applySemanticPatch(domain, read, mergeOptionMetadata(input, parsed.options))
                    : prepareSyncInput(domain, read, input);
        }
    }
    catch (error) {
        if (operation === "edit" || operation === "normalize" || operation === "sync") {
            throw translateRemediationFailure(domain, operation, read, error);
        }
        throw error;
    }
    let desired;
    try {
        desired = prepareRemediationArtifact(domain, read.contract, desiredInput);
    }
    catch (error) {
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
        console.log(JSON.stringify({
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
        }));
        return 0;
    }
    const mutated = await updateGovernedExistingArtifact(adapter, domain, number, desired);
    console.log(JSON.stringify({
        ok: true,
        ...resultBase,
        mutation: "applied",
        artifact: { number: mutated.artifact.number, url: mutated.artifact.url },
        governance: mutated.governance,
    }));
    return 0;
}
function existingArtifactMetadata(domain, remote) {
    if (domain === "issue") {
        if (!("labels" in remote) || !("assignees" in remote))
            throw new Error("Issue metadata response is invalid.");
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
function projectRemediationResult(domain, contract, input, artifact) {
    if (contract === undefined)
        throw new Error("A remediation result requires a selected contract.");
    const loaded = loadCanonicalArtifact(contract, input);
    const fields = loaded.canonical;
    if (domain === "issue") {
        const issue = artifact;
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
    const pullRequest = artifact;
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
function createAdapter(dependencies, root, repository) {
    const factory = dependencies.createAdapter ?? ((options) => new GitHubAdapter(options));
    return factory({ cwd: root, ...(typeof repository === "string" ? { repository } : {}) });
}
async function readInputDocument(value, parser = parseArtifactInputDocument) {
    if (typeof value !== "string" || value.length === 0)
        throw new CliError("INPUT_REQUIRED", "Use --from <file.json>.", "--from");
    let source;
    if (value === "-")
        source = await readStdin();
    else {
        try {
            const handle = await open(value, "r");
            try {
                const stats = await handle.stat();
                if (stats.size > MAX_INPUT_BYTES)
                    throw inputTooLargeError(stats.size);
                source = await handle.readFile("utf8");
                if (Buffer.byteLength(source, "utf8") > MAX_INPUT_BYTES)
                    throw inputTooLargeError(Buffer.byteLength(source, "utf8"));
            }
            finally {
                await handle.close();
            }
        }
        catch (cause) {
            if (cause instanceof CliError)
                throw cause;
            const error = new CliError("INPUT_READ_FAILED", `Cannot read input file "${value}".`, "--from");
            if (cause instanceof Error)
                error.cause = cause;
            throw error;
        }
    }
    let parsed;
    try {
        parsed = JSON.parse(source);
    }
    catch (cause) {
        const error = new CliError("INPUT_INVALID_JSON", "Input file must contain valid JSON.", "--from");
        if (cause instanceof Error)
            error.cause = cause;
        throw error;
    }
    return parser(parsed);
}
function mergeOptionMetadata(document, options) {
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
function hasEditMetadataOption(options) {
    return METADATA_OPTION_KEYS.some((key) => Object.prototype.hasOwnProperty.call(options, key));
}
function rejectUnsupportedRemediationMetadata(domain, operation, options) {
    if (operation === "edit")
        return;
    const supplied = METADATA_OPTION_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(options, key));
    if (supplied.length === 0)
        return;
    const flags = supplied.map((key) => (key === "maintainerCanModify" ? "--maintainer-can-modify" : `--${key}`));
    const label = flags.length === 1 ? "flag" : "flags";
    const verb = flags.length === 1 ? "is" : "are";
    const guidance = operation === "sync"
        ? "use the documented --from input contract for metadata changes"
        : "this remediation command does not accept metadata mutation flags";
    throw new CliError("METADATA_UNSUPPORTED_COMMAND", `${flags.join(", ")} ${label} ${verb} not accepted by ${domain} ${operation}; ${guidance}.`, `$.metadata.${supplied[0]}`, {
        command: `${domain} ${operation}`,
        metadata: supplied,
        flags,
    });
}
/** Bound on how many accepted field names an unknown-field diagnostic lists before truncating. */
const MAX_LISTED_FIELDS = 12;
/** Bound on how many close-name suggestions an unknown-field diagnostic offers. */
const MAX_FIELD_SUGGESTIONS = 3;
/** Suggestions only surface within this edit distance; beyond it a name is not "close". */
const MAX_SUGGESTION_DISTANCE = 3;
function compareStrings(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function levenshteinDistance(left, right) {
    const rows = left.length + 1;
    const cols = right.length + 1;
    const previous = new Array(cols);
    const current = new Array(cols);
    for (let column = 0; column < cols; column += 1)
        previous[column] = column;
    for (let row = 1; row < rows; row += 1) {
        current[0] = row;
        for (let column = 1; column < cols; column += 1) {
            const cost = left[row - 1] === right[column - 1] ? 0 : 1;
            current[column] = Math.min((previous[column] ?? 0) + 1, (current[column - 1] ?? 0) + 1, (previous[column - 1] ?? 0) + cost);
        }
        for (let column = 0; column < cols; column += 1)
            previous[column] = current[column] ?? 0;
    }
    return previous[cols - 1] ?? 0;
}
function unknownFieldError(name, allowedFields) {
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
function duplicateFieldError(name, occurrences) {
    return new CliError("FIELD_DUPLICATE", `Field "${name}" was provided ${occurrences} times as a scalar --field option; a scalar field accepts exactly one value.`, "--field", { field: name, occurrences });
}
function fieldConflictError(names) {
    return new CliError("FIELD_CONFLICT", `Field(s) ${names.join(", ")} were supplied by both --from and --field; remove one source.`, "--field", { fields: names });
}
/** True only for the issue/pr commands that actually resolve an ArtifactInputDocument from --field. */
function isFieldCapableCommand(domain, command) {
    if (domain !== "issue" && domain !== "pr")
        return false;
    const definition = getCommandForPositionals([domain, command ?? ""]);
    return definition?.optionIds.includes("field") === true;
}
function fieldUnsupportedCommandError(positionals) {
    const label = positionals.length === 0 ? "this command" : `"${positionals.join(" ")}"`;
    const supported = getDomainCommands("issue")
        .filter((entry) => entry.optionIds.includes("field"))
        .map((entry) => entry.operation)
        .sort(compareStrings);
    return new CliError("FIELD_UNSUPPORTED_COMMAND", `--field is only supported by issue/pr ${supported.join(", ")}; ${label} does not accept direct field input.`, "--field", { command: positionals.join(" "), supportedCommands: supported });
}
/**
 * The one field-usage projection shared by direct --field acceptance
 * (resolveDirectFields, below) and discovery/help (the `schema` command's
 * `directFields`, and progressive help via missing/invalid field
 * diagnostics). Both read this same contract-derived list, so the CLI's
 * documented `--field` syntax and its runtime acceptance cannot drift from
 * each other or from the selected canonical contract.
 */
function projectDirectFieldUsage(contract) {
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
            cliSyntax: field.type === "checklist"
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
function resolveDirectFields(contract, entries) {
    const usage = projectDirectFieldUsage(contract);
    const usageByName = new Map(usage.map((entry) => [entry.name, entry]));
    const allowedFields = usage.map((entry) => entry.name);
    const grouped = new Map();
    for (const entry of entries) {
        if (!usageByName.has(entry.name))
            throw unknownFieldError(entry.name, allowedFields);
        const values = grouped.get(entry.name);
        if (values === undefined)
            grouped.set(entry.name, [entry.value]);
        else
            values.push(entry.value);
    }
    const fields = {};
    for (const [name, values] of grouped) {
        if (usageByName.get(name)?.repeatable === true) {
            fields[name] = values;
            continue;
        }
        if (values.length > 1)
            throw duplicateFieldError(name, values.length);
        fields[name] = values[0];
    }
    return fields;
}
/** Merge direct-field values into a document under a deterministic, order-independent conflict rule. */
function mergeDirectFields(document, directFields) {
    const directNames = Object.keys(directFields);
    if (directNames.length === 0)
        return document;
    const conflicts = directNames
        .filter((name) => Object.prototype.hasOwnProperty.call(document.fields, name))
        .sort(compareStrings);
    if (conflicts.length > 0)
        throw fieldConflictError(conflicts);
    return {
        fields: { ...document.fields, ...directFields },
        metadata: document.metadata,
        ...(document.dependencies === undefined ? {} : { dependencies: document.dependencies }),
    };
}
/**
 * Resolve one artifact input document from `--from` and/or `--field`, sharing
 * the same candidate/normalization/validation path regardless of source. At
 * least one of the two is required; when both are present, `--from` supplies
 * the base document and direct fields are merged in under a conflict rule
 * that never depends on which flag appeared first in argv.
 */
async function resolveArtifactInputDocument(parsed, contract, requirePullRequestSyncInput = false, allowEmpty = false) {
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
function templateSelector(parsed, positional) {
    return typeof parsed.options.template === "string" ? parsed.options.template : positional;
}
function parseArguments(argv) {
    const options = {};
    const fields = [];
    const tokenized = tokenizeCommandArgv(argv);
    for (const occurrence of tokenized.options) {
        const option = occurrence.definition;
        if (option === undefined) {
            if (occurrence.rawName.startsWith("--")) {
                throw new CliError("INVALID_OPTION", `Unknown option ${occurrence.rawName}.`);
            }
            throw new CliError("INVALID_OPTION", `Unknown option ${occurrence.rawName}.`);
        }
        if (option.id === "rawBody")
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
            if (raw === undefined)
                throw new CliError("INVALID_OPTION", "Option --field requires a value.");
            const separatorIndex = raw.indexOf("=");
            if (separatorIndex <= 0)
                throw new CliError("INVALID_OPTION", 'Option --field requires "<name>=<value>" syntax.', "--field");
            fields.push({ name: raw.slice(0, separatorIndex), value: raw.slice(separatorIndex + 1) });
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
    return { positionals: tokenized.positionals, options, fields };
}
function toErrorShape(error) {
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
    if (isGitHubAdapterError(error))
        return { code: error.code, message: error.message, details: error.details };
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
function classifyExitCode(error) {
    if (error instanceof SemanticValidationError ||
        error instanceof ArtifactInputError ||
        error instanceof RemediationError ||
        error instanceof ArtifactPreparationError)
        return EXIT_VALIDATION;
    if (isGitHubAdapterError(error))
        return EXIT_REMOTE;
    if (isObjectWithCode(error) &&
        typeof error.code === "string" &&
        (error.code.includes("TEMPLATE") || error.code.includes("POLICY")))
        return EXIT_VALIDATION;
    if (error instanceof CliError &&
        (error.code === "UNKNOWN_COMMAND" ||
            error.code === "INVALID_OPTION" ||
            error.code === "INPUT_REQUIRED" ||
            error.code === "INPUT_READ_FAILED" ||
            error.code === "FIELD_UNSUPPORTED_COMMAND" ||
            error.code === "METADATA_UNSUPPORTED_COMMAND" ||
            error.code === "GOVERNED_CREATE_OPTION"))
        return EXIT_USAGE;
    if (error instanceof CliError &&
        (error.code === "INPUT_INVALID_JSON" ||
            error.code === "INPUT_TOO_LARGE" ||
            error.code === "INVALID_ARTIFACT_NUMBER" ||
            error.code === "INVALID_CHANGE_NUMBER" ||
            error.code === "UNKNOWN_SKILL_SCENARIO" ||
            error.code === "SKILL_OUTPUT_EXCEEDS_BUDGET" ||
            error.code === "FIELD_UNKNOWN" ||
            error.code === "FIELD_DUPLICATE" ||
            error.code === "FIELD_CONFLICT"))
        return EXIT_VALIDATION;
    if (isObjectWithCode(error) && error.code === "GOVERNANCE_POLICY_OVERRIDE_FORBIDDEN")
        return EXIT_VALIDATION;
    if (isObjectWithCode(error) && error.code.startsWith("CHANGE_REMOTE_"))
        return EXIT_REMOTE;
    if (isObjectWithCode(error) && error.code.startsWith("CHANGE_EXECUTION_"))
        return EXIT_REMOTE;
    if (isObjectWithCode(error) && error.code.startsWith("CHANGE_"))
        return EXIT_VALIDATION;
    if (isObjectWithCode(error) && error.code.startsWith("GOVERNANCE_"))
        return EXIT_REMOTE;
    if (isObjectWithCode(error) && /^(?:ISSUE_FORM|PR_TEMPLATE|IR_|CONTRACT_)/u.test(error.code))
        return EXIT_VALIDATION;
    return EXIT_INTERNAL;
}
/**
 * True when argv targets a command Inari implements; false means it must fall
 * back to the real `gh` binary. The same tokenizer is used by parseArguments,
 * so supported option values cannot become routing positionals.
 */
function isOwnedInvocation(argv) {
    const { positionals } = tokenizeCommandArgv(argv);
    const first = positionals[0];
    if (first === undefined)
        return true;
    if (first === "diagnose" || first === "doctor" || first === "version" || first === "help")
        return true;
    if (first === "skill")
        return true;
    if (argv.includes("--version") || argv.includes("--diagnose") || argv.includes("--doctor"))
        return true;
    const helpRequested = argv.some((token) => token === "--help" || token.startsWith("--help="));
    if (helpRequested &&
        (first === "issue" || first === "pr" || first === "template" || first === "change") &&
        positionals.length === 1)
        return true;
    return getCommandForPositionals(positionals) !== undefined;
}
function isMachineCommand(positionals) {
    return getCommandForPositionals(positionals) !== undefined;
}
function isMachineCommandTokens(argv) {
    const { positionals } = tokenizeCommandArgv(argv);
    if (argv.includes("--diagnose") ||
        argv.includes("--doctor") ||
        positionals[0] === "diagnose" ||
        positionals[0] === "doctor")
        return true;
    if (positionals[0] === "version")
        return argv.includes("--json");
    return positionals[0] === "skill" || getCommandForPositionals(positionals) !== undefined;
}
function isPositiveInteger(value) {
    return /^[1-9]\d*$/u.test(value);
}
function isObjectWithCode(value) {
    return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string";
}
function readPackageMetadata() {
    const packagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const value = JSON.parse(requireFile(packagePath));
    if (typeof value.name !== "string" || typeof value.version !== "string") {
        throw new Error("package.json must define the package name and version.");
    }
    return {
        name: value.name,
        version: value.version,
        description: typeof value.description === "string" ? value.description : "",
    };
}
function requireFile(filePath) {
    return readFileSync(filePath, "utf8");
}
async function readStdin() {
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.byteLength;
        if (totalBytes > MAX_INPUT_BYTES)
            throw inputTooLargeError(totalBytes);
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
}
const DOMAIN_PASSTHROUGH_EXAMPLE = {
    issue: "issue list",
    pr: "pr checks",
    template: "template view",
    change: "change list",
};
/** Dispatches to root, domain, or leaf help from the canonical command model. */
function printHelpFor(positionals, helpValue) {
    if (helpValue === "json")
        return console.log(JSON.stringify(projectCommandHelp(positionals)));
    if (helpValue === "full")
        return printFullHelp();
    const [domain, command] = positionals;
    if (domain === "issue" || domain === "pr" || domain === "change") {
        const definition = command === undefined ? undefined : getCommandForPositionals([domain, command]);
        if (definition !== undefined && definition.domain === domain)
            return printLeafHelp(definition);
        return printDomainHelp(domain);
    }
    if (domain === "template") {
        const definition = command === undefined ? undefined : getCommandForPositionals([domain, command]);
        if (definition !== undefined && definition.domain === domain)
            return printLeafHelp(definition);
        return printDomainHelp("template");
    }
    if (domain === "skill")
        return printSkillHelp(command);
    printRootHelp();
}
function printRootHelp() {
    console.log(`Usage: inari <command> [...]

A governed GitHub CLI. Issue and PR commands under governed templates run
through Inari; every other command passes through to the real gh binary
with the original argv and exit status.

Domains:
  issue      Governed Issue schema, validation, rendering, and lifecycle
  pr         Governed pull request schema, validation, rendering, and lifecycle
  template   Semantic template authoring and native template sync
  change     Semantic Change projection and authoritative lifecycle requests
  skill      Bounded operational playbooks for common governed workflows

All other commands (e.g. repo, auth, pr list, issue view) are passed through to gh.

Run \`inari <domain> --help\` for that domain's operations.
Run \`inari --help=full\` for the complete command and option reference.
Run \`inari --version\` or \`inari --diagnose\` for machine-readable runtime checks.`);
}
function printDomainHelp(domain) {
    const lines = getDomainCommands(domain).map((entry) => `  ${commandUsage(entry)}`);
    console.log(`Usage: inari ${domain} <command> [...]

Operations:
${lines.join("\n")}

Commands outside this list under "${domain}" (e.g. \`${DOMAIN_PASSTHROUGH_EXAMPLE[domain]}\`) pass through to gh.

Run \`inari ${domain} <command> --help\` for that command's inputs and an example.`);
}
function printSkillHelp(scenarioId) {
    if (scenarioId !== undefined) {
        const scenario = findSkillScenario(scenarioId);
        if (scenario === undefined)
            return printSkillHelp(undefined);
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
function printLeafHelp(command) {
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
function printFullHelp() {
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
function leafSummary(command) {
    if (command.id === "pr.sync")
        return `${command.summary} ${renderPullRequestSyncInputHelp()}`;
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
//# sourceMappingURL=cli-core.js.map