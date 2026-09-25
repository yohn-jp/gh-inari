/**
 * Canonical setup state and next-action computation (#1099 / #1110).
 *
 * One pure projection turns an owner-supplied `SetupObservation` plus the
 * bounded, secret-free setup journal into steps, allowed actions and exactly
 * one next action. CLI and Web render this state; they do not derive legality
 * or completion themselves.
 *
 * The projection performs no effect: it never calls an action port, appends a
 * journal entry, reads a file or touches a secret. Evidence is trusted only
 * when it is known, bound to the observed repository and configuration
 * generation, and fresh. Unknown, stale or wrong-repository evidence is never
 * complete and never enables an action. Publication of trust is not trust:
 * only a `trusted` repository-trust observation completes that step. Health is
 * not provider binding, trust or Session readiness.
 */
import {
  MAX_SETUP_DIAGNOSTICS,
  MAX_SETUP_JOURNAL_ENTRIES,
  SETUP_CONTRACT_VERSION,
  SETUP_DIMENSIONS,
  SETUP_OBSERVATION_MEMBERS,
  assertSecretFreeSetupJson,
  validateSetupAction,
  validateSetupJournalEntry,
  validateSetupObservation,
  type RuntimeComponent,
  type SetupAction,
  type SetupActionOutcome,
  type SetupDiagnostic,
  type SetupDimension,
  type SetupDimensionObservation,
  type SetupGeneration,
  type SetupInputRequirement,
  type SetupJournalEntry,
  type SetupObservation,
  type SetupPrerequisite,
  type StructuredCommand,
} from "../../runtime-contracts/index.js";

/** Version of the public setup state below; bump on any incompatible change. */
export const SETUP_STATE_VERSION = 1 as const;

export type SetupRepository = SetupGeneration["repository"];

/**
 * Overall setup stage: the first incomplete step in canonical order decides
 * it. `unknown` means the deciding evidence is unknown, stale or for another
 * repository, so no stage can be claimed.
 */
export const SETUP_STAGES = Object.freeze([
  "unknown",
  "clean",
  "partial",
  "configured",
  "pending-human-trust",
  "trusted",
  "healthy",
  "task-ready",
] as const);
export type SetupStage = (typeof SETUP_STAGES)[number];

export const SETUP_STEP_STATUSES = Object.freeze([
  "complete",
  "missing-input",
  "ready",
  "in-progress",
  "external-human-wait",
  "blocked",
  "failed",
  "uncertain",
] as const);
export type SetupStepStatus = (typeof SETUP_STEP_STATUSES)[number];

export type SetupBlockReason =
  | "repository-mismatch"
  | "evidence-unknown"
  | "evidence-stale"
  | "journal-invalid"
  | "prerequisite"
  | "owner-resolution";

export type SetupEvidenceFreshness = "fresh" | "unknown" | "stale" | "repository-mismatch";

export interface SetupDimensionState {
  readonly dimension: SetupDimension;
  /** Owner-observed status, reported verbatim. */
  readonly status: string;
  readonly freshness: SetupEvidenceFreshness;
  readonly owner?: RuntimeComponent;
  readonly observedAt?: string;
  readonly diagnostics: readonly SetupDiagnostic[];
}

export interface SetupStepState {
  readonly dimension: SetupDimension;
  readonly status: SetupStepStatus;
  readonly reason?: SetupBlockReason;
  /** Operation identity of the step's action in the observed generation. */
  readonly actionId?: string;
  readonly diagnostics: readonly SetupDiagnostic[];
}

export type SetupNextAction =
  | { readonly kind: "perform"; readonly step: SetupDimension; readonly actionId: string; readonly reconcile: boolean }
  | {
      readonly kind: "wait";
      readonly step: SetupDimension;
      readonly reason: "human-trust" | "in-progress";
      readonly actionId?: string;
    }
  | { readonly kind: "refresh"; readonly step?: SetupDimension; readonly reason: SetupBlockReason | "journal-newer" }
  | { readonly kind: "blocked"; readonly step: SetupDimension; readonly reason: SetupBlockReason }
  | { readonly kind: "complete" };

