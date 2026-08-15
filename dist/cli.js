import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactInputError, parseArtifactInputDocument, prepareIssueArtifact, preparePullRequestArtifact, projectExistingArtifact, renderIssueArtifact, renderPullRequestArtifact, selectExistingArtifactCandidate, validateExistingIssueArtifact, validateExistingPullRequestArtifact, } from "./artifact.js";
import { projectContract, SemanticValidationError, validateSemanticInput, } from "./contract/index.js";
import { GitHubAdapter, isGitHubAdapterError } from "./github/index.js";
import { compileLocalGovernedContract, compileRepositoryGovernedContract, compileRepositoryGovernedContracts, createGovernedIssue, createGovernedPullRequest, discoverRepositoryTemplates, rejectGovernedPolicyOverride, } from "./governance.js";
import { discoverTemplates } from "./template-discovery.js";
import { discoverSemanticTemplates, importNativeTemplate, renderSemanticCompactSchema, syncSemanticTemplates, SEMANTIC_ISSUE_DIRECTORY, SEMANTIC_PULL_REQUEST_FILE, SEMANTIC_TEMPLATE_DIRECTORY, } from "./semantic-template.js";
const EXIT_USAGE = 1;
const EXIT_VALIDATION = 2;
const EXIT_REMOTE = 3;
const EXIT_INTERNAL = 4;
const DIAGNOSTIC_PROTOCOL_VERSION = 1;
const RUNTIME_CAPABILITIES = [
    "canonical-invocation",
    "machine-readable-version",
    "capability-diagnostics",
    "extension-bootstrap",
];
const CANONICAL_INVOCATION = "gh inari";
const INSTALL_COMMAND = "gh extension install yohn-jp/gh-inari";
const UPDATE_COMMAND = "gh extension upgrade inari";
const FALLBACK_COMMAND = "npx --yes gh-inari";
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
/** The installed gh-inari executable entrypoint. */
export async function runCli(argv, dependencies = {}) {
    const metadata = dependencies.packageMetadata ?? readPackageMetadata();
    let parsed;
    try {
        parsed = parseArguments(argv);
    }
    catch (error) {
        const shape = toErrorShape(error);
        const json = argv.some((token) => token === "--json" || token === "--json=true");
        if (json || isMachineCommandTokens(argv))
            console.log(JSON.stringify({ ok: false, error: shape }));
        else
            console.error(`${shape.code}: ${shape.message}`);
        return classifyExitCode(error);
    }
    const diagnosticRequested = parsed.options.diagnose === true ||
        parsed.options.doctor === true ||
        parsed.positionals[0] === "diagnose" ||
        parsed.positionals[0] === "doctor";
    const versionRequested = parsed.options.version === true || parsed.positionals[0] === "version";
    if (parsed.options.help === true || (parsed.positionals.length === 0 && !versionRequested && !diagnosticRequested)) {
        printHelp();
        return parsed.positionals.length === 0 && parsed.options.help !== true ? EXIT_USAGE : 0;
    }
    const json = parsed.options.json === true;
    try {
        if (versionRequested)
            return runVersion(metadata, parsed.options, json);
        if (diagnosticRequested)
            return runDiagnostic(metadata, parsed.options, json, dependencies);
        const root = path.resolve(dependencies.repositoryRoot ?? process.cwd());
        const [domain, command, ...rest] = parsed.positionals;
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
    if (json)
        console.log(JSON.stringify(output));
    else {
        console.log(`${metadata.name} ${metadata.version}`);
        if (ok)
            console.log(`${CANONICAL_INVOCATION}: ready (${canonical.version ?? "unknown version"})`);
        else {
            console.error(`gh-inari: ${canonicalDiagnosticMessage(canonical)}`);
            console.error(`Action: ${canonical.recovery}`);
        }
    }
    return ok ? 0 : EXIT_VALIDATION;
}
function runtimeInfo(metadata) {
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
function probeCanonicalExtension(requirements, runCommand) {
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
function canonicalDiagnosticMessage(diagnostic) {
    if (diagnostic.status === "missing")
        return "the canonical gh extension is not installed";
    if (diagnostic.status === "unavailable")
        return diagnostic.detail ?? "the GitHub CLI could not be executed";
    if (diagnostic.status === "stale")
        return diagnostic.detail ?? "the installed gh extension is stale";
    return "the canonical gh extension is ready";
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
/** Bound for local --from <file> and stdin artifact input, independent of semantic field constraints. */
const MAX_INPUT_BYTES = 1_048_576;
function inputTooLargeError(observedBytes) {
    return new CliError("INPUT_TOO_LARGE", `Input exceeds the maximum allowed size of ${MAX_INPUT_BYTES} bytes.`, "--from", { limitBytes: MAX_INPUT_BYTES, observedBytes });
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
async function runArtifactCommand(domain, command, rest, parsed, root, dependencies, json) {
    if (command === "schema") {
        let contract;
        if (typeof parsed.options.repository === "string") {
            rejectGovernedPolicyOverride(parsed.options.policy);
            const adapter = createAdapter(dependencies, root, parsed.options.repository);
            await adapter.resolveRepositoryContext();
            contract = await compileRepositoryGovernedContract(adapter, domain, templateSelector(parsed, rest[0]));
        }
        else {
            contract = await compileLocalGovernedContract(domain, root, templateSelector(parsed, rest[0]), parsed.options.policy);
        }
        const projection = projectContract(contract);
        if (parsed.options.compact === true)
            console.log(JSON.stringify({ schema: renderSemanticCompactSchema(contract) }));
        else
            console.log(JSON.stringify({ contract, template: contract.templateIdentity, ...projection }));
        return 0;
    }
    if (command === "validate" || command === "render" || command === "create") {
        if (command === "validate" &&
            rest[0] !== undefined &&
            isPositiveInteger(rest[0]) &&
            parsed.options.from === undefined) {
            return runExistingValidation(domain, Number(rest[0]), parsed, root, dependencies, json);
        }
        if (command === "validate" || command === "render") {
            let contract;
            if (typeof parsed.options.repository === "string") {
                rejectGovernedPolicyOverride(parsed.options.policy);
                const adapter = createAdapter(dependencies, root, parsed.options.repository);
                await adapter.resolveRepositoryContext();
                contract = await compileRepositoryGovernedContract(adapter, domain, templateSelector(parsed, rest[0]));
            }
            else {
                contract = await compileLocalGovernedContract(domain, root, templateSelector(parsed, rest[0]), parsed.options.policy);
            }
            const document = await readInputDocument(parsed.options.from);
            const preparedDocument = mergeOptionMetadata(document, parsed.options);
            if (command === "validate") {
                const validation = validateSemanticInput(contract, preparedDocument.fields);
                console.log(JSON.stringify({ valid: validation.valid, violations: validation.violations, values: validation.values }));
                return validation.valid ? 0 : EXIT_VALIDATION;
            }
            const body = domain === "issue"
                ? renderIssueArtifact(contract, preparedDocument.fields)
                : renderPullRequestArtifact(contract, preparedDocument.fields);
            if (json)
                console.log(JSON.stringify({ valid: true, body }));
            else
                process.stdout.write(body);
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
async function runExistingGet(domain, number, parsed, root, dependencies) {
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
    };
}
async function readExistingArtifact(domain, number, parsed, root, dependencies) {
    const adapter = createAdapter(dependencies, root, parsed.options.repository);
    await adapter.resolveRepositoryContext();
    const selector = templateSelector(parsed, undefined);
    let contracts;
    let failedTemplates;
    if (selector === undefined) {
        const outcomes = await compileRepositoryGovernedContracts(adapter, domain);
        contracts = outcomes.filter((outcome) => outcome.status === "compiled").map((outcome) => outcome.contract);
        failedTemplates = outcomes.filter((outcome) => outcome.status === "failed");
    }
    else {
        contracts = [await compileRepositoryGovernedContract(adapter, domain, selector)];
        failedTemplates = [];
    }
    const remote = domain === "issue" ? await adapter.getIssue(number) : await adapter.getPullRequest(number);
    const candidates = contracts.map((contract) => ({
        contract,
        result: domain === "issue"
            ? validateExistingIssueArtifact(contract, remote.body)
            : validateExistingPullRequestArtifact(contract, remote.body),
    }));
    const selected = selectExistingArtifactCandidate(candidates);
    if (selected.contract !== undefined || failedTemplates.length === 0) {
        return { remote, contract: selected.contract, result: selected.result };
    }
    // No compiled template matched, and at least one sibling template failed to
    // compile: fail closed, since the malformed template could be the one that
    // actually owns this artifact. Surface it as a bounded diagnostic rather
    // than an opaque compile error.
    const compileDiagnostics = failedTemplates.map((failed) => ({
        code: "EXISTING_TEMPLATE_COMPILE_FAILED",
        path: failed.path,
        message: `[${failed.path}] Template failed to compile: ${failed.message}`,
    }));
    // selected.contract is undefined here, so selectExistingArtifactCandidate resolved this
    // as an unmatched candidate set: its violations are always ExistingArtifactDiagnostic[].
    const existingViolations = selected.result.violations;
    return {
        remote,
        result: {
            valid: false,
            classification: selected.result.classification,
            parse: {
                parsed: false,
                values: {},
                diagnostics: [...selected.result.parse.diagnostics, ...compileDiagnostics],
            },
            violations: [...existingViolations, ...compileDiagnostics],
        },
    };
}
function createAdapter(dependencies, root, repository) {
    const factory = dependencies.createAdapter ?? ((options) => new GitHubAdapter(options));
    return factory({ cwd: root, ...(typeof repository === "string" ? { repository } : {}) });
}
async function readInputDocument(value) {
    if (typeof value !== "string" || value.length === 0)
        throw new CliError("INPUT_REQUIRED", "Use --from <file.json>.", "--from");
    let source;
    if (value === "-")
        source = await readStdin();
    else {
        try {
            const stats = await stat(value);
            if (stats.size > MAX_INPUT_BYTES)
                throw inputTooLargeError(stats.size);
            source = await readFile(value, "utf8");
            if (Buffer.byteLength(source, "utf8") > MAX_INPUT_BYTES)
                throw inputTooLargeError(Buffer.byteLength(source, "utf8"));
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
    return parseArtifactInputDocument(parsed);
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
    return { fields: document.fields, metadata };
}
function templateSelector(parsed, positional) {
    return typeof parsed.options.template === "string" ? parsed.options.template : positional;
}
function parseArguments(argv) {
    const positionals = [];
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === undefined)
            continue;
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
        const key = rawKey.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
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
        if (!VALUE_OPTIONS.has(key))
            throw new CliError("INVALID_OPTION", `Unknown option --${rawKey}.`);
        const value = equalIndex >= 0 ? token.slice(equalIndex + 1) : argv[++index];
        if (value === undefined || (equalIndex < 0 && value.startsWith("--")))
            throw new CliError("INVALID_OPTION", `Option --${rawKey} requires a value.`);
        options[key] = value;
    }
    return { positionals, options };
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
        return { code: "SEMANTIC_VALIDATION_FAILED", message: error.message, violations: error.violations };
    if (error instanceof ArtifactInputError)
        return { code: error.code, message: error.message, path: error.path };
    if (isGitHubAdapterError(error))
        return { code: error.code, message: error.message, details: error.details };
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
function classifyExitCode(error) {
    if (error instanceof SemanticValidationError || error instanceof ArtifactInputError)
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
            error.code === "INPUT_READ_FAILED"))
        return EXIT_USAGE;
    if (error instanceof CliError &&
        (error.code === "INPUT_INVALID_JSON" ||
            error.code === "INPUT_TOO_LARGE" ||
            error.code === "INVALID_ARTIFACT_NUMBER"))
        return EXIT_VALIDATION;
    if (isObjectWithCode(error) && error.code === "GOVERNANCE_POLICY_OVERRIDE_FORBIDDEN")
        return EXIT_VALIDATION;
    if (isObjectWithCode(error) && error.code.startsWith("GOVERNANCE_"))
        return EXIT_REMOTE;
    if (isObjectWithCode(error) && /^(?:ISSUE_FORM|PR_TEMPLATE|IR_|CONTRACT_)/u.test(error.code))
        return EXIT_VALIDATION;
    return EXIT_INTERNAL;
}
function isMachineCommand(positionals) {
    return ((positionals.length >= 2 &&
        (positionals[1] === "schema" ||
            positionals[1] === "validate" ||
            positionals[1] === "render" ||
            positionals[1] === "create" ||
            positionals[1] === "explain" ||
            positionals[1] === "get")) ||
        positionals[0] === "diagnose" ||
        positionals[0] === "doctor" ||
        positionals[0] === "version");
}
function isMachineCommandTokens(argv) {
    if (argv.includes("--diagnose") || argv.includes("--doctor") || argv.includes("diagnose") || argv.includes("doctor"))
        return true;
    if (argv.includes("--version") || argv.includes("version"))
        return argv.includes("--json");
    const domainIndex = argv.findIndex((token) => token === "issue" || token === "pr");
    if (domainIndex < 0)
        return false;
    const command = argv[domainIndex + 1];
    return (command === "schema" ||
        command === "validate" ||
        command === "render" ||
        command === "create" ||
        command === "explain" ||
        command === "get");
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
function printHelp() {
    console.log(`Usage: gh-inari <command> [options]

Commands:
  template list
  template sync [--check]
  template import --from <native-template> [--to <semantic-file>]
                      Discovered semantic paths: .github/inari/issues/<id>.json,
                      .github/inari/pull-request.json (single PR template), or
                      .github/inari/pull-requests/<id>.json (multiple PR templates).
                      Other --to paths write successfully but are never discovered.
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
  --compact            Emit only semantic fields and constraints for schema
  --check              Check generated native projections without writing
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
  --help              Print this help

Create always validates and renders before invoking gh. Schema, validate, and render never mutate GitHub.

Canonical installation: gh extension install yohn-jp/gh-inari
PATH-independent fallback: npx --yes gh-inari`);
}
//# sourceMappingURL=cli.js.map