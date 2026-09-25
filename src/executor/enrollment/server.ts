/** Enrollment-only loopback process entrypoint; normal Executor routes are absent. */
import { createServer, type Server } from "node:http";
import { ExecutorEnrollmentOwner, type ExecutorEnrollmentOwnerOptions } from "./owner.js";

export interface ExecutorEnrollmentProcess {
  readonly owner: ExecutorEnrollmentOwner;
  readonly server: Server;
  readonly endpoint: string;
}

export async function startExecutorEnrollmentProcess(
  options: ExecutorEnrollmentOwnerOptions & { readonly port?: number },
): Promise<ExecutorEnrollmentProcess> {
  const owner = new ExecutorEnrollmentOwner(options);
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("Invalid enrollment port.");
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/enroll") {
      response.writeHead(404).end();
      return;
    }
    void (async () => {
      const capability = request.headers["x-inari-enrollment-capability"];
      const metadata = request.headers["x-inari-enrollment-request"];
      if (typeof capability !== "string" || typeof metadata !== "string" || metadata.length > 4096)
        throw new Error("Invalid enrollment request.");
      const decoded: unknown = JSON.parse(Buffer.from(metadata, "base64url").toString("utf8"));
      const receipt = await owner.enrollStream(
        { token: capability },
        decoded as Parameters<typeof owner.enrollStream>[1],
        request,
      );
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(receipt));
    })().catch(() => {
      response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: "ENROLLMENT_REJECTED" }));
    });
  });
  server.listen(port, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch (error) {
    server.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Enrollment bind failed.");
  }
  return { owner, server, endpoint: `http://127.0.0.1:${address.port}` };
}
