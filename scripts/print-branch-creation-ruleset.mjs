#!/usr/bin/env node

/**
 * Read-only operator helper for #223 issuer-controlled canonical Change
 * branch-creation enforcement.
 *
 * Prints the exact desired-state GitHub Ruleset payload for a requested
 * staged enforcement value, computed from the single Core definition in
 * `../src/branch-creation-ruleset.ts`. It never calls the GitHub API and
 * never enables live enforcement; see
 * `../docs/BRANCH_CREATION_RULESET_OPERATIONS.md` for the governed rollout
 * and rollback/recovery procedure that consumes this output.
 */
import { INARI_ISSUER_APP_KIND, INARI_ISSUER_APP_SLUG } from "../src/issuer-identity.ts";
import { buildChangeBranchCreationRuleset, RULESET_ENFORCEMENT_STAGES } from "../src/branch-creation-ruleset.ts";

function parseCliArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== "--enforcement" && token !== "--issuer-app-id") {
      throw new Error(`unsupported option ${token ?? ""}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} requires a value`);
    values[token.slice(2)] = value;
    index += 1;
  }
  if (values["issuer-app-id"] === undefined) {
    throw new Error(
      "--issuer-app-id is required (the inari-issuer GitHub App's numeric App ID; deployment configuration, not committed).",
    );
  }
  if (values.enforcement === undefined) values.enforcement = RULESET_ENFORCEMENT_STAGES[0];
  return values;
}

function runAsCommand() {
  try {
    const args = parseCliArguments(process.argv.slice(2));
    const ruleset = buildChangeBranchCreationRuleset({
      enforcement: args.enforcement,
      issuerApp: { kind: INARI_ISSUER_APP_KIND, slug: INARI_ISSUER_APP_SLUG, appId: args["issuer-app-id"] },
    });
    console.log(JSON.stringify(ruleset, null, 2));
  } catch (error) {
    console.error(`print-branch-creation-ruleset failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

runAsCommand();
