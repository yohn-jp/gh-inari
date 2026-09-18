/**
 * Golden Path composition for the first-class Implementation topology.
 *
 * This module only joins already-authoritative Implementation, Change, and
 * conformance results. It does not authorize an Implementation, issue a
 * Change, or create another lifecycle store.
 */

import {
  CHANGE_PROJECTION_STATUSES,
  CHANGE_STATES,
  type Change,
  type ChangeProjectionResult,
  type ChangeProjectionStatus,
  type ChangeState,
  validateChange,
  validateChangeProjectionResult,
} from "./change.js";
import {
  IMPLEMENTATION_AUTHORIZATION_KIND,
  validateImplementationAuthorizationRecord,
  type ImplementationAuthorizationRecord,
  type ImplementationLifecycleStatus,
} from "./implementation-authorization.js";
import {
  IMPLEMENTATION_CONFORMANCE_KIND,
  IMPLEMENTATION_CONFORMANCE_STATUSES,
  IMPLEMENTATION_CONFORMANCE_VERSION,
  type ImplementationConformanceStatus,
} from "./implementation-conformance.js";
import {
  IMPLEMENTATION_READINESS_ADMISSION_KIND,
  IMPLEMENTATION_READINESS_ADMISSION_VERSION,
  IMPLEMENTATION_READINESS_CLASSIFICATIONS,
  type ImplementationReadinessClassification,
} from "./implementation-readiness.js";
import { validateImplementationContract } from "./implementation-contract.js";
import { classifyChangeRoot } from "./implementation-change-identity.js";
import { normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";

export const GOLDEN_PATH_IMPLEMENTATION_VERSION = 1 as const;
export type GoldenPathImplementationVersion = typeof GOLDEN_PATH_IMPLEMENTATION_VERSION;

export const GOLDEN_PATH_IMPLEMENTATION_STATUSES = Object.freeze([
  "draft",
  "blocked",
  "ready-to-authorize",
  "authorized",
  "active",
  "conformance-required",
  "ready-change",
  "review",
  "terminal",
] as const);
export type GoldenPathImplementationStatus = (typeof GOLDEN_PATH_IMPLEMENTATION_STATUSES)[number];

export const GOLDEN_PATH_IMPLEMENTATION_COMPATIBILITY_MODES = Object.freeze([
  "implementation-native",
  "historical-issue-root",
] as const);
export type GoldenPathImplementationCompatibilityMode = (typeof GOLDEN_PATH_IMPLEMENTATION_COMPATIBILITY_MODES)[number];

export type GoldenPathImplementationDiagnosticCode =
  | "GOLDEN_PATH_IMPLEMENTATION_INPUT_INVALID"
  | "GOLDEN_PATH_IMPLEMENTATION_REQUIRED"
  | "GOLDEN_PATH_IMPLEMENTATION_IDENTITY_MISMATCH"
  | "GOLDEN_PATH_IMPLEMENTATION_SOURCE_MISMATCH"
  | "GOLDEN_PATH_IMPLEMENTATION_CONTRACT_INVALID"
  | "GOLDEN_PATH_IMPLEMENTATION_AUTHORIZATION_INVALID"
  | "GOLDEN_PATH_IMPLEMENTATION_READINESS_INVALID"
  | "GOLDEN_PATH_IMPLEMENTATION_CONFORMANCE_INVALID"
  | "GOLDEN_PATH_IMPLEMENTATION_COMPATIBILITY_INVALID"
  | "GOLDEN_PATH_IMPLEMENTATION_CHANGE_INVALID";

export interface GoldenPathImplementationDiagnostic {
  readonly code: GoldenPathImplementationDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

/** Canonical results are accepted as opaque evidence; their authorities own their details. */
export interface GoldenPathImplementationProjectionInput {
  readonly sourceIssue?: unknown;
  readonly implementation?: unknown;
  readonly contract?: unknown;
  readonly authorization?: unknown;
  readonly readiness?: unknown;
  readonly conformance?: unknown;
  readonly change?: unknown;
  readonly changeProjection?: unknown;
  readonly compatibility?: GoldenPathImplementationCompatibilityMode;
  /** Explicit worker completion evidence; it never grants ready-transition authority. */
  readonly complete?: boolean;
}

export interface GoldenPathImplementationProjection {
  readonly version: GoldenPathImplementationVersion;
  readonly status: GoldenPathImplementationStatus;
  readonly compatibility: GoldenPathImplementationCompatibilityMode;
  readonly sourceIssue?: IssueReference;
  readonly implementation?: IssueReference;
  readonly authorizationStatus?: ImplementationLifecycleStatus;
  readonly readinessClassification?: ImplementationReadinessClassification;
  readonly conformanceStatus?: ImplementationConformanceStatus;
  readonly changeState?: ChangeState;
  readonly projectionStatus?: ChangeProjectionStatus;
  readonly diagnostics: readonly GoldenPathImplementationDiagnostic[];
}

export interface GoldenPathImplementationProjectionResult {
  readonly valid: boolean;
  readonly projection?: GoldenPathImplementationProjection;
  readonly diagnostics: readonly GoldenPathImplementationDiagnostic[];
}

type RecordValue = Record<string, unknown>;

const MAX_DIAGNOSTICS = 16;
const INPUT_KEYS = new Set([
  "sourceIssue",
  "implementation",
  "contract",
  "authorization",
  "readiness",
  "conformance",
  "change",
  "changeProjection",
  "compatibility",
  "complete",
]);
const AUTHORIZATION_STATUSES = new Set<ImplementationLifecycleStatus>([
  "draft",
  "ready",
  "authorized",
  "invalidated",
  "superseded",
  "completed",
]);
function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function diagnostic(
  code: GoldenPathImplementationDiagnosticCode,
  path: string,
  message: string,
): GoldenPathImplementationDiagnostic {
  return { code, path, message };
}

function boundedDiagnostics(
  diagnostics: readonly GoldenPathImplementationDiagnostic[],
): readonly GoldenPathImplementationDiagnostic[] {
  return Object.freeze(diagnostics.slice(0, MAX_DIAGNOSTICS));
}

function sameReference(left: IssueReference, right: IssueReference): boolean {
  return (
    left.repositoryHost === right.repositoryHost &&
    left.repositoryId === right.repositoryId &&
    left.number === right.number
  );
}

function sameRepository(left: IssueReference, right: IssueReference): boolean {
  return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}

function referenceValue(
  value: unknown,
  path: string,
): { readonly reference?: IssueReference; readonly diagnostics: readonly GoldenPathImplementationDiagnostic[] } {
  const candidate = isRecord(value) && hasOwn(value, "reference") ? value.reference : value;
  const result = normalizeIssueReference(candidate, path);
  if (result.valid && result.reference !== undefined) return { reference: result.reference, diagnostics: [] };
  return {
    diagnostics: [
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_INPUT_INVALID",
        path,
        "A canonical Issue reference is required for Implementation composition.",
      ),
    ],
  };
}

function implementationReference(
  value: unknown,
  path: string,
): {
  readonly reference?: IssueReference;
  readonly diagnostics: readonly GoldenPathImplementationDiagnostic[];
} {
  if (isRecord(value) && hasOwn(value, "reference")) return referenceValue(value, path);
  return referenceValue(value, path);
}

interface AuthorizationView {
  readonly status?: ImplementationLifecycleStatus;
  readonly authorized: boolean;
  readonly current: boolean;
  readonly implementation?: IssueReference;
  readonly valid: boolean;
}

function authorizationView(
  value: unknown,
  diagnostics: GoldenPathImplementationDiagnostic[],
): AuthorizationView | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_AUTHORIZATION_INVALID",
        "$.authorization",
        "Implementation authorization evidence must be a canonical result or record.",
      ),
    );
    return undefined;
  }

  const wrapper = value;
  const recordCandidate =
    wrapper.kind === IMPLEMENTATION_AUTHORIZATION_KIND
      ? wrapper
      : isRecord(wrapper.authorization)
        ? isRecord(wrapper.authorization.record)
          ? wrapper.authorization.record
          : wrapper.authorization
        : isRecord(wrapper.record)
          ? wrapper.record
          : undefined;
  let record: ImplementationAuthorizationRecord | undefined;
  if (recordCandidate !== undefined) {
    const validation = validateImplementationAuthorizationRecord(recordCandidate);
    if (!validation.valid || validation.record === undefined) {
      diagnostics.push(
        diagnostic(
          "GOLDEN_PATH_IMPLEMENTATION_AUTHORIZATION_INVALID",
          "$.authorization",
          "Implementation authorization record is not canonical.",
        ),
      );
    } else record = validation.record;
  }

  const status = wrapper.status;
  if (
    status !== undefined &&
    (!AUTHORIZATION_STATUSES.has(status as ImplementationLifecycleStatus) || typeof status !== "string")
  ) {
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_AUTHORIZATION_INVALID",
        "$.authorization.status",
        "Implementation authorization status is invalid.",
      ),
    );
  }
  const authorized =
    wrapper.authorized === true || (record !== undefined && wrapper.kind === IMPLEMENTATION_AUTHORIZATION_KIND);
  const current =
    wrapper.current === true || (record !== undefined && wrapper.kind === IMPLEMENTATION_AUTHORIZATION_KIND);
  if (wrapper.authorized !== undefined && typeof wrapper.authorized !== "boolean")
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_AUTHORIZATION_INVALID",
        "$.authorization.authorized",
        "Authorization status must be boolean when supplied.",
      ),
    );
  if (wrapper.current !== undefined && typeof wrapper.current !== "boolean")
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_AUTHORIZATION_INVALID",
        "$.authorization.current",
        "Authorization currentness must be boolean when supplied.",
      ),
    );
  const wrapperImplementation = isRecord(wrapper.implementation)
    ? referenceValue(wrapper.implementation, "$.authorization.implementation")
    : undefined;
  if (wrapperImplementation !== undefined && wrapperImplementation.reference === undefined)
    diagnostics.push(...wrapperImplementation.diagnostics);
  return {
    status: (status as ImplementationLifecycleStatus | undefined) ?? (record === undefined ? undefined : "authorized"),
    authorized,
    current,
    implementation: record?.implementation ?? wrapperImplementation?.reference,
    valid:
      wrapper.valid !== false &&
      diagnostics.every((entry) => entry.code !== "GOLDEN_PATH_IMPLEMENTATION_AUTHORIZATION_INVALID"),
  };
}

