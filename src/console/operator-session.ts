/** Explicit, short-lived authority for one local setup repository/configuration. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { RepositoryIdentity } from "../github/effect-authorizer.js";
import { sameSetupGeneration, type SetupGeneration } from "../runtime-contracts/index.js";

const token = () => randomBytes(32).toString("base64url");
const equal = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export interface OperatorContext {
  readonly repository: RepositoryIdentity;
  readonly configuration: string;
  readonly bearer: string;
  readonly csrf: string;
  readonly expiresAt: number;
}

export class OperatorSession {
  private readonly confirmations = new Map<
    string,
    { actionId: string; generation: SetupGeneration; expiresAt: number }
  >();
  readonly context: OperatorContext;
  constructor(repository: RepositoryIdentity, configuration: string, now = Date.now(), lifetimeMs = 5 * 60_000) {
    this.context = Object.freeze({
      repository,
      configuration,
      bearer: token(),
      csrf: token(),
      expiresAt: now + lifetimeMs,
    });
  }
  authorize(
    bearer: string | undefined,
    csrf: string | undefined,
    repository: RepositoryIdentity,
    configuration: string,
    now = Date.now(),
  ): boolean {
    const c = this.context;
    return (
      now < c.expiresAt &&
      repository.repositoryHost === c.repository.repositoryHost &&
      repository.repositoryId === c.repository.repositoryId &&
      configuration === c.configuration &&
      typeof bearer === "string" &&
      equal(bearer, c.bearer) &&
      typeof csrf === "string" &&
      equal(csrf, c.csrf)
    );
  }
  /**
   * Issues a short-lived, single-use confirmation bound to the action and the
   * exact setup generation observed when the confirmation was issued.
   */
  confirm(actionId: string, generation: SetupGeneration, now = Date.now()): string {
    const value = token();
    this.confirmations.set(value, {
      actionId,
      generation: Object.freeze({
        repository: Object.freeze({ ...generation.repository }),
        configuration: generation.configuration,
      }),
      expiresAt: Math.min(this.context.expiresAt, now + 60_000),
    });
    return value;
  }
  /**
   * Consumes a confirmation once. It succeeds only for the same action and the
   * same setup generation it was issued for, before it expires; a generation
   * change invalidates it even when the action ID is unchanged.
   */
  consume(value: string | undefined, actionId: string, generation: SetupGeneration, now = Date.now()): boolean {
    if (typeof value !== "string") return false;
    const item = this.confirmations.get(value);
    if (item === undefined) return false;
    this.confirmations.delete(value);
    return item.actionId === actionId && sameSetupGeneration(item.generation, generation) && now < item.expiresAt;
  }
}
