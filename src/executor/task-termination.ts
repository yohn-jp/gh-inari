/** Executor-only composition of current task authority and repository termination evidence. */
import {
  tryVerifyImplementationAuthorization,
  validateImplementationAuthorizationRecord,
  type ImplementationAuthorizationRecord,
} from "../implementation-authorization.js";
import {
  observeImplementationTaskTermination,
  type ImplementationTaskTerminationObservationResult,
} from "../implementation-task-termination.js";
import type { CurrentImplementationAdmissionEvidence } from "../implementation-frontier-composition.js";
import type { GitHubBranchAdvanceCapability } from "../github/git-data-capability.js";
import { GitHubBranchAdvanceCapabilityImpl } from "../github/git-data-capability.js";
import type { GitHubAppRepositoryReadCapability } from "../github/app-installation-credential-broker.js";
import type { RepositoryIdentity } from "../github/effect-authorizer.js";
import {
  finalizeTaskTerminationRecord,
  readTaskTerminationRecord,
  type TaskTerminationFinalization,
} from "../github/task-termination-record.js";

/** Reuse Git data read validation with the broker's read-only App capability. */
export function taskTerminationReadCapability(
  capability: GitHubAppRepositoryReadCapability,
  identity: RepositoryIdentity,
): GitHubBranchAdvanceCapability {
  const parts = identity.nameWithOwner.split("/");
  if (parts.length !== 2) throw new TypeError("Repository locator is invalid.");
  if (
    capability.scope.repository.repositoryHost.toLowerCase() !== identity.repositoryHost.toLowerCase() ||
    capability.scope.repository.repositoryId !== identity.repositoryId ||
    capability.scope.repository.nameWithOwner.toLowerCase() !== identity.nameWithOwner.toLowerCase()
  )
    throw new TypeError("Task evidence repository binding is invalid.");
  return new GitHubBranchAdvanceCapabilityImpl({
    repository: { hostname: identity.repositoryHost, owner: parts[0]!, name: parts[1]! },
    repositoryId: identity.repositoryId,
    // This adapter can only GET. The node ID is never sent by its read methods.
    repositoryNodeId: "read-only-task-termination",
    scope: capability.scope,
    transport: {
      request: (request) => {
        if (request.method !== "GET") throw new TypeError("Task evidence capability is read-only.");
        return capability.transport.request({ hostname: request.hostname, method: "GET", path: request.path });
      },
      requestGraphql: async () => {
        throw new TypeError("Task evidence capability is read-only.");
      },
    },
  });
}

function currentAuthorization(
  supplied: unknown,
  current: CurrentImplementationAdmissionEvidence,
): ImplementationAuthorizationRecord | undefined {
  const checked = validateImplementationAuthorizationRecord(supplied);
  if (!checked.valid || checked.record === undefined) return undefined;
  const result = tryVerifyImplementationAuthorization({
    authorization: checked.record,
    implementation: current.implementation,
    issue: current.issue,
    repository: current.repository,
    base: current.base,
    readiness: current.readiness,
  });
  return result.valid && result.current && result.authorized ? checked.record : undefined;
}

/** A malformed or drifted authorization cannot establish authoritative absence. */
function invalid(supplied: unknown): ImplementationTaskTerminationObservationResult {
  return observeImplementationTaskTermination(null, supplied);
}

export async function readExecutorTaskTermination(
  capability: GitHubBranchAdvanceCapability,
  suppliedAuthorization: unknown,
  current: CurrentImplementationAdmissionEvidence,
): Promise<ImplementationTaskTerminationObservationResult> {
  const authorization = currentAuthorization(suppliedAuthorization, current);
  return authorization === undefined
    ? invalid(suppliedAuthorization)
    : readTaskTerminationRecord(capability, authorization);
}

/** Internal effect only. The future operator route must establish caller authority first. */
export async function finalizeExecutorTaskTermination(
  capability: GitHubBranchAdvanceCapability,
  suppliedAuthorization: unknown,
  current: CurrentImplementationAdmissionEvidence,
  proposedRecord: unknown,
): Promise<TaskTerminationFinalization> {
  const authorization = currentAuthorization(suppliedAuthorization, current);
  if (authorization === undefined) return { status: "denied", observation: invalid(suppliedAuthorization) };
  return finalizeTaskTerminationRecord(capability, authorization, proposedRecord);
}