export interface SetupState {
  readonly version: typeof SETUP_STATE_VERSION;
  readonly contractVersion: typeof SETUP_CONTRACT_VERSION;
  readonly repository: SetupRepository;
  readonly generation: SetupGeneration;
  readonly observedAt: string;
  readonly evaluatedAt: string;
  readonly stage: SetupStage;
  readonly dimensions: readonly SetupDimensionState[];
  readonly steps: readonly SetupStepState[];
  /** Actions allowed now; each is bound to the observed generation. */
  readonly actions: readonly SetupAction[];
  readonly nextAction: SetupNextAction;
  readonly diagnostics: readonly SetupDiagnostic[];
}

export interface SetupStateOptions {
  /** Oldest owner evidence that still counts as fresh. */
  readonly maxEvidenceAgeMs?: number;
  /** Lifetime of an offered action. */
  readonly actionTtlMs?: number;
  /** An unfinished journal attempt older than this is reconciled as uncertain. */
  readonly inFlightLeaseMs?: number;
}

export const DEFAULT_SETUP_STATE_OPTIONS: Required<SetupStateOptions> = Object.freeze({
  maxEvidenceAgeMs: 5 * 60_000,
  actionTtlMs: 5 * 60_000,
  inFlightLeaseMs: 10 * 60_000,
});

/** Tolerated clock skew for owner evidence timestamps. */
const MAX_FUTURE_SKEW_MS = 60_000;

interface SetupActionDefinition {
  readonly kind: string;
  readonly owner: RuntimeComponent;
  readonly title: string;
  /** Own-dimension statuses that offer this action. */
  readonly when: readonly string[];
  /** Other dimensions that must be fresh and in the listed statuses. */
  readonly requires: readonly SetupPrerequisite[];
  readonly inputs: readonly SetupInputRequirement[];
  readonly confirmation: { readonly required: boolean; readonly summary: string };
  readonly command?: StructuredCommand;
}

interface SetupStepDefinition {
  readonly dimension: SetupDimension;
  readonly complete: string;
  readonly humanWait?: string;
  readonly actions: readonly SetupActionDefinition[];
}

const CONFIGURED: SetupPrerequisite = { dimension: "configuration", statuses: ["configured"] };
const BOUND: SetupPrerequisite = { dimension: "provider-binding", statuses: ["bound"] };

