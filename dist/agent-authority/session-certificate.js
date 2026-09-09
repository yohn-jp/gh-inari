/**
 * Session Certificate schema, canonical JWS signing input, and offline
 * admission evaluation against a trusted Runtime Authority record.
 *
 * Shape and semantics follow `docs/AGENT_CAPABILITY_AUTHORIZATION.md`
 * section 9: a Runtime-signed JWS (`alg: EdDSA`) binding one ephemeral
 * Session public key to an immutable repository identity, a bounded
 * task/capability claim set, and an expiry no later than the delegating
 * Runtime's `maxSessionTtlSeconds`.
 *
 * Scope boundary: this module defines the deterministic bytes a Runtime
 * signs and a decoder that structurally validates a certificate and detects
 * non-canonical ("drifted") encoding, plus the offline half of admission
 * (section 7.3's `Authority(S) ⊆ CapabilityCeiling(R)`, `TTL(S) <=
 * MaxSessionTTL(R)`, and repository-identity binding). It does not verify
 * the Ed25519 signature, does not hold or generate any private key, and does
 * not evaluate live repository policy or GitHub state
 * (`CurrentStateAdmission` in section 11.1) -- signature verification and
 * full App admission are later Gate 2/3 work.
 */
import { base64UrlDecodeToBytes, base64UrlDecodeToText, base64UrlEncodeText, canonicalJsonString, isBase64UrlText, } from "./codec.js";
import { validateEd25519PublicJwk } from "./ed25519-jwk.js";
import { MAX_ISSUE_NUMBER, capabilityClaimIssueNumber, capabilityClaimWithinCeiling, validateCapabilityClaim, } from "./capability.js";
import { RUNTIME_AUTHORITY_ID_PATTERN, isRuntimeAuthorityActive } from "./runtime-authority.js";
export const SESSION_CERTIFICATE_CONTRACT_VERSION = 1;
export const SESSION_CERTIFICATE_ALG = "EdDSA";
export const SESSION_CERTIFICATE_TYP = "inari-session+jwt";
export const MAX_OPAQUE_ID_LENGTH = 128;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_REPOSITORY_ID_LENGTH = 20;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const MAX_REPOSITORY_NAME_LENGTH = 255;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
export const MAX_CAPABILITIES = 16;
/** 2100-01-01T00:00:00Z; a sanity ceiling against absurd/overflowing Unix-time claims, not a policy default. */
export const MAX_UNIX_TIME_SECONDS = 4_102_444_800;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function createDiagnostic(code, path, message) {
    return { version: SESSION_CERTIFICATE_CONTRACT_VERSION, code, path, message };
}
function requireProperty(input, key, path, diagnostics) {
    if (key in input)
        return true;
    diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_MISSING_PROPERTY", `${path}.${key}`, "Property is required."));
    return false;
}
function addUnknownProperties(input, allowed, path, diagnostics) {
    for (const key of Object.keys(input).sort(compareText)) {
        if (!allowed.has(key))
            diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_UNKNOWN_PROPERTY", `${path}.${key}`, "Property is not accepted."));
    }
}
const HEADER_KEYS = new Set(["alg", "typ", "kid"]);
export function validateSessionCertificateHeader(input, path = "$.header") {
    const diagnostics = [];
    if (!isRecord(input)) {
        return {
            valid: false,
            diagnostics: [createDiagnostic("SESSION_CERTIFICATE_INVALID_ROOT", path, "Header must be an object.")],
        };
    }
    addUnknownProperties(input, HEADER_KEYS, path, diagnostics);
    if (requireProperty(input, "alg", path, diagnostics) && input.alg !== SESSION_CERTIFICATE_ALG) {
        diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_ALG", `${path}.alg`, `alg must be "${SESSION_CERTIFICATE_ALG}".`));
    }
    if (requireProperty(input, "typ", path, diagnostics) && input.typ !== SESSION_CERTIFICATE_TYP) {
        diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_TYP", `${path}.typ`, `typ must be "${SESSION_CERTIFICATE_TYP}".`));
    }
    let kid;
    if (requireProperty(input, "kid", path, diagnostics)) {
        if (typeof input.kid !== "string" || !RUNTIME_AUTHORITY_ID_PATTERN.test(input.kid)) {
            diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_KID", `${path}.kid`, "kid must be a valid Runtime Authority id."));
        }
        else {
            kid = input.kid;
        }
    }
    if (diagnostics.length > 0 || kid === undefined)
        return { valid: false, diagnostics };
    return {
        valid: true,
        value: Object.freeze({ alg: SESSION_CERTIFICATE_ALG, typ: SESSION_CERTIFICATE_TYP, kid }),
        diagnostics: [],
    };
}
const REPOSITORY_KEYS = new Set(["id", "name"]);
function validateRepository(input, path) {
    const diagnostics = [];
    if (!isRecord(input)) {
        return {
            valid: false,
            diagnostics: [createDiagnostic("SESSION_CERTIFICATE_INVALID_REPOSITORY", path, "repository must be an object.")],
        };
    }
    addUnknownProperties(input, REPOSITORY_KEYS, path, diagnostics);
    let id;
    if (requireProperty(input, "id", path, diagnostics)) {
        if (typeof input.id !== "string" ||
            input.id.length > MAX_REPOSITORY_ID_LENGTH ||
            !DECIMAL_ID_PATTERN.test(input.id)) {
            diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_REPOSITORY", `${path}.id`, "repository.id must be an immutable decimal repository ID."));
        }
        else {
            id = input.id;
        }
    }
    let name;
    if (requireProperty(input, "name", path, diagnostics)) {
        if (typeof input.name !== "string" ||
            input.name.length > MAX_REPOSITORY_NAME_LENGTH ||
            !REPOSITORY_NAME_PATTERN.test(input.name) ||
            input.name.split("/").some((segment) => segment === "." || segment === "..")) {
            diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_REPOSITORY", `${path}.name`, "repository.name must be a diagnostic owner/name string."));
        }
        else {
            name = input.name;
        }
    }
    if (diagnostics.length > 0 || id === undefined || name === undefined)
        return { valid: false, diagnostics };
    return { valid: true, value: Object.freeze({ id, name }), diagnostics: [] };
}
const TASK_KEYS = new Set(["kind", "number"]);
function validateTask(input, path) {
    const diagnostics = [];
    if (!isRecord(input)) {
        return {
            valid: false,
            diagnostics: [createDiagnostic("SESSION_CERTIFICATE_INVALID_TASK", path, "task must be an object.")],
        };
    }
    addUnknownProperties(input, TASK_KEYS, path, diagnostics);
    if (requireProperty(input, "kind", path, diagnostics) && input.kind !== "issue") {
        diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_TASK", `${path}.kind`, 'task.kind must be "issue".'));
    }
    let number;
    if (requireProperty(input, "number", path, diagnostics)) {
        const value = input.number;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_ISSUE_NUMBER) {
            diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_TASK", `${path}.number`, "task.number must be a positive Issue number."));
        }
        else {
            number = value;
        }
    }
    if (diagnostics.length > 0 || number === undefined)
        return { valid: false, diagnostics };
    return { valid: true, value: Object.freeze({ kind: "issue", number }), diagnostics: [] };
}
function isValidUnixTime(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_UNIX_TIME_SECONDS;
}
const PAYLOAD_KEYS = new Set([
    "ver",
    "iss",
    "sub",
    "jti",
    "repository",
    "sessionKey",
    "task",
    "capabilities",
    "iat",
    "nbf",
    "exp",
]);
export function validateSessionCertificatePayload(input, path = "$.payload") {
    const diagnostics = [];
    if (!isRecord(input)) {
        return {
            valid: false,
            diagnostics: [createDiagnostic("SESSION_CERTIFICATE_INVALID_ROOT", path, "Payload must be an object.")],
        };
    }
    addUnknownProperties(input, PAYLOAD_KEYS, path, diagnostics);
    if (requireProperty(input, "ver", path, diagnostics) && input.ver !== SESSION_CERTIFICATE_CONTRACT_VERSION) {
        diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_UNSUPPORTED_VERSION", `${path}.ver`, "Session Certificate contract version is unsupported."));
    }
    let issuerId;
    if (requireProperty(input, "iss", path, diagnostics)) {
        const match = typeof input.iss === "string" ? /^runtime:(.+)$/u.exec(input.iss) : null;
        if (match === null || !RUNTIME_AUTHORITY_ID_PATTERN.test(match[1])) {
            diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_ISSUER", `${path}.iss`, 'iss must be "runtime:<Runtime Authority id>".'));
        }
        else {
            issuerId = match[1];
        }
    }
    if (requireProperty(input, "sub", path, diagnostics)) {
        const match = typeof input.sub === "string" ? /^session:(.+)$/u.exec(input.sub) : null;
        if (match === null || !OPAQUE_ID_PATTERN.test(match[1])) {
            diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_SUBJECT", `${path}.sub`, 'sub must be "session:<opaque session id>".'));
        }
    }
    if (requireProperty(input, "jti", path, diagnostics) &&
        (typeof input.jti !== "string" || !OPAQUE_ID_PATTERN.test(input.jti))) {
        diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_JTI", `${path}.jti`, `jti must be a bounded opaque identifier of at most ${MAX_OPAQUE_ID_LENGTH} characters.`));
    }
    const repositoryResult = requireProperty(input, "repository", path, diagnostics)
        ? validateRepository(input.repository, `${path}.repository`)
        : { valid: false, diagnostics: [] };
    diagnostics.push(...repositoryResult.diagnostics);
    let sessionKey;
    if (requireProperty(input, "sessionKey", path, diagnostics)) {
        const keyResult = validateEd25519PublicJwk(input.sessionKey, `${path}.sessionKey`);
        if (!keyResult.valid || keyResult.value === undefined) {
            diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_SESSION_KEY", `${path}.sessionKey`, "sessionKey must be a valid Ed25519 public JWK."));
        }
        else {
            sessionKey = keyResult.value;
        }
    }
    let task;
    if ("task" in input) {
        const taskResult = validateTask(input.task, `${path}.task`);
        diagnostics.push(...taskResult.diagnostics);
        task = taskResult.value;
    }
    let capabilities;
    if (requireProperty(input, "capabilities", path, diagnostics)) {
        const value = input.capabilities;
        if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CAPABILITIES) {
            diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_CAPABILITIES", `${path}.capabilities`, `capabilities must contain 1-${MAX_CAPABILITIES} capability claims.`));
        }
        else {
            const normalized = [];
            const seen = new Set();
            let ok = true;
            value.forEach((entry, index) => {
                const claimResult = validateCapabilityClaim(entry, `${path}.capabilities[${index}]`);
                if (!claimResult.valid || claimResult.value === undefined) {
                    for (const d of claimResult.diagnostics) {
                        diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_CAPABILITIES", d.path, d.message));
                    }
                    ok = false;
                    return;
                }
                const fingerprint = canonicalJsonString(claimResult.value);
                if (seen.has(fingerprint)) {
                    diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_CAPABILITIES", `${path}.capabilities[${index}]`, "Duplicate capability claim."));
                    ok = false;
                    return;
                }
                seen.add(fingerprint);
                normalized.push(claimResult.value);
            });
            if (ok)
                capabilities = Object.freeze(normalized);
        }
    }
    if (task !== undefined && capabilities !== undefined) {
        capabilities.forEach((claim, index) => {
            const issue = capabilityClaimIssueNumber(claim);
            if (issue !== undefined && issue !== task.number) {
                diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_TASK_SCOPE_MISMATCH", `${path}.capabilities[${index}].issue`, "A change.* capability's issue must match the certificate task; a certificate cannot widen scope beyond its declared task."));
            }
        });
    }
    let iat;
    let nbf;
    let exp;
    if (requireProperty(input, "iat", path, diagnostics)) {
        if (!isValidUnixTime(input.iat))
            diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_TIME", `${path}.iat`, "iat must be a bounded Unix-seconds integer."));
        else
            iat = input.iat;
    }
    if (requireProperty(input, "nbf", path, diagnostics)) {
        if (!isValidUnixTime(input.nbf))
            diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_TIME", `${path}.nbf`, "nbf must be a bounded Unix-seconds integer."));
        else
            nbf = input.nbf;
    }
    if (requireProperty(input, "exp", path, diagnostics)) {
        if (!isValidUnixTime(input.exp))
            diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_TIME", `${path}.exp`, "exp must be a bounded Unix-seconds integer."));
        else
            exp = input.exp;
    }
    if (nbf !== undefined && exp !== undefined && nbf > exp) {
        diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_TIME", `${path}.exp`, "exp must not precede nbf."));
    }
    if (iat !== undefined && exp !== undefined && iat > exp) {
        diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_TIME", `${path}.iat`, "iat must not be after exp."));
    }
    if (diagnostics.length > 0 ||
        issuerId === undefined ||
        repositoryResult.value === undefined ||
        sessionKey === undefined ||
        capabilities === undefined ||
        iat === undefined ||
        nbf === undefined ||
        exp === undefined) {
        return { valid: false, diagnostics };
    }
    return {
        valid: true,
        value: Object.freeze({
            ver: SESSION_CERTIFICATE_CONTRACT_VERSION,
            iss: `runtime:${issuerId}`,
            sub: input.sub,
            jti: input.jti,
            repository: repositoryResult.value,
            sessionKey,
            ...(task === undefined ? {} : { task }),
            capabilities,
            iat,
            nbf,
            exp,
        }),
        diagnostics: [],
    };
}
function headerIssuerConsistency(header, payload) {
    if (payload.iss !== `runtime:${header.kid}`) {
        return createDiagnostic("SESSION_CERTIFICATE_HEADER_ISSUER_MISMATCH", "$.payload.iss", "payload.iss must reference the same Runtime Authority id as header.kid.");
    }
    return undefined;
}
/**
 * Build the deterministic JWS signing input for a header/payload pair: each
 * segment is the base64url encoding of its RFC 8785 canonical JSON form, so
 * two independent conformant implementations produce byte-identical output
 * for the same claims.
 */
