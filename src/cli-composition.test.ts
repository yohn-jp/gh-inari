import assert from "node:assert/strict";
import { test } from "node:test";
import { bindHandlers, compileProduct } from "@yohn-jp/cli-canon";
import { executeNodeCli, runNodeCli } from "@yohn-jp/cli-canon/node";
import {
  ARTIFACT_RECONCILIATION_COMMANDS,
  compileInariCliProduct,
  createLegacyDelegatedCommandSource,
} from "./cli-composition.js";

const packageMetadata = {
  name: "gh-inari",
  version: "0.18.0",
  bin: { inari: "dist/index.js", "gh-inari": "dist/index.js" },
} as const;

function product() {
  return compileInariCliProduct(
    packageMetadata,
    "Deterministic GitHub governance for repository-governed Issues, Changes, pull requests, and agent workflows.",
  );
}

test("CLI Canon owns the shared root shell for the composed product", async () => {
  let delegatedCalls = 0;
  const delegated = createLegacyDelegatedCommandSource(async () => {
    delegatedCalls += 1;
    return { exitCode: 0, stdout: "delegated\n", stderr: "" };
  });
  const compiled = product();

  const help = await runNodeCli(compiled, ["--help"], { delegatedSources: [delegated] });
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /Usage: inari/);
  assert.match(help.stdout, /branch/);

  const version = await runNodeCli(compiled, ["--version", "--json"], { delegatedSources: [delegated] });
  assert.deepEqual(JSON.parse(version.stdout), { name: "gh-inari", version: "0.18.0" });

  const noCommand = await runNodeCli(compiled, [], { delegatedSources: [delegated] });
  assert.equal(noCommand.failureKind, "usage");
  assert.notEqual(noCommand.exitCode, 0);

  const invalid = await runNodeCli(compiled, ["missing", "--json"], { delegatedSources: [delegated] });
  assert.equal(invalid.failureKind, "usage");
  assert.equal(JSON.parse(invalid.stderr).error.code, "unknown-command");
  assert.equal(delegatedCalls, 0);
});

test("typed reconcile routes own their Canon grammar, help, and dispatch", async () => {
  const compiled = compileProduct({
    name: "inari",
    packageMetadata,
    commands: ARTIFACT_RECONCILIATION_COMMANDS,
    handlers: bindHandlers(ARTIFACT_RECONCILIATION_COMMANDS)({
      "issue.reconcile": ({ number }) => ({ route: "issue", number }),
      "pr.reconcile": ({ number }) => ({ route: "pr", number }),
    }),
  });
  let delegatedCalls = 0;
  const delegated = createLegacyDelegatedCommandSource(async () => {
    delegatedCalls += 1;
    return { exitCode: 0, stdout: "delegated\n", stderr: "" };
  });

  for (const [domain, commandId] of [
    ["issue", "issue.reconcile"],
    ["pr", "pr.reconcile"],
  ] as const) {
    const execution = await executeNodeCli(compiled, [domain, "reconcile", "42"], {
      delegatedSources: [delegated],
    });
    assert.equal(execution.status, "success");
    if (execution.status === "success") {
      assert.equal(execution.commandId, commandId);
      assert.deepEqual(execution.result, { route: domain, number: 42 });
    }

    const help = await runNodeCli(compiled, [domain, "reconcile", "--help"], {
      delegatedSources: [delegated],
    });
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, new RegExp(`Usage: inari ${domain} reconcile <number>`));
    assert.match(help.stdout, /--repository/);
  }
  assert.equal(delegatedCalls, 0);
});

test("derived delegated route owners resolve a product route and a prefix route", async () => {
  const requests: Array<{
    readonly commandId: string;
    readonly route: readonly string[];
    readonly argv: readonly string[];
    readonly presentation: string;
  }> = [];
  const delegated = createLegacyDelegatedCommandSource(async (request) => {
    requests.push(request);
    return { exitCode: 0, stdout: `${request.route.join(" ")} delegated\n`, stderr: "" };
  });
  const compiled = product();

  assert.equal(
    delegated.commands.some(
      (command) => command.id.includes("branch.check") || command.id.includes("branch.semantic.check"),
    ),
    false,
  );

  const ordinaryBranchHelp = await runNodeCli(compiled, ["branch", "check", "--help"], {
    delegatedSources: [delegated],
  });
  assert.equal(ordinaryBranchHelp.exitCode, 0);
  assert.match(ordinaryBranchHelp.stdout, /Usage: inari branch check <name>/);
  assert.match(ordinaryBranchHelp.stdout, /\[--from <path>\]/);

  const semanticBranchHelp = await runNodeCli(compiled, ["branch", "semantic", "check", "--help"], {
    delegatedSources: [delegated],
  });
  assert.equal(semanticBranchHelp.exitCode, 0);
  assert.match(semanticBranchHelp.stdout, /Usage: inari branch semantic check <name>/);
  assert.match(semanticBranchHelp.stdout, /--from <path>/);
  assert.doesNotMatch(semanticBranchHelp.stdout, /\[--from <path>\]/);

  const setupChild = await runNodeCli(
    compiled,
    ["setup", "status", "--detail", "--repository", "example/setup", "--json"],
    { delegatedSources: [delegated] },
  );
  assert.equal(setupChild.exitCode, 0);

  const setupNext = await runNodeCli(compiled, ["setup", "next", "--yes", "--repository-id", "1", "--json"], {
    delegatedSources: [delegated],
  });
  assert.equal(setupNext.exitCode, 0);

  const setupConsole = await runNodeCli(compiled, ["setup", "console", "--repository-id", "1", "--json"], {
    delegatedSources: [delegated],
  });
  assert.equal(setupConsole.exitCode, 0);

  assert.deepEqual(requests, [
    {
      sourceId: "inari-legacy-command-core",
      commandId: "setup.status",
      route: ["setup", "status"],
      argv: ["--detail", "--repository", "example/setup"],
      presentation: "machine",
    },
    {
      sourceId: "inari-legacy-command-core",
      commandId: "setup.next",
      route: ["setup", "next"],
      argv: ["--yes", "--repository-id", "1"],
      presentation: "machine",
    },
    {
      sourceId: "inari-legacy-command-core",
      commandId: "setup.console",
      route: ["setup", "console"],
      argv: ["--repository-id", "1"],
      presentation: "machine",
    },
  ]);
});
