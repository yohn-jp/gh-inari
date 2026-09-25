/** Opaque, bounded enrollment bytes; interpretation belongs to the owner port. */
import type { IncomingMessage } from "node:http";
import { MAX_SECRET_ENROLLMENT_BYTES } from "../runtime-contracts/enrollment.js";
import type { SetupEnrollmentUpload } from "../application/setup/actions.js";

export function enrollmentUpload(request: IncomingMessage): SetupEnrollmentUpload {
  const header = request.headers["content-length"];
  const length = typeof header === "string" && /^(?:[1-9][0-9]*)$/u.test(header) ? Number(header) : NaN;
  if (
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > MAX_SECRET_ENROLLMENT_BYTES ||
    request.headers["transfer-encoding"] !== undefined
  ) {
    throw new Error("Invalid enrollment length.");
  }
  return {
    declaredBytes: length,
    stream: (async function* () {
      let received = 0;
      for await (const chunk of request) {
        received += chunk.length;
        if (received > length) throw new Error("Enrollment length exceeded.");
        yield chunk as Uint8Array;
      }
      if (received !== length) throw new Error("Enrollment length mismatch.");
    })(),
  };
}