export function sessionCertificateSigningInput(header, payload) {
    const headerResult = validateSessionCertificateHeader(header);
    if (!headerResult.valid || headerResult.value === undefined)
        throw new SessionCertificateValidationError(headerResult.diagnostics);
    const payloadResult = validateSessionCertificatePayload(payload);
    if (!payloadResult.valid || payloadResult.value === undefined)
        throw new SessionCertificateValidationError(payloadResult.diagnostics);
    const consistency = headerIssuerConsistency(headerResult.value, payloadResult.value);
    if (consistency !== undefined)
        throw new SessionCertificateValidationError([consistency]);
    const encodedHeader = base64UrlEncodeText(canonicalJsonString(headerResult.value));
    const encodedPayload = base64UrlEncodeText(canonicalJsonString(payloadResult.value));
    return { encodedHeader, encodedPayload, signingInput: `${encodedHeader}.${encodedPayload}` };
}
/** Assemble the three-segment compact JWS from an already-computed Ed25519 signature (base64url, 64 raw bytes). */
export function encodeSessionCertificateCompact(header, payload, signature) {
    const { signingInput } = sessionCertificateSigningInput(header, payload);
    if (!isBase64UrlText(signature) || base64UrlDecodeToBytes(signature).length !== 64) {
        throw new TypeError("Ed25519 signature must be unpadded base64url encoding 64 raw bytes.");
    }
    return `${signingInput}.${signature}`;
}
const MAX_COMPACT_LENGTH = 16_384;
/**
 * Parse and structurally validate a compact Session Certificate. This never
 * verifies the Ed25519 signature; it verifies structure, bounds, and that
 * the wire encoding is exactly the canonical encoding this module would have
 * produced (a mismatch here -- "signature-input drift" -- means the bytes an
 * eventual verifier would recompute the signature over are not the bytes the
 * decoded claims canonicalize to, which is rejected outright rather than
 * silently re-canonicalized).
 */
