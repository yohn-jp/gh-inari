/**
 * Setup action dispatch and recovery (#1099 / #1110).
 *
 * `createSetupApplication` connects the pure state projection to the public
 * owner ports. Reads (`state`) call only the observation and journal ports.
 * `perform` re-observes, binds the request to the same repository and
 * configuration generation, accepts only an action the fresh state offers,
 * checks inputs and confirmation, journals the attempt without secrets and
 * dispatches exactly one owner port call. Unobserved effects are recorded as
 * `unknown` and reconciled through fresh evidence and the stable operation
 * identity, never by blind replay. Cancellation never claims rollback.
 */
import {
  MAX_SECRET_ENROLLMENT_BYTES,
  MAX_SETUP_DIAGNOSTICS,
  SECRET_ENROLLMENT_OWNERS,
  SETUP_CONTRACT_VERSION,
  sameSetupGeneration,
  validateSecretEnrollmentReceipt,
  validateSetupActionRequest,
  validateSetupActionResult,
  validateSetupJournalEntry,
  type SecretEnrollmentPort,
  type SecretEnrollmentReceipt,
  type SetupAction,
  type SetupActionOutcome,
  type SetupActionPort,
  type SetupActionRequest,
  type SetupActionResult,
  type SetupDiagnostic,
  type SetupJournalPhase,
  type SetupJournalPort,
  type SetupObservationPort,
} from "../../runtime-contracts/index.js";
import { projectSetupState, type SetupRepository, type SetupState, type SetupStateOptions } from "./state.js";

/** Secret bytes for one `enrollment` input; handed only to the owning enrollment port. */
export interface SetupEnrollmentUpload {
  readonly declaredBytes: number;
  readonly stream: AsyncIterable<Uint8Array>;
}

export interface SetupPerformOptions {
  readonly signal?: AbortSignal;
  /** Keyed by enrollment input ID. Never serialized, journaled or retained. */
  readonly enrollments?: Readonly<Record<string, SetupEnrollmentUpload>>;
}

export interface SetupApplicationPorts {
  readonly observation: SetupObservationPort;
  readonly action: SetupActionPort;
  readonly journal: SetupJournalPort;
  readonly enrollment?: readonly SecretEnrollmentPort[];
  readonly now?: () => Date;
  readonly options?: SetupStateOptions;
}

export interface SetupApplication {
  /** Observes and projects state. Never initiates an action or writes the journal. */
  state(repository: SetupRepository): Promise<SetupState>;
  perform(repository: SetupRepository, request: unknown, options?: SetupPerformOptions): Promise<SetupActionResult>;
}

function diagnostic(code: string, message: string): SetupDiagnostic {
  return Object.freeze({ code, message });
}

function result(
  request: Pick<SetupActionRequest, "actionId" | "generation">,
  outcome: SetupActionOutcome,
  diagnostics: readonly SetupDiagnostic[],
  receipt?: SecretEnrollmentReceipt,
): SetupActionResult {
  return validateSetupActionResult({
    version: SETUP_CONTRACT_VERSION,
    actionId: request.actionId,
    generation: request.generation,
    outcome,
    diagnostics: diagnostics.slice(0, MAX_SETUP_DIAGNOSTICS),
    ...(receipt === undefined ? {} : { receipt }),
  });
}

function sameRepository(left: SetupRepository, right: SetupRepository): boolean {
  return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}

