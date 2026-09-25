/**
 * Canonical setup-state fixtures for wizard controller/render tests. States are
 * produced by the real `projectSetupState` projection, never hand-written, so
 * the tests exercise exactly the actions and inputs the server offers.
 */
import { projectSetupState, SETUP_STEPS, type SetupState } from "../../src/application/setup/state.js";
import type { SetupActionRequest, SetupActionResult } from "../../src/runtime-contracts/setup.js";
import { sameSetupGeneration, type SetupGeneration } from "../../src/runtime-contracts/setup-primitives.js";
import type { SetupTransport } from "./src/api-client.js";
import { SetupApiError } from "./src/api-client.js";

export const repository = Object.freeze({
  repositoryHost: "github.com",
  repositoryId: "1330755860",
  nameWithOwner: "yohn-jp/gh-inari",
});
export const NOW = new Date("2026-09-24T00:05:00.000Z");
const OBSERVED = "2026-09-24T00:04:00.000Z";

export interface Statuses {
  configuration: string;
  health: string;
  providerBinding: string;
  repositoryTrust: string;
  sessionReadiness: string;
}

const DIMENSION = {
  configuration: "configuration",
  health: "health",
  providerBinding: "provider-binding",
  repositoryTrust: "repository-trust",
  sessionReadiness: "session-readiness",
} as const;
const OWNER = {
  configuration: "composition",
  health: "composition",
  providerBinding: "executor",
  repositoryTrust: "authority",
  sessionReadiness: "admission",
} as const;

export function canonicalState(
  statuses: Partial<Statuses> = {},
  configuration = "gen-1",
  journal: readonly unknown[] = [],
): SetupState {
  const all: Statuses = {
    configuration: "configured",
    health: "healthy",
    providerBinding: "bound",
    repositoryTrust: "trusted",
    sessionReadiness: "ready",
    ...statuses,
  };
  const observation: Record<string, unknown> = {
    version: 1,
    generation: { repository, configuration },
    observedAt: OBSERVED,
  };
  for (const member of Object.keys(DIMENSION) as (keyof Statuses)[]) {
    const status = all[member];
    observation[member] = {
      dimension: DIMENSION[member],
      status,
      ...(status === "unknown"
        ? {}
        : { evidence: { owner: OWNER[member], observedAt: OBSERVED, generation: configuration } }),
      diagnostics: [],
    };
  }
  // Round-trip through JSON like the HTTP transport does.
  return JSON.parse(JSON.stringify(projectSetupState({ repository, observation, journal, now: NOW }))) as SetupState;
}

/** One canonical state per offered action kind, in canonical step order. */
export const ACTION_FIXTURES: Readonly<Record<string, Partial<Statuses>>> = Object.freeze({
  "executor.configure": { configuration: "unconfigured" },
  "composition.complete-configuration": { configuration: "partial" },
  "executor.bind-repository": { providerBinding: "unbound" },
  "authority.publish-trust": { repositoryTrust: "untrusted" },
  "authority.recheck-trust": { repositoryTrust: "pending-human-trust" },
  "composition.start-runtime": { health: "not-running" },
  "composition.restart-runtime": { health: "unhealthy" },
});

export const CANONICAL_ACTION_KINDS: readonly string[] = SETUP_STEPS.flatMap((step) =>
  step.actions.map((action) => action.kind),
);

/** An in-progress journal attempt for the Runtime start action. */
export function inProgressState(): SetupState {
  const base = canonicalState({ health: "not-running" });
  const actionId = base.actions.find((action) => action.kind === "composition.start-runtime")!.id;
  return canonicalState({ health: "not-running" }, "gen-1", [
    {
      version: 1,
      actionId,
      owner: "composition",
      generation: base.generation,
      phase: "requested",
      recordedAt: "2026-09-24T00:04:30.000Z",
      diagnostics: [],
    },
  ]);
}

