/**
 * Public trusted Change execution boundary.
 *
 * The operation machines and their transport/Core adapter live in the
 * internal machine module. This class intentionally only binds that adapter
 * to the stable ChangeRemoteExecutor contract.
 */

import type {
  ChangeRemoteExecutionResult,
  ChangeRemoteExecutor,
  ChangeRemoteMutationRequest,
  ChangeRemoteReadRequest,
} from "./change-executor.js";
import {
  TrustedChangeExecutionAdapter,
  type ChangeTrustedExecutorOptions,
} from "./change/machine/trusted-execution-adapter.js";

export {
  CHANGE_TRUSTED_EXECUTOR_ERROR_CODES,
  ChangeTrustedExecutorError,
  isChangeTrustedExecutorErrorCode,
} from "./change/machine/trusted-execution-adapter.js";
export type {
  ChangeTrustedExecutorErrorCode,
  ChangeTrustedEvidenceReader,
  ChangeTrustedExecutorOptions,
} from "./change/machine/trusted-execution-adapter.js";

export class TrustedChangeExecutor implements ChangeRemoteExecutor {
  readonly #adapter: TrustedChangeExecutionAdapter;

  constructor(options: ChangeTrustedExecutorOptions) {
    this.#adapter = new TrustedChangeExecutionAdapter(options);
  }

  read(request: ChangeRemoteReadRequest): Promise<ChangeRemoteExecutionResult["projection"]> {
    return this.#adapter.read(request);
  }

  execute(request: ChangeRemoteMutationRequest): Promise<ChangeRemoteExecutionResult> {
    return this.#adapter.execute(request);
  }
}

export const GitHubActionsChangeExecutor = TrustedChangeExecutor;