interface ReadinessView {
  readonly classification?: ImplementationReadinessClassification;
  readonly admitted: boolean;
  readonly valid: boolean;
  readonly implementation?: IssueReference;
}

function readinessView(value: unknown, diagnostics: GoldenPathImplementationDiagnostic[]): ReadinessView | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_READINESS_INVALID",
        "$.readiness",
        "Implementation readiness evidence must be a canonical admission result.",
      ),
    );
    return undefined;
  }
  if (
    value.kind !== IMPLEMENTATION_READINESS_ADMISSION_KIND ||
    value.version !== IMPLEMENTATION_READINESS_ADMISSION_VERSION
  ) {
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_READINESS_INVALID",
        "$.readiness",
        "Implementation readiness evidence is not a canonical admission result.",
      ),
    );
  }
  const classification = value.classification;
  if (!IMPLEMENTATION_READINESS_CLASSIFICATIONS.includes(classification as ImplementationReadinessClassification))
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_READINESS_INVALID",
        "$.readiness.classification",
        "Implementation readiness classification is invalid.",
      ),
    );
  if (typeof value.admitted !== "boolean" || (value.admitted === true && classification !== "READY"))
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_READINESS_INVALID",
        "$.readiness.admitted",
        "Readiness admission must agree with its classification.",
      ),
    );
  const referenceResult =
    value.implementation === undefined ? undefined : referenceValue(value.implementation, "$.readiness.implementation");
  if (referenceResult !== undefined && referenceResult.reference === undefined)
    diagnostics.push(...referenceResult.diagnostics);
  const reference = referenceResult?.reference;
  return {
    classification: classification as ImplementationReadinessClassification,
    admitted: value.admitted === true,
    valid: value.valid === true,
    implementation: reference,
  };
}

