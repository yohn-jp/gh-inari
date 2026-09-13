/**
 * Runtime-side provenance signing entrypoint for a narrowly-scoped GitHub
 * Actions job.
 *
 * This is the ONLY place the Runtime Authority private key
 * (`INARI_RUNTIME_AUTHORITY_PRIVATE_KEY`) may be configured in Actions. It
 * signs the canonical Change provenance payload and prints the resulting
 * `SignedChangeProvenanceRecord` as one bounded JSON line. The trusted
 * `execute` job never sees this secret; it receives only the signed record
 * produced here (see `actions-change-executor.ts`'s
 * `INARI_CHANGE_PROVENANCE_RECORD` input and `verifyChangeProvenanceRecord`).
 */

import { createChangeProvenanceRecord, renderChangeProvenanceRecord } from "../change-provenance-record.js";
import { resolveRuntimeAuthority } from "../agent-authority/runtime-authority-trust.js";
import { importRuntimeAuthorityPrivateKey } from "../agent-authority/runtime-key.js";
import { createRepositoryEvidenceReader } from "./app-repository-evidence-reader.js";
import { GitHubActionsApiTransport } from "./actions-change-executor.js";
import { resolveGitHubRepository } from "./app-installation-credential-broker.js";
import type { GitHubChangeEffectRepository } from "./change-effect-adapter.js";

const DEFAULT_API_URL = "https://api.github.com";
const MAX_BOUNDED_ENV_LENGTH = 16_384;

export class RuntimeSignCliError extends Error {
  constructor(message = "Runtime provenance signing failed closed.") {
    super(message);
    this.name = "RuntimeSignCliError";
  }
}

/** Simple non-whitespace token environment inputs (ids, hostnames, JSON blobs without literal spaces). */
function requiredEnvironment(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_BOUNDED_ENV_LENGTH) {
    throw new RuntimeSignCliError();
  }
  return value;
}

function parseRepository(value: string, hostname: string): GitHubChangeEffectRepository {
  const parts = value.split("/");
  if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) throw new RuntimeSignCliError();
  return { hostname, owner: parts[0]!, name: parts[1]! };
}

function parseChangeRequest(serialized: string): { readonly operation: string; readonly issue: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new RuntimeSignCliError();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new RuntimeSignCliError();
  const record = parsed as Record<string, unknown>;
  if (typeof record.operation !== "string" || typeof record.issue !== "number") throw new RuntimeSignCliError();
  return { operation: record.operation, issue: record.issue };
}

/**
 * Sign a fresh Change provenance bootstrap record when, and only when, the
 * requested operation is `"issue"`. For every other operation this returns
 * `undefined` without ever reading the Runtime private key, so non-issue
 * workflow runs need not have that secret available.
 */
export async function runRuntimeSignCli(environment: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const serializedRequest = requiredEnvironment(environment, "INARI_CHANGE_REQUEST");
  const { operation, issue } = parseChangeRequest(serializedRequest);
  if (operation !== "issue") return undefined;

  const repositoryNameWithOwner = requiredEnvironment(environment, "GITHUB_REPOSITORY");
  const hostname =
    environment.GITHUB_SERVER_URL === undefined ? "github.com" : new URL(environment.GITHUB_SERVER_URL).hostname;
  const repository = parseRepository(repositoryNameWithOwner, hostname);
  const readTransport = new GitHubActionsApiTransport({
    apiUrl: environment.GITHUB_API_URL ?? DEFAULT_API_URL,
    token: requiredEnvironment(environment, "GITHUB_TOKEN"),
  });
  const { target } = await resolveGitHubRepository(repository, readTransport, () => new RuntimeSignCliError());

  const runtimeAuthorityId = requiredEnvironment(environment, "INARI_RUNTIME_AUTHORITY_ID");
  const runtimePrivateKeyPemRaw = environment.INARI_RUNTIME_AUTHORITY_PRIVATE_KEY;
  if (
    typeof runtimePrivateKeyPemRaw !== "string" ||
    runtimePrivateKeyPemRaw.length === 0 ||
    runtimePrivateKeyPemRaw.length > MAX_BOUNDED_ENV_LENGTH
  ) {
    throw new RuntimeSignCliError();
  }
  const runtimeReader = createRepositoryEvidenceReader(readTransport, repository, target);
  const loaded = await resolveRuntimeAuthority(runtimeReader, runtimeAuthorityId);
  const runtimeKey = importRuntimeAuthorityPrivateKey(runtimePrivateKeyPemRaw);

  const actorType = environment.INARI_PROVENANCE_ACTOR_TYPE;
  const actorName = environment.INARI_PROVENANCE_ACTOR_NAME;
  const actor =
    actorType === undefined && actorName === undefined
      ? undefined
      : (() => {
          if (actorType !== "user" && actorType !== "bot" && actorType !== "agent") throw new RuntimeSignCliError();
          if (typeof actorName !== "string" || actorName.length === 0) throw new RuntimeSignCliError();
          return { type: actorType, name: actorName } as const;
        })();

  const record = createChangeProvenanceRecord({
    rootIssue: issue,
    runtimeAuthority: loaded.authority,
    runtimeKey,
    ...(actor === undefined ? {} : { actor }),
  });
  return renderChangeProvenanceRecord(record);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && invokedPath.endsWith("runtime-sign-cli.js")) {
  runRuntimeSignCli()
    .then((rendered) => {
      process.stdout.write(rendered ?? `${JSON.stringify(null)}\n`);
      process.exitCode = 0;
    })
    .catch(() => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "RUNTIME_SIGN_FAILED" } })}\n`);
      process.exitCode = 1;
    });
}
