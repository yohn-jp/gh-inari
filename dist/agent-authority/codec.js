/**
 * Deterministic canonical JSON serialization for Runtime Authority / Session
 * Certificate signing input, plus the base64url codec used by JWS compact
 * encoding.
 *
 * This is RFC 8785 (JSON Canonicalization Scheme) narrowed to the finite
 * value space this repository's signed structures actually use: strings,
 * booleans, null, safe integers, arrays, and plain objects with string keys.
 * JCS's general ECMAScript float-serialization algorithm is deliberately out
 * of scope; a fractional, non-finite, or unsafe-integer number is rejected
 * rather than approximated, so callers never sign bytes whose numeric
 * representation could legitimately differ between implementations.
 */
/** Defends against pathological input; every real signing structure here nests a handful of levels. */
export const MAX_CANONICAL_JSON_DEPTH = 32;
/** Serialize a value using RFC 8785 object-key ordering (UTF-16 code unit order) and minimal encoding. */
export function canonicalJsonString(value) {
    return serialize(value, 0);
}
function serialize(value, depth) {
    if (depth > MAX_CANONICAL_JSON_DEPTH) {
        throw new RangeError(`Canonical JSON exceeds the maximum nesting depth of ${MAX_CANONICAL_JSON_DEPTH}.`);
    }
    if (value === null)
        return "null";
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "string")
        return JSON.stringify(value);
    if (typeof value === "number")
        return serializeNumber(value);
    if (Array.isArray(value))
        return `[${value.map((entry) => serialize(entry, depth + 1)).join(",")}]`;
    if (typeof value === "object")
        return serializeObject(value, depth);
    throw new TypeError("Unsupported canonical JSON value.");
}
function serializeObject(value, depth) {
    const keys = Object.keys(value).sort(compareUtf16CodeUnits);
    const entries = keys.map((key) => `${JSON.stringify(key)}:${serialize(value[key], depth + 1)}`);
    return `{${entries.join(",")}}`;
}
function serializeNumber(value) {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        throw new TypeError("Canonical JSON only supports safe, non-fractional, non-negative-zero integers.");
    }
    return String(value);
}
/** JCS key ordering is UTF-16 code unit order, which is JavaScript's default relational string order. */
function compareUtf16CodeUnits(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/u;
/** Encode UTF-8 text as unpadded base64url, matching JWS/JWK conventions. */
export function base64UrlEncodeText(value) {
    return Buffer.from(value, "utf8").toString("base64url");
}
/** Encode raw bytes as unpadded base64url. */
export function base64UrlEncodeBytes(value) {
    return Buffer.from(value).toString("base64url");
}
/**
 * Decode base64url text to raw bytes. Padding characters are rejected: JWS
 * and JWK both require the unpadded form, so a padded value is malformed
 * input rather than a value to be silently tolerated.
 */
export function base64UrlDecodeToBytes(value) {
    if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) {
        throw new TypeError("Value is not unpadded base64url text.");
    }
    return Buffer.from(value, "base64url");
}
/** Decode base64url text to a UTF-8 string. */
export function base64UrlDecodeToText(value) {
    return base64UrlDecodeToBytes(value).toString("utf8");
}
export function isBase64UrlText(value) {
    return typeof value === "string" && BASE64URL_PATTERN.test(value);
}
//# sourceMappingURL=codec.js.map