interface ConformanceView {
  readonly status?: ImplementationConformanceStatus;
  readonly valid: boolean;
}

function conformanceView(
  value: unknown,
  diagnostics: GoldenPathImplementationDiagnostic[],
): ConformanceView | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_CONFORMANCE_INVALID",
        "$.conformance",
        "Implementation conformance evidence must be a canonical verification result.",
      ),
    );
    return undefined;
  }
  if (value.kind !== IMPLEMENTATION_CONFORMANCE_KIND || value.version !== IMPLEMENTATION_CONFORMANCE_VERSION)
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_CONFORMANCE_INVALID",
        "$.conformance",
        "Implementation conformance evidence is not a canonical verification result.",
      ),
    );
  if (!IMPLEMENTATION_CONFORMANCE_STATUSES.includes(value.status as ImplementationConformanceStatus))
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_CONFORMANCE_INVALID",
        "$.conformance.status",
        "Implementation conformance status is invalid.",
      ),
    );
  if (typeof value.valid !== "boolean")
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_CONFORMANCE_INVALID",
        "$.conformance.valid",
        "Implementation conformance validity is required.",
      ),
    );
  return { status: value.status as ImplementationConformanceStatus, valid: value.valid === true };
}

interface ChangeView {
  readonly change?: Change;
  readonly state?: ChangeState;
  readonly projectionStatus?: ChangeProjectionStatus;
}

