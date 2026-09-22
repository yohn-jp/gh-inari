import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DashboardBrowserError,
  createDashboardReadRequest,
  dashboardResultText,
  type DashboardBrowserConfig,
} from "./browser.js";
import type { DashboardEndpointResult } from "./endpoint-client.js";

const config: DashboardBrowserConfig = {
  endpointUrl: "https://endpoint.example.test",
  endpointId: "dashboard-endpoint",
  deployment: "shared-hosted",
  githubHost: "github.com",
  clientId: "public-client",
  redirectUri: "https://dashboard.example.test/oauth/callback",
};

test("Dashboard bounds browser input before it forms an Endpoint read request", () => {
  const request = createDashboardReadRequest(config, {
    installationId: "123456",
    repositoryName: "yohn-jp/gh-inari",
    repositoryId: "1330755860",
    rootIssue: "952",
  });
  assert.deepEqual(request.query, { rootIssue: 952 });
  assert.equal(request.repository.repositoryId, "1330755860");
  assert.equal(request.operation, "repository.read");

  assert.throws(
    () =>
      createDashboardReadRequest(config, {
        installationId: "x".repeat(129),
        repositoryName: "yohn-jp/gh-inari",
        repositoryId: "1330755860",
        rootIssue: "",
      }),
    (error: unknown) => error instanceof DashboardBrowserError && error.code === "DASHBOARD_BROWSER_INPUT_INVALID",
  );
  assert.throws(
    () =>
      createDashboardReadRequest(config, {
        installationId: "123456",
        repositoryName: "yohn-jp/gh-inari",
        repositoryId: "1330755860",
        rootIssue: "1000000000",
      }),
    (error: unknown) => error instanceof DashboardBrowserError && error.code === "DASHBOARD_BROWSER_INPUT_INVALID",
  );
});

test("Dashboard presents Endpoint-owned result freshness and unavailable states without reinterpretation", () => {
  const result = {
    version: 1,
    ok: true,
    operation: "repository.read",
    authorization: { allowed: true },
    data: {
      repository: {
        version: 1,
        kind: "repository",
        endpointId: "dashboard-endpoint",
        installationId: "123456",
        repositoryHost: "github.com",
        repositoryId: "1330755860",
        nameWithOwner: "yohn-jp/gh-inari",
      },
      presence: { state: "connected", freshness: { state: "stale" } },
      unavailable: [{ resource: "work", diagnostics: [] }],
    },
  } as unknown as DashboardEndpointResult;
  const text = dashboardResultText(result, 1_000);
  assert.match(text, /Work: unavailable/u);
  assert.match(text, /Work freshness: unavailable/u);
  assert.match(text, /Presence: connected/u);
  assert.match(text, /Presence freshness: stale/u);
  assert.match(text, /Refreshed:/u);

  const error = {
    version: 1,
    ok: false,
    error: { code: "ENDPOINT_API_AUTHORIZATION_DENIED", message: "denied", diagnostics: [] },
  } as unknown as DashboardEndpointResult;
  assert.match(dashboardResultText(error), /Endpoint error: ENDPOINT_API_AUTHORIZATION_DENIED/u);
});
