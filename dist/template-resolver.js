import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parse as parseYaml } from "yaml";
export const TEMPLATE_RESOLUTION_CONFIG_PATH = ".github/inari/template-resolution.yml";
export const TEMPLATE_RESOLUTION_CONFIG_VERSION = 1;
const MAX_DIAGNOSTIC_CANDIDATES = 8;
export class TemplateResolutionError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = "TemplateResolutionError";
        this.code = code;
        this.details = details;
    }
    toJSON() {
        return { code: this.code, message: this.message, details: this.details };
    }
}
export function nativeTemplateResolutionCandidate(identity) {
    return {
        id: identity.id,
        kind: identity.kind === "issue" ? "issue" : "pr",
        name: identity.name,
        paths: [identity.path],
        type: identity.type,
        value: identity,
    };
}
export function semanticTemplateResolutionCandidate(identity) {
    return {
        id: identity.id,
        kind: identity.kind === "issue" ? "issue" : "pr",
        name: identity.name,
        paths: [identity.sourcePath, identity.generatedPath],
        ...(identity.kind === "pull_request" && identity.generatedPath === ".github/PULL_REQUEST_TEMPLATE.md"
            ? { nameAliases: ["default"] }
            : {}),
        value: identity,
    };
}
/** Resolve the same precedence asynchronously for CLI and repository-backed callers. */
export async function resolveTemplate(request) {
    const candidates = sortCandidates(request.candidates);
    const deterministic = resolveDeterministically(candidates, request.selector, request.configuredDefault);
    if (deterministic !== undefined)
        return deterministic.value;
    const isInteractive = request.dependencies?.isInteractive?.() ?? defaultIsInteractive();
    if (!isInteractive)
        throw ambiguousError(candidates);
    const selected = await chooseInteractively(candidates, request.dependencies?.select);
    return selected.value;
}
/** Synchronous counterpart for compatibility APIs that cannot provide interactive input. */
export function resolveTemplateSync(request) {
    const candidates = sortCandidates(request.candidates);
    const deterministic = resolveDeterministically(candidates, request.selector, request.configuredDefault);
    if (deterministic !== undefined)
        return deterministic.value;
    throw ambiguousError(candidates);
}
export async function readTemplateResolutionConfig(repositoryRoot) {
    const configPath = path.join(repositoryRoot, TEMPLATE_RESOLUTION_CONFIG_PATH);
    let source;
    try {
        source = await readFile(configPath, "utf8");
    }
    catch (error) {
        if (isFileNotFound(error))
            return undefined;
        throw new TemplateResolutionError("TEMPLATE_CONFIG_UNAVAILABLE", `Cannot read template resolution config "${configPath}".`, {
            candidates: [],
            candidateCount: 0,
            candidatesTruncated: false,
            reason: "configuration source unavailable",
            recovery: explicitRecovery(),
        });
    }
    return parseTemplateResolutionConfig(source, TEMPLATE_RESOLUTION_CONFIG_PATH);
}
export function parseTemplateResolutionConfig(source, sourcePath = TEMPLATE_RESOLUTION_CONFIG_PATH) {
    let value;
    try {
        value = parseYaml(source);
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : "invalid YAML";
        throw configError(sourcePath, reason);
    }
    if (!isRecord(value))
        throw configError(sourcePath, "configuration must be a mapping");
    if (!hasOnlyKeys(value, ["version", "defaults"]))
        throw configError(sourcePath, "unknown configuration property");
    if (value.version !== TEMPLATE_RESOLUTION_CONFIG_VERSION)
        throw configError(sourcePath, `only configuration version ${TEMPLATE_RESOLUTION_CONFIG_VERSION} is supported`);
    if (value.defaults === undefined)
        return { version: TEMPLATE_RESOLUTION_CONFIG_VERSION, defaults: {} };
    if (!isRecord(value.defaults))
        throw configError(`${sourcePath}.defaults`, "defaults must be a mapping");
    if (!hasOnlyKeys(value.defaults, ["issue", "pr"]))
        throw configError(`${sourcePath}.defaults`, "unknown default domain");
    const defaults = {};
    for (const domain of ["issue", "pr"]) {
        const selector = value.defaults[domain];
        if (selector === undefined)
            continue;
        if (typeof selector === "string") {
            if (selector.trim().length === 0)
                throw configError(`${sourcePath}.defaults.${domain}`, "selector must not be empty");
            defaults[domain] = selector;
            continue;
        }
        if (!isTemplateSelectorValue(selector))
            throw configError(`${sourcePath}.defaults.${domain}`, "selector must contain supported non-empty string fields");
        defaults[domain] = selector;
    }
    return { version: TEMPLATE_RESOLUTION_CONFIG_VERSION, defaults };
}
function resolveExplicit(candidates, selector) {
    const match = matchCandidates(candidates, selector);
    if (!match.valid)
        throw selectorInvalidError(selector, candidates);
    if (match.matches.length === 0)
        throw selectorNotFoundError(selector, candidates, match.matchKind ?? "none");
    if (match.matches.length > 1)
        throw selectorAmbiguousError(selector, candidates, match.matchKind ?? "selector");
    return match.matches[0];
}
/** The one implementation of explicit/default/sole-candidate precedence. */
function resolveDeterministically(candidates, selector, configuredDefault) {
    if (selector !== undefined)
        return resolveExplicit(candidates, selector);
    if (candidates.length === 0)
        throw noCandidatesError(candidates);
    if (configuredDefault !== undefined) {
        const match = matchCandidates(candidates, configuredDefault);
        if (!match.valid)
            throw defaultInvalidError(configuredDefault, candidates);
        if (match.matches.length === 0)
            throw defaultUnavailableError(configuredDefault, candidates, match.matchKind ?? "none");
        if (match.matches.length > 1)
            throw defaultAmbiguousError(configuredDefault, candidates, match.matchKind ?? "selector");
        return match.matches[0];
    }
    if (candidates.length === 1)
        return candidates[0];
    return undefined;
}
function matchCandidates(candidates, selector) {
    if (typeof selector === "string") {
        if (selector.trim().length === 0)
            return { valid: false, matches: [], matchKind: "none" };
        const idMatches = candidates.filter((candidate) => candidate.id === selector);
        if (idMatches.length > 0)
            return { valid: true, matches: idMatches, matchKind: "id" };
        const pathMatches = candidates.filter((candidate) => candidate.paths.includes(selector));
        if (pathMatches.length > 0)
            return { valid: true, matches: pathMatches, matchKind: "path" };
        const nameMatches = candidates.filter((candidate) => matchesName(candidate, selector));
        return { valid: true, matches: nameMatches, matchKind: "name" };
    }
    if (!isTemplateSelectorValue(selector))
        return { valid: false, matches: [], matchKind: "none" };
    return {
        valid: true,
        matches: candidates.filter((candidate) => matchesSelector(candidate, selector)),
        matchKind: selector.name === undefined ? "selector" : "name",
    };
}
function matchesSelector(candidate, selector) {
    if (selector.id !== undefined && candidate.id !== selector.id)
        return false;
    if (selector.type !== undefined && candidate.type !== selector.type)
        return false;
    if (selector.kind !== undefined && !kindMatches(candidate.kind, selector.kind))
        return false;
    if (selector.name !== undefined && !matchesName(candidate, selector.name))
        return false;
    if (selector.path !== undefined && !candidate.paths.includes(selector.path))
        return false;
    return true;
}
function matchesName(candidate, name) {
    const expected = canonicalName(name);
    return [candidate.name, ...(candidate.nameAliases ?? [])].some((value) => canonicalName(value) === expected);
}
function kindMatches(kind, selectorKind) {
    if (kind === "issue")
        return selectorKind === "issue";
    return selectorKind === "pull-request";
}
async function chooseInteractively(candidates, select) {
    const choices = candidates.map(toChoice);
    const answer = select === undefined
        ? await defaultSelect(choices)
        : await select({ kind: "multiple-candidates", candidates: choices });
    const selected = chooseAnswer(candidates, answer);
    if (selected !== undefined)
        return selected;
    throw interactionError(candidates, "interactive selection did not identify one of the candidates");
}
async function defaultSelect(candidates) {
    for (const [index, candidate] of candidates.entries()) {
        process.stdout.write(`${index + 1}) ${candidate.id}\n`);
    }
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
        return await readline.question("Select a template: ");
    }
    finally {
        readline.close();
    }
}
function chooseAnswer(candidates, answer) {
    if (typeof answer === "number") {
        if (!Number.isInteger(answer) || answer < 1 || answer > candidates.length)
            return undefined;
        return candidates[answer - 1];
    }
    const match = matchCandidates(candidates, answer);
    if (!match.valid || match.matches.length !== 1)
        return undefined;
    return match.matches[0];
}
function sortCandidates(candidates) {
    return [...candidates].sort((left, right) => compareStrings(left.id, right.id) ||
        compareStrings(left.paths[0] ?? "", right.paths[0] ?? "") ||
        compareStrings(left.name, right.name));
}
function toChoice(candidate) {
    return {
        id: candidate.id,
        kind: candidate.kind,
        name: candidate.name,
        paths: candidate.paths,
        ...(candidate.type === undefined ? {} : { type: candidate.type }),
    };
}
function noCandidatesError(candidates) {
    return new TemplateResolutionError("TEMPLATE_RESOLUTION_NO_CANDIDATES", "No governed template is available for this artifact.", errorDetails(candidates, { reason: "no available candidates" }));
}
function selectorInvalidError(selector, candidates) {
    return new TemplateResolutionError("TEMPLATE_RESOLUTION_SELECTOR_NOT_FOUND", "The explicit template selector is invalid.", errorDetails(candidates, { selector, match: "none", reason: "selector is empty or malformed" }));
}
function selectorNotFoundError(selector, candidates, match) {
    return new TemplateResolutionError("TEMPLATE_RESOLUTION_SELECTOR_NOT_FOUND", `No governed template matches explicit selector ${selectorLabel(selector)}.`, errorDetails(candidates, { selector, match, reason: "explicit selector is unavailable" }));
}
function selectorAmbiguousError(selector, candidates, match) {
    return new TemplateResolutionError("TEMPLATE_RESOLUTION_SELECTOR_AMBIGUOUS", `Explicit template selector ${selectorLabel(selector)} matches multiple governed templates.`, errorDetails(candidates, { selector, match, reason: "explicit selector is ambiguous" }));
}
function defaultInvalidError(selector, candidates) {
    return new TemplateResolutionError("TEMPLATE_RESOLUTION_DEFAULT_INVALID", "The configured default template selector is invalid; refusing to guess a template.", errorDetails(candidates, { configuredDefault: selector, match: "none", reason: "invalid configured selector" }));
}
function defaultUnavailableError(selector, candidates, match) {
    return new TemplateResolutionError("TEMPLATE_RESOLUTION_DEFAULT_UNAVAILABLE", `The configured default template ${selectorLabel(selector)} is unavailable; refusing to guess a template.`, errorDetails(candidates, { configuredDefault: selector, match, reason: "configured default matches no candidate" }));
}
function defaultAmbiguousError(selector, candidates, match) {
    return new TemplateResolutionError("TEMPLATE_RESOLUTION_DEFAULT_AMBIGUOUS", `The configured default template ${selectorLabel(selector)} is ambiguous; refusing to guess a template.`, errorDetails(candidates, {
        configuredDefault: selector,
        match,
        reason: "configured default matches multiple candidates",
    }));
}
function ambiguousError(candidates) {
    return new TemplateResolutionError("TEMPLATE_RESOLUTION_AMBIGUOUS", `Multiple governed templates are available. Provide --template <template> explicitly; candidates: ${candidateSummary(candidates)}.`, errorDetails(candidates, {
        match: "none",
        reason: "non-interactive execution cannot choose among multiple candidates",
    }));
}
function interactionError(candidates, reason) {
    return new TemplateResolutionError("TEMPLATE_RESOLUTION_INTERACTION_FAILED", `Interactive template selection failed: ${reason}. Provide --template <template> explicitly.`, errorDetails(candidates, { match: "none", reason }));
}
function errorDetails(candidates, extra) {
    const identifiers = candidates.map((candidate) => boundedIdentifier(candidate.id));
    return {
        candidates: identifiers.slice(0, MAX_DIAGNOSTIC_CANDIDATES),
        candidateCount: identifiers.length,
        candidatesTruncated: identifiers.length > MAX_DIAGNOSTIC_CANDIDATES,
        ...extra,
        recovery: explicitRecovery(),
    };
}
function explicitRecovery() {
    return [
        {
            action: "provide-explicit-selector",
            option: "--template",
            guidance: "Provide --template <template> explicitly, using an identifier from template list.",
        },
    ];
}
function configError(path, reason) {
    return new TemplateResolutionError("TEMPLATE_CONFIG_INVALID", `Template resolution config at "${path}" is invalid: ${reason}.`, {
        candidates: [],
        candidateCount: 0,
        candidatesTruncated: false,
        reason,
        recovery: explicitRecovery(),
    });
}
function candidateSummary(candidates) {
    const identifiers = candidates
        .slice(0, MAX_DIAGNOSTIC_CANDIDATES)
        .map((candidate) => boundedIdentifier(candidate.id));
    const suffix = candidates.length > identifiers.length ? `, and ${candidates.length - identifiers.length} more` : "";
    return `${identifiers.join(", ")}${suffix}`;
}
function boundedIdentifier(identifier) {
    return identifier.length <= 160 ? identifier : `${identifier.slice(0, 157)}...`;
}
function selectorLabel(selector) {
    return typeof selector === "string"
        ? JSON.stringify(selector)
        : JSON.stringify(selector.id ?? selector.path ?? selector.name ?? selector.type ?? selector.kind);
}
function defaultIsInteractive() {
    return process.stdin.isTTY === true && process.stdout.isTTY === true;
}
function canonicalName(name) {
    return name.normalize("NFC").toLocaleLowerCase("en-US");
}
function compareStrings(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
export function isTemplateSelectorValue(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const entries = Object.entries(value).filter(([, option]) => option !== undefined);
    const allowed = new Set(["id", "type", "kind", "name", "path"]);
    return (entries.length > 0 &&
        entries.every(([key, option]) => allowed.has(key) && typeof option === "string" && option.trim().length > 0));
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value, allowed) {
    const allowedKeys = new Set(allowed);
    return Object.keys(value).every((key) => allowedKeys.has(key));
}
function isFileNotFound(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
//# sourceMappingURL=template-resolver.js.map