/** Canonical step order; the first incomplete step decides stage and next action. */
export const SETUP_STEPS: readonly SetupStepDefinition[] = Object.freeze([
  {
    dimension: "configuration",
    complete: "configured",
    actions: [
      {
        kind: "executor.configure",
        owner: "executor",
        title: "Configure the Executor Issuer App",
        when: ["unconfigured"],
        requires: [],
        inputs: [
          { id: "app-id", kind: "text", label: "Issuer App ID", required: true },
          {
            id: "issuer-key",
            kind: "enrollment",
            label: "Issuer App private key",
            required: true,
            enrollment: "executor-issuer-private-key",
          },
        ],
        confirmation: {
          required: true,
          summary: "Store the Issuer App ID and private key in Executor custody.",
        },
      },
      {
        kind: "composition.complete-configuration",
        owner: "composition",
        title: "Complete the missing Runtime configuration",
        when: ["partial"],
        requires: [],
        inputs: [],
        confirmation: {
          required: true,
          summary:
            "Prepare or adopt the missing Authority and Admission configuration. Existing keys and capability ceilings are kept.",
        },
      },
    ],
  },
  {
    dimension: "provider-binding",
    complete: "bound",
    actions: [
      {
        kind: "executor.bind-repository",
        owner: "executor",
        title: "Bind the Issuer App installation to the repository",
        when: ["unbound"],
        requires: [CONFIGURED],
        inputs: [],
        confirmation: {
          required: true,
          summary: "Authorize bootstrap access and bind the Issuer App installation to this repository.",
        },
      },
    ],
  },
  {
    dimension: "repository-trust",
    complete: "trusted",
    humanWait: "pending-human-trust",
    actions: [
      {
        kind: "authority.publish-trust",
        owner: "authority",
        title: "Publish the Runtime trust pull request",
        when: ["untrusted"],
        requires: [CONFIGURED, BOUND],
        inputs: [],
        confirmation: {
          required: true,
          summary: "Open the trust publication pull request. Publication is not approval; a human must merge it.",
        },
      },
      {
        kind: "authority.recheck-trust",
        owner: "authority",
        title: "Recheck repository trust on the protected ref",
        when: ["pending-human-trust"],
        requires: [],
        inputs: [],
        confirmation: { required: false, summary: "Re-observe trust on the protected ref; nothing is merged." },
      },
    ],
  },
  {
    dimension: "health",
    complete: "healthy",
    actions: [
      {
        kind: "composition.start-runtime",
        owner: "composition",
        title: "Start the local Runtime",
        when: ["not-running"],
        requires: [CONFIGURED],
        inputs: [],
        confirmation: { required: false, summary: "Start the local Runtime Supervisor." },
        command: { executable: "inari", argv: ["runtime", "supervise"] },
      },
      {
        kind: "composition.restart-runtime",
        owner: "composition",
        title: "Restart the unhealthy local Runtime",
        when: ["unhealthy"],
        requires: [CONFIGURED],
        inputs: [],
        confirmation: { required: true, summary: "Stop and restart the local Runtime processes." },
      },
    ],
  },
  {
    // Session readiness is owned by Admission; the engine never manufactures it.
    dimension: "session-readiness",
    complete: "ready",
    actions: [],
  },
]);

const STAGE_BY_STATUS: Readonly<Record<string, SetupStage>> = Object.freeze({
  unconfigured: "clean",
  partial: "partial",
  unbound: "partial",
  mismatched: "partial",
  untrusted: "configured",
  "pending-human-trust": "pending-human-trust",
  "not-running": "trusted",
  unhealthy: "trusted",
  "not-ready": "healthy",
});

function diagnostic(code: string, message: string): SetupDiagnostic {
  return Object.freeze({ code, message });
}

function boundDiagnostics(items: readonly SetupDiagnostic[]): readonly SetupDiagnostic[] {
  return Object.freeze(items.slice(0, MAX_SETUP_DIAGNOSTICS));
}

function sameRepository(left: SetupRepository, right: SetupRepository): boolean {
  return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}

/** Deterministic 64-bit FNV-1a digest (hex) of a bounded string. */
function digest(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x01000193 ^ 0x2f) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/**
 * Operation identity of one action intent: the action kind bound to the
 * repository and configuration generation. Retries of the same intent reuse
 * it, so owners reconcile instead of replaying an effect.
 */
export function setupOperationId(kind: string, generation: SetupGeneration): string {
  const { repositoryHost, repositoryId } = generation.repository;
  return `${kind}:${digest(`${repositoryHost}\u0000${repositoryId}\u0000${generation.configuration}`)}`;
}

/** Action kind encoded in an operation identity produced by `setupOperationId`. */
export function setupOperationKind(actionId: string): string {
  const separator = actionId.lastIndexOf(":");
  return separator < 0 ? actionId : actionId.slice(0, separator);
}

