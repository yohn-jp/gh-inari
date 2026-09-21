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
export * from "./implementation-contract.js";
export * from "./implementation-authorization.js";
export * from "./implementation-session-binding.js";
export * from "./implementation-readiness.js";
export * from "./implementation-execution-evidence.js";
export * from "./implementation-scope-projection.js";
export * from "./implementation-scope-applicability.js";
export * from "./implementation-conformance.js";
export * from "./implementation-scope-conformance.js";
export * from "./implementation-lifecycle.js";
export * from "./implementation-change-identity.js";
export * from "./implementation-rework.js";
export * from "./implementation-frontier.js";
export * from "./implementation-frontier-composition.js";
export * from "./github/index.js";
export * from "./pull-request-template.js";
export * from "./semantic-template.js";
export * from "./template-resolver.js";
export * from "./diagnostics.js";
export * from "./command-contract.js";
export * from "./change.js";
export * from "./branch-naming.js";
export * from "./integration-routing.js";
export * from "./branch-creation-ruleset.js";
export * from "./change-provenance-record.js";
export * from "./change-execution-port.js";
export * from "./change-handoff.js";
export * from "./change-trusted-executor.js";
export * from "./golden-path-review.js";
export * from "./golden-path-entry.js";
export * from "./golden-path-recovery.js";
export * from "./semantic-pr-projection.js";
// The existing PR projection owns the historical MutationPlan names. Export
// the governed write authority under explicit names to keep that authority
// separate at the package barrel as well as in its implementation module.
export {
  SEMANTIC_PULL_REQUEST_MUTATION_CONTRACT_VERSION,
  SEMANTIC_PULL_REQUEST_MUTATION_LIMITS,
  SemanticPullRequestMutationError,
  SemanticPullRequestMutationExecutor,
  SemanticPullRequestMutationValidationError,
  LocalSemanticPullRequestMutationExecutor,
  materializeSemanticPullRequestMutationRequest as materializeGovernedSemanticPullRequestMutationRequest,
  tryMaterializeSemanticPullRequestMutationRequest as tryMaterializeGovernedSemanticPullRequestMutationRequest,
  planSemanticPullRequestMutation as planGovernedSemanticPullRequestMutation,
  createSemanticPullRequestMutationPlan as createGovernedSemanticPullRequestMutationPlan,
  tryPlanSemanticPullRequestMutation as tryPlanGovernedSemanticPullRequestMutation,
  validateSemanticPullRequestMutationPlan as validateGovernedSemanticPullRequestMutationPlan,
  serializeSemanticPullRequestMutationPlan as serializeGovernedSemanticPullRequestMutationPlan,
  deserializeSemanticPullRequestMutationPlan as deserializeGovernedSemanticPullRequestMutationPlan,
  parseSemanticPullRequestMutationPlan as parseGovernedSemanticPullRequestMutationPlan,
} from "./semantic-pr-mutation.js";
export type {
  SemanticPullRequestMutationContractVersion as GovernedSemanticPullRequestMutationContractVersion,
  SemanticPullRequestMutationPlanVersion as GovernedSemanticPullRequestMutationPlanVersion,
  SemanticPullRequestMutationOperation,
  SemanticPullRequestMutationOutcome,
  SemanticPullRequestReviewIntent,
  SemanticPullRequestRetryMode,
  SemanticPullRequestMergeStrategy,
  SemanticPullRequestRepositoryIdentity,
  SemanticPullRequestCommentRequest,
  SemanticPullRequestReviewRequest,
  SemanticPullRequestMergeRequest,
  SemanticPullRequestMutationRequest,
  SemanticPullRequestMutationPrecondition,
  SemanticPullRequestMutationEffect,
  SemanticPullRequestMutationPlan as GovernedSemanticPullRequestMutationPlan,
  SemanticPullRequestMutationViolation,
  SemanticPullRequestMutationRequestResult,
  SemanticPullRequestMutationPlanResult,
  SemanticPullRequestMutationDiagnostic,
  SemanticPullRequestMutationEvidence,
  SemanticPullRequestMutationResult,
  SemanticPullRequestMutationErrorCode,
  SemanticPullRequestMutationProvider,
  SemanticPullRequestMutationExecutionRequest,
  SemanticPullRequestMutationExecutionPort,
} from "./semantic-pr-mutation.js";
export * from "./semantic-issue-projection.js";
export * from "./semantic-issue-observation.js";
export * from "./semantic-issue-relations.js";
export * from "./issue-relationship.js";
export * from "./operational-observation.js";
export * from "./operational-discovery.js";
export * from "./semantic-issue-lifecycle.js";
export * from "./semantic-issue-closure.js";
export * from "./semantic-issue-closure-executor.js";
export * from "./semantic-branch-projection.js";
export * from "./semantic-branch-observation.js";
export * from "./semantic-pr-executor.js";
export * from "./semantic-issue-executor.js";
export * from "./semantic-issue-relation-executor.js";
export * from "./issue-relationship-executor.js";
export * from "./semantic-branch-executor.js";
export * from "./artifact-contract-governance.js";
export * from "./golden-path-governance.js";
export * from "./legacy-artifact-convergence.js";
export * from "./golden-path-status.js";
export * from "./golden-path-implementation.js";
export * from "./release-certification.js";
export * from "./release-preparation-plan.js";
export * from "./github/release-history-adapter.js";
export * from "./agent-authority/index.js";
export * from "./session-authorized-change-executor.js";
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
if (invokedPath === fileURLToPath(import.meta.url)) {
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
