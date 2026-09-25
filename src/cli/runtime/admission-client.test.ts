import assert from "node:assert/strict";
import { test } from "node:test";
import * as admissionServer from "../../local-control/admission-server.js";
import * as compatibilityFacade from "../../local-control/admission-client.js";
import * as launcherFacade from "../../local-control/session-launcher.js";
import * as launcher from "./session-launcher.js";
import * as client from "./admission-client.js";

test("the CLI Admission client wire constants match the Admission server without importing it", () => {
  assert.equal(client.LOCAL_ADMISSION_CLIENT_PROTOCOL_VERSION, admissionServer.LOCAL_ADMISSION_PROTOCOL_VERSION);
  assert.equal(client.LOCAL_ADMISSION_CLIENT_HEALTH_PATH, admissionServer.LOCAL_ADMISSION_HEALTH_PATH);
  assert.equal(client.LOCAL_ADMISSION_CLIENT_SESSIONS_PATH, admissionServer.LOCAL_ADMISSION_SESSIONS_PATH);
  assert.equal(client.LOCAL_ADMISSION_CLIENT_REPOSITORY_PATH, admissionServer.LOCAL_ADMISSION_REPOSITORY_PATH);
  assert.equal(client.LOCAL_ADMISSION_CLIENT_EXECUTIONS_PATH, admissionServer.LOCAL_ADMISSION_EXECUTIONS_PATH);
  assert.equal(client.LOCAL_ADMISSION_CLIENT_SESSION_ID_HEADER, admissionServer.LOCAL_ADMISSION_SESSION_ID_HEADER);
});

test("local-control compatibility facades re-export the CLI Runtime modules unchanged", () => {
  for (const name of Object.keys(client) as (keyof typeof client)[]) {
    assert.equal(compatibilityFacade[name], client[name], name);
  }
  for (const name of Object.keys(launcher) as (keyof typeof launcher)[]) {
    assert.equal(launcherFacade[name], launcher[name], name);
  }
  for (const name of [
    "createLocalAdmissionClient",
    "createAdmissionChangeExecutionPort",
    "createSessionExecutionIntent",
    "configuredLocalAdmissionTopology",
    "requireConfiguredLocalAdmissionRoute",
    "LocalAdmissionClientError",
  ] as const) {
    assert.equal(typeof compatibilityFacade[name], "function", name);
  }
  for (const name of [
    "startLocalSession",
    "closeLocalSession",
    "readLocalSessionBinding",
    "storeLocalSessionBinding",
    "readLocalSessionChangeIssueProvenance",
    "storeLocalSessionChangeIssueProvenance",
    "LocalSessionLauncherError",
  ] as const) {
    assert.equal(typeof launcherFacade[name], "function", name);
  }
});
