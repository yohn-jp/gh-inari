/** Secret-free state and next-action projection for local execution setup. */

import path from "node:path";
import { lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { FileAppUserCredentialStore } from "./github/app-user-credential-store.js";
import { LocalRuntimeProfileStore } from "./local-runtime-profile.js";
import { resolveLocalRepositoryContext } from "./github/local-repository-context.js";
import { CANONICAL_BRANCH_TYPES, DEFAULT_BRANCH_NAME, recognizeBranchName } from "./branch-naming.js";
import {
  localComponentPath,
  readExistingLocalPublicJson,
  readLocalJson,
  resolveConfigHome,
  validateLocalAdmissionConfig,
  validateLocalAuthorityConfig,
  validateLocalCliConfig,
  validateLocalExecutorConfig,
} from "./local-control/config.js";
import { localExecutorAppId, localExecutorIssuerKeyStatus } from "./local-control/executor-server.js";
import { LOCAL_EXECUTOR_HEALTH_PATH } from "./local-control/executor-http.js";
import { LOCAL_ADMISSION_HEALTH_PATH } from "./local-control/admission-server.js";
import { readLocalRuntimeEndpoint, type LocalRuntimeComponent } from "./local-control/runtime-discovery.js";
import {
  delegatorPublicKeyFingerprint,
  exportDelegatorPublicKey,
  loadDelegatorKeyPair,
} from "./agent-authority/delegator-key.js";
import { validateDelegator, type Delegator } from "./agent-authority/delegator.js";

export type LocalApplicationSetupStepId =
  | "cli-topology"
  | "app-user-authorization"
  | "executor-app-id"
  | "executor-issuer-key"
  | "executor"
  | "runtime-authority-key"
  | "runtime-authority-record"
  | "admission";

export type LocalApplicationSetupStepStatus = "ready" | "required" | "waiting" | "blocked";

export interface LocalApplicationSetupStep {
  readonly id: LocalApplicationSetupStepId;
  readonly status: LocalApplicationSetupStepStatus;
  readonly title: string;
  readonly detail: string;
  readonly syntax: string;
  readonly command?: string;
  readonly diagnostic?: string;
}

export interface LocalApplicationNextAction {
  readonly stepId: LocalApplicationSetupStepId | "start-runtime" | "change-branch";
  readonly commands: readonly string[];
  readonly detail: string;
}

/**
 * Readiness of the canonical Issue-bound Change branch that local Session
 * start requires. This is derived read-only from the current local Git
 * branch through the canonical branch grammar (`recognizeBranchName`); it
 * never derives or validates branch naming itself.
 */
export type LocalApplicationChangeBranchStatus = "ready" | "issue-not-selected" | "branch-mismatch";

export interface LocalApplicationChangeBranchReadiness {
  readonly status: LocalApplicationChangeBranchStatus;
  readonly detail: string;
  readonly issue?: number;
  readonly branch?: string;
}

export interface LocalApplicationState {
  readonly version: 1;
  readonly status: "incomplete" | "configured";
  readonly setupComplete: boolean;
  readonly configHome: string;
  readonly provider: {
    readonly appIdConfigured: boolean;
    readonly appId?: string;
    readonly appIdSource?: "environment" | "repository-runtime-profile";
    readonly credentialConfigured: boolean;
    readonly credentialPath: string;
    readonly issuerKey: "configured" | "missing";
  };
  readonly steps: readonly LocalApplicationSetupStep[];
  readonly nextAction: LocalApplicationNextAction;
  readonly runtime: {
    readonly status: "not-checked";
    readonly commands: readonly ["inari runtime supervise"];
    readonly detail: string;
  };
  readonly changeBranch: LocalApplicationChangeBranchReadiness;
  readonly sessionStartCommand: "inari session start --issue <number> -- <command...>";
}

export interface LocalApplicationStateOptions {
  readonly root?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

const AUTHORITY_RECORD_PATH = "runtime-authority.json";
const SESSION_START_COMMAND = "inari session start --issue <number> -- <command...>" as const;
const RUNTIME_SUPERVISE_COMMAND = "inari runtime supervise" as const;
/**
 * A descriptive branch-name pattern, not a literal executable command: it
 * contains placeholder syntax (`<...|...>`) that a shell would parse as
 * redirection/pipeline operators if copied verbatim. Callers must only ever
 * surface this inside prose (`detail`), never inside `nextAction.commands`
 * or any other "run this" surface.
 */
const CHANGE_BRANCH_PATTERN = `<${CANONICAL_BRANCH_TYPES.join("|")}>/<issue-number>-<slug>` as const;

function authorityValidator(value: unknown): Delegator {
  const validation = validateDelegator(value);
  if (!validation.valid || validation.value === undefined) throw new Error("Runtime Authority record is invalid.");
  return validation.value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

/** App-user credential custody used only by bootstrap `inari setup`. */
function appUserCredentialPath(environment: NodeJS.ProcessEnv): string {
  const configured = environment.INARI_GITHUB_APP_USER_CREDENTIAL_FILE ?? environment.INARI_APP_USER_CREDENTIAL_FILE;
  return configured === undefined
    ? path.join(resolveConfigHome(environment), "app-user-credential.json")
    : path.resolve(configured);
}

function configuredAppId(environment: NodeJS.ProcessEnv): {
  readonly value?: string;
  readonly source?: "environment" | "repository-runtime-profile";
} {
  const configured = localExecutorAppId(environment);
  return configured === undefined ? {} : { value: configured, source: "environment" };
}

async function repositoryRuntimeAppId(root: string, environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const repository = resolveLocalRepositoryContext({ cwd: root });
    const profile = await new LocalRuntimeProfileStore({ environment }).findForRepository({
      repositoryHost: repository.hostname,
      repositoryNameWithOwner: repository.nameWithOwner,
    });
    return profile?.app.appId;
  } catch {
    return undefined;
  }
}

function readConfig<T>(filePath: string, read: () => T | undefined): { readonly value?: T; readonly blocked?: true } {
  try {
    lstatSync(filePath);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
  }
  try {
    const value = read();
    return value === undefined ? {} : { value };
  } catch {
    return { blocked: true };
  }
}

function currentLocalGitBranch(root: string): string | undefined {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch.length === 0 ? undefined : branch;
  } catch {
    return undefined;
  }
}

/**
 * Resolve Issue/Change selection and canonical Change-branch readiness from
 * the current local Git branch. Recognition is delegated to the canonical
 * `recognizeBranchName` branch authority (#1065): this never re-derives or
 * revalidates the branch grammar it owns.
 */
function resolveLocalChangeBranchReadiness(root: string): LocalApplicationChangeBranchReadiness {
  const branch = currentLocalGitBranch(root);
  const identity = branch === undefined ? undefined : recognizeBranchName(branch);
  const issue =
    identity !== undefined && (CANONICAL_BRANCH_TYPES as readonly string[]).includes(identity.type)
      ? identity.issueNumber
      : undefined;
  if (issue !== undefined && branch !== undefined) {
    return {
      status: "ready",
      detail: `Local branch ${branch} is the canonical Change branch for Issue #${issue}.`,
      issue,
      branch,
    };
  }
  if (branch === undefined || branch === DEFAULT_BRANCH_NAME) {
    return {
      status: "issue-not-selected",
      detail:
        "No Issue is selected. Check out a canonical Issue-bound Change branch " +
        `(git checkout -b, naming: ${CHANGE_BRANCH_PATTERN}) before Session start.`,
      ...(branch === undefined ? {} : { branch }),
    };
  }
  return {
    status: "branch-mismatch",
    detail:
      `Local branch ${branch} is not a canonical Issue-bound Change branch; check out the correct one ` +
      `(git checkout -b, naming: ${CHANGE_BRANCH_PATTERN}) before Session start.`,
    branch,
  };
}

function readPublicAuthorityRecord(environment: NodeJS.ProcessEnv): {
  readonly value?: Delegator;
  readonly blocked?: true;
} {
  try {
    const value = readExistingLocalPublicJson("authority", AUTHORITY_RECORD_PATH, authorityValidator, environment);
    return value === undefined ? {} : { value };
  } catch {
    return { blocked: true };
  }
}

/**
 * Evaluate persisted local setup prerequisites without starting services or
 * exposing App-user credential, Issuer App private-key, or Runtime Authority
 * private-key material.
 */
export async function projectLocalApplicationState(
  options: LocalApplicationStateOptions = {},
): Promise<LocalApplicationState> {
  const root = path.resolve(options.root ?? process.cwd());
  const environment = options.environment ?? process.env;
  const configHome = resolveConfigHome(environment);
  const appCredentialPath = appUserCredentialPath(environment);
  const issuerKey = localExecutorIssuerKeyStatus(environment);
  const envApp = configuredAppId(environment);
  const profileAppId = envApp.value === undefined ? await repositoryRuntimeAppId(root, environment) : undefined;
  const appId = envApp.value ?? profileAppId;
  const appIdSource = envApp.source ?? (profileAppId === undefined ? undefined : "repository-runtime-profile");

  let credentialConfigured = false;
  let credentialBlocked = false;
  try {
    credentialConfigured = (await new FileAppUserCredentialStore({ path: appCredentialPath }).load()) !== undefined;
  } catch {
    credentialBlocked = true;
  }

  const cli = readConfig(localComponentPath("cli", "config.json", environment), () =>
    readLocalJson("cli", "config.json", validateLocalCliConfig, environment),
  );
  const executor = readConfig(localComponentPath("executor", "config.json", environment), () =>
    readLocalJson("executor", "config.json", validateLocalExecutorConfig, environment),
  );
  const authority = readConfig(localComponentPath("authority", "config.json", environment), () =>
    readLocalJson("authority", "config.json", validateLocalAuthorityConfig, environment),
  );
  const record = readPublicAuthorityRecord(environment);
  const admission = readConfig(localComponentPath("admission", "config.json", environment), () =>
    readLocalJson("admission", "config.json", validateLocalAdmissionConfig, environment),
  );
  const pinnedAuthority = readConfig(localComponentPath("admission", AUTHORITY_RECORD_PATH, environment), () =>
    readLocalJson("admission", AUTHORITY_RECORD_PATH, authorityValidator, environment),
  );

  let authorityKeyMatches = false;
  let authorityKeyBlocked = authority.blocked === true;
  if (authority.value !== undefined) {
    try {
      const keyPath = localComponentPath("authority", authority.value.privateKeyFile, environment);
      const keyPair = loadDelegatorKeyPair(keyPath);
      authorityKeyMatches =
        exportDelegatorPublicKey(keyPair).x === authority.value.publicKey.x &&
        delegatorPublicKeyFingerprint(keyPair) === authority.value.publicKeyFingerprint;
      if (!authorityKeyMatches) authorityKeyBlocked = true;
    } catch {
      authorityKeyBlocked = true;
    }
  }

  const appUserStep: LocalApplicationSetupStep = {
    id: "app-user-authorization",
    status: credentialBlocked ? "blocked" : credentialConfigured ? "ready" : "required",
    title: "Authorize the Inari GitHub App user",
    detail:
      `Repository Runtime setup runs the supported Device Flow and stores the App-user credential at ${appCredentialPath}. ` +
      "This bootstrap credential publishes the initial Runtime trust PR only; the local Executor does not use it.",
    syntax: "inari setup --endpoint <endpoint-url>",
    ...(!credentialConfigured && !credentialBlocked ? { command: "inari setup --endpoint <endpoint-url>" } : {}),
    ...(credentialBlocked ? { diagnostic: "APP_USER_CREDENTIAL_UNAVAILABLE" } : {}),
  };
  const appIdStep: LocalApplicationSetupStep = {
    id: "executor-app-id",
    status: envApp.value !== undefined ? "ready" : "required",
    title: "Configure the GitHub App ID for local Executor",
    detail:
      "Executor reads the numeric Inari Issuer App ID from INARI_GITHUB_APP_ID (or GITHUB_APP_ID); the installation is bound from the repository Runtime profile written by `inari setup`.",
    syntax: "export INARI_GITHUB_APP_ID='<numeric-app-id-from-inari-setup>'",
    ...(envApp.value === undefined
      ? {
          command:
            appId === undefined
              ? "export INARI_GITHUB_APP_ID='<numeric-app-id-from-inari-setup>'"
              : `export INARI_GITHUB_APP_ID=${appId}`,
        }
      : {}),
  };
  const issuerKeyStep: LocalApplicationSetupStep = {
    id: "executor-issuer-key",
    status: issuerKey === "configured" ? "ready" : "required",
    title: "Provide the Inari Issuer App private key to the local Executor",
    detail:
      "The local Executor mints repository-scoped Issuer App installation credentials. Point INARI_GITHUB_APP_PRIVATE_KEY_FILE at the Issuer App private key (.pem). Setup checks only that the reference is set; the running Executor alone reads and validates the key, and it is never persisted or displayed.",
    syntax: "export INARI_GITHUB_APP_PRIVATE_KEY_FILE='<path-to-inari-issuer-app-private-key.pem>'",
  };
  const issuerReady = envApp.value !== undefined && issuerKey === "configured";
  const executorReady = executor.value !== undefined && issuerReady;
  const executorStep: LocalApplicationSetupStep = {
    id: "executor",
    status: executor.blocked ? "blocked" : !issuerReady ? "waiting" : executorReady ? "ready" : "required",
    title: "Provision the local Executor",
    detail:
      "This writes the secret-free local Executor identity/configuration; the Issuer App private key stays in Executor-owned custody.",
    syntax: "inari executor setup",
    ...(!executorReady && executor.blocked !== true && issuerReady ? { command: "inari executor setup" } : {}),
    ...(executor.blocked ? { diagnostic: "LOCAL_EXECUTOR_CONFIG_INVALID" } : {}),
  };
  const authorityStep: LocalApplicationSetupStep = {
    id: "runtime-authority-key",
    status: authorityKeyBlocked ? "blocked" : authorityKeyMatches ? "ready" : "required",
    title: "Create local Runtime Authority key custody",
    detail:
      "The private key remains in local Authority custody and is never copied into CLI or Admission configuration.",
    syntax: "inari authority setup",
    ...(authority.value === undefined && !authorityKeyBlocked ? { command: "inari authority setup" } : {}),
    ...(authorityKeyBlocked ? { diagnostic: "LOCAL_RUNTIME_AUTHORITY_KEY_INVALID" } : {}),
  };

  const localAuthorityFingerprint = authority.value?.publicKeyFingerprint;
  const recordMatches =
    record.value !== undefined &&
    record.value.status === "active" &&
    localAuthorityFingerprint !== undefined &&
    delegatorPublicKeyFingerprint(record.value.key) === localAuthorityFingerprint;
  const recordStep: LocalApplicationSetupStep = {
    id: "runtime-authority-record",
    status:
      record.blocked || (record.value !== undefined && !recordMatches)
        ? "blocked"
        : recordMatches
          ? "ready"
          : authorityKeyMatches
            ? "required"
            : "waiting",
    title: "Create the public Runtime Authority record",
    detail:
      "Bootstrap a public-only record from the local Authority key, then pass that file to Admission setup with --from.",
    syntax: [
      "inari authority bootstrap",
      "--authority-id",
      localAuthorityFingerprint === undefined
        ? "'<authority-id-from-authority-setup>'"
        : `runtime-${localAuthorityFingerprint.slice("sha256:".length)}`,
      "--private-key",
      shellQuote(localComponentPath("authority", "private-key.pem", environment)),
      "--max-session-ttl-seconds 3600",
      "--capability change.implement",
      "--output",
      shellQuote(localComponentPath("authority", AUTHORITY_RECORD_PATH, environment)),
    ].join(" "),
    ...(record.value === undefined && authorityKeyMatches && !record.blocked
      ? {
          command: [
            "inari authority bootstrap",
            "--authority-id",
            `runtime-${(localAuthorityFingerprint ?? "sha256:").slice("sha256:".length)}`,
            "--private-key",
            shellQuote(localComponentPath("authority", "private-key.pem", environment)),
            "--max-session-ttl-seconds 3600",
            "--capability change.implement",
            "--output",
            shellQuote(localComponentPath("authority", AUTHORITY_RECORD_PATH, environment)),
          ].join(" "),
        }
      : {}),
    ...(record.blocked || (record.value !== undefined && !recordMatches)
      ? { diagnostic: "LOCAL_RUNTIME_AUTHORITY_RECORD_MISMATCH" }
      : {}),
  };

  const admissionConfigMatches =
    admission.value !== undefined &&
    pinnedAuthority.value !== undefined &&
    recordMatches &&
    authority.value !== undefined &&
    JSON.stringify(pinnedAuthority.value) === JSON.stringify(record.value) &&
    executor.value !== undefined &&
    admission.value.executor.id === executor.value.id;
  const configuredCliRoute = cli.value?.admission;
  const cliRouteMatches = admission.value !== undefined && configuredCliRoute?.id === admission.value.id;
  const cliRouteConflict = configuredCliRoute !== undefined && !cliRouteMatches;
  const admissionMatches = admissionConfigMatches && cliRouteMatches;
  const admissionBlocked =
    admission.blocked === true ||
    pinnedAuthority.blocked === true ||
    cliRouteConflict ||
    (admission.value !== undefined && !admissionConfigMatches) ||
    (pinnedAuthority.value !== undefined && !recordMatches);
  const admissionSetupAvailable =
    executorReady &&
    recordMatches &&
    !admissionBlocked &&
    (admission.value === undefined || (admissionConfigMatches && !cliRouteMatches));
  const admissionStep: LocalApplicationSetupStep = {
    id: "admission",
    status: admissionBlocked
      ? "blocked"
      : admissionMatches
        ? "ready"
        : admissionSetupAvailable
          ? "required"
          : "waiting",
    title: "Pin public trust and bind local Admission",
    detail:
      "Admission setup consumes the public Runtime Authority file through --from and binds the CLI route automatically.",
    syntax: `inari admission setup --from ${shellQuote(localComponentPath("authority", AUTHORITY_RECORD_PATH, environment))}`,
    ...(admissionSetupAvailable
      ? {
          command: `inari admission setup --from ${shellQuote(localComponentPath("authority", AUTHORITY_RECORD_PATH, environment))}`,
        }
      : {}),
    ...(admissionBlocked ? { diagnostic: "LOCAL_ADMISSION_CONFIG_INVALID" } : {}),
  };

  const topologyReady = cli.value?.topology.admission === "local" && cli.value.topology.executor === "local";
  const topologyStep: LocalApplicationSetupStep = {
    id: "cli-topology",
    status: cli.blocked ? "blocked" : topologyReady ? "ready" : "required",
    title: "Initialize the local CLI topology",
    detail: "Declare local Admission and Executor routing without provisioning either service identity.",
    syntax: "inari init",
    ...(!topologyReady && !cli.blocked ? { command: "inari init" } : {}),
    ...(cli.blocked ? { diagnostic: "LOCAL_CLI_TOPOLOGY_INVALID" } : {}),
  };

  const steps: LocalApplicationSetupStep[] = [
    topologyStep,
    appUserStep,
    appIdStep,
    issuerKeyStep,
    executorStep,
    authorityStep,
    recordStep,
    admissionStep,
  ];
  const setupComplete = steps.every((step) => step.status === "ready");
  const nextSetupStep = steps.find((step) => step.status === "required" || step.status === "blocked");
  const changeBranch = resolveLocalChangeBranchReadiness(root);
  const nextAction: LocalApplicationNextAction =
    nextSetupStep !== undefined
      ? {
          stepId: nextSetupStep.id,
          commands: nextSetupStep.command === undefined ? [] : [nextSetupStep.command],
          detail: nextSetupStep.detail,
        }
      : changeBranch.status === "ready"
        ? {
            stepId: "start-runtime",
            commands: [RUNTIME_SUPERVISE_COMMAND],
            detail: `Run the local Runtime Supervisor in a separate foreground terminal, then launch the governed child for Issue #${changeBranch.issue} on ${changeBranch.branch} with the Session command below.`,
          }
        : {
            stepId: "change-branch",
            commands: [RUNTIME_SUPERVISE_COMMAND],
            detail: `Run the local Runtime Supervisor in a separate foreground terminal. ${changeBranch.detail}`,
          };

  return {
    version: 1,
    status: setupComplete ? "configured" : "incomplete",
    setupComplete,
    configHome,
    provider: {
      appIdConfigured: envApp.value !== undefined,
      ...(appId === undefined ? {} : { appId }),
      ...(appIdSource === undefined ? {} : { appIdSource }),
      credentialConfigured,
      credentialPath: appCredentialPath,
      issuerKey,
    },
    steps,
    nextAction,
    runtime: {
      status: "not-checked",
      commands: [RUNTIME_SUPERVISE_COMMAND],
      detail:
        "Process health is not part of persisted setup state; Admission verifies the configured Executor identity when it starts.",
    },
    changeBranch,
    sessionStartCommand: SESSION_START_COMMAND,
  };
}

export type LocalRuntimeComponentReadiness = "ready" | "not-ready" | "not-running";

export interface LocalRuntimeReadiness {
  readonly executor: LocalRuntimeComponentReadiness;
  readonly admission: LocalRuntimeComponentReadiness;
  readonly overall: "ready" | "not-ready";
}

const RUNTIME_HEALTH_PATH: Readonly<Record<"executor" | "admission", string>> = {
  executor: LOCAL_EXECUTOR_HEALTH_PATH,
  admission: LOCAL_ADMISSION_HEALTH_PATH,
};
const RUNTIME_HEALTH_PROBE_TIMEOUT_MS = 800;

async function probeLocalRuntimeComponentReadiness(
  component: "executor" | "admission",
  environment: NodeJS.ProcessEnv,
): Promise<LocalRuntimeComponentReadiness> {
  const discovered = readLocalRuntimeEndpoint(component as LocalRuntimeComponent, environment);
  if (discovered === undefined) return "not-running";
  try {
    const response = await fetch(new URL(RUNTIME_HEALTH_PATH[component], discovered.endpoint), {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(RUNTIME_HEALTH_PROBE_TIMEOUT_MS),
    });
    if (response.status !== 200) return "not-ready";
    const body: unknown = await response.json();
    const readiness =
      typeof body === "object" && body !== null && "readiness" in body
        ? (body as Record<string, unknown>).readiness
        : undefined;
    return readiness === "ready" ? "ready" : "not-ready";
  } catch {
    return "not-ready";
  }
}

/**
 * Probe live Executor/Admission process readiness through the same loopback
 * discovery and health surfaces the Supervisor uses. This is a best-effort
 * read; it never persists state and exposes no secrets.
 */
export async function projectLocalRuntimeReadiness(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LocalRuntimeReadiness> {
  const [executor, admission] = await Promise.all([
    probeLocalRuntimeComponentReadiness("executor", environment),
    probeLocalRuntimeComponentReadiness("admission", environment),
  ]);
  return { executor, admission, overall: executor === "ready" && admission === "ready" ? "ready" : "not-ready" };
}
