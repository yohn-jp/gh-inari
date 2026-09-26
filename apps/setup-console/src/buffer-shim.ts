/**
 * Browser stand-in for the one Node `Buffer` member the shared setup contract
 * validators use (`Buffer.byteLength(text, "utf8")`). The packaged console
 * build injects it for free `Buffer` references so the canonical validators
 * run unchanged in the browser. Anything else is unsupported and throws.
 */
const encoder = new TextEncoder();

export const Buffer = Object.freeze({
  byteLength(value: string, encoding: "utf8" = "utf8"): number {
    if (typeof value !== "string" || encoding !== "utf8") throw new TypeError("Unsupported byteLength input.");
    return encoder.encode(value).byteLength;
  },
});
