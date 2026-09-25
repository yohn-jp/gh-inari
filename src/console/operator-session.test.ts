import { strict as assert } from "node:assert";
import { test } from "node:test";
import { OperatorSession } from "./operator-session.js";
const repository = { repositoryHost: "github.com", repositoryId: "1", nameWithOwner: "a/b" };
const generation = { repository, configuration: "cfg" };
test("operator context expires and binds repository/configuration; confirmations are single use", () => {
  const session = new OperatorSession(repository, "cfg", 1000, 1000);
  const { bearer, csrf } = session.context;
  assert.equal(session.authorize(bearer, csrf, repository, "cfg", 1500), true);
  assert.equal(session.authorize(bearer, csrf, repository, "other", 1500), false);
  assert.equal(session.authorize(bearer, csrf, { ...repository, repositoryId: "2" }, "cfg", 1500), false);
  assert.equal(session.authorize(bearer, csrf, repository, "cfg", 2000), false);
  const confirmation = session.confirm("action", generation, 1500);
  assert.equal(session.consume(confirmation, "wrong", generation, 1500), false);
  assert.equal(session.consume(confirmation, "action", generation, 1500), false);
  const second = session.confirm("action", generation, 1500);
  assert.equal(session.consume(second, "action", generation, 1500), true);
  assert.equal(session.consume(second, "action", generation, 1500), false);
  const expired = session.confirm("action", generation, 1500);
  assert.equal(session.consume(expired, "action", generation, 2000), false);
});

test("confirmations are bound to the exact setup generation observed at issuance", () => {
  const session = new OperatorSession(repository, "cfg", 1000, 10 * 60_000);
  const drifted = { ...generation, configuration: "cfg-2" };
  const stale = session.confirm("action", generation, 1500);
  // Same action ID, different generation: rejected and burned.
  assert.equal(session.consume(stale, "action", drifted, 1500), false);
  assert.equal(session.consume(stale, "action", generation, 1500), false);
  const otherRepository = { ...generation, repository: { ...repository, repositoryId: "2" } };
  const wrongRepository = session.confirm("action", generation, 1500);
  assert.equal(session.consume(wrongRepository, "action", otherRepository, 1500), false);
  // The captured generation is a copy: mutating the caller's object cannot re-bind it.
  const mutable = { repository: { ...repository }, configuration: "cfg" };
  const copied = session.confirm("action", mutable, 1500);
  mutable.configuration = "cfg-2";
  assert.equal(session.consume(copied, "action", mutable, 1500), false);
  const fresh = session.confirm("action", drifted, 1500);
  assert.equal(session.consume(fresh, "action", drifted, 1500), true);
  // Short-lived: at most one minute.
  const shortLived = session.confirm("action", generation, 1500);
  assert.equal(session.consume(shortLived, "action", generation, 1500 + 60_000), false);
});
