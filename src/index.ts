#!/usr/bin/env node
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli.js";

export { runCli };
export * from "./artifact.js";
export * from "./reconciliation.js";
export * from "./pr-sync-input.js";
export * from "./pr-policy.js";
export * from "./governance.js";
export * from "./contract/index.js";
export * from "./github/index.js";
export * from "./pull-request-template.js";
export * from "./semantic-template.js";
export * from "./template-resolver.js";
export * from "./diagnostics.js";
export * from "./command-contract.js";
export * from "./change.js";
export * from "./change-executor.js";
export * from "./change-trusted-executor.js";
export * from "./semantic-pr-projection.js";
export * from "./semantic-issue-projection.js";
export * from "./semantic-issue-observation.js";
export * from "./semantic-issue-lifecycle.js";
export * from "./semantic-branch-projection.js";
export * from "./semantic-branch-observation.js";
export * from "./semantic-pr-executor.js";
export * from "./semantic-issue-executor.js";
export * from "./semantic-branch-executor.js";
export * from "./artifact-contract-governance.js";
export * from "./golden-path-governance.js";
export * from "./legacy-artifact-convergence.js";
export * from "./agent-authority/index.js";
export * from "./mcp/index.js";
export {
  discoverTemplates,
  discoverTemplatesSync,
  discoverTemplatesFromPaths,
  classifyTemplatePath,
  isTemplateContainerPath,
  isTemplatePathInNativeDirectory,
  selectTemplate,
  selectIssueTemplate,
  selectPullRequestTemplate,
  TemplateDiscoveryError,
  TemplateFilesystemError,
  TemplateNotFoundError,
  TemplateSelectionAmbiguousError,
  TemplateNameConflictError,
  InvalidTemplateSelectorError,
} from "./template-discovery.js";
export type {
  TemplateDiscoveryResult,
  TemplateSelector,
  TemplateType,
  TemplateKind,
  TemplateDiscoveryErrorCode,
  TemplateDiscoveryErrorDetails,
} from "./template-discovery.js";

let invokedPath: string | undefined;
try {
  invokedPath = process.argv[1] === undefined ? undefined : realpathSync(path.resolve(process.argv[1]));
} catch {
  invokedPath = undefined;
}
// `import.meta.url` is empty when this module is bundled to CommonJS for the
// precompiled `gh` extension executable (scripts/build-gh-extension-release.sh
// uses a dedicated entrypoint instead, so this self-invocation never applies
// there) — guard so `fileURLToPath` isn't called on an empty URL.
if (import.meta.url !== "" && invokedPath === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      if (process.exitCode === undefined || process.exitCode === 0) {
        process.exitCode = 1;
      }
    });
}
