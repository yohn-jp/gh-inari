/**
 * Public Runtime role status for local CLI/console projection (#1108).
 *
 * Everything here is secret-free: it inspects only public environment
 * references and the public loopback health surface. It never imports the
 * Executor or Admission servers (issuer-custody / admission-private), never
 * opens the Issuer App private-key file and never parses key material. The
 * client tests pin these readers to the owning roles' behavior.
 */
import { LOCAL_EXECUTOR_HEALTH_PATH } from "../../local-control/executor-http.js";
import { readLocalRuntimeEndpoint } from "../../local-control/runtime-discovery.js";
import type { SetupDimensionStatus } from "../../runtime-contracts/index.js";
import { LOCAL_ADMISSION_CLIENT_HEALTH_PATH } from "./admission-client.js";

export type LocalExecutorIssuerKeyReferenceStatus = "configured" | "missing";

/** Executor-owned Issuer App private-key file references (inline PEM variables are not accepted). */
const ISSUER_KEY_REFERENCE_VARIABLES = ["INARI_GITHUB_APP_PRIVATE_KEY_FILE", "GITHUB_APP_PRIVATE_KEY_FILE"] as const;

/** Numeric Issuer App ID configured for the local Executor, if any. */
export function localExecutorAppIdReference(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = environment.INARI_GITHUB_APP_ID ?? environment.GITHUB_APP_ID;
  if (value === undefined || !/^[1-9][0-9]{0,19}$/u.test(value.trim())) return undefined;
  return value.trim();
}

/** Whether an Executor-owned Issuer App private-key file reference is set. The file is never opened. */
export function localExecutorIssuerKeyReferenceStatus(
  environment: NodeJS.ProcessEnv = process.env,
): LocalExecutorIssuerKeyReferenceStatus {
  return ISSUER_KEY_REFERENCE_VARIABLES.some((name) => (environment[name]?.trim().length ?? 0) > 0)
    ? "configured"
    : "missing";
}

const RUNTIME_HEALTH_PATH: Readonly<Record<"executor" | "admission", string>> = Object.freeze({
  executor: LOCAL_EXECUTOR_HEALTH_PATH,
  admission: LOCAL_ADMISSION_CLIENT_HEALTH_PATH,
});
const RUNTIME_HEALTH_PROBE_TIMEOUT_MS = 800;

/**
 * Probe one local Runtime role through loopback discovery and its public
 * health surface, reported in the `health` setup dimension vocabulary.
 */
export async function probeLocalRuntimeRoleHealth(
  component: "executor" | "admission",
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Exclude<SetupDimensionStatus<"health">, "unknown">> {
  const discovered = readLocalRuntimeEndpoint(component, environment);
  if (discovered === undefined) return "not-running";
  try {
    const response = await fetch(new URL(RUNTIME_HEALTH_PATH[component], discovered.endpoint), {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(RUNTIME_HEALTH_PROBE_TIMEOUT_MS),
    });
    if (response.status !== 200) return "unhealthy";
    const body: unknown = await response.json();
    const readiness =
      typeof body === "object" && body !== null && "readiness" in body
        ? (body as Record<string, unknown>).readiness
        : undefined;
    return readiness === "ready" ? "healthy" : "unhealthy";
  } catch {
    return "unhealthy";
  }
}
