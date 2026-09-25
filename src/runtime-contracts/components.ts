/**
 * Frozen Runtime component ownership catalog (#1098 / #1105).
 *
 * Each component lists the Implementation leaf that owns its code, the module
 * paths it owns, the public entry modules other components may load, and the
 * public ports (declared in this directory) it implements or consumes.
 * Producers implement and consumers import these ports; nobody imports a
 * sibling leaf's implementation. `scripts/check-runtime-boundaries.mjs`
 * enforces the same ownership mechanically.
 */
export const RUNTIME_COMPONENTS = Object.freeze([
  "runtime-contracts",
  "setup-application",
  "cli",
  "console",
  "admission",
  "executor",
  "authority",
  "composition",
] as const);

export type RuntimeComponent = (typeof RUNTIME_COMPONENTS)[number];

/** Public port names exported by `src/runtime-contracts/index.ts`. */
export const RUNTIME_PUBLIC_PORTS = Object.freeze([
  "AdmissionSessionPort",
  "AuthoritySigningPort",
  "ExecutorExecutionPort",
  "RuntimeRoleStatusPort",
  "SecretEnrollmentPort",
  "SetupActionPort",
  "SetupJournalPort",
  "SetupObservationPort",
] as const);

export type RuntimePublicPort = (typeof RUNTIME_PUBLIC_PORTS)[number];

export interface RuntimeComponentOwnership {
  /** Implementation Issue owning the component code during the #1097 Epic. */
  readonly owner: `#${number}`;
  /** Owned module prefixes ("dir/") or exact modules. */
  readonly paths: readonly string[];
  /** Modules other components may import to reach this component. */
  readonly publicEntries: readonly string[];
  readonly implements: readonly RuntimePublicPort[];
  readonly consumes: readonly RuntimePublicPort[];
}

function ownership(value: RuntimeComponentOwnership): RuntimeComponentOwnership {
  return Object.freeze({
    owner: value.owner,
    paths: Object.freeze([...value.paths]),
    publicEntries: Object.freeze([...value.publicEntries]),
    implements: Object.freeze([...value.implements]),
    consumes: Object.freeze([...value.consumes]),
  });
}

export const RUNTIME_COMPONENT_CATALOG: Readonly<Record<RuntimeComponent, RuntimeComponentOwnership>> = Object.freeze({
  "runtime-contracts": ownership({
    owner: "#1105",
    paths: ["src/runtime-contracts/"],
    publicEntries: ["src/runtime-contracts/index.ts"],
    implements: [],
    consumes: [],
  }),
  "setup-application": ownership({
    owner: "#1110",
    paths: ["src/application/setup/"],
    publicEntries: ["src/application/setup/index.ts"],
    implements: [],
    consumes: ["SetupObservationPort", "SetupActionPort", "SetupJournalPort", "SecretEnrollmentPort"],
  }),
  cli: ownership({
    owner: "#1108",
    paths: [
      "src/cli/",
      "src/local-control/admission-client.ts",
      "src/local-control/session-launcher.ts",
      "src/local-application-state.ts",
    ],
    publicEntries: ["src/cli/runtime/session-launcher.ts"],
    implements: [],
    consumes: ["AdmissionSessionPort", "AuthoritySigningPort", "RuntimeRoleStatusPort"],
  }),
  console: ownership({
    owner: "#1109",
    paths: ["src/local-control/console-server.ts"],
    publicEntries: ["src/local-control/console-server.ts"],
    implements: [],
    consumes: ["RuntimeRoleStatusPort"],
  }),
  admission: ownership({
    owner: "#1107",
    paths: ["src/admission/", "src/local-control/admission-server.ts", "src/local-control/session-store.ts"],
    publicEntries: ["src/admission/setup.ts", "src/admission/server.ts"],
    implements: ["AdmissionSessionPort", "RuntimeRoleStatusPort"],
    consumes: ["ExecutorExecutionPort"],
  }),
  executor: ownership({
    owner: "#1106",
    paths: ["src/executor/", "src/local-control/executor-server.ts"],
    publicEntries: ["src/executor/setup.ts", "src/executor/server.ts"],
    implements: ["ExecutorExecutionPort", "RuntimeRoleStatusPort", "SecretEnrollmentPort"],
    consumes: [],
  }),
  authority: ownership({
    owner: "#1108",
    paths: ["src/authority/"],
    publicEntries: ["src/authority/index.ts"],
    implements: ["AuthoritySigningPort"],
    consumes: [],
  }),
  composition: ownership({
    owner: "#1109",
    paths: ["src/composition/", "src/local-control/supervisor.ts"],
    publicEntries: ["src/composition/index.ts"],
    implements: [],
    consumes: [
      "AdmissionSessionPort",
      "ExecutorExecutionPort",
      "RuntimeRoleStatusPort",
      "SecretEnrollmentPort",
      "SetupActionPort",
      "SetupJournalPort",
      "SetupObservationPort",
    ],
  }),
});
