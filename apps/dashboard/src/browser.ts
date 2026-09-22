import {
  ENDPOINT_ONBOARDING_PATH,
  decodeEndpointOnboardingDescriptor,
  type EndpointOnboardingDescriptor,
} from "../../../src/endpoint-onboarding.js";
import { validateEndpointReadQuery, type EndpointReadQuery } from "../../../src/endpoint-read-query.js";
import { createDashboardAuth, DashboardAuthError, type DashboardAuthSession } from "./auth.js";
import { createDashboardApplication, type DashboardApplication } from "./main.js";
import type { DashboardEndpointReadRequest, DashboardEndpointResult } from "./endpoint-client.js";
import { createGitHubInstallationsClient, type GitHubInstallationsClient } from "./github-installations-client.js";

const MAX_ENDPOINT_URL_LENGTH = 2_048;
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_REPOSITORY_NAME_LENGTH = 255;
const MAX_INSTALLATION_ID_LENGTH = 128;
const MAX_REPOSITORY_ID_LENGTH = 20;
const MAX_ROOT_ISSUE_LENGTH = 9;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const HOST_PATTERN = /^[A-Za-z0-9.-]+$/u;

export interface DashboardBrowserConfig {
  readonly endpointUrl: string;
  readonly endpointId: string;
  readonly deployment: "shared-hosted" | "self-hosted";
  readonly githubHost: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly exchangeEndpoint?: string;
  readonly authorizeEndpoint?: string;
}

export interface DashboardBrowserInput {
  readonly installationId: string;
  readonly repositoryName: string;
  readonly repositoryId: string;
  readonly rootIssue: string;
}

export class DashboardBrowserError extends Error {
  readonly code:
    | "DASHBOARD_BROWSER_CONFIGURATION_INVALID"
    | "DASHBOARD_BROWSER_INPUT_INVALID"
    | "DASHBOARD_BROWSER_ONBOARDING_FAILED";

  constructor(code: DashboardBrowserError["code"], message: string) {
    super(message);
    this.name = "DashboardBrowserError";
    this.code = code;
  }
}

export interface DashboardBrowserRuntime {
  readonly document: Document;
  readonly location: Location;
  readonly history: History;
  readonly fetch: typeof globalThis.fetch;
  readonly storage?: Storage | null;
  readonly crypto?: Pick<Crypto, "getRandomValues" | "subtle">;
}

export interface DashboardBrowserController {
  readonly auth: DashboardAuthSession;
  readonly application: DashboardApplication;
  refresh(): Promise<DashboardEndpointResult | undefined>;
}

function dataValue(root: HTMLElement, name: string): string | undefined {
  const value = root.dataset[name];
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function boundedIdentifier(value: string, field: string, maxLength = MAX_INSTALLATION_ID_LENGTH): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength || !IDENTIFIER_PATTERN.test(normalized)) {
    throw new DashboardBrowserError("DASHBOARD_BROWSER_INPUT_INVALID", `${field} is invalid.`);
  }
  return normalized;
}

function boundedRepositoryId(value: string): string {
  const normalized = value.trim();
  if (normalized.length > MAX_REPOSITORY_ID_LENGTH || !DECIMAL_ID_PATTERN.test(normalized)) {
    throw new DashboardBrowserError("DASHBOARD_BROWSER_INPUT_INVALID", "Repository ID is invalid.");
  }
  return normalized;
}

function boundedRepositoryName(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_REPOSITORY_NAME_LENGTH ||
    !REPOSITORY_NAME_PATTERN.test(normalized) ||
    normalized.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new DashboardBrowserError("DASHBOARD_BROWSER_INPUT_INVALID", "Repository owner/name is invalid.");
  }
  return normalized;
}

function boundedHost(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 255 ||
    !HOST_PATTERN.test(normalized) ||
    normalized.startsWith(".") ||
    normalized.endsWith(".") ||
    normalized.includes("..")
  ) {
    throw new DashboardBrowserError("DASHBOARD_BROWSER_CONFIGURATION_INVALID", "GitHub host is invalid.");
  }
  return normalized;
}

