/** Select only the requested private Runtime role at the local composition boundary. */
export async function setupExecutorRole(environment: NodeJS.ProcessEnv) {
  const { setupLocalExecutor } = await import("../executor/setup.js");
  return setupLocalExecutor(environment);
}

export async function serveExecutorRole(version: string, environment: NodeJS.ProcessEnv) {
  const { startConfiguredLocalExecutor } = await import("../executor/server.js");
  return startConfiguredLocalExecutor(version, environment);
}

export async function setupAdmissionRole(authority: unknown, environment: NodeJS.ProcessEnv) {
  const { setupLocalAdmission } = await import("../admission/setup.js");
  return setupLocalAdmission(authority, environment);
}

export async function serveAdmissionRole(version: string, environment: NodeJS.ProcessEnv) {
  const { startConfiguredLocalAdmission } = await import("../admission/server.js");
  return startConfiguredLocalAdmission(version, environment);
}
