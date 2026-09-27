/** Repository-owned termination evidence for one authorized Implementation task. */
import { canonicalJsonString, type CanonicalJsonValue } from "../agent-authority/codec.js";
import {
  MAX_IMPLEMENTATION_TASK_TERMINATION_RECORD_BYTES,
  observeImplementationTaskTermination,
  validateImplementationTaskTerminationRecord,
  type ImplementationTaskTerminationObservationResult,
  type ImplementationTaskTerminationRecord,
} from "../implementation-task-termination.js";
import {
  validateImplementationAuthorizationRecord,
  type ImplementationAuthorizationRecord,
} from "../implementation-authorization.js";
import type { GitHubBranchAdvanceCapability } from "./git-data-capability.js";

export const TASK_TERMINATION_RECORD_DIRECTORY = ".inari/task-termination" as const;
export const TASK_TERMINATION_METADATA_BRANCH = "inari/task-termination" as const;
const ZERO_OID = "0".repeat(40);

type Snapshot = {
  readonly observation: ImplementationTaskTerminationObservationResult;
  /** Existing metadata head, or the accepted base commit for first creation. */
  readonly head?: string;
  readonly tree?: string;
  readonly metadataExists?: boolean;
};

export type TaskTerminationFinalization =
  | {
      readonly status: "success";
      readonly observation: ImplementationTaskTerminationObservationResult;
      readonly replay: boolean;
    }
  | { readonly status: "denied"; readonly observation?: ImplementationTaskTerminationObservationResult }
  | { readonly status: "possible-effect"; readonly observation: ImplementationTaskTerminationObservationResult };

function sameRepository(
  authorization: ImplementationAuthorizationRecord,
  capability: GitHubBranchAdvanceCapability,
): boolean {
  const expected = authorization.repository;
  const actual = capability.scope?.repository;
  return (
    actual !== undefined &&
    actual.repositoryHost.toLowerCase() === expected.repositoryHost.toLowerCase() &&
    actual.repositoryId === expected.repositoryId &&
    (expected.repository === undefined || actual.nameWithOwner.toLowerCase() === expected.repository.toLowerCase())
  );
}

function unavailable(authorization: ImplementationAuthorizationRecord): ImplementationTaskTerminationObservationResult {
  return observeImplementationTaskTermination(
    { status: "unavailable", provenance: { source: "github-git-data" } },
    authorization,
  );
}

function invalid(authorization: ImplementationAuthorizationRecord): ImplementationTaskTerminationObservationResult {
  return observeImplementationTaskTermination(
    {
      status: "authoritative",
      provenance: { source: "github-git-data" },
      records: [{ record: null, provenance: { source: "github-git-data" } }],
    },
    authorization,
  );
}

function pathFor(authorization: ImplementationAuthorizationRecord): string {
  return `${TASK_TERMINATION_RECORD_DIRECTORY}/implementation-${authorization.implementation.number}.json`;
}

async function snapshot(
  capability: GitHubBranchAdvanceCapability,
  authorization: ImplementationAuthorizationRecord,
): Promise<Snapshot> {
  if (!sameRepository(authorization, capability)) return { observation: invalid(authorization) };
  try {
    const baseRef = await capability.readRef(authorization.base.branch);
    if (baseRef === undefined) {
      return { observation: unavailable(authorization) };
    }
    if (baseRef.ref !== `refs/heads/${authorization.base.branch}` || baseRef.sha !== authorization.base.revision) {
      return { observation: invalid(authorization) };
    }
    const metadataRef = await capability.readRef(TASK_TERMINATION_METADATA_BRANCH);
    if (metadataRef !== undefined && metadataRef.ref !== `refs/heads/${TASK_TERMINATION_METADATA_BRANCH}`) {
      return { observation: invalid(authorization) };
    }
    const head = metadataRef?.sha ?? baseRef.sha;
    const commit = await capability.readCommit(head);
    const tree = await capability.readTree(commit.treeSha);
    if (commit.sha !== head || tree.sha !== commit.treeSha) return { observation: invalid(authorization) };
    if (metadataRef === undefined) {
      return {
        observation: observeImplementationTaskTermination(
          { status: "authoritative", provenance: { source: "github-git-data", commit: baseRef.sha }, records: [] },
          authorization,
        ),
        head,
        tree: tree.sha,
        metadataExists: false,
      };
    }
    const entries = tree.entries.filter((entry) => entry.path === pathFor(authorization));
    if (entries.length > 1 || (entries.length === 1 && (entries[0]?.type !== "blob" || entries[0].mode !== "100644"))) {
      return { observation: invalid(authorization) };
    }
    if (entries.length === 0) {
      return {
        observation: observeImplementationTaskTermination(
          { status: "authoritative", provenance: { source: "github-git-data", commit: metadataRef.sha }, records: [] },
          authorization,
        ),
        head: metadataRef.sha,
        tree: tree.sha,
        metadataExists: true,
      };
    }
    if (capability.readBlob === undefined) return { observation: unavailable(authorization) };
    const content = await capability.readBlob(entries[0]!.sha);
    if (Buffer.byteLength(content, "utf8") > MAX_IMPLEMENTATION_TASK_TERMINATION_RECORD_BYTES) {
      return { observation: invalid(authorization) };
    }
    let record: unknown;
    try {
      record = JSON.parse(content) as unknown;
    } catch {
      return { observation: invalid(authorization) };
    }
    return {
      observation: observeImplementationTaskTermination(
        {
          status: "authoritative",
          provenance: { source: "github-git-data", commit: metadataRef.sha },
          records: [{ record, provenance: { path: pathFor(authorization) } }],
        },
        authorization,
      ),
      head: metadataRef.sha,
      tree: tree.sha,
      metadataExists: true,
    };
  } catch {
    return { observation: unavailable(authorization) };
  }
}

