import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "./index.js";

test("root library exports can be imported without invoking the CLI", () => {
  assert.equal(typeof runCli, "function");
});