function dimensionState(
  item: SetupDimensionObservation,
  observation: SetupObservation,
  repositoryMatches: boolean,
  now: number,
  options: Required<SetupStateOptions>,
): SetupDimensionState {
  let freshness: SetupEvidenceFreshness = "fresh";
  if (!repositoryMatches) freshness = "repository-mismatch";
  else if (item.status === "unknown" || item.evidence === undefined) freshness = "unknown";
  else {
    const observedAt = Date.parse(item.evidence.observedAt);
    if (
      item.evidence.generation !== observation.generation.configuration ||
      observedAt > now + MAX_FUTURE_SKEW_MS ||
      now - observedAt > options.maxEvidenceAgeMs
    ) {
      freshness = "stale";
    }
  }
  return Object.freeze({
    dimension: item.dimension,
    status: item.status,
    freshness,
    ...(item.evidence === undefined ? {} : { owner: item.evidence.owner, observedAt: item.evidence.observedAt }),
    diagnostics: item.diagnostics,
  });
}

function freshnessReason(freshness: SetupEvidenceFreshness): SetupBlockReason {
  if (freshness === "repository-mismatch") return "repository-mismatch";
  return freshness === "unknown" ? "evidence-unknown" : "evidence-stale";
}

/** Latest journal attempt of one operation: its terminal entry, or its unfinished start. */
interface JournalAttempt {
  readonly last: SetupJournalEntry;
  readonly confirmed: boolean;
}

function latestAttempt(entries: readonly SetupJournalEntry[], actionId: string): JournalAttempt | undefined {
  const own = entries.filter((entry) => entry.actionId === actionId);
  const last = own.at(-1);
  if (last === undefined) return undefined;
  let confirmed = false;
  for (let index = own.length - (last.phase === "completed" ? 2 : 1); index >= 0; index -= 1) {
    const entry = own[index];
    if (entry === undefined || entry.phase === "completed") break;
    if (entry.phase === "confirmed") confirmed = true;
  }
  return { last, confirmed };
}

/** An unfinished attempt of the same action kind in any generation of this repository. */
function unfinishedOfKind(entries: readonly SetupJournalEntry[], kind: string): SetupJournalEntry | undefined {
  const latest = new Map<string, SetupJournalEntry>();
  for (const entry of entries) {
    if (setupOperationKind(entry.actionId) === kind) latest.set(entry.actionId, entry);
  }
  return [...latest.values()].find((entry) => entry.phase !== "completed");
}

/** Outcomes whose effect may have been applied without being observed. */
function effectUncertain(attempt: JournalAttempt): boolean {
  const outcome: SetupActionOutcome | undefined = attempt.last.outcome;
  return outcome === "unknown" || outcome === "succeeded" || (outcome === "cancelled" && attempt.confirmed);
}

interface StepEvaluation {
  readonly step: SetupStepState;
  readonly action?: SetupAction;
  readonly next?: SetupNextAction;
}

function buildAction(
  definition: SetupActionDefinition,
  dimension: SetupDimension,
  generation: SetupGeneration,
  notAfter: string,
): SetupAction {
  return validateSetupAction({
    version: SETUP_CONTRACT_VERSION,
    id: setupOperationId(definition.kind, generation),
    kind: definition.kind,
    owner: definition.owner,
    title: definition.title,
    prerequisites: [{ dimension, statuses: [...definition.when] }, ...definition.requires],
    inputs: definition.inputs,
    confirmation: definition.confirmation,
    freshness: { generation, notAfter },
    ...(definition.command === undefined ? {} : { command: definition.command }),
  });
}

