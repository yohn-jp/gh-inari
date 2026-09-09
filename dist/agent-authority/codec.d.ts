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
export type CanonicalJsonPrimitive = string | number | boolean | null;
export type CanonicalJsonValue = CanonicalJsonPrimitive | readonly CanonicalJsonValue[] | {
    readonly [key: string]: CanonicalJsonValue;
};
/** Defends against pathological input; every real signing structure here nests a handful of levels. */
export declare const MAX_CANONICAL_JSON_DEPTH: 32;
/** Serialize a value using RFC 8785 object-key ordering (UTF-16 code unit order) and minimal encoding. */
export declare function canonicalJsonString(value: CanonicalJsonValue): string;
/** Encode UTF-8 text as unpadded base64url, matching JWS/JWK conventions. */
export declare function base64UrlEncodeText(value: string): string;
/** Encode raw bytes as unpadded base64url. */
export declare function base64UrlEncodeBytes(value: Uint8Array): string;
/**
 * Decode base64url text to raw bytes. Padding characters are rejected: JWS
 * and JWK both require the unpadded form, so a padded value is malformed
 * input rather than a value to be silently tolerated.
 */
export declare function base64UrlDecodeToBytes(value: string): Buffer;
/** Decode base64url text to a UTF-8 string. */
export declare function base64UrlDecodeToText(value: string): string;
export declare function isBase64UrlText(value: unknown): value is string;
