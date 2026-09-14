/**
 * Public trusted Change execution boundary.
 *
 * The operation machines and their transport/Core adapter live in the
 * internal machine module. This class intentionally only binds that adapter
 * to the stable ChangeExecutionPort contract.
 */

import type {
  ChangeExecutionResult,
  ChangeExecutionPort,
  ChangeMutationRequest,
  ChangeReadRequest,
} from "./change-execution-port.js";
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

export class TrustedChangeExecutor implements ChangeExecutionPort {
  readonly #adapter: TrustedChangeExecutionAdapter;

  constructor(options: ChangeTrustedExecutorOptions) {
    this.#adapter = new TrustedChangeExecutionAdapter(options);
  }

  read(request: ChangeReadRequest): Promise<ChangeExecutionResult["projection"]> {
    return this.#adapter.read(request);
  }

  execute(request: ChangeMutationRequest): Promise<ChangeExecutionResult> {
    return this.#adapter.execute(request);
  }
}

export const GitHubActionsChangeExecutor = TrustedChangeExecutor;
