// Bounded compatibility facade (#1106). The Executor implementation lives in
// `src/executor/`: `setup.ts` and `server.ts` are the public role entries,
// `execution.ts` and `issuer-input.ts` are private. Existing callers keep this
// path until #1109 wires the composition; it grants no frontend access to the
// private implementation.
export {
  LOCAL_EXECUTOR_CREDENTIAL_PROFILE,
  LOCAL_EXECUTOR_DEFAULT_PORT,
  LocalExecutorError,
  localExecutorAppId,
  localExecutorIssuerKeyStatus,
  setupLocalExecutor,
  type LocalExecutorIssuerKeyStatus,
  type LocalExecutorSetupResult,
} from "../executor/setup.js";
export {
  LOCAL_EXECUTOR_STATUS_PATH,
  createLocalExecutorHttpServer,
  startConfiguredLocalExecutor,
  type LocalExecutorHttpServerOptions,
} from "../executor/server.js";
export { executeLocalAuthorizedExecution } from "../executor/execution.js";
