import assert from "node:assert/strict";
import { test } from "node:test";
import { getPathsFromEvents, getShortestPaths, toDirectedGraph, type DirectedGraphNode } from "@xstate/graph";
import type { AnyStateMachine } from "xstate";
import {
  CHANGE_STATES,
  CHANGE_TRANSITION_OPERATIONS,
  type Change,
  type ChangeDiagnostic,
  type ChangeEffect,
  type ChangeIdentity,
  type ChangeProjectionInput,
  type ChangeProjectionResult,
  type ChangeState,
  type ChangeTransition,
  type ChangeTransitionPlan,
} from "../../change.js";
import type { ChangeRemoteExecutionResult } from "../../change-executor.js";
import { ChangeTrustedExecutorError } from "../../change-trusted-executor.js";
import {
  createGoldenPathActors,
  absentEvidenceInput,
  abortedEvidenceInput,
  draftEvidenceInput,
  mutationRequest,
  reviewEvidenceInput,
} from "../../golden-path-status/fixtures.js";
import { abortExecutionMachine } from "./abort-execution-machine.js";
import {
  type AbortAdmissionResult,
  type AbortEffectResult,
  type AbortExecutionServices,
  type AbortPlanResult,
  type AbortReadResult,
  type AbortRecoveryResult,
  type AbortVerificationResult,
} from "./abort-execution-machine.js";
import { issuanceExecutionMachine } from "./issuance-execution-machine.js";
import {
  type IssuanceExecutionServices,
  type IssuanceEffectResult,
  type IssuancePlanResult,
  type IssuanceReadResult,
  type IssuanceRecoveryPlanResult,
  type IssuanceVerificationResult,
} from "./issuance-execution-machine.js";
import { lifecycleMachine, transitionChangeLifecycle } from "./lifecycle-machine.js";
import {
  type ReadyEffectResult,
  type ReadyExecutionServices,
  type ReadyReadResult,
  type ReadyVerificationResult,
} from "./ready-execution-machine.js";
import { readyExecutionMachine } from "./ready-execution-machine.js";

const GRAPH_TRAVERSAL_LIMIT = 4_096;
const TRANSIENT_GRAPH_STATE_REASON =
  "XState graph transition resolves the always chain atomically; no stable snapshot can observe this state.";
const READY_GRAPH_EXCLUSIONS = new Map(
  ["projecting", "validating", "planning", "verifying"].map((state) => [state, TRANSIENT_GRAPH_STATE_REASON]),
);
const ABORT_GRAPH_EXCLUSIONS = new Map(
  ["projecting", "classifyingAbort", "planning", "nextEffect", "recoveryPlanning", "verifying"].map((state) => [
    state,
    TRANSIENT_GRAPH_STATE_REASON,
  ]),
);
ABORT_GRAPH_EXCLUSIONS.set(
  "recoveryRequired",
  "The recovery-required compound state immediately enters its final cleanup marker and completes atomically.",
);
ABORT_GRAPH_EXCLUSIONS.set(
  "recoveryRequired.cleanupPending",
  "The recovery-required cleanup marker is an internal final state consumed by the compound onDone transition.",
);
const ABORT_GRAPH_EDGE_EXCLUSIONS = new Map([
  [
    "change-abort-execution.recoveryRequired:0:0",
    "The recovery-required compound onDone edge is an internal atomic handoff with no stable source snapshot.",
  ],
]);
const ISSUANCE_GRAPH_EXCLUSIONS = new Map(
  [
    "validatingInitialGovernance",
    "validatingFreshGovernance",
    "planning",
    "nextEffect",
    "classifyingFailure",
    "planningCompensation",
    "planningRecoveryOutcome",
    "verifying",
  ].map((state) => [state, TRANSIENT_GRAPH_STATE_REASON]),
);
const GRAPH_MODES = [
  "valid",
  "existing",
  "precondition",
  "plan-failure",
  "verify",
  "effect-failure",
  "branch-failure",
  "safe-compensation",
  "unsafe-recovery",
  "compensation-failure",
  "compensation-unsafe",
  "recovery",
] as const;
type GraphMode = (typeof GRAPH_MODES)[number];

const GRAPH_IDENTITY: ChangeIdentity = {
  repositoryHost: "github.com",
  repositoryId: "351000001",
  rootIssue: 351,
};

