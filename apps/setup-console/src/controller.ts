/**
 * Local setup wizard controller (#1119).
 *
 * The controller renders nothing and decides no legality: the canonical
 * `SetupState` (actions, inputs, steps, next action) comes from the server and
 * is re-read after every action, on page return and while a bounded
 * operation is waiting. Every mutation re-reads fresh state, obtains a
 * confirmation for the current generation, submits one typed request and then
 * re-reads state. It never retries an effect, approves, merges or infers
 * completion. Selected enrollment files stay as in-memory `Blob` references,
 * are streamed once through the bounded enrollment transport and are dropped
 * after success, failure or cancellation. Nothing is persisted or logged.
 */
import type { SetupState } from "../../../src/application/setup/state.js";
import { MAX_SECRET_ENROLLMENT_BYTES } from "../../../src/runtime-contracts/enrollment.js";
import type { SetupAction, SetupActionResult } from "../../../src/runtime-contracts/setup.js";
import { SetupApiError, type SetupApiFailure, type SetupTransport } from "./api-client.js";

export interface SetupConsoleScheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SetupControllerOptions {
  readonly transport: SetupTransport;
  readonly scheduler: SetupConsoleScheduler;
  /** True while the page is hidden; hidden pages never poll. */
  readonly isHidden: () => boolean;
  readonly onChange?: (snapshot: SetupSnapshot) => void;
  readonly pollIntervalMs?: number;
  /** Poll budget per active/waiting period; refreshed by user action or page return. */
  readonly maxPolls?: number;
}

export type SetupNoticeCode =
  | "refresh-failed"
  | "session-stale"
  | "action-not-offered"
  | "confirmation-required"
  | "enrollment-missing"
  | "enrollment-too-large"
  | "enrollment-multiple"
  | "enrollment-cancelled"
  | `api-${SetupApiFailure}`;

export interface SetupNotice {
  readonly code: SetupNoticeCode;
  readonly severity: "error" | "info";
}

export type SetupPollingState = "idle" | "active" | "paused";

export interface SetupEnrollmentSelection {
  readonly bytes: number;
}

export interface SetupSnapshot {
  readonly phase: "loading" | "ready" | "working" | "unavailable";
  readonly state?: SetupState;
  readonly working?: { readonly actionId: string; readonly enrollment: boolean };
  readonly lastResult?: SetupActionResult;
  readonly notice?: SetupNotice;
  /** Secret-free draft values of declared text/choice/confirmation inputs, by action then input. */
  readonly drafts: Readonly<Record<string, Readonly<Record<string, string | boolean>>>>;
  /** Operator acknowledgement of an action's confirmation summary. */
  readonly acknowledged: Readonly<Record<string, boolean>>;
  /** Selected enrollment files by `enrollmentKey`; only the size is exposed. */
  readonly enrollments: Readonly<Record<string, SetupEnrollmentSelection>>;
  readonly polling: SetupPollingState;
  /** Increments when focus should move to the result/status region. */
  readonly focusRequest: number;
}

export interface SetupController {
  snapshot(): SetupSnapshot;
  start(): Promise<void>;
  refresh(): Promise<void>;
  setDraft(actionId: string, inputId: string, value: string | boolean): void;
  setAcknowledged(actionId: string, value: boolean): void;
  submit(actionId: string): Promise<void>;
  selectEnrollment(actionId: string, inputId: string, file: Blob | undefined): void;
  /** Drops the selected file; aborts the upload when it is in flight. */
  cancelEnrollment(actionId: string, inputId: string): void;
  visibilityChanged(hidden: boolean): void;
  focusReturned(): void;
  dispose(): void;
}

export const DEFAULT_POLL_INTERVAL_MS = 4_000;
export const DEFAULT_MAX_POLLS = 45;

export function enrollmentKey(actionId: string, inputId: string): string {
  return `${actionId}\u0000${inputId}`;
}

function noticeFor(error: unknown): SetupNotice {
  if (error instanceof SetupApiError) return { code: `api-${error.failure}`, severity: "error" };
  return { code: "api-unavailable", severity: "error" };
}

