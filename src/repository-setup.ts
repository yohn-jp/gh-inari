/** The repository onboarding Golden Path. */

import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import { fetchEndpointOnboardingDescriptor } from "./endpoint-onboarding-client.js";
import type { EndpointOnboardingDescriptor } from "./endpoint-onboarding.js";
import { resolveLocalRepositoryContext } from "./github/local-repository-context.js";
import {
  GitHubAppDeviceFlowClient,
  GitHubAppUserCredential,
  type GitHubAppDeviceFlowOptions,
} from "./github/app-user-credential.js";
import { FileAppUserCredentialStore, type AppUserCredentialStore } from "./github/app-user-credential-store.js";
import {
  GitHubAppUserCredentialBroker,
  GitHubAppUserCredentialBrokerError,
} from "./github/app-user-credential-broker.js";
import type { AppProviderCredentialBroker } from "./github/app-provider-credential-broker.js";
import { GitHubNativeHttpTransport, githubRestBaseUrl } from "./github/native-http-transport.js";
import type { GitHubAppRepositoryReadCapability } from "./github/app-installation-credential-broker.js";
import {
  delegatorPublicKeyFingerprint,
  generateAndPersistDelegatorKeyPair,
  loadDelegatorKeyPair,
} from "./agent-authority/delegator-key.js";
import { verifyDelegatorReadiness, type DelegatorReadinessResult } from "./agent-authority/delegator-operations.js";
import type { CapabilityKind } from "./agent-authority/capability.js";
import { selectSetupAuthority, SetupTrustSelectionError } from "./authority/setup-trust.js";
import { assertDelegator, DELEGATOR_ARTIFACT_DIRECTORY, type Delegator } from "./agent-authority/delegator.js";
import { loadLocalDelegatorRepository, registerDelegator } from "./agent-authority/delegator-lifecycle.js";
import { renderDelegatorArtifact } from "./agent-authority/delegator-trust.js";
import { loadDelegatorTrust } from "./agent-authority/delegator-trust.js";
import {
  LocalRuntimeProfileStore,
  resolveLocalRuntimeConfigHome,
  type LocalRuntimeProfile,
  type LocalRuntimeProfileRepository,
} from "./local-runtime-profile.js";
import type { RepositoryContext, RepositoryTree, RepositoryTreeEntry } from "./github/types.js";
import type { RepositoryIdentity } from "./github/effect-authorizer.js";
import type { RuntimeAuthorityPublicationBroker } from "./github/runtime-authority-publication-capability.js";
import {
  createRuntimeAuthorityPublicationRequest,
  publishRuntimeAuthority,
  type RuntimeAuthorityPublicationResult,
} from "./runtime-authority-publication.js";

const DEFAULT_SESSION_TTL_SECONDS = 3_600;
const DEFAULT_GITHUB_HOST = "github.com";
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;

export type RepositorySetupErrorCode =
  | "REPOSITORY_SETUP_AUTH_REQUIRED"
  | "REPOSITORY_SETUP_APP_INSTALL_REQUIRED"
  | "REPOSITORY_SETUP_ENDPOINT_FAILED"
  | "REPOSITORY_SETUP_REPOSITORY_FAILED"
  | "REPOSITORY_SETUP_PROFILE_MISMATCH"
  | "REPOSITORY_SETUP_AUTHORITY_MISMATCH"
  | "REPOSITORY_SETUP_AUTHORITY_FAILED"
  | "REPOSITORY_SETUP_TRUST_UNAVAILABLE"
  | "REPOSITORY_SETUP_TRUST_CHANGE_REQUIRED"
  | "REPOSITORY_SETUP_PUBLICATION_FAILED";

export class RepositorySetupError extends Error {
  readonly code: RepositorySetupErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: RepositorySetupErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "RepositorySetupError";
    this.code = code;
    this.details = details;
  }
}

/** Bootstrap trust publication (#1066) input: the generated public Delegator record only. */
export interface RuntimeAuthorityPublisherOptions {
  readonly capability: GitHubAppRepositoryReadCapability;
  readonly repository: LocalRuntimeProfileRepository;
  readonly authority: Delegator;
}