const GRAPH_CHANGE: Change = {
  version: 1,
  identity: GRAPH_IDENTITY,
  state: "DEFINED",
  provenance: {},
};

const GRAPH_INPUT_MARKER = "__modelMode";

type MarkedGraphInput = ChangeProjectionInput & { readonly [GRAPH_INPUT_MARKER]: GraphMode };

function graphInput(mode: GraphMode): ChangeProjectionInput {
  return {
    change: GRAPH_CHANGE,
    evidence: {},
    [GRAPH_INPUT_MARKER]: mode,
  } as MarkedGraphInput;
}

function graphMode(value: unknown): GraphMode {
  if (typeof value !== "object" || value === null) return "valid";
  const candidate = (value as Record<string, unknown>)[GRAPH_INPUT_MARKER];
  return typeof candidate === "string" && GRAPH_MODES.includes(candidate as GraphMode)
    ? (candidate as GraphMode)
    : "valid";
}

function graphChange(state: Change["state"]): Change {
  return { ...GRAPH_CHANGE, state, projection: { branch: "test/351-model-graph", pullRequest: 3510 } };
}

function graphProjection(
  mode: GraphMode,
  state: Change["state"],
  status: ChangeProjectionResult["status"] = "healthy",
): ChangeProjectionResult {
  return {
    valid: true,
    status,
    canonicalBranch: "test/351-model-graph",
    canonicalBaseBranch: "main",
    candidates: { branches: [], pullRequests: [] },
    change: graphChange(state),
    diagnostics: [],
    [GRAPH_INPUT_MARKER]: mode,
  } as unknown as ChangeProjectionResult;
}

function graphFailure(code = "MODEL_FAILURE"): { readonly code: string; readonly message: string } {
  return { code, message: `deterministic ${code}` };
}

function graphDiagnostic(): ChangeDiagnostic {
  return { version: 1, code: "CHANGE_INVALID_PLAN", path: "$.model", message: "deterministic model precondition" };
}

function graphResult(projection: ChangeProjectionResult): ChangeRemoteExecutionResult {
  return { projection };
}

function graphTransitionPlan(effects: readonly ChangeEffect[]): ChangeTransitionPlan {
  return {
    version: 1,
    request: {
      version: 1,
      transition: "ready",
      change: GRAPH_CHANGE,
    },
    from: "DRAFT",
    to: "REVIEW",
    result: graphChange("REVIEW"),
    effects,
  };
}

function graphIssuancePlan(effects: readonly ChangeEffect[]): IssuancePlanResult {
  return { ok: true, plan: { effects } as never };
}

function graphRecoveryPlan(effects: readonly ChangeEffect[]): IssuanceRecoveryPlanResult {
  return {
    ok: true,
    plan: { compensation: { plan: { effects } } } as never,
  };
}

function graphSerializable(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "function" ? undefined : value;
  }
  if (Array.isArray(value)) return value.map((item) => graphSerializable(item));
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, item]) => typeof item !== "function")
      .map(([key, item]) => [key, graphSerializable(item)]),
  );
}

interface GraphSnapshot {
  readonly value: unknown;
  readonly context: unknown;
}

function serializeGraphSnapshot(snapshot: GraphSnapshot): string {
  return JSON.stringify({
    value: graphSerializable(snapshot.value),
    context: graphSerializable(snapshot.context),
  });
}

function graphNodes(root: DirectedGraphNode): readonly DirectedGraphNode[] {
  return [root, ...root.children.flatMap((child) => graphNodes(child))];
}

interface ProductionGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly event: string;
  readonly target: string;
  readonly guard?: (args: { readonly context: unknown; readonly event: GraphEvent }) => boolean;
}

function stateSuffix(machineId: string, stateId: string): string {
  if (stateId === machineId) return "";
  return stateId.startsWith(`${machineId}.`) ? stateId.slice(machineId.length + 1) : stateId;
}

function productionStateIds(machine: AnyStateMachine): ReadonlySet<string> {
  return new Set(graphNodes(toDirectedGraph(machine)).map((node) => stateSuffix(machine.id, node.id)));
}

function productionEventTypes(machine: AnyStateMachine): readonly string[] {
  return [
    ...new Set(graphNodes(toDirectedGraph(machine)).flatMap((node) => node.edges.map((edge) => edge.label.text))),
  ];
}