function changeView(value: unknown, diagnostics: GoldenPathImplementationDiagnostic[]): ChangeView {
  if (value === undefined) return {};
  if (isRecord(value) && hasOwn(value, "valid") && hasOwn(value, "candidates")) {
    const validation = validateChangeProjectionResult(value);
    if (!validation.valid || validation.projection === undefined) {
      diagnostics.push(
        diagnostic(
          "GOLDEN_PATH_IMPLEMENTATION_CHANGE_INVALID",
          "$.changeProjection",
          "Change projection evidence is invalid.",
        ),
      );
      return {};
    }
    return {
      change: validation.projection.change,
      state: validation.projection.change?.state,
      projectionStatus: validation.projection.status,
    };
  }
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic("GOLDEN_PATH_IMPLEMENTATION_CHANGE_INVALID", "$.change", "Change evidence must be an object."),
    );
    return {};
  }
  const validation = validateChange(value);
  if (validation.valid && validation.change !== undefined)
    return {
      change: validation.change,
      state: validation.change.state,
      projectionStatus: validation.change.state === "DEFINED" ? "absent" : "healthy",
    };
  if (typeof value.state === "string" && CHANGE_STATES.includes(value.state as ChangeState))
    return {
      state: value.state as ChangeState,
      projectionStatus:
        typeof value.projectionStatus === "string" &&
        CHANGE_PROJECTION_STATUSES.includes(value.projectionStatus as ChangeProjectionStatus)
          ? (value.projectionStatus as ChangeProjectionStatus)
          : undefined,
    };
  if (isRecord(value.identity) && typeof value.identity.rootIssue === "number") return {};
  diagnostics.push(
    diagnostic("GOLDEN_PATH_IMPLEMENTATION_CHANGE_INVALID", "$.change", "Change evidence is not canonical."),
  );
  return {};
}

function contractRepository(
  value: unknown,
): { readonly repositoryHost: string; readonly repositoryId: string } | undefined {
  if (!isRecord(value) || !isRecord(value.repository)) return undefined;
  if (typeof value.repository.repositoryHost !== "string" || typeof value.repository.repositoryId !== "string")
    return undefined;
  return {
    repositoryHost: value.repository.repositoryHost.toLocaleLowerCase("en-US"),
    repositoryId: value.repository.repositoryId,
  };
}

function changeRoot(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.change) && isRecord(value.change.identity) && typeof value.change.identity.rootIssue === "number")
    return value.change.identity.rootIssue;
  if (isRecord(value.identity) && typeof value.identity.rootIssue === "number") return value.identity.rootIssue;
  return undefined;
}