/** Exact current read through the Executor's repository-scoped App capability. */
export async function readTaskTerminationRecord(
  capability: GitHubBranchAdvanceCapability,
  currentAuthorization: unknown,
): Promise<ImplementationTaskTerminationObservationResult> {
  const checked = validateImplementationAuthorizationRecord(currentAuthorization);
  if (!checked.valid || checked.record === undefined)
    return invalid(currentAuthorization as ImplementationAuthorizationRecord);
  return (await snapshot(capability, checked.record)).observation;
}

function sameRecord(left: ImplementationTaskTerminationRecord, right: ImplementationTaskTerminationRecord): boolean {
  return (
    canonicalJsonString(left as unknown as CanonicalJsonValue) ===
    canonicalJsonString(right as unknown as CanonicalJsonValue)
  );
}

/** Conditionally append one record. Any uncertain ref effect is reconciled once, without retry. */
export async function finalizeTaskTerminationRecord(
  capability: GitHubBranchAdvanceCapability,
  currentAuthorization: unknown,
  proposedRecord: unknown,
): Promise<TaskTerminationFinalization> {
  const checked = validateImplementationAuthorizationRecord(currentAuthorization);
  if (!checked.valid || checked.record === undefined) return { status: "denied" };
  const authorization = checked.record;
  const validated = validateImplementationTaskTerminationRecord(proposedRecord, authorization);
  if (!validated.valid || validated.record === undefined || !sameRepository(authorization, capability)) {
    return { status: "denied" };
  }
  const before = await snapshot(capability, authorization);
  if (before.observation.status === "present") {
    return sameRecord(before.observation.record, validated.record)
      ? { status: "success", observation: before.observation, replay: true }
      : { status: "denied", observation: before.observation };
  }
  if (before.observation.status !== "absent" || before.head === undefined || before.tree === undefined) {
    return { status: "denied", observation: before.observation };
  }
  const content = canonicalJsonString(validated.record as unknown as CanonicalJsonValue);
  let afterOid: string;
  try {
    const blob = await capability.createBlob({ content: Buffer.from(content, "utf8").toString("base64") });
    const tree = await capability.createTree({
      baseTreeSha: before.tree,
      entries: [{ path: pathFor(authorization), mode: "100644", type: "blob", sha: blob.sha }],
    });
    const commit = await capability.createCommit({
      message: `Record Implementation #${authorization.implementation.number} termination`,
      treeSha: tree.sha,
      parents: [before.head],
    });
    afterOid = commit.sha;
  } catch {
    return { status: "denied", observation: before.observation };
  }
  // Git-object creation is inert. Recheck the fixed base immediately before the ref effect.
  try {
    const baseRef = await capability.readRef(authorization.base.branch);
    if (
      baseRef === undefined ||
      baseRef.ref !== `refs/heads/${authorization.base.branch}` ||
      baseRef.sha !== authorization.base.revision
    ) {
      return { status: "denied", observation: invalid(authorization) };
    }
  } catch {
    return { status: "denied", observation: unavailable(authorization) };
  }
  try {
    await capability.compareAndAdvanceRef({
      branch: TASK_TERMINATION_METADATA_BRANCH,
      beforeOid: before.metadataExists ? before.head : ZERO_OID,
      afterOid,
      force: false,
    });
  } catch {
    // The ref update may have reached GitHub. Reconcile by read; never retry it.
  }
  const after = await snapshot(capability, authorization);
  if (after.observation.status === "present" && sameRecord(after.observation.record, validated.record)) {
    return { status: "success", observation: after.observation, replay: false };
  }
  return { status: "possible-effect", observation: after.observation };
}
