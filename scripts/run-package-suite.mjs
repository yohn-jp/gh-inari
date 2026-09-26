#!/usr/bin/env node
// Package-content validation: confirms `npm pack` includes exactly the files
// package.json's "files" field promises (no more, no less), then delegates
// runtime verification to the standalone package certification against the
// installed tarball.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// This manifest must be updated whenever a source module is added or renamed.
// Suite failures are intentional until the manifest is maintained.
const EXPECTED_PACKED_FILES = [
  "LICENSE",
  "README.md",
  "package.json",
  "branch-naming-authority.d.mts",
  "branch-naming-authority.mjs",
  "scripts/certification-evidence.d.mts",
  "scripts/certification-evidence.mjs",
  ".codex-plugin/plugin.json",
  "skills/inari/SKILL.md",
  "dist/artifact.d.ts",
  "dist/artifact.js",
  "dist/artifact.js.map",
  "dist/artifact-contract-governance.d.ts",
  "dist/artifact-contract-governance.js",
  "dist/artifact-contract-governance.js.map",
  "dist/cli-core.d.ts",
  "dist/cli-core.js",
  "dist/cli-core.js.map",
  "dist/cli.d.ts",
  "dist/cli.js",
  "dist/cli.js.map",
  "dist/change.d.ts",
  "dist/change.js",
  "dist/change.js.map",
  "dist/branch-naming.d.ts",
  "dist/branch-naming.js",
  "dist/branch-naming.js.map",
  "dist/integration-routing.d.ts",
  "dist/integration-routing.js",
  "dist/integration-routing.js.map",
  "dist/integration-routing-adapters.d.ts",
  "dist/integration-routing-adapters.js",
  "dist/integration-routing-adapters.js.map",
  "dist/branch-creation-ruleset.d.ts",
  "dist/branch-creation-ruleset.js",
  "dist/branch-creation-ruleset.js.map",
  "dist/change-provenance-record.d.ts",
  "dist/change-provenance-record.js",
  "dist/change-provenance-record.js.map",
  "dist/change/machine/lifecycle-machine.d.ts",
  "dist/change/machine/lifecycle-machine.js",
  "dist/change/machine/lifecycle-machine.js.map",
  "dist/change/machine/abort-execution-machine.d.ts",
  "dist/change/machine/abort-execution-machine.js",
  "dist/change/machine/abort-execution-machine.js.map",
  "dist/change/machine/issuance-execution-machine.d.ts",
  "dist/change/machine/issuance-execution-machine.js",
  "dist/change/machine/issuance-execution-machine.js.map",
  "dist/change/machine/ready-execution-machine.d.ts",
  "dist/change/machine/ready-execution-machine.js",
  "dist/change/machine/ready-execution-machine.js.map",
  "dist/change/machine/trusted-execution-adapter.d.ts",
  "dist/change/machine/trusted-execution-adapter.js",
  "dist/change/machine/trusted-execution-adapter.js.map",
  "dist/change-execution-port.d.ts",
  "dist/change-execution-port.js",
  "dist/change-execution-port.js.map",
  "dist/change-executor.d.ts",
  "dist/change-executor.js",
  "dist/change-executor.js.map",
  "dist/change-handoff.d.ts",
  "dist/change-handoff.js",
  "dist/change-handoff.js.map",
  "dist/change-failure-diagnostics.d.ts",
  "dist/change-failure-diagnostics.js",
  "dist/change-failure-diagnostics.js.map",
  "dist/change-trusted-executor.d.ts",
  "dist/change-trusted-executor.js",
  "dist/change-trusted-executor.js.map",
  "dist/change-publish-projection.d.ts",
  "dist/change-publish-projection.js",
  "dist/change-publish-projection.js.map",
  "dist/authorized-execution.d.ts",
  "dist/authorized-execution.js",
  "dist/authorized-execution.js.map",
  "dist/session-authorized-change-executor.d.ts",
  "dist/session-authorized-change-executor.js",
  "dist/session-authorized-change-executor.js.map",
  "dist/semantic-pr-projection.d.ts",
  "dist/semantic-pr-projection.js",
  "dist/semantic-pr-projection.js.map",
  "dist/pr-publication.d.ts",
  "dist/pr-publication.js",
  "dist/pr-publication.js.map",
  "dist/release-pr-publication.d.ts",
  "dist/release-pr-publication.js",
  "dist/release-pr-publication.js.map",
  "dist/semantic-issue-projection.d.ts",
  "dist/semantic-issue-projection.js",
  "dist/semantic-issue-projection.js.map",
  "dist/semantic-issue-observation.d.ts",
  "dist/semantic-issue-observation.js",
  "dist/semantic-issue-observation.js.map",
  "dist/semantic-issue-lifecycle.d.ts",
  "dist/semantic-issue-lifecycle.js",
  "dist/semantic-issue-lifecycle.js.map",
  "dist/semantic-issue-closure.d.ts",
  "dist/semantic-issue-closure.js",
  "dist/semantic-issue-closure.js.map",
  "dist/semantic-issue-closure-executor.d.ts",
  "dist/semantic-issue-closure-executor.js",
  "dist/semantic-issue-closure-executor.js.map",
  "dist/semantic-branch-projection.d.ts",
  "dist/semantic-branch-projection.js",
  "dist/semantic-branch-projection.js.map",
  "dist/semantic-branch-observation.d.ts",
  "dist/semantic-branch-observation.js",
  "dist/semantic-branch-observation.js.map",
  "dist/semantic-pr-executor.d.ts",
  "dist/semantic-pr-executor.js",
  "dist/semantic-pr-executor.js.map",
  "dist/semantic-issue-executor.d.ts",
  "dist/semantic-issue-executor.js",
  "dist/semantic-issue-executor.js.map",
  "dist/semantic-issue-relation-executor.d.ts",
  "dist/semantic-issue-relation-executor.js",
  "dist/semantic-issue-relation-executor.js.map",
  "dist/semantic-issue-relations.d.ts",
  "dist/semantic-issue-relations.js",
  "dist/semantic-issue-relations.js.map",
  "dist/issue-relationship.d.ts",
  "dist/issue-relationship.js",
  "dist/issue-relationship.js.map",
  "dist/issue-relationship-executor.d.ts",
  "dist/issue-relationship-executor.js",
  "dist/issue-relationship-executor.js.map",
  "dist/semantic-branch-executor.d.ts",
  "dist/semantic-branch-executor.js",
  "dist/semantic-branch-executor.js.map",
  "dist/semantic-pr-observation.d.ts",
  "dist/semantic-pr-observation.js",
  "dist/semantic-pr-observation.js.map",
  "dist/operational-observation.d.ts",
  "dist/operational-observation.js",
  "dist/operational-observation.js.map",
  "dist/operational-discovery.d.ts",
  "dist/operational-discovery.js",
  "dist/operational-discovery.js.map",
  "dist/semantic-pr-mutation.d.ts",
  "dist/semantic-pr-mutation.js",
  "dist/semantic-pr-mutation.js.map",
  "dist/command-contract.d.ts",
  "dist/command-contract.js",
  "dist/command-contract.js.map",
  "dist/contract/artifact-contract.d.ts",
  "dist/contract/artifact-contract.js",
  "dist/contract/artifact-contract.js.map",
  "dist/contract/index.d.ts",
  "dist/contract/index.js",
  "dist/contract/index.js.map",
  "dist/contract/effective-artifact-contract.d.ts",
  "dist/contract/effective-artifact-contract.js",
  "dist/contract/effective-artifact-contract.js.map",
  "dist/contract/semantic-artifact.d.ts",
  "dist/contract/semantic-artifact.js",
  "dist/contract/semantic-artifact.js.map",
  "dist/contract/constraints.d.ts",
  "dist/contract/constraints.js",
  "dist/contract/constraints.js.map",
  "dist/contract/ir.d.ts",
  "dist/contract/ir.js",
  "dist/contract/ir.js.map",
  "dist/contract/issue-form.d.ts",
  "dist/contract/issue-form.js",
  "dist/contract/issue-form.js.map",
  "dist/contract/issue-reference.d.ts",
  "dist/contract/issue-reference.js",
  "dist/contract/issue-reference.js.map",
  "dist/contract/native-template-projection.d.ts",
  "dist/contract/native-template-projection.js",
  "dist/contract/native-template-projection.js.map",
  "dist/contract/normalization.d.ts",
  "dist/contract/normalization.js",
  "dist/contract/normalization.js.map",
  "dist/contract/schema.d.ts",
  "dist/contract/schema.js",
  "dist/contract/schema.js.map",
  "dist/contract/validation.d.ts",
  "dist/contract/validation.js",
  "dist/contract/validation.js.map",
  "dist/diagnostics.d.ts",
  "dist/diagnostics.js",
  "dist/diagnostics.js.map",
  "dist/implementation-contract.d.ts",
  "dist/implementation-contract.js",
  "dist/implementation-contract.js.map",
  "dist/implementation-authorization.d.ts",
  "dist/implementation-authorization.js",
  "dist/implementation-authorization.js.map",
  "dist/implementation-readiness.d.ts",
  "dist/implementation-readiness.js",
  "dist/implementation-readiness.js.map",
  "dist/implementation-execution-evidence.d.ts",
  "dist/implementation-execution-evidence.js",
  "dist/implementation-execution-evidence.js.map",
  "dist/implementation-scope-applicability.d.ts",
  "dist/implementation-scope-applicability.js",
  "dist/implementation-scope-applicability.js.map",
  "dist/implementation-scope-conformance.d.ts",
  "dist/implementation-scope-conformance.js",
  "dist/implementation-scope-conformance.js.map",
  "dist/implementation-scope-projection.d.ts",
  "dist/implementation-scope-projection.js",
  "dist/implementation-scope-projection.js.map",
  "dist/implementation-conformance.d.ts",
  "dist/implementation-conformance.js",
  "dist/implementation-conformance.js.map",
  "dist/implementation-lifecycle.d.ts",
  "dist/implementation-lifecycle.js",
  "dist/implementation-lifecycle.js.map",
  "dist/implementation-session-binding.d.ts",
  "dist/implementation-session-binding.js",
  "dist/implementation-session-binding.js.map",
  "dist/implementation-rework.d.ts",
  "dist/implementation-rework.js",
  "dist/implementation-rework.js.map",
  "dist/implementation-change-identity.d.ts",
  "dist/implementation-change-identity.js",
  "dist/implementation-change-identity.js.map",
  "dist/implementation-frontier.d.ts",
  "dist/implementation-frontier.js",
  "dist/implementation-frontier.js.map",
  "dist/implementation-frontier-composition.d.ts",
  "dist/implementation-frontier-composition.js",
  "dist/implementation-frontier-composition.js.map",
  "dist/github.d.ts",
  "dist/github.js",
  "dist/github.js.map",
  "dist/github/adapter.d.ts",
  "dist/github/adapter.js",
  "dist/github/adapter.js.map",
  "dist/github/adapter-core.d.ts",
  "dist/github/adapter-core.js",
  "dist/github/adapter-core.js.map",
  "dist/github/pr-publication-adapter.d.ts",
  "dist/github/pr-publication-adapter.js",
  "dist/github/pr-publication-adapter.js.map",
  "dist/github/pr-publication-provider.d.ts",
  "dist/github/pr-publication-provider.js",
  "dist/github/pr-publication-provider.js.map",
  "dist/github/gh-auth-credential.d.ts",
  "dist/github/gh-auth-credential.js",
  "dist/github/gh-auth-credential.js.map",
  "dist/github/capability.d.ts",
  "dist/github/capability.js",
  "dist/github/capability.js.map",
  "dist/github/change-actions-remote-executor.d.ts",
  "dist/github/change-actions-remote-executor.js",
  "dist/github/change-actions-remote-executor.js.map",
  "dist/github/change-effect-adapter.d.ts",
  "dist/github/change-effect-adapter.js",
  "dist/github/change-effect-adapter.js.map",
  "dist/github/actions-change-execution-adapter.d.ts",
  "dist/github/actions-change-execution-adapter.js",
  "dist/github/actions-change-execution-adapter.js.map",
  "dist/github/actions-change-executor.d.ts",
  "dist/github/actions-change-executor.js",
  "dist/github/actions-change-executor.js.map",
  "dist/github/errors.d.ts",
  "dist/github/errors.js",
  "dist/github/errors.js.map",
  "dist/github/provider-failure.d.ts",
  "dist/github/provider-failure.js",
  "dist/github/provider-failure.js.map",
  "dist/github/app-installation-credential-broker.d.ts",
  "dist/github/app-installation-credential-broker.js",
  "dist/github/app-installation-credential-broker.js.map",
  "dist/github/app-provider-credential-broker.d.ts",
  "dist/github/app-provider-credential-broker.js",
  "dist/github/app-provider-credential-broker.js.map",
  "dist/github/app-user-credential-broker.d.ts",
  "dist/github/app-user-credential-broker.js",
  "dist/github/app-user-credential-broker.js.map",
  "dist/github/endpoint-human-auth.d.ts",
  "dist/github/endpoint-human-auth.js",
  "dist/github/endpoint-human-auth.js.map",
  "dist/github/app-user-credential-store.d.ts",
  "dist/github/app-user-credential-store.js",
  "dist/github/app-user-credential-store.js.map",
  "dist/github/app-user-credential.d.ts",
  "dist/github/app-user-credential.js",
  "dist/github/app-user-credential.js.map",
  "dist/github/app-principal.d.ts",
  "dist/github/app-principal.js",
  "dist/github/app-principal.js.map",
  "dist/github/app-repository-evidence-reader.d.ts",
  "dist/github/app-repository-evidence-reader.js",
  "dist/github/app-repository-evidence-reader.js.map",
  "dist/github/app-semantic-pr-mutation.d.ts",
  "dist/github/app-semantic-pr-mutation.js",
  "dist/github/app-semantic-pr-mutation.js.map",
  "dist/github/change-state-projector.d.ts",
  "dist/github/change-state-projector.js",
  "dist/github/change-state-projector.js.map",
  "dist/github/direct-app-execution.d.ts",
  "dist/github/direct-app-execution.js",
  "dist/github/direct-app-execution.js.map",
  "dist/github/effect-authorizer.d.ts",
  "dist/github/effect-authorizer.js",
  "dist/github/effect-authorizer.js.map",
  "dist/github/git-data-capability.d.ts",
  "dist/github/git-data-capability.js",
  "dist/github/git-data-capability.js.map",
  "dist/github/issuer-authority.d.ts",
  "dist/github/issuer-authority.js",
  "dist/github/issuer-authority.js.map",
  "dist/github/index.d.ts",
  "dist/github/index.js",
  "dist/github/index.js.map",
  "dist/github/issue-relation-observation-adapter.d.ts",
  "dist/github/issue-relation-observation-adapter.js",
  "dist/github/issue-relation-observation-adapter.js.map",
  "dist/github/issue-relation-mutation-adapter.d.ts",
  "dist/github/issue-relation-mutation-adapter.js",
  "dist/github/issue-relation-mutation-adapter.js.map",
  "dist/github/repository-evidence-reader.d.ts",
  "dist/github/repository-evidence-reader.js",
  "dist/github/repository-evidence-reader.js.map",
  "dist/github/standalone-adapter.d.ts",
  "dist/github/standalone-adapter.js",
  "dist/github/standalone-adapter.js.map",
  "dist/github/runtime-authority-publication-capability.d.ts",
  "dist/github/runtime-authority-publication-capability.js",
  "dist/github/runtime-authority-publication-capability.js.map",
  "dist/github/local-repository-context.d.ts",
  "dist/github/local-repository-context.js",
  "dist/github/local-repository-context.js.map",
  "dist/github/native-http-transport.d.ts",
  "dist/github/native-http-transport.js",
  "dist/github/native-http-transport.js.map",
  "dist/github/types.d.ts",
  "dist/github/types.js",
  "dist/github/types.js.map",
  "dist/github/user-credential.d.ts",
  "dist/github/user-credential.js",
  "dist/github/user-credential.js.map",
  "dist/github/user-identity.d.ts",
  "dist/github/user-identity.js",
  "dist/github/user-identity.js.map",
  "dist/golden-path-entry.d.ts",
  "dist/golden-path-entry.js",
  "dist/golden-path-entry.js.map",
  "dist/golden-path-review.d.ts",
  "dist/golden-path-review.js",
  "dist/golden-path-review.js.map",
  "dist/golden-path-status.d.ts",
  "dist/golden-path-status.js",
  "dist/golden-path-status.js.map",
  "dist/golden-path-recovery.d.ts",
  "dist/golden-path-recovery.js",
  "dist/golden-path-recovery.js.map",
  "dist/golden-path-governance.d.ts",
  "dist/golden-path-governance.js",
  "dist/golden-path-governance.js.map",
  "dist/golden-path-implementation.d.ts",
  "dist/golden-path-implementation.js",
  "dist/golden-path-implementation.js.map",
  "dist/governance.d.ts",
  "dist/governance.js",
  "dist/governance.js.map",
  "dist/hosted-worker.d.ts",
  "dist/hosted-worker.js",
  "dist/hosted-worker.js.map",
  "dist/hosted-endpoint.d.ts",
  "dist/hosted-endpoint.js",
  "dist/hosted-endpoint.js.map",
  "dist/hosted-endpoint-presence-reader.d.ts",
  "dist/hosted-endpoint-presence-reader.js",
  "dist/hosted-endpoint-presence-reader.js.map",
  "dist/hosted-endpoint-work-reader.d.ts",
  "dist/hosted-endpoint-work-reader.js",
  "dist/hosted-endpoint-work-reader.js.map",
  "dist/hosted-endpoint-oauth.d.ts",
  "dist/hosted-endpoint-oauth.js",
  "dist/hosted-endpoint-oauth.js.map",
  "dist/endpoint-onboarding.d.ts",
  "dist/endpoint-onboarding.js",
  "dist/endpoint-onboarding.js.map",
  "dist/endpoint-onboarding-client.d.ts",
  "dist/endpoint-onboarding-client.js",
  "dist/endpoint-onboarding-client.js.map",
  "dist/endpoint-authorization.d.ts",
  "dist/endpoint-authorization.js",
  "dist/endpoint-authorization.js.map",
  "dist/endpoint-capability.d.ts",
  "dist/endpoint-capability.js",
  "dist/endpoint-capability.js.map",
  "dist/endpoint-reconciliation.d.ts",
  "dist/endpoint-reconciliation.js",
  "dist/endpoint-reconciliation.js.map",
  "dist/endpoint-work-projection.d.ts",
  "dist/endpoint-work-projection.js",
  "dist/endpoint-work-projection.js.map",
  "dist/endpoint-webhook.d.ts",
  "dist/endpoint-webhook.js",
  "dist/endpoint-webhook.js.map",
  "dist/endpoint-runtime-presence.d.ts",
  "dist/endpoint-runtime-presence.js",
  "dist/endpoint-runtime-presence.js.map",
  "dist/endpoint-read-query.d.ts",
  "dist/endpoint-read-query.js",
  "dist/endpoint-read-query.js.map",
  "dist/endpoint-api.d.ts",
  "dist/endpoint-api.js",
  "dist/endpoint-api.js.map",
  "dist/endpoint-http.d.ts",
  "dist/endpoint-http.js",
  "dist/endpoint-http.js.map",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/index.js.map",
  "dist/worker.d.ts",
  "dist/worker.js",
  "dist/worker.js.map",
  "dist/worker-http.d.ts",
  "dist/worker-http.js",
  "dist/worker-http.js.map",
  "dist/issuer-identity.d.ts",
  "dist/issuer-identity.js",
  "dist/issuer-identity.js.map",
  "dist/legacy-artifact-convergence.d.ts",
  "dist/legacy-artifact-convergence.js",
  "dist/legacy-artifact-convergence.js.map",
  "dist/markdown-ast.d.ts",
  "dist/markdown-ast.js",
  "dist/markdown-ast.js.map",
  "dist/agent-authority/index.d.ts",
  "dist/agent-authority/index.js",
  "dist/agent-authority/index.js.map",
  "dist/agent-authority/capability-admission.d.ts",
  "dist/agent-authority/capability-admission.js",
  "dist/agent-authority/capability-admission.js.map",
  "dist/agent-authority/branch-advance.d.ts",
  "dist/agent-authority/branch-advance.js",
  "dist/agent-authority/branch-advance.js.map",
  "dist/agent-authority/direct-app-http.d.ts",
  "dist/agent-authority/direct-app-http.js",
  "dist/agent-authority/direct-app-http.js.map",
  "dist/agent-authority/runtime-authority-publication-http.d.ts",
  "dist/agent-authority/runtime-authority-publication-http.js",
  "dist/agent-authority/runtime-authority-publication-http.js.map",
  "dist/agent-authority/direct-app-client.d.ts",
  "dist/agent-authority/direct-app-client.js",
  "dist/agent-authority/direct-app-client.js.map",
  "dist/agent-authority/capability-provenance.d.ts",
  "dist/agent-authority/capability-provenance.js",
  "dist/agent-authority/capability-provenance.js.map",
  "dist/agent-authority/codec.d.ts",
  "dist/agent-authority/codec.js",
  "dist/agent-authority/codec.js.map",
  "dist/agent-authority/ed25519-jwk.d.ts",
  "dist/agent-authority/ed25519-jwk.js",
  "dist/agent-authority/ed25519-jwk.js.map",
  "dist/agent-authority/capability.d.ts",
  "dist/agent-authority/capability.js",
  "dist/agent-authority/capability.js.map",
  "dist/agent-authority/protected-paths.d.ts",
  "dist/agent-authority/protected-paths.js",
  "dist/agent-authority/protected-paths.js.map",
  "dist/agent-authority/runtime-authority.d.ts",
  "dist/agent-authority/runtime-authority.js",
  "dist/agent-authority/runtime-authority.js.map",
  "dist/agent-authority/delegator.d.ts",
  "dist/agent-authority/delegator.js",
  "dist/agent-authority/delegator.js.map",
  "dist/agent-authority/runtime-authority-trust.d.ts",
  "dist/agent-authority/runtime-authority-trust.js",
  "dist/agent-authority/runtime-authority-trust.js.map",
  "dist/agent-authority/delegator-trust.d.ts",
  "dist/agent-authority/delegator-trust.js",
  "dist/agent-authority/delegator-trust.js.map",
  "dist/agent-authority/runtime-authority-lifecycle.d.ts",
  "dist/agent-authority/runtime-authority-lifecycle.js",
  "dist/agent-authority/runtime-authority-lifecycle.js.map",
  "dist/agent-authority/delegator-lifecycle.d.ts",
  "dist/agent-authority/delegator-lifecycle.js",
  "dist/agent-authority/delegator-lifecycle.js.map",
  "dist/agent-authority/runtime-authority-operations.d.ts",
  "dist/agent-authority/runtime-authority-operations.js",
  "dist/agent-authority/runtime-authority-operations.js.map",
  "dist/agent-authority/delegator-operations.d.ts",
  "dist/agent-authority/delegator-operations.js",
  "dist/agent-authority/delegator-operations.js.map",
  "dist/agent-authority/runtime-key.d.ts",
  "dist/agent-authority/runtime-key.js",
  "dist/agent-authority/runtime-key.js.map",
  "dist/agent-authority/delegator-key.d.ts",
  "dist/agent-authority/delegator-key.js",
  "dist/agent-authority/delegator-key.js.map",
  "dist/agent-authority/session-certificate.d.ts",
  "dist/agent-authority/session-certificate.js",
  "dist/agent-authority/session-certificate.js.map",
  "dist/agent-authority/session-issuance.d.ts",
  "dist/agent-authority/session-issuance.js",
  "dist/agent-authority/session-issuance.js.map",
  "dist/agent-authority/managed-runtime.d.ts",
  "dist/agent-authority/managed-runtime.js",
  "dist/agent-authority/managed-runtime.js.map",
  "dist/agent-authority/session-request.d.ts",
  "dist/agent-authority/session-request.js",
  "dist/agent-authority/session-request.js.map",
  "dist/agent-authority/session-signer.d.ts",
  "dist/agent-authority/session-signer.js",
  "dist/agent-authority/session-signer.js.map",
  "dist/agent-authority/session-bundle.d.ts",
  "dist/agent-authority/session-bundle.js",
  "dist/agent-authority/session-bundle.js.map",
  "dist/agent-authority/session-bundle-signer.d.ts",
  "dist/agent-authority/session-bundle-signer.js",
  "dist/agent-authority/session-bundle-signer.js.map",
  "dist/agent-authority/session-authentication.d.ts",
  "dist/agent-authority/session-authentication.js",
  "dist/agent-authority/session-authentication.js.map",
  "dist/mcp/http-transport.d.ts",
  "dist/mcp/http-transport.js",
  "dist/mcp/http-transport.js.map",
  "dist/mcp/apps/inari-app.d.ts",
  "dist/mcp/apps/inari-app.js",
  "dist/mcp/apps/inari-app.js.map",
  "dist/mcp/index.d.ts",
  "dist/mcp/index.js",
  "dist/mcp/index.js.map",
  "dist/mcp/relay-session-executor.d.ts",
  "dist/mcp/relay-session-executor.js",
  "dist/mcp/relay-session-executor.js.map",
  "dist/mcp/server.d.ts",
  "dist/mcp/server.js",
  "dist/mcp/server.js.map",
  "dist/mcp/session-app-bridge.d.ts",
  "dist/mcp/session-app-bridge.js",
  "dist/mcp/session-app-bridge.js.map",
  "dist/mcp/session-client.d.ts",
  "dist/mcp/session-client.js",
  "dist/mcp/session-client.js.map",
  "dist/mcp/stdio.d.ts",
  "dist/mcp/stdio.js",
  "dist/mcp/stdio.js.map",
  "dist/mcp/tools.d.ts",
  "dist/mcp/tools.js",
  "dist/mcp/tools.js.map",
  "dist/pr-policy.d.ts",
  "dist/pr-policy.js",
  "dist/pr-policy.js.map",
  "dist/repository-branch-policy.d.ts",
  "dist/repository-branch-policy.js",
  "dist/repository-branch-policy.js.map",
  "dist/pr-sync-input.d.ts",
  "dist/pr-sync-input.js",
  "dist/pr-sync-input.js.map",
  "dist/pull-request-template.d.ts",
  "dist/pull-request-template.js",
  "dist/pull-request-template.js.map",
  "dist/reconciliation.d.ts",
  "dist/reconciliation.js",
  "dist/reconciliation.js.map",
  "dist/relay/contract.d.ts",
  "dist/relay/contract.js",
  "dist/relay/contract.js.map",
  "dist/relay/connection-proof.d.ts",
  "dist/relay/connection-proof.js",
  "dist/relay/connection-proof.js.map",
  "dist/relay/delivery-state.d.ts",
  "dist/relay/delivery-state.js",
  "dist/relay/delivery-state.js.map",
  "dist/relay/telemetry.d.ts",
  "dist/relay/telemetry.js",
  "dist/relay/telemetry.js.map",
  "dist/relay/local-runtime-config.d.ts",
  "dist/relay/local-runtime-config.js",
  "dist/relay/local-runtime-config.js.map",
  "dist/relay/local-runtime-config-credentials.d.ts",
  "dist/relay/local-runtime-config-credentials.js",
  "dist/relay/local-runtime-config-credentials.js.map",
  "dist/relay/local-runtime.d.ts",
  "dist/relay/local-runtime.js",
  "dist/relay/local-runtime.js.map",
  "dist/local-application-state.d.ts",
  "dist/local-application-state.js",
  "dist/local-application-state.js.map",
  "dist/local-application-state-terminal.d.ts",
  "dist/local-application-state-terminal.js",
  "dist/local-application-state-terminal.js.map",
  "dist/local-control/config.d.ts",
  "dist/local-control/config.js",
  "dist/local-control/config.js.map",
  "dist/local-control/console-server.d.ts",
  "dist/local-control/console-server.js",
  "dist/local-control/console-server.js.map",
  "dist/local-control/transport-security.d.ts",
  "dist/local-control/transport-security.js",
  "dist/local-control/transport-security.js.map",
  "dist/admission/authorization.d.ts",
  "dist/admission/authorization.js",
  "dist/admission/authorization.js.map",
  "dist/admission/server.d.ts",
  "dist/admission/server.js",
  "dist/admission/server.js.map",
  "dist/admission/setup.d.ts",
  "dist/admission/setup.js",
  "dist/admission/setup.js.map",
  "dist/local-control/admission-server.d.ts",
  "dist/local-control/admission-server.js",
  "dist/local-control/admission-server.js.map",
  "dist/local-control/admission-client.d.ts",
  "dist/local-control/admission-client.js",
  "dist/local-control/admission-client.js.map",
  "dist/local-control/execution-intent.d.ts",
  "dist/local-control/execution-intent.js",
  "dist/local-control/execution-intent.js.map",
  "dist/local-control/executor-client.d.ts",
  "dist/local-control/executor-client.js",
  "dist/local-control/executor-client.js.map",
  "dist/local-control/executor-http.d.ts",
  "dist/local-control/executor-http.js",
  "dist/local-control/executor-http.js.map",
  "dist/local-control/executor-server.d.ts",
  "dist/local-control/executor-server.js",
  "dist/local-control/executor-server.js.map",
  "dist/executor/errors.d.ts",
  "dist/executor/errors.js",
  "dist/executor/errors.js.map",
  "dist/executor/credential-store.d.ts",
  "dist/executor/credential-store.js",
  "dist/executor/credential-store.js.map",
  "dist/executor/execution.d.ts",
  "dist/executor/execution.js",
  "dist/executor/execution.js.map",
  "dist/executor/issuer-input.d.ts",
  "dist/executor/issuer-input.js",
  "dist/executor/issuer-input.js.map",
  "dist/executor/enrollment/owner.d.ts",
  "dist/executor/enrollment/owner.js",
  "dist/executor/enrollment/owner.js.map",
  "dist/executor/enrollment/issuer-reference.d.ts",
  "dist/executor/enrollment/issuer-reference.js",
  "dist/executor/enrollment/issuer-reference.js.map",
  "dist/executor/enrollment/server.d.ts",
  "dist/executor/enrollment/server.js",
  "dist/executor/enrollment/server.js.map",
  "dist/executor/server.d.ts",
  "dist/executor/server.js",
  "dist/executor/server.js.map",
  "dist/executor/setup.d.ts",
  "dist/executor/setup.js",
  "dist/executor/setup.js.map",
  "dist/local-control/identity.d.ts",
  "dist/local-control/identity.js",
  "dist/local-control/identity.js.map",
  "dist/local-control/runtime-discovery.d.ts",
  "dist/local-control/runtime-discovery.js",
  "dist/local-control/runtime-discovery.js.map",
  "dist/local-control/runtime-log.d.ts",
  "dist/local-control/runtime-log.js",
  "dist/local-control/runtime-log.js.map",
  "dist/local-control/session-binding.d.ts",
  "dist/local-control/session-binding.js",
  "dist/local-control/session-binding.js.map",
  "dist/local-control/session-store.d.ts",
  "dist/local-control/session-store.js",
  "dist/local-control/session-store.js.map",
  "dist/local-control/session-launcher.d.ts",
  "dist/local-control/session-launcher.js",
  "dist/local-control/session-launcher.js.map",
  "dist/composition/local-runtime-roles.d.ts",
  "dist/composition/local-runtime-roles.js",
  "dist/composition/local-runtime-roles.js.map",
  "dist/composition/setup-adapters.d.ts",
  "dist/composition/setup-adapters.js",
  "dist/composition/setup-adapters.js.map",
  "dist/composition/setup-config-store.d.ts",
  "dist/composition/setup-config-store.js",
  "dist/composition/setup-config-store.js.map",
  "dist/composition/setup-journal-store.d.ts",
  "dist/composition/setup-journal-store.js",
  "dist/composition/setup-journal-store.js.map",
  "dist/composition/setup-observation.d.ts",
  "dist/composition/setup-observation.js",
  "dist/composition/setup-observation.js.map",
  "dist/composition/setup-host.d.ts",
  "dist/composition/setup-host.js",
  "dist/composition/setup-host.js.map",
  "dist/setup-console/index.html",
  "dist/setup-console/setup-console.js",
  "dist/setup-console/styles.css",
  "dist/authority/index.d.ts",
  "dist/authority/index.js",
  "dist/authority/index.js.map",
  "dist/authority/local-migration.d.ts",
  "dist/authority/local-migration.js",
  "dist/authority/local-migration.js.map",
  "dist/authority/local-runtime-authority.d.ts",
  "dist/authority/local-runtime-authority.js",
  "dist/authority/local-runtime-authority.js.map",
  "dist/authority/setup-trust.d.ts",
  "dist/authority/setup-trust.js",
  "dist/authority/setup-trust.js.map",
  "dist/cli/setup/index.d.ts",
  "dist/cli/setup/index.js",
  "dist/cli/setup/index.js.map",
  "dist/cli/runtime/admission-client.d.ts",
  "dist/cli/runtime/admission-client.js",
  "dist/cli/runtime/admission-client.js.map",
  "dist/cli/runtime/role-status.d.ts",
  "dist/cli/runtime/role-status.js",
  "dist/cli/runtime/role-status.js.map",
  "dist/cli/runtime/session-launcher.d.ts",
  "dist/cli/runtime/session-launcher.js",
  "dist/cli/runtime/session-launcher.js.map",
  "dist/cli/runtime/branch-observation.d.ts",
  "dist/cli/runtime/branch-observation.js",
  "dist/cli/runtime/branch-observation.js.map",
  "dist/local-control/status-page.d.ts",
  "dist/local-control/status-page.js",
  "dist/local-control/status-page.js.map",
  "dist/local-control/supervisor.d.ts",
  "dist/local-control/supervisor.js",
  "dist/local-control/supervisor.js.map",
  "dist/local-runtime-profile.d.ts",
  "dist/local-runtime-profile.js",
  "dist/local-runtime-profile.js.map",
  "dist/repository-setup.d.ts",
  "dist/repository-setup.js",
  "dist/repository-setup.js.map",
  "dist/runtime-authority-publication.d.ts",
  "dist/runtime-authority-publication.js",
  "dist/runtime-authority-publication.js.map",
  "dist/runtime-contracts/command.d.ts",
  "dist/runtime-contracts/command.js",
  "dist/runtime-contracts/command.js.map",
  "dist/runtime-contracts/components.d.ts",
  "dist/runtime-contracts/components.js",
  "dist/runtime-contracts/components.js.map",
  "dist/runtime-contracts/enrollment.d.ts",
  "dist/runtime-contracts/enrollment.js",
  "dist/runtime-contracts/enrollment.js.map",
  "dist/runtime-contracts/errors.d.ts",
  "dist/runtime-contracts/errors.js",
  "dist/runtime-contracts/errors.js.map",
  "dist/runtime-contracts/index.d.ts",
  "dist/runtime-contracts/index.js",
  "dist/runtime-contracts/index.js.map",
  "dist/runtime-contracts/ports.d.ts",
  "dist/runtime-contracts/ports.js",
  "dist/runtime-contracts/ports.js.map",
  "dist/runtime-contracts/runtime-failure.d.ts",
  "dist/runtime-contracts/runtime-failure.js",
  "dist/runtime-contracts/runtime-failure.js.map",
  "dist/runtime-contracts/secret-material.d.ts",
  "dist/runtime-contracts/secret-material.js",
  "dist/runtime-contracts/secret-material.js.map",
  "dist/runtime-contracts/setup.d.ts",
  "dist/runtime-contracts/setup.js",
  "dist/runtime-contracts/setup.js.map",
  "dist/runtime-contracts/setup-primitives.d.ts",
  "dist/runtime-contracts/setup-primitives.js",
  "dist/runtime-contracts/setup-primitives.js.map",
  "dist/application/setup/actions.d.ts",
  "dist/application/setup/actions.js",
  "dist/application/setup/actions.js.map",
  "dist/application/setup/index.d.ts",
  "dist/application/setup/index.js",
  "dist/application/setup/index.js.map",
  "dist/application/setup/state.d.ts",
  "dist/application/setup/state.js",
  "dist/application/setup/state.js.map",
  "dist/console/api.d.ts",
  "dist/console/api.js",
  "dist/console/api.js.map",
  "dist/console/operator-session.d.ts",
  "dist/console/operator-session.js",
  "dist/console/operator-session.js.map",
  "dist/console/enrollment-forwarder.d.ts",
  "dist/console/enrollment-forwarder.js",
  "dist/console/enrollment-forwarder.js.map",
  "dist/console/public-assets.d.ts",
  "dist/console/public-assets.js",
  "dist/console/public-assets.js.map",
  "dist/release-certification.d.ts",
  "dist/release-certification.js",
  "dist/release-certification.js.map",
  "dist/release-preparation-plan.d.ts",
  "dist/release-preparation-plan.js",
  "dist/release-preparation-plan.js.map",
  "dist/release-preparation.d.ts",
  "dist/release-preparation.js",
  "dist/release-preparation.js.map",
  "dist/github/release-history-adapter.d.ts",
  "dist/github/release-history-adapter.js",
  "dist/github/release-history-adapter.js.map",
  "dist/release-history-governance.d.ts",
  "dist/release-history-governance.js",
  "dist/release-history-governance.js.map",
  "dist/self-dogfood-marker.d.ts",
  "dist/self-dogfood-marker.js",
  "dist/self-dogfood-marker.js.map",
  "dist/semantic-template.d.ts",
  "dist/semantic-template.js",
  "dist/semantic-template.js.map",
  "dist/skill.d.ts",
  "dist/skill.js",
  "dist/skill.js.map",
  "dist/template-discovery.d.ts",
  "dist/template-discovery.js",
  "dist/template-discovery.js.map",
  "dist/template-resolver.d.ts",
  "dist/template-resolver.js",
  "dist/template-resolver.js.map",
];

