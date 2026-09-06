/**
 * GitHub-native Issue relation observation adapter (#288).
 *
 * Reads the native `parent` and `blocked_by` relationships for one Issue and
 * normalizes each related Issue into the existing {@link IssueReference}
 * identity primitive. This module owns no repository policy: it does not
 * infer `children`/`blocks`, tracker state, supersession, or completion
 * semantics, does not parse Markdown/body markers, and never mutates
 * relationships. Canon vocabulary, Effective Contract, materialization,
 * projection policy, and #161 lifecycle interpretation remain out of scope.
 *
 * Depending on the full `GitHubAdapter` surface here would recreate the
 * coupling #288 is meant to avoid, so this module consumes only the bounded
 * `requestRepositoryApi` read seam through a narrow interface.
 */
import { ContractViolationError } from "./errors.js";
import { normalizeIssueReference } from "../contract/issue-reference.js";
const BLOCKED_BY_PAGE_SIZE = 100;
/** Bounded page limit for blocked_by pagination; caps evidence at 1,000 entries per read. */
const BLOCKED_BY_MAX_PAGES = 10;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 500;
/**
 * Observes GitHub-native Issue `parent` and `blocked_by` relationships for
 * one repository context and normalizes them into bounded, deterministic
 * evidence rather than raw GitHub payloads.
 */