function endpointUrl(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_ENDPOINT_URL_LENGTH) {
    throw new DashboardBrowserError("DASHBOARD_BROWSER_CONFIGURATION_INVALID", "Endpoint URL is invalid.");
  }
  try {
    const parsed = new URL(normalized);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error();
    }
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    throw new DashboardBrowserError("DASHBOARD_BROWSER_CONFIGURATION_INVALID", "Endpoint URL is invalid.");
  }
}

function rootIssue(value: string): EndpointReadQuery | undefined {
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  if (normalized.length > MAX_ROOT_ISSUE_LENGTH || !/^[0-9]+$/u.test(normalized)) {
    throw new DashboardBrowserError("DASHBOARD_BROWSER_INPUT_INVALID", "Root Issue is invalid.");
  }
  const parsed = Number(normalized);
  const validation = validateEndpointReadQuery("repository.read", { rootIssue: parsed }, "$.rootIssue");
  if (!validation.valid || validation.value === undefined || validation.value.rootIssue === undefined) {
    throw new DashboardBrowserError("DASHBOARD_BROWSER_INPUT_INVALID", "Root Issue is invalid.");
  }
  return validation.value;
}

function callbackUrl(endpoint: string): string {
  return `${endpoint}/oauth/callback`;
}

/** Build the public browser configuration from the static shell and descriptor. */
export function createDashboardBrowserConfig(
  root: HTMLElement,
  descriptor: EndpointOnboardingDescriptor,
  locationOrigin: string,
): DashboardBrowserConfig {
  const endpoint = endpointUrl(dataValue(root, "endpointUrl") ?? locationOrigin);
  const deployment = dataValue(root, "endpointDeployment") ?? "shared-hosted";
  if (deployment !== "shared-hosted" && deployment !== "self-hosted") {
    throw new DashboardBrowserError("DASHBOARD_BROWSER_CONFIGURATION_INVALID", "Endpoint deployment is invalid.");
  }
  const redirectUri = dataValue(root, "redirectUri") ?? descriptor.appCallbackUrl ?? callbackUrl(endpoint);
  return Object.freeze({
    endpointUrl: endpoint,
    endpointId: boundedIdentifier(dataValue(root, "endpointId") ?? "dashboard-endpoint", "Endpoint ID"),
    deployment,
    githubHost: boundedHost(dataValue(root, "repositoryHost") ?? descriptor.githubHost),
    clientId: descriptor.appClientId,
    redirectUri,
    ...(dataValue(root, "exchangeEndpoint") === undefined
      ? {}
      : { exchangeEndpoint: dataValue(root, "exchangeEndpoint") }),
    ...(dataValue(root, "authorizeEndpoint") === undefined
      ? {}
      : { authorizeEndpoint: dataValue(root, "authorizeEndpoint") }),
  });
}

/** Form the closed repository read request only after all user input is bounded. */
export function createDashboardReadRequest(
  config: DashboardBrowserConfig,
  input: DashboardBrowserInput,
): DashboardEndpointReadRequest {
  const endpointId = boundedIdentifier(config.endpointId, "Endpoint ID");
  const installationId = boundedIdentifier(input.installationId, "Installation ID");
  const repositoryName = boundedRepositoryName(input.repositoryName);
  const repositoryId = boundedRepositoryId(input.repositoryId);
  const query = rootIssue(input.rootIssue);
  const endpoint = Object.freeze({
    version: 1 as const,
    kind: "endpoint" as const,
    id: endpointId,
    deployment: config.deployment,
  });
  const installation = Object.freeze({
    version: 1 as const,
    kind: "installation" as const,
    endpointId,
    installationId,
  });
  const repository = Object.freeze({
    version: 1 as const,
    kind: "repository" as const,
    endpointId,
    installationId,
    repositoryHost: boundedHost(config.githubHost),
    repositoryId,
    nameWithOwner: repositoryName,
  });
  return Object.freeze({
    operation: "repository.read" as const,
    endpoint,
    installation,
    repository,
    capability: { kind: "repository.read" as const },
    ...(query === undefined ? {} : { query }),
  });
}