function implementationStatus(
  authorization: AuthorizationView | undefined,
  readiness: ReadinessView | undefined,
  conformance: ConformanceView | undefined,
  change: ChangeView,
  complete: boolean | undefined,
): GoldenPathImplementationStatus {
  if (readiness?.classification === "BLOCKED" || readiness?.classification === "INVALID") return "blocked";
  if (authorization?.status === "invalidated" || authorization?.status === "superseded") return "blocked";
  if (
    change.state === "RECOVERY_REQUIRED" ||
    (change.projectionStatus !== undefined && !["absent", "healthy"].includes(change.projectionStatus))
  )
    return "blocked";
  if (change.state === "REVIEW") return "review";
  if (change.state === "ACCEPTED" || change.state === "MERGED" || change.state === "ABORTED") return "terminal";
  if (change.state === "DRAFT") {
    if (conformance?.status === "conformant" && conformance.valid) return "ready-change";
    if (complete === true || conformance !== undefined) return "conformance-required";
    return "active";
  }
  if (authorization?.authorized && authorization.current && authorization.status === "authorized") return "authorized";
  if (authorization?.status === "ready" || (readiness?.classification === "READY" && readiness.admitted))
    return "ready-to-authorize";
  return "draft";
}

function projectionFor(
  status: GoldenPathImplementationStatus,
  compatibility: GoldenPathImplementationCompatibilityMode,
  sourceIssue: IssueReference | undefined,
  implementation: IssueReference | undefined,
  authorization: AuthorizationView | undefined,
  readiness: ReadinessView | undefined,
  conformance: ConformanceView | undefined,
  change: ChangeView,
  diagnostics: readonly GoldenPathImplementationDiagnostic[],
): GoldenPathImplementationProjection {
  return Object.freeze({
    version: GOLDEN_PATH_IMPLEMENTATION_VERSION,
    status,
    compatibility,
    ...(sourceIssue === undefined ? {} : { sourceIssue }),
    ...(implementation === undefined ? {} : { implementation }),
    ...(authorization?.status === undefined ? {} : { authorizationStatus: authorization.status }),
    ...(readiness?.classification === undefined ? {} : { readinessClassification: readiness.classification }),
    ...(conformance?.status === undefined ? {} : { conformanceStatus: conformance.status }),
    ...(change.state === undefined ? {} : { changeState: change.state }),
    ...(change.projectionStatus === undefined ? {} : { projectionStatus: change.projectionStatus }),
    diagnostics: boundedDiagnostics(diagnostics),
  });
}