function productionGraphEdges(machine: AnyStateMachine): readonly ProductionGraphEdge[] {
  return graphNodes(toDirectedGraph(machine)).flatMap((node) =>
    node.edges.map((edge) => ({
      id: edge.id,
      source: stateSuffix(machine.id, edge.source.id),
      event: edge.label.text,
      target: stateSuffix(machine.id, edge.target.id),
      guard:
        typeof edge.transition.guard === "function"
          ? (edge.transition.guard as unknown as ProductionGraphEdge["guard"])
          : undefined,
    })),
  );
}

interface GraphEvent {
  readonly type: string;
  readonly output?: unknown;
}

function machineGraphEvents(
  machine: AnyStateMachine,
  modes: readonly GraphMode[] | ((eventType: string) => readonly GraphMode[]) = GRAPH_MODES,
): readonly GraphEvent[] {
  return productionEventTypes(machine).flatMap((type) => {
    if (!type.startsWith("xstate.done.actor.")) return [{ type }];
    const selectedModes = typeof modes === "function" ? modes(type) : modes;
    return [
      ...selectedModes.map((mode) => ({ type, output: { ok: true, input: graphInput(mode) } })),
      { type, output: { ok: true } },
      { type, output: { ok: false, failure: graphFailure() } },
    ];
  });
}

function stateValueSuffixes(value: unknown, prefix = ""): readonly string[] {
  if (typeof value === "string") return [prefix === "" ? value : `${prefix}.${value}`];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const next = prefix === "" ? key : `${prefix}.${key}`;
    return [next, ...stateValueSuffixes(child, next)];
  });
}

interface GraphPath {
  readonly state: GraphSnapshot;
  readonly steps: readonly { readonly state: GraphSnapshot; readonly event: GraphEvent }[];
}

function coveredStateIds(paths: readonly GraphPath[]): ReadonlySet<string> {
  return new Set(paths.flatMap((path) => stateValueSuffixes(path.state.value)));
}

function stateDepth(state: string): number {
  return state === "" ? 0 : state.split(".").length;
}

function coveredGraphEdges(
  paths: readonly GraphPath[],
  graphEdges: readonly ProductionGraphEdge[],
): ReadonlySet<string> {
  const covered = new Set<string>();
  for (const path of paths) {
    for (let index = 1; index < path.steps.length; index += 1) {
      const previous = path.steps[index - 1];
      const step = path.steps[index];
      if (previous === undefined || step === undefined || step.event.type === "xstate.init") continue;

      const activeStates = [...stateValueSuffixes(previous.state.value)].sort((left, right) => {
        return stateDepth(right) - stateDepth(left);
      });
      const edge = selectGraphEdge(activeStates, previous.state.context, step.event, graphEdges);
      if (edge !== undefined) covered.add(edge.id);
    }
  }
  return covered;
}

function selectGraphEdge(
  activeStates: readonly string[],
  context: unknown,
  event: GraphEvent,
  graphEdges: readonly ProductionGraphEdge[],
): ProductionGraphEdge | undefined {
  for (const source of activeStates) {
    const candidates = graphEdges.filter((edge) => edge.source === source && edge.event === event.type);
    if (candidates.length === 0) continue;

    const selected = candidates.find((edge) => {
      if (edge.guard === undefined) return true;
      try {
        return edge.guard?.({ context, event }) === true;
      } catch {
        return false;
      }
    });
    return selected;
  }
  return undefined;
}

function coverReachableGraphEdges(
  machine: AnyStateMachine,
  paths: readonly GraphPath[],
  graphEdges: readonly ProductionGraphEdge[],
  events: readonly GraphEvent[],
  input: unknown,
  observed: Set<string>,
): void {
  const sourceSnapshots = paths.flatMap((path) => path.steps.map((step) => step.state));
  for (const edge of graphEdges) {
    if (observed.has(edge.id)) continue;
    const matchingSnapshots = sourceSnapshots.filter((snapshot) =>
      stateValueSuffixes(snapshot.value).includes(edge.source),
    );
    for (const sourceSnapshot of matchingSnapshots) {
      for (const event of events.filter((candidate) => candidate.type === edge.event)) {
        const selected = selectGraphEdge(
          [...stateValueSuffixes(sourceSnapshot.value)].sort((left, right) => stateDepth(right) - stateDepth(left)),
          sourceSnapshot.context,
          event,
          graphEdges,
        );
        if (selected?.id !== edge.id) continue;
        try {
          const edgePaths = getPathsFromEvents(machine, [event], {
            fromState: sourceSnapshot as never,
            input: input as never,
            events: [event] as never,
            limit: GRAPH_TRAVERSAL_LIMIT,
            serializeState: serializeGraphSnapshot,
          });
          if (edgePaths.length > 0) {
            observed.add(edge.id);
            break;
          }
        } catch {
          // Keep the edge uncovered; the assertion below requires coverage or an explicit exclusion.
        }
      }
      if (observed.has(edge.id)) break;
    }
  }
}

