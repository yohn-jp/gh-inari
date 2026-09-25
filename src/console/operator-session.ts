/** Explicit, short-lived authority for one local setup repository/configuration. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { RepositoryIdentity } from "../github/effect-authorizer.js";

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
  private readonly confirmations = new Map<string, { actionId: string; expiresAt: number }>();
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
  confirm(actionId: string, now = Date.now()): string {
    const value = token();
    this.confirmations.set(value, { actionId, expiresAt: Math.min(this.context.expiresAt, now + 60_000) });
    return value;
  }
  consume(value: string | undefined, actionId: string, now = Date.now()): boolean {
    if (typeof value !== "string") return false;
    const item = this.confirmations.get(value);
    if (item === undefined) return false;
    this.confirmations.delete(value);
    return item.actionId === actionId && now < item.expiresAt;
  }
}
