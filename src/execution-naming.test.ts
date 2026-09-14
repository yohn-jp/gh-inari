import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
  ChangeExecutionPortError,
  changeMutationRequest,
  createUnavailableChangeExecutionPort,
} from "./change-execution-port.js";
import * as legacyPort from "./change-executor.js";
import {
  ActionsChangeExecutionAdapter,
  createActionsChangeExecutionAdapter,
} from "./github/actions-change-execution-adapter.js";
import * as legacyAdapter from "./github/change-actions-remote-executor.js";
import { createDirectAppChangeExecutionAdapter } from "./agent-authority/direct-app-client.js";
import * as directAppClient from "./agent-authority/direct-app-client.js";
import { LocalSemanticBranchExecutor, SemanticBranchExecutor } from "./semantic-branch-executor.js";
import { LocalSemanticIssueExecutor, SemanticIssueExecutor } from "./semantic-issue-executor.js";
import { LocalSemanticPullRequestExecutor, SemanticPullRequestExecutor } from "./semantic-pr-executor.js";
import {
  LocalSemanticIssueRelationExecutor,
  SemanticIssueRelationExecutor,
} from "./semantic-issue-relation-executor.js";
import {
  LocalSemanticPullRequestMutationExecutor,
  SemanticPullRequestMutationExecutor,
} from "./semantic-pr-mutation.js";

test("canonical Change execution port owns the legacy contract aliases", () => {
  assert.equal(legacyPort.CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION, CHANGE_EXECUTION_PORT_CONTRACT_VERSION);
  assert.equal(legacyPort.ChangeRemoteExecutorError, ChangeExecutionPortError);
  assert.equal(legacyPort.changeRemoteMutationRequest, changeMutationRequest);
  assert.equal(legacyPort.createUnavailableChangeRemoteExecutor, createUnavailableChangeExecutionPort);
});

test("Actions and Direct-App compatibility names resolve to transport adapters", () => {
  assert.equal(legacyAdapter.GitHubActionsChangeRemoteExecutor, ActionsChangeExecutionAdapter);
  assert.equal(legacyAdapter.createGitHubActionsChangeRemoteExecutor, createActionsChangeExecutionAdapter);
  assert.equal(directAppClient.createDirectAppChangeRemoteExecutor, createDirectAppChangeExecutionAdapter);
});

test("semantic artifact executors expose profile-qualified canonical constructors", () => {
  assert.equal(SemanticIssueExecutor, LocalSemanticIssueExecutor);
  assert.equal(SemanticBranchExecutor, LocalSemanticBranchExecutor);
  assert.equal(SemanticPullRequestExecutor, LocalSemanticPullRequestExecutor);
  assert.equal(SemanticIssueRelationExecutor, LocalSemanticIssueRelationExecutor);
  assert.equal(SemanticPullRequestMutationExecutor, LocalSemanticPullRequestMutationExecutor);
});