function assertProductionGraphCoverage(
  machine: AnyStateMachine,
  paths: readonly GraphPath[],
  excludedStates: ReadonlyMap<string, string> = new Map(),
  excludedEdges: ReadonlyMap<string, string> = new Map(),
  events: readonly GraphEvent[] = [],
  input?: unknown,
): void {
  const machineId = machine.id;
  const stateIds = productionStateIds(machine);
  const covered = coveredStateIds(paths);
  const missingStates = [...stateIds].filter(
    (state) => state !== "" && !covered.has(state) && !excludedStates.has(state),
  );
  assert.deepEqual(missingStates, [], `${machineId} has uncovered production states`);

  for (const [state, reason] of excludedStates) {
    assert.ok(stateIds.has(state), `${machineId} exclusion is stale: ${state} (${reason})`);
    assert.ok(reason.length > 0, `${machineId} exclusion reason must be bounded and non-empty`);
  }

  const graphEdges = productionGraphEdges(machine);
  const graphEdgeIds = new Set(graphEdges.map((edge) => edge.id));
  for (const [edge, reason] of excludedEdges) {
    assert.ok(graphEdgeIds.has(edge), `${machineId} edge exclusion is stale: ${edge} (${reason})`);
    assert.ok(reason.length > 0, `${machineId} edge exclusion reason must be bounded and non-empty`);
  }

  const observed = new Set(coveredGraphEdges(paths, graphEdges));
  coverReachableGraphEdges(machine, paths, graphEdges, events, input, observed);
  const missingEdges = graphEdges
    .filter((edge) => !observed.has(edge.id) && !excludedEdges.has(edge.id))
    .map((edge) => `${edge.id} (${edge.source}|${edge.event}|${edge.target})`);
  assert.deepEqual(missingEdges, [], `${machineId} has uncovered production event edges`);
}

function graphPaths(
  machine: AnyStateMachine,
  input: ReadyExecutionServices | AbortExecutionServices | IssuanceExecutionServices,
  events: readonly GraphEvent[],
): readonly GraphPath[] {
  return getShortestPaths(machine, {
    input: input as never,
    events: events as never,
    limit: GRAPH_TRAVERSAL_LIMIT,
    serializeState: serializeGraphSnapshot,
  }) as unknown as readonly GraphPath[];
}

function graphPathProfiles(
  machine: AnyStateMachine,
  input: ReadyExecutionServices | AbortExecutionServices | IssuanceExecutionServices,
  profiles: readonly ((eventType: string) => readonly GraphMode[])[],
): readonly GraphPath[] {
  return profiles.flatMap((profile) => graphPaths(machine, input, machineGraphEvents(machine, profile)));
}

const READY_EFFECT: ChangeEffect = { kind: "MARK_PULL_REQUEST_READY", pullRequest: 3510 };
const ABORT_EFFECTS: readonly ChangeEffect[] = [
  { kind: "CLOSE_PULL_REQUEST", pullRequest: 3510 },
  { kind: "DELETE_BRANCH", branch: "test/351-model-graph" },
];
const ISSUANCE_EFFECTS: readonly ChangeEffect[] = [
  { kind: "CREATE_BRANCH", branch: "test/351-model-graph", baseBranch: "main" },
  {
    kind: "CREATE_PULL_REQUEST",
    branch: "test/351-model-graph",
    baseBranch: "main",
    rootIssue: 351,
    title: "Change #351",
    body: "Closes #351",
    draft: true,
  },
];
const DELETE_BRANCH_EFFECT: ChangeEffect = { kind: "DELETE_BRANCH", branch: "test/351-model-graph" };