/** Builds typed input values only for declared, non-enrollment inputs; no defaults are filled in. */
export function requestInputs(
  action: SetupAction,
  draft: Readonly<Record<string, string | boolean>> | undefined,
): Record<string, string | boolean> {
  const inputs: Record<string, string | boolean> = {};
  for (const input of action.inputs) {
    const value = draft?.[input.id];
    if (input.kind === "enrollment" || value === undefined) continue;
    if (input.kind === "confirmation") {
      if (value === true) inputs[input.id] = true;
    } else if (typeof value === "string" && value.trim() !== "") {
      inputs[input.id] = input.kind === "text" ? value.trim() : value;
    }
  }
  return inputs;
}

export function createSetupController(options: SetupControllerOptions): SetupController {
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS;
  const files = new Map<string, Blob>();
  let upload: { key: string; abort: AbortController } | undefined;
  let snapshot: SetupSnapshot = Object.freeze({
    phase: "loading",
    drafts: {},
    acknowledged: {},
    enrollments: {},
    polling: "idle",
    focusRequest: 0,
  });
  let timer: unknown;
  let polls = 0;
  let refreshing: Promise<void> | undefined;
  let disposed = false;

  function update(patch: Partial<SetupSnapshot>, notify = true): void {
    snapshot = Object.freeze({ ...snapshot, ...patch });
    if (notify && !disposed) options.onChange?.(snapshot);
  }

  function selections(): Record<string, SetupEnrollmentSelection> {
    const out: Record<string, SetupEnrollmentSelection> = {};
    for (const [key, file] of files) out[key] = Object.freeze({ bytes: file.size });
    return out;
  }

  function stopTimer(): void {
    if (timer !== undefined) options.scheduler.clearTimeout(timer);
    timer = undefined;
  }

  /** The server's next action alone decides whether an operation is still waiting. */
  function waiting(state: SetupState | undefined): boolean {
    return state !== undefined && (state.nextAction.kind === "wait" || state.nextAction.kind === "refresh");
  }

  function schedule(): void {
    stopTimer();
    if (disposed || snapshot.phase !== "ready" || !waiting(snapshot.state)) {
      if (snapshot.polling !== "idle") update({ polling: "idle" });
      return;
    }
    if (options.isHidden()) {
      if (snapshot.polling !== "idle") update({ polling: "idle" });
      return;
    }
    if (polls >= maxPolls) {
      update({ polling: "paused" });
      return;
    }
    polls += 1;
    timer = options.scheduler.setTimeout(() => {
      timer = undefined;
      void refresh();
    }, interval);
    if (snapshot.polling !== "active") update({ polling: "active" });
  }

  async function read(): Promise<SetupState | undefined> {
    try {
      const state = await options.transport.state();
      update({ state, phase: snapshot.working ? "working" : "ready" });
      return state;
    } catch (error) {
      const failure = error instanceof SetupApiError ? error.failure : undefined;
      update({
        phase: "unavailable",
        notice:
          failure === "rejected"
            ? noticeFor(error)
            : { code: failure === "stale" ? "session-stale" : "refresh-failed", severity: "error" },
      });
      return undefined;
    }
  }

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const previous = snapshot.notice;
        const state = await read();
        if (state !== undefined && previous?.code === "refresh-failed") update({ notice: undefined });
      } finally {
        refreshing = undefined;
      }
      if (!snapshot.working) schedule();
    })();
    return refreshing;
  }

  function dropFile(key: string): void {
    files.delete(key);
    update({ enrollments: selections() });
  }

  async function run(
    actionId: string,
    enrollment: boolean,
    body: (fresh: SetupState, action: SetupAction) => Promise<SetupActionResult>,
  ): Promise<void> {
    stopTimer();
    update({ phase: "working", working: { actionId, enrollment }, notice: undefined, lastResult: undefined });
    try {
      // Fresh state first: only an action the current state offers is submitted.
      const fresh = await options.transport.state();
      update({ state: fresh });
      const action = fresh.actions.find((item) => item.id === actionId);
      if (action === undefined) {
        update({ notice: { code: "action-not-offered", severity: "info" } });
        return;
      }
      update({ lastResult: await body(fresh, action) });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) update({ notice: noticeFor(error) });
    } finally {
      polls = 0;
      update({
        working: undefined,
        phase: "ready",
        // Each confirmation acknowledgement covers one submission only.
        acknowledged: { ...snapshot.acknowledged, [actionId]: false },
        focusRequest: snapshot.focusRequest + 1,
      });
      // Never reuse a read that started before the action: re-read after it.
      if (refreshing) await refreshing;
      await refresh();
    }
  }

  async function submit(actionId: string): Promise<void> {
    if (disposed || snapshot.working) return;
    const offered = snapshot.state?.actions.find((item) => item.id === actionId);
    if (offered === undefined) {
      update({ notice: { code: "action-not-offered", severity: "info" } });
      await refresh();
      return;
    }
    if (offered.confirmation.required && snapshot.acknowledged[actionId] !== true) {
      update({ notice: { code: "confirmation-required", severity: "error" } });
      return;
    }
    const selected = offered.inputs.filter(
      (input) => input.kind === "enrollment" && files.has(enrollmentKey(actionId, input.id)),
    );
    if (selected.length > 1) {
      update({ notice: { code: "enrollment-multiple", severity: "error" } });
      return;
    }
    const enrollmentInput = selected[0];
    if (enrollmentInput === undefined) {
      if (offered.inputs.some((input) => input.kind === "enrollment" && input.required)) {
        update({ notice: { code: "enrollment-missing", severity: "error" } });
        return;
      }
      await run(actionId, false, async (fresh, action) => {
        const confirmation = await options.transport.confirm(action.id);
        return options.transport.perform(confirmation, {
          version: action.version,
          actionId: action.id,
          generation: fresh.generation,
          confirmed: true,
          inputs: requestInputs(action, snapshot.drafts[action.id]),
        });
      });
      return;
    }
    const key = enrollmentKey(actionId, enrollmentInput.id);
    const abort = new AbortController();
    upload = { key, abort };
    try {
      await run(actionId, true, async (_fresh, action) => {
        const declared = action.inputs.find((input) => input.id === enrollmentInput.id && input.kind === "enrollment");
        const file = files.get(key);
        if (declared === undefined || file === undefined) {
          throw new SetupApiError("stale", 0);
        }
        try {
          const confirmation = await options.transport.confirm(action.id);
          if (abort.signal.aborted) throw new DOMException("Cancelled.", "AbortError");
          return await options.transport.enroll(declared.id, action.id, confirmation, file, abort.signal);
        } finally {
          dropFile(key);
        }
      });
    } finally {
      if (upload?.key === key) upload = undefined;
      // Success, failure or cancellation: the File reference never outlives the attempt.
      dropFile(key);
    }
  }

  return Object.freeze({
    snapshot: () => snapshot,
    async start() {
      polls = 0;
      await refresh();
    },
    refresh() {
      polls = 0;
      return refresh();
    },
    setDraft(actionId: string, inputId: string, value: string | boolean) {
      const declared = snapshot.state?.actions
        .find((action) => action.id === actionId)
        ?.inputs.find((input) => input.id === inputId && input.kind !== "enrollment");
      if (declared === undefined) return;
      // Silent: the DOM already shows the value; the draft only survives re-renders.
      update({ drafts: { ...snapshot.drafts, [actionId]: { ...snapshot.drafts[actionId], [inputId]: value } } }, false);
    },
    setAcknowledged(actionId: string, value: boolean) {
      update({ acknowledged: { ...snapshot.acknowledged, [actionId]: value } }, false);
    },
    submit,
    selectEnrollment(actionId: string, inputId: string, file: Blob | undefined) {
      const key = enrollmentKey(actionId, inputId);
      const declared = snapshot.state?.actions
        .find((action) => action.id === actionId)
        ?.inputs.some((input) => input.id === inputId && input.kind === "enrollment");
      files.delete(key);
      if (file === undefined || !declared || snapshot.working) {
        update({ enrollments: selections() });
        return;
      }
      if (file.size < 1 || file.size > MAX_SECRET_ENROLLMENT_BYTES) {
        update({ enrollments: selections(), notice: { code: "enrollment-too-large", severity: "error" } });
        return;
      }
      files.set(key, file);
      update({ enrollments: selections(), notice: undefined });
    },
    cancelEnrollment(actionId: string, inputId: string) {
      const key = enrollmentKey(actionId, inputId);
      if (upload?.key === key) upload.abort.abort();
      dropFile(key);
      update({ notice: { code: "enrollment-cancelled", severity: "info" } });
    },
    visibilityChanged(hidden: boolean) {
      if (hidden) {
        stopTimer();
        if (snapshot.polling === "active") update({ polling: "idle" });
        return;
      }
      polls = 0;
      void refresh();
    },
    focusReturned() {
      if (options.isHidden()) return;
      polls = 0;
      void refresh();
    },
    dispose() {
      stopTimer();
      upload?.abort.abort();
      files.clear();
      disposed = true;
    },
  });
}