export interface RepositorySetupInput {
  readonly root?: string;
  readonly repository?: string;
  readonly endpoint?: string;
  readonly configHome?: string;
  readonly authorityId?: string;
  readonly privateKeyPath?: string;
  readonly capabilityCeiling?: readonly CapabilityKind[];
  readonly json?: boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly endpointDescriptor?: EndpointOnboardingDescriptor;
  readonly fetch?: typeof globalThis.fetch;
  readonly endpointFetch?: typeof globalThis.fetch;
  readonly credentialStore?: AppUserCredentialStore;
  readonly credentialFile?: string;
  readonly deviceFlow?: GitHubAppDeviceFlowClient;
  readonly deviceFlowOptions?: Omit<GitHubAppDeviceFlowOptions, "clientId" | "hostname"> & {
    readonly clientId?: string;
  };
  readonly appUserBroker?: AppProviderCredentialBroker;
  /**
   * Test/composition seam; production setup publishes the bootstrap trust PR
   * directly through this operator's own App-user credential/broker (#1066)
   * -- there is no central Issuer/Worker boundary or private-key handling in
   * this path at all.
   */
  readonly authorityPublisher?: (
    options: RuntimeAuthorityPublisherOptions,
  ) => Promise<RuntimeAuthorityPublicationResult>;
  readonly now?: () => Date;
  readonly maxSessionTtlSeconds?: number;
  /** Called only for human Device Flow setup; values are public short-lived instructions. */
  readonly onDeviceAuthorization?: (metadata: { readonly verificationUri: string; readonly userCode: string }) => void;
}

export interface RepositorySetupResult {
  readonly ok: true;
  readonly operation: "setup";
  readonly state: "app-install-required" | "trust-pending" | "ready";
  readonly endpoint: string;
  readonly relayUrl: string;
  readonly appInstallationUrl: string;
  readonly repository:
    | LocalRuntimeProfileRepository
    | {
        readonly repositoryHost: string;
        readonly repositoryNameWithOwner: string;
        readonly repositoryId?: string;
      };
  readonly app: { readonly appId: string; readonly installationId?: string };
  readonly authority?: {
    readonly authorityId: string;
    readonly publicKeyFingerprint: string;
    readonly privateKeyPath: string;
    readonly artifactPath: string;
  };
  readonly publication?: RuntimeAuthorityPublicationResult;
  readonly trust?: {
    readonly status: "untrusted" | "pending-human-trust" | "unknown" | "trusted";
    readonly nextAction?: "publish-trust" | "recheck-trust";
  };
  readonly profilePath?: string;
  readonly readiness?: Pick<DelegatorReadinessResult, "ok" | "state" | "canonical" | "diagnostics">;
}