function readyGraphServices(): ReadyExecutionServices {
  const projection = (input: ChangeProjectionInput): ChangeProjectionResult => {
    const mode = graphMode(input);
    return graphProjection(mode, mode === "existing" ? "REVIEW" : mode === "precondition" ? "ACCEPTED" : "DRAFT");
  };
  return {
    request: { version: 1, operation: "ready", issue: 351 },
    read: async (): Promise<ReadyReadResult> => ({ ok: true, input: graphInput("valid") }),
    apply: async (): Promise<ReadyEffectResult> => ({ ok: true }),
    failureForEffect: () => graphFailure("READY_EFFECT_FAILED"),
    semantics: {
      project: projection,
      validationInput: (input) => ({ [GRAPH_INPUT_MARKER]: graphMode(input) }),
      validate: (input): { valid: boolean; diagnostics: readonly ChangeDiagnostic[] } =>
        graphMode(input) === "precondition"
          ? { valid: false, diagnostics: [graphDiagnostic()] }
          : { valid: true, diagnostics: [] },
      plan: (input) => graphTransitionPlan(graphMode(input) === "existing" ? [] : [READY_EFFECT]),
      verify: (_request, input): ReadyVerificationResult =>
        graphMode(input) === "verify"
          ? { valid: false, diagnostics: [graphDiagnostic()] }
          : { valid: true, diagnostics: [] },
    },
    results: {
      returnedExisting: graphResult,
      verified: graphResult,
      failed: graphResult,
    },
  };
}

function abortGraphServices(): AbortExecutionServices {
  const projection = (input: ChangeProjectionInput): ChangeProjectionResult => {
    const mode = graphMode(input);
    if (mode === "existing") return graphProjection(mode, "ABORTED");
    if (mode === "recovery") return graphProjection(mode, "RECOVERY_REQUIRED", "partial");
    return graphProjection(mode, "DRAFT");
  };
  return {
    request: { version: 1, operation: "abort", issue: 351 },
    read: async (): Promise<AbortReadResult> => ({ ok: true, input: graphInput("valid") }),
    apply: async (): Promise<AbortEffectResult> => ({ ok: true }),
    failureForEffect: () => graphFailure("ABORT_EFFECT_FAILED"),
    recoveryReadFailure: () => ({
      code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
      message: "deterministic recovery read failure",
      diagnostics: [],
    }),
    semantics: {
      project: projection,
      classify: (value): AbortAdmissionResult => {
        const mode = value.change === undefined ? "valid" : graphMode(value);
        return mode === "precondition"
          ? {
              ok: false,
              failure: { code: "CHANGE_EXECUTION_PRECONDITION_FAILED", message: "precondition", diagnostics: [] },
            }
          : { ok: true, phase: mode === "recovery" ? "recovery" : "normal" };
      },
      plan: (_request, value): AbortPlanResult => {
        const mode = graphMode(value);
        if (mode === "plan-failure") {
          return {
            ok: false,
            failure: { code: "CHANGE_EXECUTION_PRECONDITION_FAILED", message: "plan failure", diagnostics: [] },
          };
        }
        return {
          ok: true,
          plan: graphTransitionPlan(
            mode === "existing" ? [] : mode === "recovery" ? [DELETE_BRANCH_EFFECT] : ABORT_EFFECTS,
          ),
        };
      },
      recover: (_request, _transition, _attempts, _failure, input): AbortRecoveryResult =>
        graphMode(input) === "unsafe-recovery"
          ? {
              ok: false,
              failure: { code: "CHANGE_EXECUTION_RECOVERY_REQUIRED", message: "unsafe recovery", diagnostics: [] },
            }
          : { ok: true, result: graphResult(projection(input)) },
      verify: (_request, input): AbortVerificationResult =>
        graphMode(input) === "verify"
          ? { valid: false, diagnostics: [graphDiagnostic()] }
          : { valid: true, diagnostics: [] },
    },
    results: {
      returnedExisting: graphResult,
      verified: (value) => graphResult(value),
      recoveryRequired: (value) => graphResult(value),
    },
  };
}

