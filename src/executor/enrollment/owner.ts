/**
 * Isolated Executor enrollment authority. Only trusted local composition calls issue().
 *
 * Custody is App-scoped (#1199): an owner enrolls, verifies and binds only its
 * own App. The legacy single-App index remains the setup-compatible projection
 * of the App it already holds (or of the first App enrolled into an empty
 * Executor); every change to it is adopted into App-scoped custody and
 * repository bindings before the owner reports success.
 */
import { randomBytes } from "node:crypto";
import { constants, fstatSync, openSync, readSync, closeSync } from "node:fs";
import {
  validateSecretEnrollmentRequest,
  type SecretEnrollmentPort,
  type SecretEnrollmentRequest,
  type SecretEnrollmentReceipt,
} from "../../runtime-contracts/enrollment.js";
import { GitHubAppInstallationCredentialBroker } from "../../github/app-installation-credential-broker.js";
import type { RepositoryIdentity } from "../../github/effect-authorizer.js";
import { LocalRuntimeProfileStore } from "../../local-runtime-profile.js";
import {
  ExecutorAppCredentialStore,
  ExecutorCredentialStore,
  type AppCredentialGeneration,
  type StoredAppCredential,
  type StoredIssuerBinding,
  type StoredIssuerKey,
} from "../credential-store.js";
import { adoptLegacyExecutorCustody } from "../credential-migration.js";
import {
  ExecutorRepositoryBindingStore,
  repositoryBindingState,
  type ExecutorRepositoryBinding,
  type ExecutorRepositoryBindingState,
} from "../repository-binding-store.js";

export interface ExecutorEnrollmentCapability {
  readonly token: string;
}

export interface ExecutorEnrollmentReceipt extends SecretEnrollmentReceipt {
  readonly stored: boolean;
  readonly providerVerified: boolean;
  readonly generation?: string;
}

interface Grant {
  readonly configId: string;
  readonly appId: string;
  readonly operation: "issuer-key-enroll";
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly current?: AppCredentialGeneration;
  /** Whether the grant was issued against the legacy single-App projection. */
  readonly projected: boolean;
  readonly replacementConfirmed: boolean;
}

/** The custody an owner acts on: the legacy projection of its App, or its App-scoped credential. */
interface CustodyReference {
  readonly projected: boolean;
  readonly current?: Pick<StoredIssuerKey, "configId" | "appId" | "generation" | "fingerprint" | "providerVerified">;
}

export interface ExecutorEnrollmentOwnerOptions {
  readonly configId: string;
  readonly appId: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly verifyProvider?: (pem: string, request: SecretEnrollmentRequest) => Promise<boolean>;
  /** Test seam for `verifyStoredProvider`; production uses the installation broker. */
  readonly verifyInstallation?: (
    pem: string,
    repository: RepositoryIdentity,
    installationId: string,
  ) => Promise<boolean>;
}

/** Public, secret-free projection of Executor Issuer key custody. */
export type ExecutorIssuerCustodyStatus = Pick<
  StoredIssuerKey,
  "configId" | "appId" | "generation" | "fingerprint" | "providerVerified"
> & {
  /** Repository installations the current key generation was verified against (#1182). */
  readonly bindings: readonly StoredIssuerBinding[];
};

/** Public, secret-free projection of App-scoped Executor custody and its repository bindings (#1199). */
export interface ExecutorAppCustodyStatus {
  readonly apps: readonly Pick<
    StoredAppCredential,
    "configId" | "appId" | "generation" | "fingerprint" | "providerVerified"
  >[];
  readonly bindings: readonly (ExecutorRepositoryBinding & { readonly status: ExecutorRepositoryBindingState })[];
}

/** Reads App-scoped custody and bindings without creating directories or exposing key bytes or paths. */
export function executorAppCustody(environment?: NodeJS.ProcessEnv): ExecutorAppCustodyStatus {
  const apps = new ExecutorAppCredentialStore(environment).list();
  const bindings = new ExecutorRepositoryBindingStore(environment).list();
  return Object.freeze({
    apps: Object.freeze(
      apps.map((app) =>
        Object.freeze({
          configId: app.configId,
          appId: app.appId,
          generation: app.generation,
          fingerprint: app.fingerprint,
          providerVerified: app.providerVerified,
        }),
      ),
    ),
    bindings: Object.freeze(
      bindings.map((binding) =>
        Object.freeze({
          ...binding,
          status: repositoryBindingState(
            binding,
            apps.find((app) => app.appId === binding.appId),
          ),
        }),
      ),
    ),
  });
}

