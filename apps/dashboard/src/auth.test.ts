import assert from "node:assert/strict";
import { test } from "node:test";
import { createDashboardAuth, DashboardAuthError } from "./auth.js";

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();
  get length(): number {
    return this.#values.size;
  }
  clear(): void {
    this.#values.clear();
  }
  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.#values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

const redirectUri = "https://dashboard.example.test/oauth/callback";

test("Dashboard auth creates S256 authorization URLs and rejects state mismatch before exchange", async () => {
  const storage = new MemoryStorage();
  let calls = 0;
  const auth = createDashboardAuth({
    clientId: "public-client",
    redirectUri,
    storage,
    fetch: async () => {
      calls += 1;
      return new Response("{}");
    },
  });
  const authorization = new URL(await auth.beginAuthorization());
  assert.equal(authorization.searchParams.get("client_id"), "public-client");
  assert.equal(authorization.searchParams.get("redirect_uri"), redirectUri);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.ok((authorization.searchParams.get("code_challenge") ?? "").length > 20);
  await assert.rejects(
    () => auth.handleCallback(`${redirectUri}?code=code&state=wrong`),
    (error: unknown) => error instanceof DashboardAuthError && error.code === "DASHBOARD_AUTH_STATE_MISMATCH",
  );
  assert.equal(calls, 0);
});

test("Dashboard auth keeps the access token in memory and expires it", async () => {
  const storage = new MemoryStorage();
  let now = 1_000_000;
  let request: RequestInit | undefined;
  const auth = createDashboardAuth({
    clientId: "public-client",
    redirectUri,
    storage,
    now: () => now,
    fetch: async (_input, init) => {
      request = init;
      return new Response(JSON.stringify({ accessToken: "ghu-memory", expiresAt: now + 1_000 }));
    },
  });
  const authorization = new URL(await auth.beginAuthorization());
  await auth.handleCallback(`${redirectUri}?code=one&state=${authorization.searchParams.get("state")}`);
  assert.equal(auth.getAccessToken(), "ghu-memory");
  assert.equal(storage.getItem("inari.dashboard.oauth.pending"), null);
  assert.equal(JSON.stringify(storage).includes("ghu-memory"), false);
  assert.equal(new Headers(request?.headers).get("origin"), "https://dashboard.example.test");
  now += 1_001;
  assert.equal(auth.getAccessToken(), undefined);
});