function issuanceGraphServices(): IssuanceExecutionServices {
  const projection = (input: ChangeProjectionInput): ChangeProjectionResult => {
    const mode = graphMode(input);
    return graphProjection(
      mode,
      mode === "existing" ? "DRAFT" : "DEFINED",
      mode === "recovery" ? "partial" : mode === "safe-compensation" ? "absent" : "healthy",
    );
  };
  return {
    request: { version: 1, operation: "issue", issue: 351 },
    read: async (): Promise<IssuanceReadResult> => ({ ok: true, input: graphInput("valid") }),
    apply: async (): Promise<IssuanceEffectResult> => ({ ok: true }),
    failureForEffect: () => graphFailure("ISSUANCE_EFFECT_FAILED"),
    semantics: {
      project: projection,
      validateGovernance: (input) => (graphMode(input) === "precondition" ? [graphDiagnostic()] : []),
      validateGovernanceDrift: (initial, fresh) =>
        graphMode(initial) === "precondition" || graphMode(fresh) === "precondition" ? [graphDiagnostic()] : [],
      plan: (input): IssuancePlanResult => {
        const mode = graphMode(input);
        if (mode === "existing") return graphIssuancePlan([]);
        if (mode === "plan-failure") {
          return {
            ok: false,
            failure: { code: "CHANGE_EXECUTION_PRECONDITION_FAILED", message: "plan failure", diagnostics: [] },
          };
        }
        return graphIssuancePlan(ISSUANCE_EFFECTS);
      },
      verify: (_request, input): IssuanceVerificationResult =>
        graphMode(input) === "verify"
          ? { valid: false, diagnostics: [graphDiagnostic()] }
          : { valid: true, diagnostics: [] },
      classifyEffectFailureProjection: (value) =>
        graphMode(value) === "safe-compensation" || graphMode(value) === "branch-failure"
          ? "confirmed-absent"
          : "unresolved",
      planRecovery: (input): IssuanceRecoveryPlanResult => {
        const mode = graphMode(input.projectionInput);
        if (mode === "compensation-unsafe" && input.compensation !== undefined)
          return {
            ok: false,
            failure: { code: "CHANGE_EXECUTION_RECOVERY_REQUIRED", message: "unsafe recovery", diagnostics: [] },
          };
        if (mode === "compensation-unsafe")
          return { ok: true, plan: { compensation: { plan: { effects: [] } } } as never };
        if (mode === "unsafe-recovery")
          return {
            ok: false,
            failure: { code: "CHANGE_EXECUTION_RECOVERY_REQUIRED", message: "unsafe recovery", diagnostics: [] },
          };
        return graphRecoveryPlan([DELETE_BRANCH_EFFECT]);
      },
    },
    results: {
      returnedExisting: graphResult,
      verified: (value) => graphResult(value),
      effectFailed: () => ({ code: "CHANGE_EXECUTION_EFFECT_FAILED", message: "effect failed", diagnostics: [] }),
      compensated: (value) => graphResult(value),
      recoveryRequired: (value) => graphResult(value),
      recoveryUnsafe: (_plan, value) => graphResult(value),
      recoveryReadFailure: () => ({
        code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
        message: "read failure",
        diagnostics: [],
      }),
    },
  };
}

test("production lifecycle graph covers every public reachable state/event path", () => {
  const events = machineGraphEvents(lifecycleMachine);
  const paths = CHANGE_STATES.flatMap((state) =>
    getShortestPaths(lifecycleMachine, {
      input: { state },
      events: events as never,
      limit: GRAPH_TRAVERSAL_LIMIT,
      serializeState: serializeGraphSnapshot,
    }),
  ) as unknown as readonly GraphPath[];

  assert.deepEqual(new Set(paths.flatMap((path) => stateValueSuffixes(path.state.value))), new Set(CHANGE_STATES));
  assertProductionGraphCoverage(
    lifecycleMachine,
    paths,
    new Map([["admit", "transient authoritative-state admission"]]),
    new Map(),
    events,
  );

  for (const path of paths) {
    for (let index = 1; index < path.steps.length; index += 1) {
      const source = path.steps[index - 1]?.state.value;
      const event = path.steps[index]?.event.type;
      const target = path.steps[index]?.state.value;
      if (typeof source !== "string" || typeof target !== "string" || event === "xstate.init") continue;
      const operation = event.toLowerCase() as ChangeTransition;
      if (!CHANGE_TRANSITION_OPERATIONS.includes(operation) || operation === "merge") continue;
      const result = transitionChangeLifecycle(source as ChangeState, operation);
      assert.equal(result.accepted, true, `${source}/${event}`);
      assert.equal(result.to, target, `${source}/${event}`);
    }
  }
});