export function decodeSessionCertificateCompact(compact) {
    const diagnostics = [];
    if (typeof compact !== "string" || compact.length === 0 || compact.length > MAX_COMPACT_LENGTH) {
        return {
            valid: false,
            diagnostics: [
                createDiagnostic("SESSION_CERTIFICATE_INVALID_ENCODING", "$", "Compact certificate must be a bounded non-empty string."),
            ],
        };
    }
    const segments = compact.split(".");
    if (segments.length !== 3 || segments.some((segment) => segment.length === 0 || !isBase64UrlText(segment))) {
        return {
            valid: false,
            diagnostics: [
                createDiagnostic("SESSION_CERTIFICATE_INVALID_ENCODING", "$", "Compact certificate must be three non-empty base64url segments."),
            ],
        };
    }
    const [encodedHeader, encodedPayload, signature] = segments;
    let headerJson;
    let payloadJson;
    try {
        headerJson = JSON.parse(base64UrlDecodeToText(encodedHeader));
    }
    catch {
        diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_ENCODING", "$.header", "Header segment is not valid JSON."));
    }
    try {
        payloadJson = JSON.parse(base64UrlDecodeToText(encodedPayload));
    }
    catch {
        diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_ENCODING", "$.payload", "Payload segment is not valid JSON."));
    }
    if (diagnostics.length > 0)
        return { valid: false, diagnostics };
    const headerResult = validateSessionCertificateHeader(headerJson);
    const payloadResult = validateSessionCertificatePayload(payloadJson);
    diagnostics.push(...headerResult.diagnostics, ...payloadResult.diagnostics);
    if (headerResult.value !== undefined && payloadResult.value !== undefined) {
        const consistency = headerIssuerConsistency(headerResult.value, payloadResult.value);
        if (consistency !== undefined)
            diagnostics.push(consistency);
    }
    if (base64UrlDecodeToBytes(signature).length !== 64) {
        diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_INVALID_ENCODING", "$.signature", "Signature segment must decode to exactly 64 raw bytes."));
    }
    if (diagnostics.length > 0 || headerResult.value === undefined || payloadResult.value === undefined) {
        return { valid: false, diagnostics };
    }
    const canonicalEncodedHeader = base64UrlEncodeText(canonicalJsonString(headerResult.value));
    const canonicalEncodedPayload = base64UrlEncodeText(canonicalJsonString(payloadResult.value));
    if (canonicalEncodedHeader !== encodedHeader) {
        diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_CANONICAL_DRIFT", "$.header", "Header segment is not the canonical JCS encoding of its own claims."));
    }
    if (canonicalEncodedPayload !== encodedPayload) {
        diagnostics.push(createDiagnostic("SESSION_CERTIFICATE_CANONICAL_DRIFT", "$.payload", "Payload segment is not the canonical JCS encoding of its own claims."));
    }
    if (diagnostics.length > 0)
        return { valid: false, diagnostics };
    return {
        valid: true,
        value: Object.freeze({
            header: headerResult.value,
            payload: payloadResult.value,
            signingInput: `${encodedHeader}.${encodedPayload}`,
            signature,
        }),
        diagnostics: [],
    };
}
export class SessionCertificateValidationError extends Error {
    diagnostics;
    constructor(diagnostics) {
        const first = diagnostics[0];
        super(first === undefined ? "Session Certificate is invalid." : `${first.path}: ${first.message}`);
        this.name = "SessionCertificateValidationError";
        this.diagnostics = diagnostics;
    }
}
/**
 * Offline half of architecture doc section 7.3/11.1's `EffectiveAuthority`
 * intersection: repository binding, Runtime trust/activity, TTL ceiling, and
 * capability ceiling containment. `RepositoryPolicy(current canonical ref)`
 * and `CurrentStateAdmission(GitHub evidence)` require live repository/App
 * state and are explicitly out of scope for this schema-only Issue.
 */