function evaluateStep(
  definition: SetupStepDefinition,
  dimensions: ReadonlyMap<SetupDimension, SetupDimensionState>,
  journal: readonly SetupJournalEntry[] | undefined,
  generation: SetupGeneration,
  observedAt: number,
  now: number,
  notAfter: string,
  options: Required<SetupStateOptions>,
): StepEvaluation {
  const own = dimensions.get(definition.dimension)!;
  const dimension = definition.dimension;
  const base = { dimension, diagnostics: own.diagnostics };
  if (own.freshness !== "fresh") {
    const reason = freshnessReason(own.freshness);
    return {
      step: Object.freeze({ ...base, status: "blocked" as const, reason }),
      next: { kind: "refresh", step: dimension, reason },
    };
  }
  if (own.status === definition.complete) return { step: Object.freeze({ ...base, status: "complete" as const }) };

  const actionDefinition = definition.actions.find((item) => item.when.includes(own.status));
  if (actionDefinition === undefined) {
    return {
      step: Object.freeze({ ...base, status: "blocked" as const, reason: "owner-resolution" as const }),
      next: { kind: "blocked", step: dimension, reason: "owner-resolution" },
    };
  }
  const actionId = setupOperationId(actionDefinition.kind, generation);
  const withId = { ...base, actionId };
  if (journal === undefined) {
    return {
      step: Object.freeze({ ...withId, status: "blocked" as const, reason: "journal-invalid" as const }),
      next: { kind: "blocked", step: dimension, reason: "journal-invalid" },
    };
  }
  for (const prerequisite of actionDefinition.requires) {
    const required = dimensions.get(prerequisite.dimension)!;
    if (required.freshness !== "fresh" || !prerequisite.statuses.includes(required.status)) {
      const reason = required.freshness === "fresh" ? "prerequisite" : freshnessReason(required.freshness);
      return {
        step: Object.freeze({ ...withId, status: "blocked" as const, reason }),
        next:
          reason === "prerequisite"
            ? { kind: "blocked", step: dimension, reason }
            : { kind: "refresh", step: prerequisite.dimension, reason },
      };
    }
  }

  const humanWait = definition.humanWait === own.status;
  let status: SetupStepStatus = humanWait
    ? "external-human-wait"
    : actionDefinition.inputs.some((input) => input.required && input.kind !== "confirmation")
      ? "missing-input"
      : "ready";
  let reconcile = false;

  // An unfinished attempt of this kind blocks a concurrent duplicate until it
  // finishes or its lease expires and fresh evidence postdates it.
  const unfinished = unfinishedOfKind(journal, actionDefinition.kind);
  if (unfinished !== undefined) {
    const recordedAt = Date.parse(unfinished.recordedAt);
    if (now - recordedAt < options.inFlightLeaseMs || observedAt <= recordedAt) {
      return {
        step: Object.freeze({ ...withId, status: "in-progress" as const }),
        next: { kind: "wait", step: dimension, reason: "in-progress", actionId: unfinished.actionId },
      };
    }
    status = "uncertain";
    reconcile = true;
  } else {
    const attempt = latestAttempt(journal, actionId);
    if (attempt !== undefined && attempt.last.phase === "completed") {
      if (effectUncertain(attempt)) {
        // Only evidence observed after the effect may decide it; never replay blindly.
        if (observedAt <= Date.parse(attempt.last.recordedAt)) {
          return {
            step: Object.freeze({ ...withId, status: "uncertain" as const }),
            next: { kind: "refresh", step: dimension, reason: "journal-newer" },
          };
        }
        if (!humanWait) {
          status = "uncertain";
          reconcile = true;
        }
      } else if (attempt.last.outcome === "failed" && !humanWait) {
        status = "failed";
      }
    }
  }

  const action = buildAction(actionDefinition, dimension, generation, notAfter);
  const diagnostics =
    status === "uncertain" || status === "failed"
      ? boundDiagnostics([
          ...own.diagnostics,
          diagnostic(
            status === "failed" ? "SETUP_PREVIOUS_ATTEMPT_FAILED" : "SETUP_EFFECT_UNCONFIRMED",
            status === "failed"
              ? "The previous attempt failed; the action may be retried."
              : "A previous attempt may have applied its effect; retry reconciles by operation identity.",
          ),
        ])
      : own.diagnostics;
  return {
    step: Object.freeze({ ...withId, diagnostics, status }),
    action,
    next: humanWait
      ? { kind: "wait", step: dimension, reason: "human-trust", actionId }
      : { kind: "perform", step: dimension, actionId, reconcile },
  };
}

