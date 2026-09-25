import { strict as assert } from "node:assert";
import { test } from "node:test";
import { OperatorSession } from "./operator-session.js";
const repository = { repositoryHost: "github.com", repositoryId: "1", nameWithOwner: "a/b" };
test("operator context expires and binds repository/configuration; confirmations are single use", () => {
  const session = new OperatorSession(repository, "cfg", 1000, 1000);
  const { bearer, csrf } = session.context;
  assert.equal(session.authorize(bearer, csrf, repository, "cfg", 1500), true);
  assert.equal(session.authorize(bearer, csrf, repository, "other", 1500), false);
  assert.equal(session.authorize(bearer, csrf, { ...repository, repositoryId: "2" }, "cfg", 1500), false);
  assert.equal(session.authorize(bearer, csrf, repository, "cfg", 2000), false);
  const confirmation = session.confirm("action", 1500);
  assert.equal(session.consume(confirmation, "wrong", 1500), false);
  assert.equal(session.consume(confirmation, "action", 1500), false);
  const second = session.confirm("action", 1500);
  assert.equal(session.consume(second, "action", 1500), true);
  assert.equal(session.consume(second, "action", 1500), false);
});
