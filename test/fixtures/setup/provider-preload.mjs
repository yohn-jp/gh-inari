import { createHash, createPublicKey, verify } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const stateFile = process.env.INARI_SETUP_PROVIDER_STATE;
const logFile = process.env.INARI_SETUP_PROVIDER_LOG;
if (!stateFile || !logFile) throw new Error("Setup certification provider paths are required.");
const nativeFetch = globalThis.fetch.bind(globalThis);
const repositoryName = "cert-owner/renamed-project";
const repositoryId = 44332211;
const appId = 4242;
const installationId = 77;
const prefix = `repos/${repositoryName}`;
const baseCommit = "a".repeat(40);
const baseTree = "b".repeat(40);
const publishedTree = "c".repeat(40);
const publishedCommit = "d".repeat(40);
const repository = {
  id: repositoryId,
  node_id: "R_setup_certification",
  full_name: repositoryName,
  default_branch: "main",
};
const respond = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
const save = (value) => writeFileSync(stateFile, JSON.stringify(value));
const blobSha = (content) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0${content}`)
    .digest("hex");
const pullRequest = (value) => ({
  number: 31,
  html_url: `https://github.com/${repositoryName}/pull/31`,
  title: value.title,
  body: value.body,
  state: value.merged ? "closed" : "open",
  draft: false,
  changed_files: 1,
  head: { ref: value.branch, repo: { full_name: repositoryName } },
  base: { ref: "main" },
  user: { login: "cert-operator" },
});

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return nativeFetch(input, init);
  const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const route = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  appendFileSync(logFile, JSON.stringify({ method, origin: url.origin, route, search: url.search }) + "\n");
  if (url.origin === "https://endpoint.example.test" && method === "GET" && route === ".well-known/inari")
    return respond({
      version: 1,
      githubHost: "github.com",
      appId: String(appId),
      appClientId: "Iv1.setup-cert",
      appSlug: "inari",
      appInstallationUrl: "https://github.com/apps/inari/installations/new",
      appUserAuthProfile: "device-flow",
      relayConnectionBase: "wss://relay.example.test/connect",
    });
  if (url.origin === "https://github.com" && method === "POST" && route === "login/device/code")
    return respond({
      device_code: "setup-cert-device",
      user_code: "CERT-1122",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 1,
    });
  if (url.origin === "https://github.com" && method === "POST" && route === "login/oauth/access_token")
    return respond({
      access_token: "setup-cert-user-token",
      refresh_token: "setup-cert-refresh-token",
      expires_in: 3600,
      refresh_token_expires_in: 3600,
      token_type: "bearer",
    });
  if (url.origin !== "https://api.github.com") throw new Error(`Unexpected provider origin: ${url.origin}`);
  const authorization = new Headers(init?.headers).get("authorization") ?? "";
  if (method === "POST" && route === `app/installations/${installationId}/access_tokens`) {
    const publicKeyFile = process.env.INARI_SETUP_ISSUER_PUBLIC_KEY;
    const [header, payload, signature] = authorization.replace(/^Bearer /u, "").split(".");
    const signed =
      publicKeyFile &&
      header &&
      payload &&
      signature &&
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        createPublicKey(readFileSync(publicKeyFile)),
        Buffer.from(signature, "base64url"),
      ) &&
      String(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).iss) === String(appId);
    if (!signed) return respond({ message: "Invalid Issuer App JWT" }, 401);
    const requested = JSON.parse(String(init?.body ?? "{}")).permissions ?? {};
    return respond(
      {
        token: "setup-cert-installation-token",
        expires_at: "2099-01-01T00:00:00Z",
        permissions: requested,
        repository_selection: "selected",
        repositories: [repository],
      },
      201,
    );
  }
  if (
    ![
      "Bearer setup-cert-user-token",
      "token setup-cert-user-token",
      "Bearer setup-cert-installation-token",
      "token setup-cert-installation-token",
    ].includes(authorization)
  )
    return respond({ message: "Unauthorized" }, 401);
  if (method === "GET" && route === prefix) return respond(repository);
  if (method === "GET" && route === "user/installations")
    return respond({
      installations: [
        {
          id: installationId,
          app_id: appId,
          suspended_at: null,
          permissions: { metadata: "read", contents: "write", issues: "write", pull_requests: "write" },
        },
      ],
    });
  if (method === "GET" && route === `user/installations/${installationId}/repositories`)
    return respond({ repositories: [repository] });
  const current = state();
  const branch = current.branch;
  const artifact = current.artifact;
  if (method === "GET" && route === `${prefix}/git/ref/heads/main`)
    return respond({
      ref: "refs/heads/main",
      object: { type: "commit", sha: current.merged ? publishedCommit : baseCommit },
    });
  if (method === "GET" && route.startsWith(`${prefix}/git/ref/heads/`))
    return current.branch
      ? respond({ ref: `refs/heads/${branch}`, object: { type: "commit", sha: publishedCommit } })
      : respond({}, 404);
  if (method === "GET" && route === `${prefix}/git/commits/${baseCommit}`)
    return respond({ sha: baseCommit, tree: { sha: baseTree } });
  if (method === "GET" && route === `${prefix}/git/commits/${publishedCommit}`)
    return respond({ sha: publishedCommit, tree: { sha: publishedTree } });
  if (method === "GET" && route.startsWith(`${prefix}/git/trees/`)) {
    if (current.trustUnavailable) return respond({ message: "Canonical trust is temporarily unavailable" }, 503);
    const ref = route.slice(`${prefix}/git/trees/`.length);
    const published = ref === publishedTree || ref === publishedCommit || (ref === "main" && current.merged);
    return respond({
      sha: published ? publishedTree : baseTree,
      truncated: false,
      tree: published && artifact ? [{ path: artifact.path, mode: "100644", type: "blob", sha: artifact.sha }] : [],
    });
  }
  if (method === "GET" && route.startsWith(`${prefix}/git/blobs/`)) {
    const sha = route.slice(`${prefix}/git/blobs/`.length);
    return artifact?.sha === sha
      ? respond({ sha, encoding: "base64", content: Buffer.from(artifact.content).toString("base64") })
      : respond({}, 404);
  }
  if (method === "POST" && route === `${prefix}/git/blobs`) {
    const body = JSON.parse(String(init?.body));
    const content = Buffer.from(body.content, "base64").toString("utf8");
    current.artifact = { content, sha: blobSha(content) };
    save(current);
    return respond({ sha: current.artifact.sha }, 201);
  }
  if (method === "POST" && route === `${prefix}/git/trees`) {
    const body = JSON.parse(String(init?.body));
    current.artifact.path = body.tree[0].path;
    save(current);
    return respond({ sha: publishedTree }, 201);
  }
  if (method === "POST" && route === `${prefix}/git/commits`) return respond({ sha: publishedCommit }, 201);
  if (method === "POST" && route === `${prefix}/git/refs`) {
    current.branch = JSON.parse(String(init?.body)).ref.replace("refs/heads/", "");
    save(current);
    return respond({ ref: `refs/heads/${current.branch}`, object: { sha: publishedCommit } }, 201);
  }
  if (method === "GET" && route === `${prefix}/compare/main...${branch}`)
    return respond({ ahead_by: 1, files: [{ filename: artifact.path }] });
  if (method === "GET" && route === `${prefix}/pulls`) return respond(current.pr ? [pullRequest(current)] : []);
  if (method === "POST" && route === `${prefix}/pulls`) {
    const body = JSON.parse(String(init?.body));
    current.pr = true;
    current.title = body.title;
    current.body = body.body;
    save(current);
    return respond(pullRequest(current), 201);
  }
  if (method === "GET" && route === `${prefix}/pulls/31/files`) return respond([{ filename: artifact.path }]);
  return respond({ message: "Unmatched setup certification provider route" }, 404);
};