test("production Ready, Abort, and Issuance graphs cover all bounded machine states and event edges", () => {
  const readyServices = readyGraphServices();
  const readyEvents = machineGraphEvents(readyExecutionMachine, [
    "valid",
    "existing",
    "precondition",
    "verify",
    "effect-failure",
  ]);
  const readyPaths = graphPaths(readyExecutionMachine, readyServices, readyEvents);
  const abortServices = abortGraphServices();
  const abortEvents = machineGraphEvents(abortExecutionMachine, [
    "valid",
    "existing",
    "precondition",
    "plan-failure",
    "verify",
    "unsafe-recovery",
    "recovery",
  ]);
  const abortPaths = graphPaths(abortExecutionMachine, abortServices, abortEvents);
  const issuanceServices = issuanceGraphServices();
  const issuanceEvents = machineGraphEvents(issuanceExecutionMachine);
  const issuancePaths = graphPathProfiles(issuanceExecutionMachine, issuanceServices, [
    () => ["valid"],
    () => ["existing"],
    () => ["precondition"],
    () => ["plan-failure"],
    (eventType) => (eventType.endsWith(".rereadingAfterFailure") ? ["branch-failure"] : ["valid"]),
    (eventType) =>
      eventType.endsWith(".rereadingAfterFailure") || eventType.endsWith(".rereadingAfterCompensation")
        ? ["safe-compensation"]
        : ["valid"],
    (eventType) => (eventType.endsWith(".rereadingAfterFailure") ? ["unsafe-recovery"] : ["valid"]),
    (eventType) =>
      eventType.endsWith(".rereadingAfterCompensation")
        ? ["compensation-failure"]
        : eventType.endsWith(".rereadingAfterFailure")
          ? ["safe-compensation"]
          : ["valid"],
    (eventType) =>
      eventType.endsWith(".rereadingAfterCompensation")
        ? ["compensation-unsafe"]
        : eventType.endsWith(".rereadingAfterFailure")
          ? ["safe-compensation"]
          : ["valid"],
  ]);

  assertProductionGraphCoverage(
    readyExecutionMachine,
    readyPaths,
    READY_GRAPH_EXCLUSIONS,
    new Map(),
    readyEvents,
    readyServices,
  );
  assertProductionGraphCoverage(
    abortExecutionMachine,
    abortPaths,
    ABORT_GRAPH_EXCLUSIONS,
    ABORT_GRAPH_EDGE_EXCLUSIONS,
    abortEvents,
    abortServices,
  );
  assertProductionGraphCoverage(
    issuanceExecutionMachine,
    issuancePaths,
    ISSUANCE_GRAPH_EXCLUSIONS,
    new Map(),
    issuanceEvents,
    issuanceServices,
  );
});

async function expectExecutionFailure(
  operation: "ready" | "abort" | "issue",
  execute: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(
    execute,
    (error: unknown) => error instanceof ChangeTrustedExecutorError && error.code === code,
    `${operation} must fail with ${code}`,
  );
}

test("model scenarios execute Ready's success, retry, precondition, effect, and verification paths", async () => {
  const success = await createGoldenPathActors(draftEvidenceInput()).executor.execute(mutationRequest("ready"));
  assert.equal(success.evidence?.outcome, "verified");
  assert.equal(success.projection.change?.state, "REVIEW");

  const retry = await createGoldenPathActors(reviewEvidenceInput()).executor.execute(mutationRequest("ready"));
  assert.equal(retry.evidence?.outcome, "returned-existing");
  assert.equal(retry.projection.change?.state, "REVIEW");

  await expectExecutionFailure(
    "ready",
    () => createGoldenPathActors(abortedEvidenceInput()).executor.execute(mutationRequest("ready")),
    "CHANGE_EXECUTION_PRECONDITION_FAILED",
  );

  const effectFailure = await createGoldenPathActors(draftEvidenceInput(), {
    failEffect: "MARK_PULL_REQUEST_READY",
  }).executor.execute(mutationRequest("ready"));
  assert.equal(effectFailure.evidence?.outcome, "failed");
  assert.equal(effectFailure.projection.change?.state, "DRAFT");

  await expectExecutionFailure(
    "ready",
    () =>
      createGoldenPathActors(draftEvidenceInput(), { applySuccessfulEffect: false }).executor.execute(
        mutationRequest("ready"),
      ),
    "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
  );
});