export function evaluateSessionCertificateAgainstRuntimeAuthority(certificate, context) {
    const diagnostics = [];
    const { header, payload } = certificate;
    const { runtimeAuthority, expectedRepositoryId, now } = context;
    if (header.kid !== runtimeAuthority.id || payload.iss !== `runtime:${runtimeAuthority.id}`) {
        diagnostics.push({
            code: "SESSION_CERTIFICATE_UNTRUSTED_RUNTIME",
            path: "$.header.kid",
            message: "Certificate issuer does not match the supplied Runtime Authority.",
        });
    }
    else if (!isRuntimeAuthorityActive(runtimeAuthority, now)) {
        diagnostics.push({
            code: "SESSION_CERTIFICATE_RUNTIME_NOT_ACTIVE",
            path: "$.runtimeAuthority.status",
            message: "The delegating Runtime Authority is not currently active.",
        });
    }
    if (payload.repository.id !== expectedRepositoryId) {
        diagnostics.push({
            code: "SESSION_CERTIFICATE_REPOSITORY_MISMATCH",
            path: "$.payload.repository.id",
            message: "Certificate repository ID does not match the expected repository; repository.name is diagnostic-only and is never the security binding.",
        });
    }
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (nowSeconds < payload.nbf) {
        diagnostics.push({
            code: "SESSION_CERTIFICATE_NOT_YET_VALID",
            path: "$.payload.nbf",
            message: "Certificate is not yet valid.",
        });
    }
    if (nowSeconds > payload.exp) {
        diagnostics.push({
            code: "SESSION_CERTIFICATE_EXPIRED",
            path: "$.payload.exp",
            message: "Certificate has expired.",
        });
    }
    if (payload.exp - payload.nbf > runtimeAuthority.maxSessionTtlSeconds) {
        diagnostics.push({
            code: "SESSION_CERTIFICATE_TTL_EXCEEDS_RUNTIME_CEILING",
            path: "$.payload.exp",
            message: "Certificate validity window exceeds the delegating Runtime's maxSessionTtlSeconds.",
        });
    }
    payload.capabilities.forEach((claim, index) => {
        if (!capabilityClaimWithinCeiling(claim, runtimeAuthority.capabilityCeiling)) {
            diagnostics.push({
                code: "SESSION_CERTIFICATE_CAPABILITY_EXCEEDS_RUNTIME_CEILING",
                path: `$.payload.capabilities[${index}].kind`,
                message: "Capability claim is outside the delegating Runtime's capabilityCeiling.",
            });
        }
    });
    return { admitted: diagnostics.length === 0, diagnostics };
}
//# sourceMappingURL=session-certificate.js.map