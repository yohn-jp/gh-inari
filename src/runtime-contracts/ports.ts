/**
 * Public Runtime role ports (#1098).
 *
 * Every port reuses the canonical domain types: `AuthorizedExecution` /
 * `AuthorizedExecutionResult` for Executor effects, `LocalSessionBinding` and
 * `ExecutionIntent` for Admission Sessions, `SignedChangeProvenanceRecord` for
 * initiating-Runtime Authority signing and `RepositoryIdentity` for
 * repositories. Ports carry no credential, key path or provider client; the
 * implementing owner holds those privately.
 */
import type { AuthorizedExecution, AuthorizedExecutionResult } from "../authorized-execution.js";
import type { SignedChangeProvenanceRecord } from "../change-provenance-record.js";
import type { RepositoryIdentity } from "../github/effect-authorizer.js";
import type { ExecutionIntent } from "../local-control/execution-intent.js";
import type { LocalSessionBinding } from "../local-control/session-binding.js";
import type { RuntimeComponent } from "./components.js";
import type {
  SetupActionRequest,
  SetupActionResult,
  SetupDimensionObservation,
  SetupJournalEntry,
  SetupObservation,
} from "./setup.js";

/**
 * Executor effect port. Admission reaches the Executor only through this port
 * (implemented today by the neutral `LocalExecutorClient`).
 */
export interface ExecutorExecutionPort {
  resolveRepository(repositoryNameWithOwner: string): Promise<RepositoryIdentity>;
  execute(execution: AuthorizedExecution): Promise<AuthorizedExecutionResult>;
}

/** Repository identity as returned on the existing Admission wire. */
export interface AdmissionRepositoryIdentity {
  readonly host: "github.com";
  readonly repositoryId: string;
  readonly nameWithOwner: string;
}

/**
 * Admission Session port consumed by the CLI (implemented today by
 * `createLocalAdmissionClient`). Admission holds no GitHub credential.
 */
export interface AdmissionSessionPort {
  resolveRepository(repositoryNameWithOwner: string): Promise<AdmissionRepositoryIdentity>;
  registerSession(binding: LocalSessionBinding): Promise<{ readonly id: string; readonly status: string }>;
  closeSession(binding: LocalSessionBinding): Promise<{ readonly id: string; readonly status: string }>;
  executeIntent(intent: ExecutionIntent, sessionId: string): Promise<unknown>;
}

/**
 * Initiating-Runtime Authority signing port. The private signing key stays in
 * the Authority owner; Admission and Executor never implement or receive it.
 */
export interface AuthoritySigningPort {
  signChangeProvenance(rootIssue: number): Promise<SignedChangeProvenanceRecord>;
}

/**
 * Public status of one Runtime role, so CLI/console projection needs no
 * private role import. Health and configuration stay separate dimensions.
 */
export interface RuntimeRoleStatus {
  readonly component: Extract<RuntimeComponent, "admission" | "executor">;
  readonly configuration: SetupDimensionObservation<"configuration">;
  readonly health: SetupDimensionObservation<"health">;
  /** Executor only: binding of the Issuer App installation to the repository. */
  readonly providerBinding?: SetupDimensionObservation<"provider-binding">;
}

export interface RuntimeRoleStatusPort {
  observe(repository: RepositoryIdentity): Promise<RuntimeRoleStatus>;
}

/** Reads never initiate actions. */
export interface SetupObservationPort {
  observe(repository: RepositoryIdentity): Promise<SetupObservation>;
}

/**
 * Performs one previously offered action. Implementations reject a request
 * whose generation is stale or whose repository differs (`stale`), and
 * report unobserved effects as `unknown` instead of replaying blindly.
 */
export interface SetupActionPort {
  perform(request: SetupActionRequest): Promise<SetupActionResult>;
}

/** Bounded, secret-free setup journal; persistence is supplied by composition. */
export interface SetupJournalPort {
  append(entry: SetupJournalEntry): Promise<void>;
  /** At most `MAX_SETUP_JOURNAL_ENTRIES` (see setup.ts) newest entries for the repository. */
  read(repository: RepositoryIdentity): Promise<readonly SetupJournalEntry[]>;
}