test("model scenarios execute Abort success, retry, recovery, unsafe cleanup, and verification paths", async () => {
  for (const input of [draftEvidenceInput(), reviewEvidenceInput()]) {
    const result = await createGoldenPathActors(input).executor.execute(mutationRequest("abort"));
    assert.equal(result.evidence?.outcome, "verified");
    assert.equal(result.projection.change?.state, "ABORTED");
  }

  const retry = await createGoldenPathActors(abortedEvidenceInput()).executor.execute(mutationRequest("abort"));
  assert.equal(retry.evidence?.outcome, "returned-existing");

  const failedActors = createGoldenPathActors(reviewEvidenceInput(), { failEffect: "DELETE_BRANCH" });
  const failed = await failedActors.executor.execute(mutationRequest("abort"));
  assert.equal(failed.evidence?.outcome, "recovery-required");
  assert.equal(failed.projection.change?.state, "RECOVERY_REQUIRED");

  const recovered = await createGoldenPathActors(failedActors.reader.current).executor.execute(
    mutationRequest("abort"),
  );
  assert.equal(recovered.evidence?.outcome, "verified");
  assert.equal(recovered.projection.change?.state, "ABORTED");

  const unsafe = await createGoldenPathActors(reviewEvidenceInput(), {
    failEffect: "DELETE_BRANCH",
    applyFailedEffect: true,
  }).executor.execute(mutationRequest("abort"));
  assert.equal(unsafe.evidence?.outcome, "recovery-required");
  assert.equal(unsafe.projection.change?.state, "RECOVERY_REQUIRED");

  await expectExecutionFailure(
    "abort",
    () =>
      createGoldenPathActors(reviewEvidenceInput(), { leaveBranchAfterDelete: true }).executor.execute(
        mutationRequest("abort"),
      ),
    "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
  );
});

test("model scenarios execute Issuance creation, retry, failures, compensation, recovery, and verification paths", async () => {
  const created = await createGoldenPathActors(absentEvidenceInput()).executor.execute(mutationRequest("issue"));
  assert.equal(created.evidence?.outcome, "verified");
  assert.equal(created.projection.change?.state, "DRAFT");

  const retry = await createGoldenPathActors(draftEvidenceInput()).executor.execute(mutationRequest("issue"));
  assert.equal(retry.evidence?.outcome, "returned-existing");

  await expectExecutionFailure(
    "issue",
    () =>
      createGoldenPathActors(absentEvidenceInput(), { failEffect: "CREATE_BRANCH" }).executor.execute(
        mutationRequest("issue"),
      ),
    "CHANGE_EXECUTION_EFFECT_FAILED",
  );

  const compensated = await createGoldenPathActors(absentEvidenceInput(), {
    failEffect: "CREATE_PULL_REQUEST",
  }).executor.execute(mutationRequest("issue"));
  assert.equal(compensated.evidence?.outcome, "compensated");
  assert.equal(compensated.evidence?.compensation, "succeeded");

  const unsafe = await createGoldenPathActors(absentEvidenceInput(), {
    failEffect: "CREATE_PULL_REQUEST",
    applyFailedEffect: true,
  }).executor.execute(mutationRequest("issue"));
  assert.equal(unsafe.evidence?.outcome, "recovery-required");
  assert.equal(unsafe.projection.change?.state, "RECOVERY_REQUIRED");

  const failedCompensationActors = createGoldenPathActors(absentEvidenceInput(), {
    failEffect: "CREATE_PULL_REQUEST",
  });
  const originalApply = failedCompensationActors.issuer.applyEffects.bind(failedCompensationActors.issuer);
  failedCompensationActors.issuer.applyEffects = async (request) => {
    if (request.effects[0]?.kind === "DELETE_BRANCH") throw new Error("deterministic compensation failure");
    return originalApply(request);
  };
  const failedCompensation = await failedCompensationActors.executor.execute(mutationRequest("issue"));
  assert.equal(failedCompensation.evidence?.outcome, "recovery-required");
  assert.equal(failedCompensation.evidence?.compensation, "failed");

  await expectExecutionFailure(
    "issue",
    () =>
      createGoldenPathActors(absentEvidenceInput(), { applySuccessfulEffect: false }).executor.execute(
        mutationRequest("issue"),
      ),
    "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
  );
});