/** Project Implementation-native Golden Path state from canonical evidence. */
export function tryProjectGoldenPathImplementation(input: unknown): GoldenPathImplementationProjectionResult {
  const diagnostics: GoldenPathImplementationDiagnostic[] = [];
  if (!isRecord(input)) {
    diagnostics.push(
      diagnostic("GOLDEN_PATH_IMPLEMENTATION_INPUT_INVALID", "$", "Implementation evidence must be an object."),
    );
    return { valid: false, diagnostics: boundedDiagnostics(diagnostics) };
  }
  for (const key of Object.keys(input).sort())
    if (!INPUT_KEYS.has(key))
      diagnostics.push(
        diagnostic("GOLDEN_PATH_IMPLEMENTATION_INPUT_INVALID", `$.${key}`, "Property is not supported."),
      );

  const nativeSignals =
    hasOwn(input, "sourceIssue") ||
    hasOwn(input, "implementation") ||
    hasOwn(input, "contract") ||
    hasOwn(input, "authorization") ||
    hasOwn(input, "readiness") ||
    hasOwn(input, "conformance") ||
    hasOwn(input, "compatibility") ||
    hasOwn(input, "complete");
  if (!nativeSignals) return { valid: true, diagnostics: [] };

  const sourceResult =
    input.sourceIssue === undefined
      ? { diagnostics: [] as readonly GoldenPathImplementationDiagnostic[] }
      : referenceValue(input.sourceIssue, "$.sourceIssue");
  const implementationResult =
    input.implementation === undefined
      ? { diagnostics: [] as readonly GoldenPathImplementationDiagnostic[] }
      : implementationReference(input.implementation, "$.implementation");
  diagnostics.push(...sourceResult.diagnostics, ...implementationResult.diagnostics);
  const sourceIssue = sourceResult.reference;
  const implementation = implementationResult.reference;
  const rawCompatibility = input.compatibility;
  const compatibility =
    typeof rawCompatibility === "string" ? (rawCompatibility as GoldenPathImplementationCompatibilityMode) : undefined;
  if (
    rawCompatibility !== undefined &&
    !GOLDEN_PATH_IMPLEMENTATION_COMPATIBILITY_MODES.includes(compatibility as never)
  )
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_COMPATIBILITY_INVALID",
        "$.compatibility",
        "Implementation compatibility mode is invalid.",
      ),
    );
  if (sourceIssue !== undefined && implementation !== undefined) {
    if (!sameRepository(sourceIssue, implementation))
      diagnostics.push(
        diagnostic(
          "GOLDEN_PATH_IMPLEMENTATION_SOURCE_MISMATCH",
          "$.implementation",
          "Source Issue and Implementation must belong to the same repository.",
        ),
      );
    if (sameReference(sourceIssue, implementation))
      diagnostics.push(
        diagnostic(
          "GOLDEN_PATH_IMPLEMENTATION_SOURCE_MISMATCH",
          "$.implementation",
          "An Implementation cannot be the same Issue as its source Issue.",
        ),
      );
  }
  if (implementation === undefined && compatibility !== "historical-issue-root")
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_REQUIRED",
        "$.implementation",
        "An executable Implementation reference is required for native Golden Path composition.",
      ),
    );
  if (compatibility === "historical-issue-root" && implementation !== undefined)
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_COMPATIBILITY_INVALID",
        "$.compatibility",
        "Historical Issue-root compatibility cannot be combined with an executable Implementation.",
      ),
    );

  const authorizationDiagnostics: GoldenPathImplementationDiagnostic[] = [];
  const authorization = authorizationView(input.authorization, authorizationDiagnostics);
  diagnostics.push(...authorizationDiagnostics);
  if (
    authorization?.implementation !== undefined &&
    implementation !== undefined &&
    !sameReference(authorization.implementation, implementation)
  )
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_IDENTITY_MISMATCH",
        "$.authorization.implementation",
        "Implementation authorization targets a different Implementation.",
      ),
    );

  const readinessDiagnostics: GoldenPathImplementationDiagnostic[] = [];
  const readiness = readinessView(input.readiness, readinessDiagnostics);
  diagnostics.push(...readinessDiagnostics);
  if (
    readiness?.implementation !== undefined &&
    implementation !== undefined &&
    !sameReference(readiness.implementation, implementation)
  )
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_IDENTITY_MISMATCH",
        "$.readiness.implementation",
        "Implementation readiness targets a different Implementation.",
      ),
    );

  if (input.contract !== undefined) {
    const contractValidation = validateImplementationContract(input.contract);
    if (!contractValidation.valid || contractValidation.contract === undefined)
      diagnostics.push(
        diagnostic(
          "GOLDEN_PATH_IMPLEMENTATION_CONTRACT_INVALID",
          "$.contract",
          "Implementation contract evidence is not canonical.",
        ),
      );
    if (contractValidation.valid && contractValidation.contract !== undefined) {
      const repository = contractRepository(input.contract);
      if (repository === undefined)
        diagnostics.push(
          diagnostic(
            "GOLDEN_PATH_IMPLEMENTATION_CONTRACT_INVALID",
            "$.contract",
            "Implementation contract evidence is not canonical.",
          ),
        );
      else if (
        implementation !== undefined &&
        (repository.repositoryHost !== implementation.repositoryHost ||
          repository.repositoryId !== implementation.repositoryId)
      )
        diagnostics.push(
          diagnostic(
            "GOLDEN_PATH_IMPLEMENTATION_IDENTITY_MISMATCH",
            "$.contract.repository",
            "Implementation contract belongs to a different repository.",
          ),
        );
    }
  }

  const conformanceDiagnostics: GoldenPathImplementationDiagnostic[] = [];
  const conformance = conformanceView(input.conformance, conformanceDiagnostics);
  diagnostics.push(...conformanceDiagnostics);
  const changeInput = input.changeProjection ?? input.change;
  const changeDiagnostics: GoldenPathImplementationDiagnostic[] = [];
  const change = changeView(changeInput, changeDiagnostics);
  diagnostics.push(...changeDiagnostics);
  const root = changeRoot(changeInput);
  const native = compatibility !== "historical-issue-root";
  if (change.change !== undefined && (implementation !== undefined || compatibility === "historical-issue-root")) {
    const identityClassification = classifyChangeRoot({
      change: change.change,
      ...(implementation === undefined ? {} : { implementation }),
      ...(sourceIssue === undefined ? {} : { sourceIssues: [sourceIssue] }),
    });
    if (
      (native && !identityClassification.implementationNative) ||
      (compatibility === "historical-issue-root" &&
        (identityClassification.implementationNative || identityClassification.mode !== "historical-issue-root"))
    )
      diagnostics.push(
        diagnostic(
          "GOLDEN_PATH_IMPLEMENTATION_IDENTITY_MISMATCH",
          "$.change.identity.rootIssue",
          "Change root compatibility does not match the explicit Golden Path Implementation mode.",
        ),
      );
    if (!identityClassification.valid && native)
      diagnostics.push(
        diagnostic(
          "GOLDEN_PATH_IMPLEMENTATION_IDENTITY_MISMATCH",
          "$.change.identity.rootIssue",
          "Implementation-native Change identity is not admissible.",
        ),
      );
  } else if (native && implementation !== undefined && root !== undefined && root !== implementation.number) {
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_IDENTITY_MISMATCH",
        "$.change.identity.rootIssue",
        "Implementation-native Change identity must be rooted in the executable Implementation.",
      ),
    );
  }
  if (compatibility === "historical-issue-root" && (sourceIssue === undefined || root !== sourceIssue.number))
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_COMPATIBILITY_INVALID",
        "$.change.identity.rootIssue",
        "Historical Issue-root compatibility requires an explicit source Issue root match.",
      ),
    );
  if (
    native &&
    implementation !== undefined &&
    sourceIssue !== undefined &&
    input.contract !== undefined &&
    isRecord(input.contract)
  ) {
    const sources = input.contract.sources;
    if (
      Array.isArray(sources) &&
      !sources.some((entry) => {
        const normalized = normalizeIssueReference(entry);
        return (
          normalized.valid && normalized.reference !== undefined && sameReference(normalized.reference, sourceIssue)
        );
      })
    )
      diagnostics.push(
        diagnostic(
          "GOLDEN_PATH_IMPLEMENTATION_SOURCE_MISMATCH",
          "$.contract.sources",
          "Implementation contract does not declare the supplied source Issue.",
        ),
      );
  }

  const complete = typeof input.complete === "boolean" ? input.complete : undefined;
  if (input.complete !== undefined && complete === undefined)
    diagnostics.push(
      diagnostic(
        "GOLDEN_PATH_IMPLEMENTATION_INPUT_INVALID",
        "$.complete",
        "Implementation completion evidence must be boolean.",
      ),
    );
  const structuralInvalid = diagnostics.length > 0;
  const status = implementationStatus(authorization, readiness, conformance, change, complete);
  const projection = projectionFor(
    status,
    compatibility === "historical-issue-root" ? compatibility : "implementation-native",
    sourceIssue,
    implementation,
    authorization,
    readiness,
    conformance,
    change,
    diagnostics,
  );
  return {
    valid: !structuralInvalid,
    projection,
    diagnostics: boundedDiagnostics(diagnostics),
  };
}

export function projectGoldenPathImplementation(input: unknown): GoldenPathImplementationProjection {
  const result = tryProjectGoldenPathImplementation(input);
  if (!result.valid || result.projection === undefined)
    throw new Error(result.diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join("\n"));
  return result.projection;
}