function formValue(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name);
  if (!(field instanceof HTMLInputElement)) {
    throw new DashboardBrowserError("DASHBOARD_BROWSER_INPUT_INVALID", `Dashboard field ${name} is unavailable.`);
  }
  return field.value;
}

function formInput(form: HTMLFormElement): DashboardBrowserInput {
  return {
    installationId: formValue(form, "installationId"),
    repositoryName: formValue(form, "repositoryName"),
    repositoryId: formValue(form, "repositoryId"),
    rootIssue: formValue(form, "rootIssue"),
  };
}

function setFormValue(form: HTMLFormElement, name: string, value: string): void {
  const field = form.elements.namedItem(name);
  if (field instanceof HTMLInputElement) field.value = value;
}

function resetSelect(select: HTMLSelectElement, placeholder: string, disabled: boolean): void {
  select.replaceChildren(new Option(placeholder, ""));
  select.disabled = disabled;
}

/** Populate the account/repository pickers from the signed-in user's own GitHub App installations. */
async function wireInstallationPickers(
  form: HTMLFormElement,
  installations: GitHubInstallationsClient,
  installationSelect: HTMLSelectElement,
  repositorySelect: HTMLSelectElement,
  status: HTMLElement,
): Promise<void> {
  try {
    const list = await installations.listInstallations();
    resetSelect(installationSelect, "Select an account", false);
    for (const entry of list) {
      installationSelect.append(new Option(entry.accountLogin, entry.installationId));
    }
  } catch {
    resetSelect(installationSelect, "Unavailable — enter manually below", true);
    return;
  }

  installationSelect.addEventListener("change", () => {
    setFormValue(form, "installationId", installationSelect.value);
    setFormValue(form, "repositoryName", "");
    setFormValue(form, "repositoryId", "");
    if (installationSelect.value === "") {
      resetSelect(repositorySelect, "Select an account first", true);
      return;
    }
    resetSelect(repositorySelect, "Loading repositories…", true);
    void installations
      .listRepositories(installationSelect.value)
      .then((repositories) => {
        resetSelect(repositorySelect, "Select a repository", false);
        for (const entry of repositories) {
          repositorySelect.append(new Option(entry.nameWithOwner, `${entry.repositoryId}\u0000${entry.nameWithOwner}`));
        }
      })
      .catch(() => {
        resetSelect(repositorySelect, "Unavailable — enter manually below", true);
        renderStatus(status, "Could not list repositories for that account.", "error");
      });
  });

  repositorySelect.addEventListener("change", () => {
    const [repositoryId = "", nameWithOwner = ""] = repositorySelect.value.split("\u0000");
    setFormValue(form, "repositoryId", repositoryId);
    setFormValue(form, "repositoryName", nameWithOwner);
  });
}