function validateJournal(
  entries: readonly unknown[] | undefined,
  repository: SetupRepository,
): readonly SetupJournalEntry[] | undefined {
  if (entries === undefined || entries.length > MAX_SETUP_JOURNAL_ENTRIES) return undefined;
  try {
    return Object.freeze(
      entries
        .map((entry) => validateSetupJournalEntry(entry))
        .filter((entry) => sameRepository(entry.generation.repository, repository)),
    );
  } catch {
    return undefined;
  }
}

export interface ProjectSetupStateInput {
  /** Repository the caller asked about; a different observed repository blocks effects. */
  readonly repository: SetupRepository;
  readonly observation: unknown;
  /** Journal entries, oldest first; `undefined` when the journal is unavailable. */
  readonly journal: readonly unknown[] | undefined;
  readonly now: Date;
  readonly options?: SetupStateOptions;
}

/**
 * Pure observation → state → allowed actions → next action. Throws a
 * `RuntimeContractError` when the observation is invalid or carries secrets.
 */
export function projectSetupState(input: ProjectSetupStateInput): SetupState {
  const options = { ...DEFAULT_SETUP_STATE_OPTIONS, ...input.options };
  const observation = validateSetupObservation(input.observation);
  const now = input.now.getTime();
  const repositoryMatches = sameRepository(observation.generation.repository, input.repository);
  const dimensions = new Map<SetupDimension, SetupDimensionState>(
    SETUP_DIMENSIONS.map((dimension) => [
      dimension,
      dimensionState(
        observation[SETUP_OBSERVATION_MEMBERS[dimension]] as SetupDimensionObservation,
        observation,
        repositoryMatches,
        now,
        options,
      ),
    ]),
  );
  const journal = validateJournal(input.journal, observation.generation.repository);
  const observedAt = Date.parse(observation.observedAt);
  const freshEvidence = [...dimensions.values()]
    .filter((item) => item.freshness === "fresh" && item.observedAt !== undefined)
    .map((item) => Date.parse(item.observedAt!) + options.maxEvidenceAgeMs);
  const notAfter = new Date(Math.min(now + options.actionTtlMs, ...freshEvidence)).toISOString();

  const evaluations = SETUP_STEPS.map((definition) =>
    evaluateStep(definition, dimensions, journal, observation.generation, observedAt, now, notAfter, options),
  );

  let stage: SetupStage = "task-ready";
  let nextAction: SetupNextAction = { kind: "complete" };
  const first = evaluations.find((item) => item.step.status !== "complete");
  if (first !== undefined) {
    const own = dimensions.get(first.step.dimension)!;
    stage = own.freshness === "fresh" ? (STAGE_BY_STATUS[own.status] ?? "unknown") : "unknown";
    nextAction = first.next ?? { kind: "blocked", step: first.step.dimension, reason: "owner-resolution" };
  }

  const diagnostics: SetupDiagnostic[] = [];
  if (!repositoryMatches) {
    diagnostics.push(diagnostic("SETUP_REPOSITORY_MISMATCH", "The observation is for a different repository."));
  }
  if (journal === undefined) {
    diagnostics.push(diagnostic("SETUP_JOURNAL_INVALID", "The setup journal is unavailable or invalid."));
  }

  const state: SetupState = {
    version: SETUP_STATE_VERSION,
    contractVersion: SETUP_CONTRACT_VERSION,
    repository: input.repository,
    generation: observation.generation,
    observedAt: observation.observedAt,
    evaluatedAt: input.now.toISOString(),
    stage,
    dimensions: Object.freeze([...dimensions.values()]),
    steps: Object.freeze(evaluations.map((item) => item.step)),
    actions: Object.freeze(evaluations.flatMap((item) => (item.action === undefined ? [] : [item.action]))),
    nextAction: Object.freeze(nextAction),
    diagnostics: boundDiagnostics(diagnostics),
  };
  assertSecretFreeSetupJson(state);
  return Object.freeze(state);
}
