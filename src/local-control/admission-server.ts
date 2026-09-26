/**
 * Temporary compatibility facade (#1107). The Admission implementation lives in
 * `src/admission/setup.ts` (setup), `src/admission/authorization.ts` (private
 * authorization) and `src/admission/server.ts` (serving). This path keeps the
 * existing exports unchanged until #1109 composes the role producers.
 */
export {
  LOCAL_ADMISSION_DEFAULT_PORT,
  LocalAdmissionError,
  setupLocalAdmission,
  type LocalAdmissionSetupResult,
} from "../admission/setup.js";
export {
  createLocalAdmissionHttpServer,
  LOCAL_ADMISSION_EXECUTIONS_PATH,
  LOCAL_ADMISSION_HEALTH_PATH,
  LOCAL_ADMISSION_PROTOCOL_VERSION,
  LOCAL_ADMISSION_REPOSITORY_PATH,
  LOCAL_ADMISSION_SESSION_ID_HEADER,
  LOCAL_ADMISSION_SESSIONS_PATH,
  LOCAL_ADMISSION_STATUS_PATH,
  MAX_LOCAL_ADMISSION_BODY_BYTES,
  startConfiguredLocalAdmission,
} from "../admission/server.js";