/** Reads the legacy single-App custody projection without exposing key bytes or the key path. */
export function executorIssuerCustody(environment?: NodeJS.ProcessEnv): ExecutorIssuerCustodyStatus | undefined {
  const record = new ExecutorCredentialStore(environment).current();
  return record === undefined
    ? undefined
    : Object.freeze({
        configId: record.configId,
        appId: record.appId,
        generation: record.generation,
        fingerprint: record.fingerprint,
        providerVerified: record.providerVerified,
        bindings: Object.freeze((record.bindings ?? []).map((binding) => Object.freeze({ ...binding }))),
      });
}

const CAPABILITY_LIFETIME_MS = 60_000;

function denied(): Error {
  return new Error("Executor enrollment was rejected.");
}

export class ExecutorEnrollmentOwner {
  readonly #options: ExecutorEnrollmentOwnerOptions;
  readonly #store: ExecutorCredentialStore;
  readonly #apps: ExecutorAppCredentialStore;
  readonly #bindings: ExecutorRepositoryBindingStore;
  readonly #grants = new Map<string, Grant>();
  readonly #now: () => number;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(options: ExecutorEnrollmentOwnerOptions) {
    if (!/^[A-Za-z0-9_-]{16,64}$/u.test(options.configId) || !/^[1-9][0-9]{0,19}$/u.test(options.appId)) throw denied();
    this.#options = options;
    this.#store = new ExecutorCredentialStore(options.environment);
    this.#apps = new ExecutorAppCredentialStore(options.environment);
    this.#bindings = new ExecutorRepositoryBindingStore(options.environment);
    this.#now = options.now ?? Date.now;
  }

  /**
   * The custody this owner acts on. The legacy index is projected only for the
   * App it holds, or for an App enrolled while no legacy index and no
   * App-scoped credential of that App exist; any other App is App-scoped only
   * and never reads the legacy App's key. A legacy index bound to another
   * Executor configuration is denied.
   */
  #reference(): CustodyReference {
    const legacy = this.#store.current();
    if (legacy !== undefined && legacy.configId !== this.#options.configId) throw denied();
    if (legacy !== undefined && legacy.appId === this.#options.appId) {
      try {
        this.#converge();
      } catch {
        // A diverged projection is repaired only by an owner write; every write converges or fails closed.
      }
      return { projected: true, current: legacy };
    }
    const current = this.#apps.current(this.#options.appId);
    if (legacy === undefined && current === undefined) return { projected: true };
    if (current !== undefined && current.configId !== this.#options.configId) throw denied();
    return current === undefined ? { projected: false } : { projected: false, current };
  }

  /** Adopt the legacy projection of this owner's App into App-scoped custody and bindings. */
  #converge(replacing?: AppCredentialGeneration): void {
    adoptLegacyExecutorCustody(this.#options.environment, replacing === undefined ? {} : { replacing });
  }

  /** A repository binding never moves to another App or installation (#1199). */
  #bindingAllowed(binding: StoredIssuerBinding): boolean {
    const existing = this.#bindings.read(binding.repositoryId);
    return (
      existing === undefined ||
      (existing.repositoryHost === binding.repositoryHost &&
        existing.appId === this.#options.appId &&
        existing.installationId === binding.installationId)
    );
  }

  /**
   * Record a verified generation, and a verified repository installation when
   * one was proven. App-scoped custody and the repository binding commit
   * first; the legacy projection follows, so a failure never leaves a legacy
   * binding that execution cannot resolve.
   */
  #recordVerified(projected: boolean, generation: string, binding: StoredIssuerBinding | undefined): void {
    if (binding !== undefined && !this.#bindingAllowed(binding)) throw denied();
    const credential = this.#apps.markProviderVerified(this.#options.appId, generation);
    if (binding !== undefined)
      this.#bindings.publish({
        ...binding,
        appId: credential.appId,
        generation: credential.generation,
        fingerprint: credential.fingerprint,
      });
    if (!projected) return;
    if (binding === undefined) this.#store.markProviderVerified(generation);
    else this.#store.recordBinding(generation, binding);
  }

  current(): Pick<StoredIssuerKey, "configId" | "appId" | "generation" | "fingerprint"> | undefined {
    const record = this.#reference().current;
    return record === undefined
      ? undefined
      : Object.freeze({
          appId: record.appId,
          configId: record.configId,
          generation: record.generation,
          fingerprint: record.fingerprint,
        });
  }

  port(capability: ExecutorEnrollmentCapability): SecretEnrollmentPort {
    return Object.freeze({
      owner: "executor" as const,
      kinds: ["executor-issuer-private-key"] as const,
      enroll: async (request: SecretEnrollmentRequest, secret: AsyncIterable<Uint8Array>, signal?: AbortSignal) => {
        const receipt = await this.enrollStream(capability, request, secret, signal);
        return {
          version: receipt.version,
          kind: receipt.kind,
          operationId: receipt.operationId,
          repository: receipt.repository,
          outcome: receipt.outcome,
          publicFingerprint: receipt.publicFingerprint,
          diagnostics: receipt.diagnostics,
        };
      },
    });
  }

  /** Trusted local operator/composition entrypoint; never an HTTP route. */
  issue(expectedReplacement?: {
    readonly generation: string;
    readonly fingerprint: string;
  }): ExecutorEnrollmentCapability {
    const now = this.#now();
    let reference: CustodyReference;
    try {
      reference = this.#reference();
    } catch {
      throw denied();
    }
    const current = reference.current;
    if (current !== undefined && (current.configId !== this.#options.configId || current.appId !== this.#options.appId))
      throw denied();
    if (
      expectedReplacement !== undefined &&
      (current === undefined ||
        current.generation !== expectedReplacement.generation ||
        current.fingerprint !== expectedReplacement.fingerprint)
    )
      throw denied();
    const nonce = randomBytes(24).toString("base64url");
    const token = randomBytes(32).toString("base64url");
    this.#grants.set(token, {
      configId: this.#options.configId,
      appId: this.#options.appId,
      operation: "issuer-key-enroll",
      issuedAt: now,
      expiresAt: now + CAPABILITY_LIFETIME_MS,
      nonce,
      projected: reference.projected,
      replacementConfirmed: expectedReplacement !== undefined,
      ...(current === undefined
        ? {}
        : { current: Object.freeze({ generation: current.generation, fingerprint: current.fingerprint }) }),
    });
    return Object.freeze({ token });
  }

  async enrollStream(
    capability: ExecutorEnrollmentCapability,
    untrustedRequest: SecretEnrollmentRequest,
    secret: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<ExecutorEnrollmentReceipt> {
    // Claims are consumed before touching secret bytes; retry requires a new grant.
    const grant = this.#grants.get(capability.token);
    this.#grants.delete(capability.token);
    const now = this.#now();
    if (
      grant === undefined ||
      grant.configId !== this.#options.configId ||
      grant.appId !== this.#options.appId ||
      grant.operation !== "issuer-key-enroll" ||
      grant.issuedAt > now ||
      grant.expiresAt <= now ||
      signal?.aborted
    )
      throw denied();
    const request = validateSecretEnrollmentRequest(untrustedRequest);
    const stale = (reference: CustodyReference): boolean =>
      reference.projected !== grant.projected ||
      reference.current?.generation !== grant.current?.generation ||
      reference.current?.fingerprint !== grant.current?.fingerprint ||
      (reference.current !== undefined &&
        (reference.current.configId !== grant.configId || reference.current.appId !== grant.appId));
    if (stale(this.#reference())) throw denied();
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of secret) {
      if (signal?.aborted || !(chunk instanceof Uint8Array)) throw denied();
      length += chunk.byteLength;
      if (length > request.declaredBytes || length > 64 * 1024) throw denied();
      chunks.push(Buffer.from(chunk));
    }
    if (length !== request.declaredBytes) throw denied();
    const pem = Buffer.concat(chunks);
    // A concurrent enrollment can commit while bytes are being read. Serialize the final check and commit.
    const commit = this.#pending.then(async () => {
      const latest = this.#reference();
      if (stale(latest)) throw denied();
      // An unconfirmed grant can only retry the same key.
      const expected = grant.replacementConfirmed || latest.current === undefined ? grant.current : undefined;
      let record: Pick<StoredIssuerKey, "generation" | "fingerprint" | "providerVerified">;
      if (grant.projected) {
        const before = this.#apps.current(grant.appId);
        record = this.#store.save(grant.configId, grant.appId, pem, expected).record;
        // The legacy projection changed first; App-scoped custody adopts the same generation.
        this.#converge(before);
      } else record = this.#apps.save(grant.configId, grant.appId, pem, expected).record;
      let providerVerified = false;
      let binding: StoredIssuerBinding | undefined;
      try {
        if (this.#options.verifyProvider !== undefined)
          providerVerified = await this.#options.verifyProvider(pem.toString("utf8"), request);
        else {
          binding = await this.#verifyWithBroker(pem.toString("utf8"), request);
          providerVerified = binding !== undefined;
        }
      } catch {
        /* a committed key remains stored but unverified */
      }
      if (providerVerified) {
        try {
          this.#recordVerified(grant.projected, record.generation, binding);
        } catch {
          providerVerified = false;
        }
      }
      return Object.freeze({
        version: request.version,
        kind: request.kind,
        operationId: request.operationId,
        repository: request.repository,
        outcome: "enrolled" as const,
        publicFingerprint: record.fingerprint,
        diagnostics: [],
        stored: true,
        providerVerified: providerVerified || record.providerVerified,
        generation: record.generation,
      });
    });
    this.#pending = commit.catch(() => undefined);
    return commit;
  }

  async enrollReference(
    capability: ExecutorEnrollmentCapability,
    request: SecretEnrollmentRequest,
    reference: string,
    signal?: AbortSignal,
  ): Promise<ExecutorEnrollmentReceipt> {
    if (typeof reference !== "string" || reference.length === 0 || reference.length > 4096 || reference.includes("\0"))
      throw denied();
    const read = async function* (): AsyncIterable<Uint8Array> {
      let fd: number | undefined;
      try {
        fd = openSync(reference, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024) throw denied();
        const bytes = Buffer.alloc(stat.size);
        for (let offset = 0; offset < bytes.length;) {
          const read = readSync(fd, bytes, offset, bytes.length - offset, null);
          if (read < 1) throw denied();
          offset += read;
        }
        yield bytes;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    };
    return this.enrollStream(capability, request, read(), signal);
  }

  /**
   * Verify the already stored Issuer key of this owner's App against an
   * explicitly bound App installation of `repository` and record the result
   * as that repository's binding to the exact verified generation. Trusted
   * local composition only; the key never leaves the Executor owner.
   */
  async verifyStoredProvider(repository: RepositoryIdentity, installationId: string): Promise<boolean> {
    if (!/^[1-9][0-9]{0,19}$/u.test(installationId)) throw denied();
    const commit = this.#pending.then(async () => {
      const { projected, current } = this.#reference();
      if (current === undefined || current.configId !== this.#options.configId || current.appId !== this.#options.appId)
        throw denied();
      const binding: StoredIssuerBinding = {
        repositoryHost: repository.repositoryHost,
        repositoryId: repository.repositoryId,
        nameWithOwner: repository.nameWithOwner,
        installationId,
      };
      if (!this.#bindingAllowed(binding)) throw denied();
      const credential = this.#apps.current(this.#options.appId);
      if (credential === undefined || credential.generation !== current.generation) throw denied();
      const existing = this.#bindings.read(repository.repositoryId);
      const legacy = projected
        ? (current as StoredIssuerKey).bindings?.find((item) => item.repositoryId === repository.repositoryId)
        : undefined;
      if (legacy !== undefined && legacy.installationId !== installationId) throw denied();
      if (
        existing !== undefined &&
        repositoryBindingState(existing, credential) === "bound" &&
        existing.nameWithOwner === repository.nameWithOwner &&
        (!projected || legacy?.nameWithOwner === repository.nameWithOwner)
      )
        return true;
      const pem = this.#apps.readKey(credential).toString("utf8");
      let verified = false;
      try {
        verified = await (this.#options.verifyInstallation?.(pem, repository, installationId) ??
          this.#installationCheck(pem, repository, installationId));
      } catch {
        verified = false;
      }
      // The verified installation becomes the Executor's own repository binding (#1182, #1199).
      if (verified) this.#recordVerified(projected, credential.generation, binding);
      return verified;
    });
    this.#pending = commit.catch(() => undefined);
    return commit;
  }

  async #verifyWithBroker(pem: string, request: SecretEnrollmentRequest): Promise<StoredIssuerBinding | undefined> {
    const profile = await new LocalRuntimeProfileStore({ environment: this.#options.environment }).findForRepository({
      repositoryHost: request.repository.repositoryHost,
      repositoryNameWithOwner: request.repository.nameWithOwner,
    });
    if (
      profile === undefined ||
      profile.app.appId !== this.#options.appId ||
      profile.repository.repositoryId !== request.repository.repositoryId
    )
      return undefined;
    return (await this.#installationCheck(pem, request.repository, profile.app.installationId))
      ? {
          repositoryHost: request.repository.repositoryHost,
          repositoryId: request.repository.repositoryId,
          nameWithOwner: request.repository.nameWithOwner,
          installationId: profile.app.installationId,
        }
      : undefined;
  }

  async #installationCheck(pem: string, repository: RepositoryIdentity, installationId: string): Promise<boolean> {
    const [owner, name] = repository.nameWithOwner.split("/");
    if (owner === undefined || name === undefined) return false;
    const broker = new GitHubAppInstallationCredentialBroker({
      appId: this.#options.appId,
      installationId,
      privateKeyPem: pem,
      repository: { hostname: repository.repositoryHost, owner, name },
    });
    return broker.withRepositoryReadCapability(
      {},
      async (capability) =>
        capability.scope.app.appId === this.#options.appId &&
        capability.scope.repository.repositoryId === repository.repositoryId,
    );
  }
}