export interface RecordedCall {
  readonly kind: "state" | "confirm" | "perform" | "enroll";
  readonly actionId?: string;
  readonly confirmation?: string;
  readonly request?: SetupActionRequest;
  readonly inputId?: string;
  readonly body?: Blob;
  readonly signal?: AbortSignal;
}

/**
 * In-memory transport that mirrors the server contract: confirmations are
 * single-use and bound to the action ID and the generation current at issue.
 */
export class FakeSetupServer implements SetupTransport {
  current: SetupState;
  readonly calls: RecordedCall[] = [];
  effects = 0;
  /** Called after confirmation is issued, before consumption (e.g. to drift the generation). */
  afterConfirm?: () => void;
  enrollBehavior: "succeed" | "fail" | "throw" | "hang" = "succeed";
  private readonly tokens = new Map<string, { actionId: string; generation: SetupGeneration }>();
  private counter = 0;

  constructor(initial: SetupState) {
    this.current = initial;
  }

  async state(): Promise<SetupState> {
    this.calls.push({ kind: "state" });
    return this.current;
  }

  async confirm(actionId: string): Promise<string> {
    this.calls.push({ kind: "confirm", actionId });
    if (!this.current.actions.some((action) => action.id === actionId)) throw new SetupApiError("stale", 409);
    const token = `confirmation-${++this.counter}`;
    this.tokens.set(token, { actionId, generation: this.current.generation });
    this.afterConfirm?.();
    return token;
  }

  private consume(token: string, actionId: string): void {
    const item = this.tokens.get(token);
    this.tokens.delete(token);
    if (
      item === undefined ||
      item.actionId !== actionId ||
      !sameSetupGeneration(item.generation, this.current.generation) ||
      !this.current.actions.some((action) => action.id === actionId)
    ) {
      throw new SetupApiError("stale", 409);
    }
  }

  private result(actionId: string, outcome: SetupActionResult["outcome"]): SetupActionResult {
    return { version: 1, actionId, generation: this.current.generation, outcome, diagnostics: [] };
  }

  async perform(confirmation: string, request: SetupActionRequest): Promise<SetupActionResult> {
    this.calls.push({ kind: "perform", confirmation, request, actionId: request.actionId });
    if (!sameSetupGeneration(request.generation, this.current.generation)) throw new SetupApiError("stale", 409);
    this.consume(confirmation, request.actionId);
    this.effects += 1;
    return this.result(request.actionId, "succeeded");
  }

  async enroll(
    inputId: string,
    actionId: string,
    confirmation: string,
    body: Blob,
    signal: AbortSignal,
  ): Promise<SetupActionResult> {
    this.calls.push({ kind: "enroll", inputId, actionId, confirmation, body, signal });
    this.consume(confirmation, actionId);
    if (this.enrollBehavior === "hang") {
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new DOMException("Aborted.", "AbortError"))),
      );
    }
    if (this.enrollBehavior === "throw") throw new SetupApiError("unavailable", 0);
    this.effects += 1;
    return this.result(actionId, this.enrollBehavior === "fail" ? "failed" : "succeeded");
  }
}

/** Blob whose content must never be read by the controller or view. */
export class OpaqueSecretBlob extends Blob {
  constructor(size = 12) {
    super(["-----BEGIN ".padEnd(size, "X")]);
  }
  override text(): Promise<string> {
    throw new Error("secret content read");
  }
  override arrayBuffer(): Promise<ArrayBuffer> {
    throw new Error("secret content read");
  }
  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    throw new Error("secret content read");
  }
}

export class ManualScheduler {
  private next = 1;
  readonly pending = new Map<number, () => void>();
  setTimeout = (callback: () => void): unknown => {
    const handle = this.next++;
    this.pending.set(handle, callback);
    return handle;
  };
  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
  async fire(): Promise<void> {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, callback] of entries) callback();
    await settle();
  }
}

export async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
}