/** Fetch and validate the public, secret-free Endpoint onboarding descriptor. */
export async function fetchDashboardOnboardingDescriptor(
  endpoint: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<EndpointOnboardingDescriptor> {
  const origin = endpointUrl(endpoint);
  if (typeof fetcher !== "function") {
    throw new DashboardBrowserError("DASHBOARD_BROWSER_ONBOARDING_FAILED", "Endpoint onboarding is unavailable.");
  }
  let response: Response;
  try {
    response = await fetcher(`${origin}${ENDPOINT_ONBOARDING_PATH}`, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    throw new DashboardBrowserError("DASHBOARD_BROWSER_ONBOARDING_FAILED", "Endpoint onboarding failed.");
  }
  if (!response.ok) {
    throw new DashboardBrowserError("DASHBOARD_BROWSER_ONBOARDING_FAILED", "Endpoint onboarding failed.");
  }
  let body: string;
  try {
    body = await response.text();
    if (new TextEncoder().encode(body).byteLength > MAX_DESCRIPTOR_BYTES) throw new Error();
    return decodeEndpointOnboardingDescriptor(body);
  } catch {
    throw new DashboardBrowserError("DASHBOARD_BROWSER_ONBOARDING_FAILED", "Endpoint onboarding failed.");
  }
}

function resultUnavailable(
  result: Extract<DashboardEndpointResult, { readonly ok: true }>,
  resource: "work" | "presence",
) {
  return result.data.unavailable.some((entry) => entry.resource === resource);
}

/** Render only bounded Endpoint-owned state and freshness values. */
export function dashboardResultText(result: DashboardEndpointResult, refreshedAt = Date.now()): string {
  if (!result.ok) {
    const diagnostics = result.error.diagnostics.map((entry) => entry.code).join(", ") || "none";
    return [`Endpoint error: ${result.error.code}`, `Diagnostics: ${diagnostics}`].join("\n");
  }
  const workState =
    result.data.work?.work.status ?? (resultUnavailable(result, "work") ? "unavailable" : "not-requested");
  const workFreshness =
    result.data.work?.freshness.state ?? (resultUnavailable(result, "work") ? "unavailable" : "not-requested");
  const presenceState =
    result.data.presence?.state ?? (resultUnavailable(result, "presence") ? "unavailable" : "not-requested");
  const presenceFreshness =
    result.data.presence?.freshness.state ?? (resultUnavailable(result, "presence") ? "unavailable" : "not-requested");
  return [
    `Repository: ${result.data.repository.nameWithOwner}`,
    `Repository ID: ${result.data.repository.repositoryId}`,
    `Work: ${workState}`,
    `Work freshness: ${workFreshness}`,
    `Presence: ${presenceState}`,
    `Presence freshness: ${presenceFreshness}`,
    `Refreshed: ${new Date(refreshedAt).toISOString()}`,
  ].join("\n");
}

function renderResult(container: HTMLElement, result: DashboardEndpointResult, refreshedAt = Date.now()): void {
  container.dataset.state = result.ok ? "result" : "error";
  container.textContent = dashboardResultText(result, refreshedAt);
}

function renderError(status: HTMLElement, result: HTMLElement, error: unknown): void {
  const code =
    error instanceof DashboardBrowserError
      ? error.code
      : error instanceof DashboardAuthError
        ? error.code
        : "DASHBOARD_BROWSER_ERROR";
  status.dataset.state = "error";
  status.textContent = `Dashboard error: ${code}`;
  result.dataset.state = "error";
  result.textContent = `Dashboard error: ${code}`;
}

function renderStatus(status: HTMLElement, text: string, state: "loading" | "ready" | "error"): void {
  status.dataset.state = state;
  status.textContent = text;
}

function hasCallback(location: Location): boolean {
  const url = new URL(location.href);
  return url.searchParams.has("code") || url.searchParams.has("state") || url.searchParams.has("error");
}

function clearCallbackUrl(runtime: DashboardBrowserRuntime): void {
  const url = new URL(runtime.location.href);
  url.search = "";
  url.hash = "";
  runtime.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function defaultRuntime(): DashboardBrowserRuntime {
  if (typeof document === "undefined" || typeof location === "undefined" || typeof history === "undefined") {
    throw new DashboardBrowserError("DASHBOARD_BROWSER_CONFIGURATION_INVALID", "A browser runtime is required.");
  }
  if (typeof globalThis.fetch !== "function") {
    throw new DashboardBrowserError("DASHBOARD_BROWSER_CONFIGURATION_INVALID", "Browser fetch is unavailable.");
  }
  return {
    document,
    location,
    history,
    fetch: globalThis.fetch.bind(globalThis),
  };
}

function requiredElement<T extends HTMLElement>(document: Document, id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new DashboardBrowserError("DASHBOARD_BROWSER_CONFIGURATION_INVALID", `Dashboard element ${id} is missing.`);
  }
  return element as T;
}

/** Start the framework-free browser shell and wire its one read-only form. */
export async function startDashboardBrowser(
  suppliedRuntime?: DashboardBrowserRuntime,
): Promise<DashboardBrowserController | undefined> {
  const runtime = suppliedRuntime ?? defaultRuntime();
  const root = runtime.document.querySelector<HTMLElement>("[data-dashboard-shell]");
  const status = requiredElement<HTMLElement>(runtime.document, "dashboard-status");
  const result = requiredElement<HTMLElement>(runtime.document, "dashboard-result");
  if (!(root instanceof HTMLElement)) {
    renderError(
      status,
      result,
      new DashboardBrowserError("DASHBOARD_BROWSER_CONFIGURATION_INVALID", "Dashboard shell is missing."),
    );
    return undefined;
  }
  try {
    renderStatus(status, "Loading Dashboard configuration…", "loading");
    const configuredEndpoint = endpointUrl(dataValue(root, "endpointUrl") ?? runtime.location.origin);
    const descriptor = await fetchDashboardOnboardingDescriptor(configuredEndpoint, runtime.fetch);
    const config = createDashboardBrowserConfig(root, descriptor, runtime.location.origin);
    const auth = createDashboardAuth({
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      ...(config.exchangeEndpoint === undefined ? {} : { exchangeEndpoint: config.exchangeEndpoint }),
      ...(config.authorizeEndpoint === undefined ? {} : { authorizeEndpoint: config.authorizeEndpoint }),
      fetch: runtime.fetch,
      ...(runtime.storage === undefined ? {} : { storage: runtime.storage }),
      ...(runtime.crypto === undefined ? {} : { crypto: runtime.crypto }),
    });
    const application = createDashboardApplication({ endpoint: config.endpointUrl, auth });
    const signIn = requiredElement<HTMLButtonElement>(runtime.document, "dashboard-sign-in");
    const form = requiredElement<HTMLFormElement>(runtime.document, "dashboard-form");

    const refresh = async (): Promise<DashboardEndpointResult | undefined> => {
      if (auth.getAccessToken() === undefined) {
        renderStatus(status, "Sign in before reading the Endpoint.", "error");
        return undefined;
      }
      try {
        const request = createDashboardReadRequest(config, formInput(form));
        renderStatus(status, "Reading repository, work, and presence through the Endpoint…", "loading");
        const response = await application.read(request);
        renderResult(result, response);
        renderStatus(
          status,
          response.ok ? "Endpoint result received." : "Endpoint returned an error.",
          response.ok ? "ready" : "error",
        );
        return response;
      } catch (error: unknown) {
        renderError(status, result, error);
        return undefined;
      }
    };

    signIn.addEventListener("click", () => {
      void auth
        .startAuthorization()
        .then((url) => runtime.location.assign(url))
        .catch((error: unknown) => renderError(status, result, error));
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void refresh();
    });

    if (hasCallback(runtime.location)) {
      renderStatus(status, "Completing GitHub sign-in…", "loading");
      await auth.handleCallback(runtime.location.href);
      clearCallbackUrl(runtime);
    }
    const signedIn = auth.getAccessToken() !== undefined;
    signIn.hidden = signedIn;
    form.querySelector("fieldset")?.toggleAttribute("disabled", !signedIn);
    renderStatus(status, signedIn ? "Signed in in memory." : "Sign in to read the Endpoint.", "ready");
    if (signedIn) {
      const installationSelect = runtime.document.getElementById("dashboard-installation-select");
      const repositorySelect = runtime.document.getElementById("dashboard-repository-select");
      if (installationSelect instanceof HTMLSelectElement && repositorySelect instanceof HTMLSelectElement) {
        const installations = createGitHubInstallationsClient({
          getAccessToken: () => auth.getAccessToken(),
          fetch: runtime.fetch,
        });
        void wireInstallationPickers(form, installations, installationSelect, repositorySelect, status);
      }
    }
    return Object.freeze({ auth, application, refresh });
  } catch (error: unknown) {
    renderError(status, result, error);
    return undefined;
  }
}

if (typeof document !== "undefined") {
  void startDashboardBrowser();
}