interface RepositoryEvidence {
  readonly id: string;
  readonly fullName: string;
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = environment[name];
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function endpointFromInput(input: RepositorySetupInput): string {
  const environment = input.environment ?? process.env;
  const endpoint =
    input.endpoint ?? environmentValue(environment, "INARI_ENDPOINT", "INARI_ENDPOINT_URL", "INARI_RUNTIME_ENDPOINT");
  if (endpoint === undefined && input.endpointDescriptor === undefined) {
    throw new RepositorySetupError(
      "REPOSITORY_SETUP_ENDPOINT_FAILED",
      "An Endpoint URL is required for repository setup.",
    );
  }
  return endpoint ?? `https://${input.endpointDescriptor?.githubHost ?? DEFAULT_GITHUB_HOST}`;
}

function endpointKey(value: string): string {
  try {
    const url = new URL(value);
    return url.toString().replace(/\/$/u, "");
  } catch {
    throw new RepositorySetupError("REPOSITORY_SETUP_ENDPOINT_FAILED", "Endpoint URL is invalid.");
  }
}

function safeAuthorityId(fingerprint: string): string {
  const value = `runtime-${fingerprint.slice("sha256:".length)}`;
  if (!SAFE_ID.test(value))
    throw new RepositorySetupError("REPOSITORY_SETUP_AUTHORITY_FAILED", "Runtime Authority identity is invalid.");
  return value;
}

function responseRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function repositoryEvidence(value: unknown, expectedName: string): RepositoryEvidence | undefined {
  const record = responseRecord(value);
  if (record === undefined) return undefined;
  const id = typeof record.id === "number" && Number.isSafeInteger(record.id) ? String(record.id) : record.id;
  const fullName = typeof record.full_name === "string" ? record.full_name : undefined;
  if (
    typeof id !== "string" ||
    !DECIMAL_ID.test(id) ||
    fullName === undefined ||
    fullName.toLowerCase() !== expectedName.toLowerCase()
  )
    return undefined;
  return { id, fullName };
}

async function resolveRepositoryId(
  context: RepositoryContext,
  credential: GitHubAppUserCredential,
  fetcher: typeof globalThis.fetch,
): Promise<string> {
  try {
    const response = await credential.withAccessToken((token) =>
      new GitHubNativeHttpTransport({ token, apiUrl: githubRestBaseUrl(context.hostname), fetch: fetcher }).request({
        hostname: context.hostname,
        method: "GET",
        path: `repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}`,
      }),
    );
    const evidence = response.status === 200 ? repositoryEvidence(response.body, context.nameWithOwner) : undefined;
    if (evidence === undefined) throw new Error();
    return evidence.id;
  } catch {
    throw new RepositorySetupError(
      "REPOSITORY_SETUP_REPOSITORY_FAILED",
      "Immutable repository identity could not be resolved.",
    );
  }
}

async function ensureCredential(
  input: RepositorySetupInput,
  descriptor: EndpointOnboardingDescriptor,
): Promise<GitHubAppUserCredential> {
  const environment = input.environment ?? process.env;
  const configHome = resolveLocalRuntimeConfigHome({ configHome: input.configHome, environment });
  const store =
    input.credentialStore ??
    new FileAppUserCredentialStore({ path: input.credentialFile ?? path.join(configHome, "app-user-credential.json") });
  const now = input.now ?? (() => new Date());
  let credential: GitHubAppUserCredential | undefined;
  try {
    credential = await store.load();
  } catch {
    throw new RepositorySetupError("REPOSITORY_SETUP_AUTH_REQUIRED", "App-user authorization is required.");
  }
  const flow =
    input.deviceFlow ??
    new GitHubAppDeviceFlowClient({
      ...(input.deviceFlowOptions ?? {}),
      clientId: input.deviceFlowOptions?.clientId ?? descriptor.appClientId,
      hostname: descriptor.githubHost,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  const authorize = async (): Promise<GitHubAppUserCredential> => {
    try {
      const deviceCode = await flow.requestDeviceCode();
      input.onDeviceAuthorization?.({ verificationUri: deviceCode.verificationUri, userCode: deviceCode.userCode });
      const next = await flow.poll(deviceCode);
      await store.save(next);
      return next;
    } catch {
      throw new RepositorySetupError("REPOSITORY_SETUP_AUTH_REQUIRED", "App-user authorization is required.");
    }
  };
  if (credential === undefined) {
    if (input.json)
      throw new RepositorySetupError("REPOSITORY_SETUP_AUTH_REQUIRED", "App-user authorization is required.");
    return authorize();
  }
  if (!credential.isAccessExpired(now())) return credential;
  try {
    const refreshed = await flow.refresh(credential);
    await store.save(refreshed);
    return refreshed;
  } catch {
    await store.clear().catch(() => {});
    if (input.json)
      throw new RepositorySetupError("REPOSITORY_SETUP_AUTH_REQUIRED", "App-user authorization is required.");
    return authorize();
  }
}

function responseBody(response: { readonly body?: unknown }): Record<string, unknown> {
  const body = responseRecord(response.body);
  if (body === undefined) throw new Error();
  return body;
}

/** Protected-ref trust reader over a repository read capability (public records only). */
export function createReadinessReader(
  capability: GitHubAppRepositoryReadCapability,
  repository: LocalRuntimeProfileRepository,
  context: RepositoryContext,
) {
  const request = async (suffix: string) => {
    const response = await capability.transport.request({
      hostname: context.hostname,
      method: "GET",
      path: `repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}${suffix}`,
    });
    if (response.status < 200 || response.status >= 300) throw new Error();
    return response;
  };
  return {
    resolveRepositoryContext: async () => ({ ...context, repositoryId: repository.repositoryId }),
    getRepositoryDefaultBranch: async () => {
      const body = responseBody(await request(""));
      if (typeof body.default_branch !== "string" || body.default_branch.length === 0) throw new Error();
      return body.default_branch;
    },
    getRepositoryTree: async (ref: string): Promise<RepositoryTree> => {
      const body = responseBody(await request(`/git/trees/${encodeURIComponent(ref)}?recursive=1`));
      if (typeof body.sha !== "string" || !Array.isArray(body.tree) || body.truncated === true) throw new Error();
      const entries: RepositoryTreeEntry[] = [];
      for (const value of body.tree) {
        const item = responseRecord(value);
        if (
          item === undefined ||
          typeof item.path !== "string" ||
          typeof item.sha !== "string" ||
          (item.type !== "blob" && item.type !== "tree")
        )
          throw new Error();
        entries.push({ path: item.path, sha: item.sha, type: item.type });
      }
      return { sha: body.sha, entries };
    },
    getRepositoryBlob: async (sha: string): Promise<string> => {
      const body = responseBody(await request(`/git/blobs/${encodeURIComponent(sha)}`));
      if (body.sha !== sha || body.encoding !== "base64" || typeof body.content !== "string") throw new Error();
      return Buffer.from(body.content.replace(/\s+/gu, ""), "base64").toString("utf8");
    },
    findBranch: async (branch: string) => {
      const body = responseBody(await request(`/git/ref/heads/${encodeURIComponent(branch)}`));
      const object = responseRecord(body.object);
      if (typeof body.ref !== "string" || object === undefined || typeof object.sha !== "string") throw new Error();
      return { name: branch, ref: body.ref, sha: object.sha };
    },
  };
}

async function materializeAuthority(root: string, authority: Delegator): Promise<Delegator> {
  const rendered = renderDelegatorArtifact(authority);
  try {
    const existing = loadLocalDelegatorRepository(root).artifacts.find((artifact) => artifact.path === rendered.path);
    if (existing === undefined) return registerNewAuthority(root, authority);
    const parsed = assertDelegator(existing.authority);
    if (
      parsed.id !== authority.id ||
      delegatorPublicKeyFingerprint(parsed.key) !== delegatorPublicKeyFingerprint(authority.key) ||
      parsed.status !== "active"
    )
      throw new RepositorySetupError(
        "REPOSITORY_SETUP_AUTHORITY_MISMATCH",
        "Existing Runtime Authority material does not match the local Runtime identity.",
      );
    return parsed;
  } catch (error: unknown) {
    if (error instanceof RepositorySetupError) throw error;
    throw new RepositorySetupError(
      "REPOSITORY_SETUP_AUTHORITY_FAILED",
      "Runtime Authority material could not be prepared.",
      {
        reason: error instanceof Error ? error.name : "lifecycle",
        path: DELEGATOR_ARTIFACT_DIRECTORY,
      },
    );
  }
}

function registerNewAuthority(root: string, authority: Delegator): Delegator {
  try {
    registerDelegator(root, authority);
    return authority;
  } catch (error: unknown) {
    throw new RepositorySetupError(
      "REPOSITORY_SETUP_AUTHORITY_FAILED",
      "Runtime Authority material could not be prepared.",
      {
        reason: error instanceof Error ? error.name : "lifecycle",
        path: DELEGATOR_ARTIFACT_DIRECTORY,
      },
    );
  }
}

async function setupWithCapability(
  input: RepositorySetupInput,
  descriptor: EndpointOnboardingDescriptor,
  context: RepositoryContext,
  repository: LocalRuntimeProfileRepository,
  capability: GitHubAppRepositoryReadCapability,
  installationId: string,
  endpoint: string,
  authorityPublisher?: (options: RuntimeAuthorityPublisherOptions) => Promise<RuntimeAuthorityPublicationResult>,
): Promise<RepositorySetupResult> {
  const environment = input.environment ?? process.env;
  const profileStore = new LocalRuntimeProfileStore({ configHome: input.configHome, environment });
  const identity = { endpoint, repository };
  try {
    const selected = await profileStore.findForRepository(repository);
    if (selected !== undefined && selected.endpoint !== endpoint)
      throw new Error("A different Runtime profile is already selected for this repository.");
  } catch {
    throw new RepositorySetupError("REPOSITORY_SETUP_PROFILE_MISMATCH", "Runtime profile selection is ambiguous.");
  }
  const existing = await profileStore.load(identity);
  if (
    existing !== undefined &&
    (existing.endpoint !== endpoint ||
      existing.relayUrl !== descriptor.relayConnectionBase ||
      existing.app.appId !== descriptor.appId ||
      existing.app.installationId !== installationId ||
      existing.app.clientId !== descriptor.appClientId)
  ) {
    throw new RepositorySetupError(
      "REPOSITORY_SETUP_PROFILE_MISMATCH",
      "Existing Runtime profile Endpoint or App state does not match current onboarding state.",
    );
  }
  if (
    existing !== undefined &&
    input.authorityId !== undefined &&
    existing.authority.authorityId !== input.authorityId
  ) {
    throw new RepositorySetupError(
      "REPOSITORY_SETUP_PROFILE_MISMATCH",
      "Existing Runtime profile authority state does not match the requested authority.",
    );
  }
  if (
    existing !== undefined &&
    input.privateKeyPath !== undefined &&
    path.resolve(input.root ?? process.cwd(), input.privateKeyPath) !== existing.authority.privateKeyPath
  ) {
    throw new RepositorySetupError(
      "REPOSITORY_SETUP_PROFILE_MISMATCH",
      "Existing Runtime profile key reference does not match the requested key.",
    );
  }
  if (input.authorityId !== undefined && !SAFE_ID.test(input.authorityId)) {
    throw new RepositorySetupError(
      "REPOSITORY_SETUP_AUTHORITY_FAILED",
      "Requested Runtime Authority identity is invalid.",
    );
  }
  const keyPath =
    input.privateKeyPath === undefined
      ? (existing?.authority.privateKeyPath ??
        path.join(
          resolveLocalRuntimeConfigHome({ configHome: input.configHome, environment }),
          "runtime-keys",
          `${createHash("sha256").update(`${endpoint}\u0000${repository.repositoryHost}\u0000${repository.repositoryId}`, "utf8").digest("hex")}.pem`,
        ))
      : path.resolve(input.root ?? process.cwd(), input.privateKeyPath);
  let localAuthorities: readonly Delegator[];
  try {
    localAuthorities = loadLocalDelegatorRepository(path.resolve(input.root ?? process.cwd())).artifacts.map(
      (artifact) => artifact.authority,
    );
  } catch {
    throw new RepositorySetupError(
      "REPOSITORY_SETUP_AUTHORITY_MISMATCH",
      "Existing Runtime Authority material is invalid.",
    );
  }
  let keyPair;
  let keyPathAbsent = false;
  try {
    lstatSync(keyPath);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") keyPathAbsent = true;
  }
  if (keyPathAbsent && existing === undefined && localAuthorities.length === 0 && input.capabilityCeiling === undefined)
    throw new RepositorySetupError(
      "REPOSITORY_SETUP_TRUST_CHANGE_REQUIRED",
      "Explicit capability intent is required before preparing a new Runtime Authority.",
    );
  // Canonical protected-ref trust is resolved before any key generation or local materialization.
  const snapshot = await loadDelegatorTrust(createReadinessReader(capability, repository, context)).catch(
    () => undefined,
  );
  const canonicalAuthorities = snapshot?.authorities.map((item) => item.authority);
  const requestedAuthorityId = input.authorityId ?? existing?.authority.authorityId;
  const canonicalRegistered = (canonicalAuthorities ?? []).some(
    (record) => requestedAuthorityId === undefined || record.id === requestedAuthorityId,
  );
  try {
    keyPair = loadDelegatorKeyPair(keyPath);
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "RUNTIME_AUTHORITY_KEY_NOT_FOUND" ||
        (error.code === "RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE" && keyPathAbsent)) &&
      existing === undefined &&
      localAuthorities.length === 0 &&
      !canonicalRegistered
    ) {
      try {
        keyPair = generateAndPersistDelegatorKeyPair(keyPath);
      } catch {
        throw new RepositorySetupError(
          "REPOSITORY_SETUP_AUTHORITY_FAILED",
          "Runtime Authority key could not be created.",
        );
      }
    } else {
      throw new RepositorySetupError(
        "REPOSITORY_SETUP_AUTHORITY_MISMATCH",
        "Existing Runtime Authority key could not be loaded.",
      );
    }
  }
  const fingerprint = delegatorPublicKeyFingerprint(keyPair.publicKeyJwk);
  const authorityId = input.authorityId ?? existing?.authority.authorityId ?? safeAuthorityId(fingerprint);
  if (existing !== undefined && existing.authority.publicKeyFingerprint !== fingerprint) {
    throw new RepositorySetupError(
      "REPOSITORY_SETUP_PROFILE_MISMATCH",
      "Existing Runtime profile key does not match the local Runtime identity.",
    );
  }
  let authority: Delegator;
  try {
    authority = selectSetupAuthority({
      repository,
      ...(existing === undefined ? {} : { profile: existing }),
      authorityId,
      key: keyPair,
      local: localAuthorities,
      canonical: canonicalAuthorities,
      maxSessionTtlSeconds: input.maxSessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS,
      ...(input.capabilityCeiling === undefined ? {} : { capabilityIntent: input.capabilityCeiling }),
    });
  } catch (error) {
    if (error instanceof SetupTrustSelectionError && error.code === "RECORD_UNAVAILABLE")
      throw new RepositorySetupError(
        "REPOSITORY_SETUP_TRUST_UNAVAILABLE",
        "Registered Runtime Authority record is unavailable; resolve trust before retrying.",
      );
    if (error instanceof SetupTrustSelectionError && error.code !== "IDENTITY_CONFLICT")
      throw new RepositorySetupError(
        "REPOSITORY_SETUP_TRUST_CHANGE_REQUIRED",
        "Selected capabilities require an explicit Runtime Authority trust change.",
        { reason: error.code },
      );
    throw new RepositorySetupError(
      "REPOSITORY_SETUP_AUTHORITY_MISMATCH",
      "Existing Runtime Authority material conflicts with the selected signer.",
    );
  }
  const artifactPath = renderDelegatorArtifact(authority).path;
  const pendingProfile: LocalRuntimeProfile = {
    version: 1,
    state: "trust-pending",
    endpoint,
    relayUrl: descriptor.relayConnectionBase,
    repository,
    app: { appId: descriptor.appId, installationId, clientId: descriptor.appClientId },
    authority: { authorityId, publicKeyFingerprint: fingerprint, privateKeyPath: keyPath },
  };
  const materializedAuthority = await materializeAuthority(path.resolve(input.root ?? process.cwd()), authority);
  const profilePath = await profileStore.save(pendingProfile);
  let readiness: DelegatorReadinessResult;
  try {
    readiness = await verifyDelegatorReadiness(createReadinessReader(capability, repository, context), {
      authorityId: materializedAuthority.id,
      privateKeyPath: keyPath,
    });
  } catch {
    throw new RepositorySetupError(
      "REPOSITORY_SETUP_TRUST_UNAVAILABLE",
      "Canonical Runtime Authority readiness could not be resolved.",
    );
  }
  if (!readiness.ok) {
    if (readiness.state !== "unknown-authority" && readiness.state !== "canonical-trust-unavailable") {
      throw new RepositorySetupError(
        "REPOSITORY_SETUP_AUTHORITY_MISMATCH",
        "Canonical Runtime Authority trust conflicts with the selected signer or intent.",
        { state: readiness.state },
      );
    }
    let publication: RuntimeAuthorityPublicationResult | undefined;
    if (authorityPublisher !== undefined && readiness.state === "unknown-authority") {
      try {
        publication = await authorityPublisher({
          capability,
          repository,
          authority: materializedAuthority,
        });
      } catch {
        throw new RepositorySetupError(
          "REPOSITORY_SETUP_PUBLICATION_FAILED",
          "Runtime Authority trust PR could not be published. Resolve the repository publication state and rerun setup.",
          { authorityId },
        );
      }
    }
    return {
      ok: true,
      operation: "setup",
      state: "trust-pending",
      endpoint,
      relayUrl: descriptor.relayConnectionBase,
      appInstallationUrl: descriptor.appInstallationUrl,
      repository,
      app: { appId: descriptor.appId, installationId },
      authority: { authorityId, publicKeyFingerprint: fingerprint, privateKeyPath: keyPath, artifactPath },
      profilePath,
      readiness: { ok: false, state: readiness.state, diagnostics: readiness.diagnostics },
      ...(publication === undefined ? {} : { publication }),
      trust:
        publication !== undefined
          ? { status: "pending-human-trust", nextAction: "recheck-trust" }
          : readiness.state === "canonical-trust-unavailable"
            ? { status: "unknown", nextAction: "recheck-trust" }
            : { status: "untrusted", nextAction: "publish-trust" },
    };
  }
  try {
    const protectedSnapshot = await loadDelegatorTrust(createReadinessReader(capability, repository, context));
    selectSetupAuthority({
      repository,
      profile: pendingProfile,
      authorityId,
      key: keyPair,
      local: [materializedAuthority],
      canonical: protectedSnapshot.authorities.map((item) => item.authority),
      capabilityIntent: materializedAuthority.capabilityCeiling,
      maxSessionTtlSeconds: materializedAuthority.maxSessionTtlSeconds,
    });
    if (!protectedSnapshot.authorities.some((item) => item.authority.id === authorityId))
      throw new SetupTrustSelectionError("RECORD_UNAVAILABLE");
  } catch (error) {
    if (error instanceof SetupTrustSelectionError)
      throw new RepositorySetupError(
        "REPOSITORY_SETUP_AUTHORITY_MISMATCH",
        "Protected-ref Runtime Authority differs from the local signer or capability intent.",
      );
    throw new RepositorySetupError("REPOSITORY_SETUP_TRUST_UNAVAILABLE", "Protected-ref trust recheck is unavailable.");
  }
  const readyProfile = await profileStore.save({ ...pendingProfile, state: "ready" });
  return {
    ok: true,
    operation: "setup",
    state: "ready",
    endpoint,
    relayUrl: descriptor.relayConnectionBase,
    appInstallationUrl: descriptor.appInstallationUrl,
    repository,
    app: { appId: descriptor.appId, installationId },
    authority: { authorityId, publicKeyFingerprint: fingerprint, privateKeyPath: keyPath, artifactPath },
    profilePath: readyProfile,
    readiness: { ok: true, state: readiness.state, canonical: readiness.canonical, diagnostics: readiness.diagnostics },
    trust: { status: "trusted" },
  };
}

/** Resolve App installation, local identity, trust preparation, and readiness. */
export async function setupRepository(input: RepositorySetupInput = {}): Promise<RepositorySetupResult> {
  const endpoint = endpointKey(endpointFromInput(input));
  let descriptor: EndpointOnboardingDescriptor;
  try {
    descriptor =
      input.endpointDescriptor ??
      (await fetchEndpointOnboardingDescriptor({ endpoint, fetch: input.endpointFetch ?? input.fetch }));
  } catch (error: unknown) {
    if (error instanceof RepositorySetupError) throw error;
    throw new RepositorySetupError(
      "REPOSITORY_SETUP_ENDPOINT_FAILED",
      "Endpoint onboarding metadata could not be resolved.",
    );
  }
  const context = resolveLocalRepositoryContext({
    repository: input.repository,
    cwd: path.resolve(input.root ?? process.cwd()),
    hostname: descriptor.githubHost,
  });
  const customBroker = input.appUserBroker;
  const credential = customBroker === undefined ? await ensureCredential(input, descriptor) : undefined;
  const repositoryId =
    customBroker === undefined
      ? await resolveRepositoryId(
          context,
          credential as GitHubAppUserCredential,
          input.fetch ?? globalThis.fetch.bind(globalThis),
        )
      : undefined;
  const broker =
    customBroker ??
    new GitHubAppUserCredentialBroker({
      appId: descriptor.appId,
      repository: { hostname: context.hostname, owner: context.owner, name: context.name },
      repositoryId: repositoryId as string,
      credentialStore:
        input.credentialStore ??
        new FileAppUserCredentialStore({
          path:
            input.credentialFile ??
            path.join(
              resolveLocalRuntimeConfigHome({
                configHome: input.configHome,
                environment: input.environment ?? process.env,
              }),
              "app-user-credential.json",
            ),
        }),
      deviceFlow: input.deviceFlow,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  // Bootstrap trust publication (#1066): this operator's own App-user
  // credential/broker is the GitHub mutation authority. There is no Issuer
  // App installation credential, private key, or central publication
  // service anywhere in this path -- see
  // `GitHubAppUserCredentialBroker.withRuntimeAuthorityPublicationCapability`.
  const withRuntimeAuthorityPublicationCapability = broker.withRuntimeAuthorityPublicationCapability?.bind(broker);
  const authorityPublisher =
    input.authorityPublisher ??
    (withRuntimeAuthorityPublicationCapability === undefined
      ? undefined
      : async (options: RuntimeAuthorityPublisherOptions): Promise<RuntimeAuthorityPublicationResult> => {
          const target: RepositoryIdentity = {
            repositoryHost: options.repository.repositoryHost,
            repositoryId: options.repository.repositoryId,
            nameWithOwner: options.repository.repositoryNameWithOwner,
          };
          const publicationBroker: RuntimeAuthorityPublicationBroker = { withRuntimeAuthorityPublicationCapability };
          // The PR is authored by this operator's own GitHub identity, never
          // a fixed Issuer bot login (#1066 bootstrap publication); every
          // other invariant Core enforces (exact branch/base/repository,
          // exact title/body, single changed file, byte-exact artifact
          // content) still applies and remains the real integrity guarantee.
          return publishRuntimeAuthority(
            createRuntimeAuthorityPublicationRequest(options.authority),
            target,
            publicationBroker,
            { requireAuthor: null },
          );
        });
  try {
    return await broker.withRepositoryReadCapability({}, async (capability) => {
      const scope = capability.scope;
      if (scope.app.appId !== descriptor.appId)
        throw new RepositorySetupError(
          "REPOSITORY_SETUP_PROFILE_MISMATCH",
          "Resolved App identity does not match Endpoint metadata.",
        );
      const repository: LocalRuntimeProfileRepository = {
        repositoryHost: scope.repository.repositoryHost,
        repositoryId: scope.repository.repositoryId,
        repositoryNameWithOwner: scope.repository.nameWithOwner,
      };
      if (
        repository.repositoryHost !== context.hostname ||
        repository.repositoryNameWithOwner.toLowerCase() !== context.nameWithOwner.toLowerCase()
      )
        throw new RepositorySetupError(
          "REPOSITORY_SETUP_REPOSITORY_FAILED",
          "Resolved repository identity does not match the requested repository.",
        );
      return await setupWithCapability(
        input,
        descriptor,
        context,
        repository,
        capability,
        scope.installation.installationId,
        endpoint,
        authorityPublisher,
      );
    });
  } catch (error: unknown) {
    if (error instanceof RepositorySetupError) throw error;
    if (error instanceof GitHubAppUserCredentialBrokerError) {
      if (error.stage === "installation-scope" && error.reason === "scope") {
        return {
          ok: true,
          operation: "setup",
          state: "app-install-required",
          endpoint,
          relayUrl: descriptor.relayConnectionBase,
          appInstallationUrl: descriptor.appInstallationUrl,
          repository: {
            repositoryHost: context.hostname,
            ...(repositoryId === undefined ? {} : { repositoryId }),
            repositoryNameWithOwner: context.nameWithOwner,
          },
          app: { appId: descriptor.appId },
        };
      }
      if (error.stage === "user-credential")
        throw new RepositorySetupError("REPOSITORY_SETUP_AUTH_REQUIRED", "App-user authorization is required.");
    }
    throw new RepositorySetupError(
      "REPOSITORY_SETUP_REPOSITORY_FAILED",
      "App installation or repository scope could not be established.",
    );
  }
}

export const runRepositorySetup = setupRepository;
export const setupRepositoryRuntime = setupRepository;