export class GitHubIssueRelationObservationAdapter {
    reader;
    context;
    capabilities;
    constructor(reader, context, capabilities) {
        this.reader = reader;
        this.context = context;
        this.capabilities = capabilities;
    }
    /** Observe the native parent relationship for one Issue. */
    async observeParent(issueNumber) {
        assertIssueNumber(issueNumber);
        if (!this.capabilities.parent) {
            return { kind: "unavailable", reference: undefined, diagnostics: [capabilityUnsupportedDiagnostic("parent")] };
        }
        let response;
        try {
            response = await this.reader.requestRepositoryApi(`issues/${issueNumber}/parent`);
        }
        catch (error) {
            return { kind: "unavailable", reference: undefined, diagnostics: [readFailedDiagnostic(error)] };
        }
        if (response.status === 404)
            return { kind: "empty", reference: undefined, diagnostics: [] };
        if (!isRecord(response.body)) {
            return {
                kind: "malformed",
                reference: undefined,
                diagnostics: [responseMalformedDiagnostic("GitHub returned a non-object parent response.")],
            };
        }
        const resolved = resolveRelatedIssue(response.body, this.context, "$");
        if (resolved.status === "resolved") {
            return { kind: "present", reference: resolved.reference, diagnostics: [] };
        }
        return {
            kind: resolved.status === "malformed" ? "malformed" : "unavailable",
            reference: undefined,
            diagnostics: [resolved.diagnostic],
        };
    }
    /**
     * Observe the native `blocked_by` dependency set for one Issue.
     *
     * Pages through the bounded read seam up to {@link BLOCKED_BY_MAX_PAGES};
     * hitting that bound with a still-full page means completeness cannot be
     * confirmed, so the result is reported `unavailable` rather than returned
     * as a silently truncated `present` set.
     */
    async observeBlockedBy(issueNumber) {
        assertIssueNumber(issueNumber);
        if (!this.capabilities.blockedBy) {
            return { kind: "unavailable", references: [], diagnostics: [capabilityUnsupportedDiagnostic("blocked_by")] };
        }
        const entries = [];
        for (let page = 1; page <= BLOCKED_BY_MAX_PAGES; page += 1) {
            let response;
            try {
                response = await this.reader.requestRepositoryApi(`issues/${issueNumber}/dependencies/blocked_by?per_page=${BLOCKED_BY_PAGE_SIZE}&page=${page}`);
            }
            catch (error) {
                return { kind: "unavailable", references: [], diagnostics: [readFailedDiagnostic(error)] };
            }
            if (response.status === 404) {
                if (page === 1)
                    return { kind: "empty", references: [], diagnostics: [] };
                return {
                    kind: "unavailable",
                    references: [],
                    diagnostics: [
                        {
                            code: "RELATION_RESULT_TRUNCATED",
                            path: "$",
                            message: `GitHub returned 404 while paginating blocked_by at page ${page}; the accumulated evidence cannot be confirmed complete.`,
                        },
                    ],
                };
            }
            if (!Array.isArray(response.body)) {
                return {
                    kind: "malformed",
                    references: [],
                    diagnostics: [responseMalformedDiagnostic("GitHub returned a non-array blocked_by response.")],
                };
            }
            entries.push(...response.body);
            if (response.body.length < BLOCKED_BY_PAGE_SIZE) {
                return classifyBlockedByEntries(entries, this.context);
            }
            if (page === BLOCKED_BY_MAX_PAGES) {
                return {
                    kind: "unavailable",
                    references: [],
                    diagnostics: [
                        {
                            code: "RELATION_RESULT_TRUNCATED",
                            path: "$",
                            message: `GitHub returned at least ${BLOCKED_BY_MAX_PAGES * BLOCKED_BY_PAGE_SIZE} blocked_by entries; the bounded read seam cannot confirm completeness beyond this limit.`,
                        },
                    ],
                };
            }
        }
        /* c8 ignore next */
        return classifyBlockedByEntries(entries, this.context);
    }
}
function classifyBlockedByEntries(entries, context) {
    if (entries.length === 0)
        return { kind: "empty", references: [], diagnostics: [] };
    const references = [];
    const diagnostics = [];
    let malformedCount = 0;
    let unresolvedCount = 0;
    entries.forEach((entry, index) => {
        const resolved = resolveRelatedIssue(entry, context, `$[${index}]`);
        if (resolved.status === "resolved") {
            references.push(resolved.reference);
            return;
        }
        diagnostics.push(resolved.diagnostic);
        if (resolved.status === "malformed")
            malformedCount += 1;
        else
            unresolvedCount += 1;
    });
    if (malformedCount > 0)
        return { kind: "malformed", references: [], diagnostics };
    if (unresolvedCount > 0)
        return { kind: "unavailable", references: [], diagnostics };
    return { kind: "present", references, diagnostics: [] };
}
function resolveRelatedIssue(entry, context, path) {
    if (!isRecord(entry)) {
        return {
            status: "malformed",
            diagnostic: {
                code: "RELATION_ENTRY_MALFORMED",
                path,
                message: "GitHub returned a non-object Issue reference.",
            },
        };
    }
    const number = entry.number;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
        return {
            status: "malformed",
            diagnostic: {
                code: "RELATION_ENTRY_MALFORMED",
                path: `${path}.number`,
                message: "GitHub returned an Issue reference with an invalid number.",
            },
        };
    }
    // A cross-repository relation cannot be resolved through this bounded read
    // seam: requestRepositoryApi only reaches endpoints under the current
    // repository, so a related Issue's stable database ID is available only
    // when its repository_url matches the current repository context.
    const relatedRepository = parseRepositoryUrl(entry.repository_url);
    const sameRepository = relatedRepository !== undefined &&
        relatedRepository.host === context.hostname.toLowerCase() &&
        relatedRepository.nameWithOwner.toLowerCase() === context.nameWithOwner.toLowerCase();
    if (!sameRepository || context.repositoryId === undefined) {
        return {
            status: "unresolved",
            diagnostic: {
                code: "RELATION_REPOSITORY_UNRESOLVED",
                path,
                message: "GitHub returned an Issue reference whose repository identity could not be resolved through the current bounded read seam.",
            },
        };
    }
    const normalized = normalizeIssueReference({
        repositoryHost: context.hostname,
        repositoryId: context.repositoryId,
        repository: context.nameWithOwner,
        number,
    }, path);
    if (!normalized.valid || normalized.reference === undefined) {
        return {
            status: "malformed",
            diagnostic: {
                code: "RELATION_ENTRY_MALFORMED",
                path,
                message: "GitHub returned an Issue reference that failed identity normalization.",
            },
        };
    }
    return { status: "resolved", reference: normalized.reference };
}
function parseRepositoryUrl(value) {
    if (typeof value !== "string")
        return undefined;
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return undefined;
    }
    const match = /^\/(?:api\/v3\/)?repos\/([^/]+)\/([^/]+)\/?$/u.exec(url.pathname);
    if (match === null)
        return undefined;
    const host = url.hostname.toLowerCase() === "api.github.com" ? "github.com" : url.hostname.toLowerCase();
    return { host, nameWithOwner: `${match[1]}/${match[2]}` };
}
function capabilityUnsupportedDiagnostic(relation) {
    return {
        code: "RELATION_CAPABILITY_UNSUPPORTED",
        path: "$",
        message: `The target GitHub capability set does not support reading the native ${relation} relation.`,
    };
}
function responseMalformedDiagnostic(message) {
    return { code: "RELATION_RESPONSE_MALFORMED", path: "$", message };
}
function readFailedDiagnostic(error) {
    return {
        code: "RELATION_READ_FAILED",
        path: "$",
        message: boundedMessage(error instanceof Error ? error.message : "GitHub Issue relation read failed."),
    };
}
function boundedMessage(value) {
    const normalized = value.replace(/\s+/gu, " ").trim();
    return normalized.length > MAX_DIAGNOSTIC_MESSAGE_LENGTH
        ? `${normalized.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH)}…`
        : normalized;
}
function assertIssueNumber(value) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new ContractViolationError("Issue number must be a positive integer.", "issueNumber");
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=issue-relation-observation-adapter.js.map