/** Returns a diagnostic when the request inputs do not satisfy the action; no defaults are filled in. */
function checkInputs(
  action: SetupAction,
  request: SetupActionRequest,
  enrollments: Readonly<Record<string, SetupEnrollmentUpload>>,
): SetupDiagnostic | undefined {
  const declared = new Map(action.inputs.map((input) => [input.id, input]));
  for (const id of Object.keys(request.inputs)) {
    const input = declared.get(id);
    if (input === undefined) return diagnostic("SETUP_INPUT_UNKNOWN", `Input ${id} is not declared by the action.`);
    if (input.kind === "enrollment") {
      return diagnostic("SETUP_INPUT_ENROLLMENT_ONLY", `Input ${id} is accepted only through owner enrollment.`);
    }
  }
  for (const id of Object.keys(enrollments)) {
    if (declared.get(id)?.kind !== "enrollment") {
      return diagnostic("SETUP_INPUT_UNKNOWN", `Enrollment ${id} is not declared by the action.`);
    }
  }
  for (const input of action.inputs) {
    const value = request.inputs[input.id];
    if (input.kind === "enrollment") {
      const upload = enrollments[input.id];
      if (upload === undefined) {
        if (input.required) return diagnostic("SETUP_INPUT_MISSING", `Input ${input.id} is required.`);
        continue;
      }
      if (
        !Number.isSafeInteger(upload.declaredBytes) ||
        upload.declaredBytes < 1 ||
        upload.declaredBytes > MAX_SECRET_ENROLLMENT_BYTES
      ) {
        return diagnostic("SETUP_INPUT_INVALID", `Input ${input.id} exceeds the enrollment bound.`);
      }
      continue;
    }
    if (value === undefined) {
      if (input.required) return diagnostic("SETUP_INPUT_MISSING", `Input ${input.id} is required.`);
      continue;
    }
    const valid =
      input.kind === "confirmation"
        ? value === true
        : typeof value === "string" && (input.kind !== "choice" || (input.choices ?? []).includes(value));
    if (!valid) return diagnostic("SETUP_INPUT_INVALID", `Input ${input.id} has an invalid value.`);
  }
  return undefined;
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function createSetupApplication(ports: SetupApplicationPorts): SetupApplication {
  const now = ports.now ?? (() => new Date());
  /** Operations dispatched by this process; blocks concurrent duplicates before the journal shows them. */
  const inFlight = new Set<string>();

  async function state(repository: SetupRepository): Promise<SetupState> {
    const observation = await ports.observation.observe(repository);
    let journal: readonly unknown[] | undefined;
    try {
      journal = await ports.journal.read(repository);
    } catch {
      journal = undefined;
    }
    return projectSetupState({ repository, observation, journal, now: now(), options: ports.options });
  }

  async function record(
    action: SetupAction,
    request: SetupActionRequest,
    phase: SetupJournalPhase,
    outcome?: SetupActionOutcome,
    diagnostics: readonly SetupDiagnostic[] = [],
  ): Promise<void> {
    await ports.journal.append(
      validateSetupJournalEntry({
        version: SETUP_CONTRACT_VERSION,
        actionId: action.id,
        owner: action.owner,
        generation: request.generation,
        phase,
        ...(outcome === undefined ? {} : { outcome }),
        recordedAt: now().toISOString(),
        diagnostics: diagnostics.slice(0, MAX_SETUP_DIAGNOSTICS),
      }),
    );
  }

  async function enroll(
    action: SetupAction,
    request: SetupActionRequest,
    enrollments: Readonly<Record<string, SetupEnrollmentUpload>>,
    signal: AbortSignal | undefined,
  ): Promise<{ outcome?: SetupActionOutcome; receipt?: SecretEnrollmentReceipt; diagnostics: SetupDiagnostic[] }> {
    let receipt: SecretEnrollmentReceipt | undefined;
    for (const input of action.inputs) {
      const upload = enrollments[input.id];
      if (input.kind !== "enrollment" || input.enrollment === undefined || upload === undefined) continue;
      const kind = input.enrollment;
      const port = ports.enrollment?.find(
        (candidate) => candidate.owner === SECRET_ENROLLMENT_OWNERS[kind] && candidate.kinds.includes(kind),
      );
      if (port === undefined) {
        return {
          outcome: "failed",
          diagnostics: [diagnostic("SETUP_ENROLLMENT_PORT_MISSING", `No enrollment port accepts ${kind}.`)],
        };
      }
      let received: SecretEnrollmentReceipt;
      try {
        received = validateSecretEnrollmentReceipt(
          await port.enroll(
            {
              version: SETUP_CONTRACT_VERSION,
              kind,
              operationId: action.id,
              repository: request.generation.repository,
              declaredBytes: upload.declaredBytes,
            },
            upload.stream,
            signal,
          ),
        );
      } catch {
        return {
          outcome: aborted(signal) ? "cancelled" : "unknown",
          diagnostics: [
            diagnostic("SETUP_ENROLLMENT_UNCONFIRMED", "The enrollment outcome was not observed; it may have applied."),
          ],
        };
      }
      if (
        received.operationId !== action.id ||
        received.kind !== kind ||
        !sameRepository(received.repository, request.generation.repository)
      ) {
        return {
          outcome: "unknown",
          diagnostics: [diagnostic("SETUP_ENROLLMENT_MISMATCH", "The enrollment receipt is for another operation.")],
        };
      }
      if (received.outcome !== "enrolled") {
        return { outcome: "failed", receipt: received, diagnostics: [...received.diagnostics] };
      }
      receipt = received;
    }
    return { ...(receipt === undefined ? {} : { receipt }), diagnostics: [] };
  }

  async function dispatch(
    action: SetupAction,
    request: SetupActionRequest,
    enrollments: Readonly<Record<string, SetupEnrollmentUpload>>,
    signal: AbortSignal | undefined,
  ): Promise<SetupActionResult> {
    try {
      await record(action, request, "requested");
    } catch {
      return result(request, "failed", [
        diagnostic("SETUP_JOURNAL_UNAVAILABLE", "The attempt could not be journaled; no effect was started."),
      ]);
    }
    if (aborted(signal)) {
      const cancelled = result(request, "cancelled", [
        diagnostic("SETUP_CANCELLED_BEFORE_EFFECT", "Cancelled before any effect was started."),
      ]);
      await record(action, request, "completed", "cancelled", cancelled.diagnostics).catch(() => undefined);
      return cancelled;
    }
    try {
      await record(action, request, "confirmed");
    } catch {
      const failed = result(request, "failed", [
        diagnostic("SETUP_JOURNAL_UNAVAILABLE", "The attempt could not be journaled; no effect was started."),
      ]);
      await record(action, request, "completed", "failed", failed.diagnostics).catch(() => undefined);
      return failed;
    }

    let outcome: SetupActionResult;
    const enrolled = await enroll(action, request, enrollments, signal);
    if (enrolled.outcome !== undefined) {
      outcome = result(request, enrolled.outcome, enrolled.diagnostics, enrolled.receipt);
    } else {
      try {
        const returned = validateSetupActionResult(await ports.action.perform(request));
        if (returned.actionId !== request.actionId || !sameSetupGeneration(returned.generation, request.generation)) {
          outcome = result(request, "unknown", [
            diagnostic("SETUP_RESULT_MISMATCH", "The owner result is for another operation; its effect is unknown."),
          ]);
        } else {
          outcome =
            returned.receipt === undefined && enrolled.receipt !== undefined
              ? result(request, returned.outcome, returned.diagnostics, enrolled.receipt)
              : returned;
        }
      } catch {
        outcome = result(request, aborted(signal) ? "cancelled" : "unknown", [
          diagnostic("SETUP_EFFECT_UNCONFIRMED", "The owner effect was not observed; it may have applied."),
        ]);
      }
    }
    try {
      await record(action, request, "completed", outcome.outcome, outcome.diagnostics);
    } catch {
      return result(
        request,
        outcome.outcome,
        [
          ...outcome.diagnostics.slice(0, MAX_SETUP_DIAGNOSTICS - 1),
          diagnostic("SETUP_JOURNAL_UNAVAILABLE", "The outcome could not be journaled."),
        ],
        outcome.receipt,
      );
    }
    return outcome;
  }

  async function perform(
    repository: SetupRepository,
    input: unknown,
    options: SetupPerformOptions = {},
  ): Promise<SetupActionResult> {
    const request = validateSetupActionRequest(input);
    const enrollments = options.enrollments ?? {};
    if (!sameRepository(request.generation.repository, repository)) {
      return result(request, "stale", [
        diagnostic("SETUP_REPOSITORY_MISMATCH", "The request is bound to a different repository."),
      ]);
    }
    if (inFlight.has(request.actionId)) {
      return result(request, "stale", [
        diagnostic("SETUP_ACTION_IN_PROGRESS", "The same operation is already in progress; refresh the state."),
      ]);
    }
    inFlight.add(request.actionId);
    try {
      const current = await state(repository);
      if (!sameSetupGeneration(current.generation, request.generation)) {
        return result(request, "stale", [
          diagnostic("SETUP_GENERATION_STALE", "The configuration generation changed; refresh the state."),
        ]);
      }
      const action = current.actions.find((item) => item.id === request.actionId);
      if (action === undefined || Date.parse(action.freshness.notAfter) < now().getTime()) {
        return result(request, "stale", [
          diagnostic("SETUP_ACTION_NOT_OFFERED", "The action is not offered by the current state; refresh the state."),
        ]);
      }
      const invalidInput = checkInputs(action, request, enrollments);
      if (invalidInput !== undefined) return result(request, "action-required", [invalidInput]);
      if (action.confirmation.required && !request.confirmed) {
        return result(request, "action-required", [
          diagnostic("SETUP_CONFIRMATION_REQUIRED", "The action requires explicit confirmation."),
        ]);
      }
      for (const item of action.inputs) {
        if (item.kind !== "enrollment" || item.enrollment === undefined || enrollments[item.id] === undefined) continue;
        const kind = item.enrollment;
        const owner = SECRET_ENROLLMENT_OWNERS[kind];
        if (!(ports.enrollment ?? []).some((port) => port.owner === owner && port.kinds.includes(kind))) {
          return result(request, "failed", [
            diagnostic("SETUP_ENROLLMENT_PORT_MISSING", `No ${owner} enrollment port accepts ${kind}.`),
          ]);
        }
      }
      if (aborted(options.signal)) {
        return result(request, "cancelled", [
          diagnostic("SETUP_CANCELLED_BEFORE_EFFECT", "Cancelled before any effect was started."),
        ]);
      }
      return await dispatch(action, request, enrollments, options.signal);
    } finally {
      inFlight.delete(request.actionId);
    }
  }

  return Object.freeze({ state, perform });
}