const CODEX_MARKETPLACE_NAME = "gh-inari";
const CODEX_PLUGIN_NAME = "inari";
const CODEX_PLUGIN_SKILL_PATH = "skills/inari";
const NPM_REGISTRY = "https://registry.npmjs.org";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  return result;
}

// Walks every shape the "exports" map can take: a direct string target, an
// array of fallback targets, or a conditions object whose values may
// themselves be any of these (nested conditions such as node/import/require).
function collectExportsTargets(value, targets) {
  if (typeof value === "string") {
    targets.push(value.replace(/^\.\//u, ""));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectExportsTargets(entry, targets);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) collectExportsTargets(entry, targets);
  }
}

export function exportsTargetPaths(packageJson) {
  const targets = [];
  collectExportsTargets(packageJson.exports, targets);
  return targets;
}

export function validateCodexPluginMetadata(packageJson, manifest, marketplace) {
  if (packageJson.name !== "gh-inari") {
    throw new Error(`package.json name must be "gh-inari", got "${packageJson.name}"`);
  }
  if (manifest.name !== CODEX_PLUGIN_NAME) {
    throw new Error(`.codex-plugin/plugin.json name must be "${CODEX_PLUGIN_NAME}", got "${manifest.name}"`);
  }
  if (manifest.version !== packageJson.version) {
    throw new Error(
      `.codex-plugin/plugin.json version "${manifest.version}" does not match package.json version "${packageJson.version}"`,
    );
  }
  if (manifest.skills !== CODEX_PLUGIN_SKILL_PATH) {
    throw new Error(
      `.codex-plugin/plugin.json skills path must be "${CODEX_PLUGIN_SKILL_PATH}", got "${manifest.skills}"`,
    );
  }

  if (marketplace.name !== CODEX_MARKETPLACE_NAME) {
    throw new Error(`marketplace name must be "${CODEX_MARKETPLACE_NAME}", got "${marketplace.name}"`);
  }
  if (marketplace.interface?.displayName !== "Inari") {
    throw new Error('marketplace interface.displayName must be "Inari"');
  }
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) {
    throw new Error("marketplace must contain exactly one plugin entry");
  }

  const [plugin] = marketplace.plugins;
  if (plugin.name !== manifest.name) {
    throw new Error(`marketplace plugin name "${plugin.name}" does not match manifest name "${manifest.name}"`);
  }
  if (plugin.source?.source !== "npm") {
    throw new Error('marketplace plugin source.source must be "npm"');
  }
  if (plugin.source.package !== packageJson.name) {
    throw new Error(
      `marketplace npm package "${plugin.source.package}" does not match package.json name "${packageJson.name}"`,
    );
  }
  if (plugin.source.version !== `^${packageJson.version}`) {
    throw new Error(
      `marketplace npm version "${plugin.source.version}" must explicitly target compatible ${packageJson.version} releases`,
    );
  }
  if (plugin.source.registry !== NPM_REGISTRY) {
    throw new Error(`marketplace npm registry must be "${NPM_REGISTRY}"`);
  }
  if (plugin.policy?.installation !== "AVAILABLE") {
    throw new Error('marketplace policy.installation must be "AVAILABLE"');
  }
  if (plugin.policy?.authentication !== "ON_INSTALL") {
    throw new Error('marketplace policy.authentication must be "ON_INSTALL"');
  }
  if (typeof plugin.category !== "string" || plugin.category.length === 0) {
    throw new Error("marketplace plugin category must be a non-empty string");
  }
}

// Validates the repo marketplace -> npm package -> Codex Plugin manifest ->
// Skill distribution contract, confirms the declared Skill path resolves
// inside the package and is included in the packed tarball, and confirms the
// Skill routes to `inari skill` rather than duplicating playbooks. The actual
// Skill command is exercised by the installed packed artifact certification;
// this package-content check must not execute a checkout-local distribution.
export async function validateCodexPlugin(packageJson, packedFiles) {
  const manifestPath = path.join(repoRoot, ".codex-plugin", "plugin.json");
  if (!fs.existsSync(manifestPath)) throw new Error(".codex-plugin/plugin.json is missing");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const marketplacePath = path.join(repoRoot, ".agents", "plugins", "marketplace.json");
  if (!fs.existsSync(marketplacePath)) throw new Error(".agents/plugins/marketplace.json is missing");
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
  validateCodexPluginMetadata(packageJson, manifest, marketplace);

  const skillPath = manifest.skills;
  const skillFile = path.join(repoRoot, skillPath, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    throw new Error(`Codex plugin skill path "${skillPath}" does not resolve to a SKILL.md`);
  }
  const skillPackedPath = path.relative(repoRoot, skillFile).split(path.sep).join("/");
  if (!packedFiles.includes(skillPackedPath)) {
    throw new Error(`"${skillPackedPath}" is declared by the plugin manifest but not packed in the tarball`);
  }

  const body = fs.readFileSync(skillFile, "utf8");
  if (!body.includes("inari skill")) {
    throw new Error(`${skillPath}/SKILL.md must route agents to \`inari skill\` instead of duplicating playbooks`);
  }
  // Scenario routing is certified by the installed artifact harness below.
}

// Installs the packed artifact outside the checkout and starts the installed
// `inari setup console`: the host must serve exactly the packaged console
// assets from beside its own installed module and deliver a same-origin
// bootstrap, with no source-checkout path involved.
async function certifyInstalledSetupConsole(tarballPath, packageName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gh-inari-setup-console-"));
  let child;
  try {
    const consumer = path.join(root, "consumer");
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true }));
    run(
      "npm",
      [
        "install",
        "--no-save",
        "--no-package-lock",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--omit=dev",
        tarballPath,
      ],
      { cwd: consumer },
    );
    const installed = fs.realpathSync(path.join(consumer, "node_modules", ...packageName.split("/")));
    if (!path.relative(repoRoot, installed).startsWith(".."))
      throw new Error("installed package resolved inside the checkout");
    const environment = { ...process.env, INARI_CONFIG_HOME: path.join(root, "config") };
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) delete environment[name];
    child = spawn(
      process.execPath,
      [
        path.join(installed, "dist", "index.js"),
        "setup",
        "console",
        "--json",
        "--repository",
        "example/setup",
        "--repository-id",
        "1",
      ],
      { cwd: consumer, env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const started = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`installed setup console did not start: ${stdout}${stderr}`)),
        20_000,
      );
      child.stdout.on("data", () => {
        if (!stdout.includes("\n")) return;
        clearTimeout(timer);
        resolve(JSON.parse(stdout.split("\n")[0]));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`installed setup console exited ${code}: ${stdout}${stderr}`));
      });
    });
    if (started.operation !== "setup.console" || started.reused !== false)
      throw new Error("installed setup console did not start an owned host");
    for (const [route, file] of [
      ["/", "index.html"],
      ["/setup-console.js", "setup-console.js"],
      ["/styles.css", "styles.css"],
    ]) {
      const response = await fetch(`${started.endpoint}${route}`);
      const served = Buffer.from(await response.arrayBuffer());
      const packaged = fs.readFileSync(path.join(installed, "dist", "setup-console", file));
      if (response.status !== 200 || !served.equals(packaged))
        throw new Error(`installed setup console did not serve the packaged ${file}`);
    }
    const bootstrap = await fetch(`${started.endpoint}/api/setup/bootstrap`, {
      method: "POST",
      headers: { origin: started.endpoint, "x-inari-setup-bootstrap": "1" },
    });
    if (bootstrap.status !== 200) throw new Error("installed setup console refused a same-origin bootstrap");
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    child.kill("SIGTERM");
    const exit = await exited;
    if (exit.code !== 0 && exit.signal !== "SIGTERM")
      throw new Error(`installed setup console shutdown exited ${exit.code}`);
    if (fs.existsSync(path.join(root, "config", "runtime", "endpoints", "setup.json")))
      throw new Error("installed setup console left its discovery announcement after shutdown");
    console.log("installed setup console verified: packaged assets served from the installed package, owned shutdown");
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const distEntry = path.join(repoRoot, "dist", "index.js");
  if (!fs.existsSync(distEntry)) throw new Error("dist is missing; run pnpm run build before the package suite");

  for (const file of ["index.html", "setup-console.js", "styles.css"]) {
    if (!fs.existsSync(path.join(repoRoot, "dist", "setup-console", file))) {
      throw new Error(`Setup console build output is missing dist/setup-console/${file}`);
    }
  }

  const dashboardDist = path.join(repoRoot, "apps/dashboard", "dist");
  for (const file of ["index.html", "browser.js"]) {
    if (!fs.existsSync(path.join(dashboardDist, file))) {
      throw new Error(`Dashboard build output is missing apps/dashboard/dist/${file}`);
    }
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

  const packResult = run("npm", ["pack", "--json", "--ignore-scripts"]);
  const parsedPackInfo = JSON.parse(packResult.stdout);
  const packInfo = Array.isArray(parsedPackInfo)
    ? parsedPackInfo[0]
    : (parsedPackInfo[packageJson.name] ?? parsedPackInfo);
  if (typeof packInfo?.filename !== "string") throw new Error("npm pack did not return an artifact filename");

  const tarballPath = path.resolve(repoRoot, packInfo.filename);
  if (!tarballPath.endsWith(".tgz") || !fs.statSync(tarballPath).isFile()) {
    throw new Error("npm pack did not produce a tarball");
  }

  try {
    const packedFiles = packInfo.files.map((entry) => entry.path);
    const dashboardFiles = packedFiles.filter(
      (entry) => entry === "apps/dashboard" || entry.startsWith("apps/dashboard/"),
    );
    if (dashboardFiles.length > 0) {
      throw new Error(`Dashboard application files must not be published in gh-inari: ${dashboardFiles.join(", ")}`);
    }
    const expected = [...EXPECTED_PACKED_FILES].sort();
    const actual = [...packedFiles].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`packed file set mismatch:\nexpected:\n${expected.join("\n")}\nactual:\n${actual.join("\n")}`);
    }

    // Every "exports" map target must ship inside the packed tarball: an entry
    // pointing at a file the manifest doesn't carry would break consumers at
    // resolution time even though package-content checks pass.
    const exportTargets = exportsTargetPaths(packageJson);
    if (exportTargets.length === 0) throw new Error('package.json "exports" map is empty or missing');
    for (const target of exportTargets) {
      if (!packedFiles.includes(target)) {
        throw new Error(`exports map target "${target}" is not included in the packed tarball`);
      }
      if (!fs.existsSync(path.join(repoRoot, target))) {
        throw new Error(`exports map target "${target}" does not exist in the built dist output`);
      }
    }

    const executableBinPaths = Object.values(packageJson.bin ?? {});
    for (const binPath of executableBinPaths) {
      if (!packedFiles.includes(binPath)) {
        throw new Error(`bin entry "${binPath}" is not included in the packed tarball`);
      }
      const stat = fs.statSync(path.join(repoRoot, binPath));
      const isExecutableByOwner = (stat.mode & 0o100) !== 0;
      if (!isExecutableByOwner) {
        throw new Error(`bin entry "${binPath}" is not executable (chmod +x it, or check build step file perms)`);
      }
    }

    await validateCodexPlugin(packageJson, packedFiles);

    console.log(
      `package contents verified: ${packedFiles.length} file(s), ${exportTargets.length} export target(s), all bin targets present and executable; delegating the same packed artifact to runtime certification.`,
    );

    run(process.execPath, ["scripts/package-runtime-certification.mjs", "--tarball", tarballPath], {
      stdio: "inherit",
    });
    await certifyInstalledSetupConsole(tarballPath, packageJson.name);
    run(process.execPath, ["scripts/release-preparation-certification.mjs"], { stdio: "inherit" });
    run(process.execPath, ["scripts/endpoint-dashboard-certification.mjs"], { stdio: "inherit" });
  } finally {
    fs.rmSync(tarballPath, { force: true });
  }
}

if (process.argv[1]?.endsWith("run-package-suite.mjs")) main();
