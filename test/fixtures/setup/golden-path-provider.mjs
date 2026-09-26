// Deterministic GitHub stand-in for the #1184 continuous Golden Path
// certification. It is loaded with `--import` into every packed CLI process
// and every Runtime child, and keeps one repository's provider state in a
// shared JSON file so separate OS processes observe the same GitHub.
//
// It replaces only the external API boundary: it never creates local Inari
// state, trust records, Sessions or pull requests on its own. Everything the
// certification observes is produced by the packed CLI through ordinary
// provider requests (or by the explicit human-merge helper the test calls).
import { createHash, createPublicKey, verify } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const stateFile = process.env.INARI_GP_PROVIDER_STATE;
const logFile = process.env.INARI_GP_PROVIDER_LOG;
if (!stateFile || !logFile) throw new Error("Golden Path provider paths are required.");

const nativeFetch = globalThis.fetch.bind(globalThis);
const USER_TOKEN = "gp-user-access-token";
const INSTALLATION_TOKEN = "gp-installation-token";

const load = () => JSON.parse(readFileSync(stateFile, "utf8"));
const save = (value) => writeFileSync(stateFile, JSON.stringify(value));
const respond = (body, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const digest = (kind, value) =>
  createHash("sha1")
    .update(`${kind}\0${JSON.stringify(value)}`)
    .digest("hex");
const blobSha = (bytes) => createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");

function repositoryView(state) {
  return {
    id: Number(state.repository.id),
    node_id: state.repository.nodeId,
    name: state.repository.name.split("/")[1],
    full_name: state.repository.name,
    owner: { login: state.repository.name.split("/")[0] },
    private: true,
    fork: false,
    default_branch: state.defaultBranch,
    html_url: `https://github.com/${state.repository.name}`,
  };
}

function resolveTree(state, reference) {
  if (state.trees[reference] !== undefined) return reference;
  if (state.commits[reference] !== undefined) return state.commits[reference].tree;
  const ref = state.refs[reference];
  return ref === undefined ? undefined : state.commits[ref]?.tree;
}

function treeFiles(state, treeSha) {
  return new Map((state.trees[treeSha] ?? []).map((entry) => [entry.path, entry]));
}

function pullView(state, pull) {
  const headSha = state.refs[pull.head] ?? pull.headSha;
  return {
    id: pull.number * 1000,
    node_id: `PR_${pull.number}`,
    number: pull.number,
    html_url: `https://github.com/${state.repository.name}/pull/${pull.number}`,
    url: `https://api.github.com/repos/${state.repository.name}/pulls/${pull.number}`,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    draft: pull.draft,
    merged: pull.merged,
    merged_at: pull.merged ? "2026-09-26T00:00:00Z" : null,
    maintainer_can_modify: false,
    user: { login: pull.author, type: pull.author.endsWith("[bot]") ? "Bot" : "User" },
    head: { ref: pull.head, sha: headSha, repo: { full_name: state.repository.name, id: Number(state.repository.id) } },
    base: { ref: pull.base, sha: state.refs[pull.base], repo: { full_name: state.repository.name } },
    labels: [],
    assignees: [],
    changed_files: changedFiles(state, pull.base, pull.head).length,
  };
}

function changedFiles(state, base, head) {
  const baseTree = treeFiles(state, resolveTree(state, base));
  const headTree = treeFiles(state, resolveTree(state, head));
  const files = [];
  for (const [path, entry] of headTree) {
    const before = baseTree.get(path);
    if (before === undefined) files.push({ filename: path, status: "added" });
    else if (before.sha !== entry.sha) files.push({ filename: path, status: "modified" });
  }
  for (const path of baseTree.keys()) if (!headTree.has(path)) files.push({ filename: path, status: "removed" });
  return files;
}

function issueView(state, number) {
  const issue = state.issues[String(number)];
  return {
    id: number * 10,
    node_id: `I_${number}`,
    number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    html_url: `https://github.com/${state.repository.name}/issues/${number}`,
    labels: [],
    assignees: [],
    milestone: null,
    user: { login: "cert-operator" },
  };
}

function verifyAppJwt(state, authorization) {
  const [header, payload, signature] = authorization.replace(/^Bearer /u, "").split(".");
  if (!header || !payload || !signature) return false;
  try {
    return (
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        createPublicKey(state.issuerPublicKey),
        Buffer.from(signature, "base64url"),
      ) && String(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).iss) === String(state.appId)
    );
  } catch {
    return false;
  }
}

async function handle(url, method, headers, rawBody) {
  const state = load();
  const route = decodeURIComponent(url.pathname).replace(/^\/+/u, "");
  const body = rawBody === undefined || rawBody.length === 0 ? undefined : JSON.parse(rawBody);
  if (url.origin === state.endpoint && method === "GET" && route === ".well-known/inari")
    return respond({
      version: 1,
      githubHost: "github.com",
      appId: String(state.appId),
      appClientId: state.clientId,
      appSlug: "inari",
      appInstallationUrl: "https://github.com/apps/inari/installations/new",
      appUserAuthProfile: "device-flow",
      relayConnectionBase: "wss://relay.example.test/connect",
    });
  if (url.origin === "https://github.com" && method === "POST" && route === "login/device/code")
    return respond({
      device_code: "gp-device-code",
      user_code: "GOLD-1184",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 1,
    });
  if (url.origin === "https://github.com" && method === "POST" && route === "login/oauth/access_token")
    return respond({
      access_token: USER_TOKEN,
      refresh_token: "gp-user-refresh-token",
      expires_in: 28_800,
      refresh_token_expires_in: 15_897_600,
      token_type: "bearer",
    });
  if (url.origin !== "https://api.github.com") return respond({ message: `Unexpected origin ${url.origin}` }, 599);
  if (state.providerUnavailable) return respond({ message: "Service unavailable" }, 503);

  const authorization = headers.get("authorization") ?? "";
  if (method === "POST" && route === `app/installations/${state.installationId}/access_tokens`) {
    if (!verifyAppJwt(state, authorization)) return respond({ message: "A JSON web token could not be decoded" }, 401);
    const requested = body?.permissions ?? {};
    return respond(
      {
        token: INSTALLATION_TOKEN,
        expires_at: "2099-01-01T00:00:00Z",
        permissions: requested,
        repository_selection: "selected",
        repositories: [repositoryView(state)],
      },
      201,
    );
  }
  const principal = [`Bearer ${USER_TOKEN}`, `token ${USER_TOKEN}`].includes(authorization)
    ? "user"
    : [`Bearer ${INSTALLATION_TOKEN}`, `token ${INSTALLATION_TOKEN}`].includes(authorization)
      ? "installation"
      : undefined;
  if (principal === undefined) return respond({ message: "Bad credentials" }, 401);
  const author = principal === "installation" ? "inari-issuer[bot]" : "cert-operator";
  const prefix = `repos/${state.repository.name}`;

  if (method === "GET" && route === "user") return respond({ login: "cert-operator", id: 7001, type: "User" });
  if (method === "GET" && route === "user/installations" && principal === "user")
    return respond({
      total_count: 1,
      installations: [
        {
          id: Number(state.installationId),
          app_id: Number(state.appId),
          suspended_at: null,
          permissions: { metadata: "read", contents: "write", issues: "write", pull_requests: "write" },
        },
      ],
    });
  if (method === "GET" && route === `user/installations/${state.installationId}/repositories` && principal === "user")
    return respond({ total_count: 1, repositories: [repositoryView(state)] });
  if (method === "GET" && route === prefix) return respond(repositoryView(state));

  if (route === "graphql" && method === "POST") return graphql(state, body, save);

  if (!route.startsWith(`${prefix}/`)) return undefined;
  const path = route.slice(prefix.length + 1);

  if (method === "GET" && path.startsWith("git/ref/heads/")) {
    const name = path.slice("git/ref/heads/".length);
    const sha = state.refs[name];
    return sha === undefined
      ? respond({ message: "Not Found" }, 404)
      : respond({ ref: `refs/heads/${name}`, object: { type: "commit", sha } });
  }
  if (method === "GET" && path.startsWith("git/matching-refs/heads/")) {
    const start = path.slice("git/matching-refs/heads/".length);
    return respond(
      Object.entries(state.refs)
        .filter(([name]) => name.startsWith(start))
        .map(([name, sha]) => ({ ref: `refs/heads/${name}`, object: { type: "commit", sha } })),
    );
  }
  if (method === "GET" && path.startsWith("branches/")) {
    const name = path.slice("branches/".length);
    const sha = state.refs[name];
    return sha === undefined
      ? respond({ message: "Branch not found" }, 404)
      : respond({ name, commit: { sha }, protected: name === state.defaultBranch });
  }
  if (method === "GET" && path.startsWith("git/commits/")) {
    const sha = path.slice("git/commits/".length);
    const commit = state.commits[sha];
    return commit === undefined
      ? respond({ message: "Not Found" }, 404)
      : respond({
          sha,
          tree: { sha: commit.tree },
          parents: commit.parents.map((parent) => ({ sha: parent })),
          message: commit.message,
        });
  }
  if (method === "GET" && path.startsWith("commits/")) {
    const reference = path.slice("commits/".length);
    const sha = state.commits[reference] !== undefined ? reference : state.refs[reference];
    const commit = sha === undefined ? undefined : state.commits[sha];
    return commit === undefined
      ? respond({ message: "Not Found" }, 404)
      : respond({
          sha,
          commit: { tree: { sha: commit.tree }, message: commit.message },
          parents: commit.parents.map((parent) => ({ sha: parent })),
        });
  }
  if (method === "GET" && path.startsWith("git/trees/")) {
    if (state.trustUnavailable) return respond({ message: "Service unavailable" }, 503);
    const treeSha = resolveTree(state, path.slice("git/trees/".length));
    if (treeSha === undefined) return respond({ message: "Not Found" }, 404);
    return respond({ sha: treeSha, truncated: false, tree: state.trees[treeSha] });
  }
  if (method === "GET" && path.startsWith("git/blobs/")) {
    const sha = path.slice("git/blobs/".length);
    const content = state.blobs[sha];
    return content === undefined
      ? respond({ message: "Not Found" }, 404)
      : respond({ sha, encoding: "base64", content, size: Buffer.from(content, "base64").byteLength });
  }
  if (method === "POST" && path === "git/blobs") {
    const bytes = Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8");
    const sha = blobSha(bytes);
    state.blobs[sha] = bytes.toString("base64");
    save(state);
    return respond({ sha, url: `https://api.github.com/${prefix}/git/blobs/${sha}` }, 201);
  }
  if (method === "POST" && path === "git/trees") {
    const base = body.base_tree === undefined ? new Map() : treeFiles(state, resolveTree(state, body.base_tree));
    for (const entry of body.tree) {
      if (entry.sha === null) {
        base.delete(entry.path);
        continue;
      }
      let sha = entry.sha;
      if (sha === undefined && typeof entry.content === "string") {
        const bytes = Buffer.from(entry.content, "utf8");
        sha = blobSha(bytes);
        state.blobs[sha] = bytes.toString("base64");
      }
      base.set(entry.path, { path: entry.path, mode: entry.mode ?? "100644", type: entry.type ?? "blob", sha });
    }
    const entries = [...base.values()].sort((left, right) => left.path.localeCompare(right.path));
    const sha = digest("tree", entries);
    state.trees[sha] = entries;
    save(state);
    return respond({ sha, tree: entries, truncated: false }, 201);
  }
  if (method === "POST" && path === "git/commits") {
    const commit = { tree: body.tree, parents: body.parents ?? [], message: body.message };
    const sha = digest("commit", { ...commit, author: body.author ?? null, committer: body.committer ?? null });
    state.commits[sha] = commit;
    save(state);
    return respond(
      {
        sha,
        tree: { sha: commit.tree },
        parents: commit.parents.map((parent) => ({ sha: parent })),
        message: commit.message,
      },
      201,
    );
  }
  if (method === "POST" && path === "git/refs") {
    const name = String(body.ref).replace(/^refs\/heads\//u, "");
    if (state.refs[name] !== undefined) return respond({ message: "Reference already exists" }, 422);
    state.refs[name] = body.sha;
    save(state);
    return respond({ ref: `refs/heads/${name}`, object: { type: "commit", sha: body.sha } }, 201);
  }
  if (method === "PATCH" && path.startsWith("git/refs/heads/")) {
    const name = path.slice("git/refs/heads/".length);
    state.refs[name] = body.sha;
    save(state);
    return respond({ ref: `refs/heads/${name}`, object: { type: "commit", sha: body.sha } });
  }
  if (method === "DELETE" && path.startsWith("git/refs/heads/")) {
    delete state.refs[path.slice("git/refs/heads/".length)];
    save(state);
    return new Response(null, { status: 204 });
  }
  if (method === "GET" && path.startsWith("compare/")) {
    const [base, head] = path.slice("compare/".length).split("...");
    const files = changedFiles(state, base, head);
    return respond({
      status: files.length === 0 ? "identical" : "ahead",
      ahead_by: files.length === 0 ? 0 : 1,
      behind_by: 0,
      files,
    });
  }
  const issueMatch = /^issues\/(\d+)(\/.*)?$/u.exec(path);
  if (method === "GET" && issueMatch !== null) {
    const number = Number(issueMatch[1]);
    const rest = issueMatch[2] ?? "";
    const pull = state.pulls.find((candidate) => candidate.number === number);
    if (rest === "" && pull !== undefined)
      return respond({
        ...issueView(
          { ...state, issues: { [number]: { title: pull.title, body: pull.body, state: pull.state } } },
          number,
        ),
        pull_request: { url: "x" },
      });
    if (state.issues[String(number)] === undefined && pull === undefined) return respond({ message: "Not Found" }, 404);
    if (rest === "") return respond(issueView(state, number));
    if (rest === "/comments" || rest === "/dependencies/blocked_by" || rest === "/sub_issues" || rest === "/labels")
      return respond([]);
    if (rest === "/parent") return respond({ message: "Not Found" }, 404);
  }
  if (method === "GET" && path === "pulls") {
    const head = url.searchParams.get("head")?.split(":").at(-1);
    const base = url.searchParams.get("base");
    const stateFilter = url.searchParams.get("state") ?? "open";
    return respond(
      state.pulls
        .filter((pull) => head === undefined || pull.head === head)
        .filter((pull) => base === null || pull.base === base)
        .filter((pull) => stateFilter === "all" || pull.state === stateFilter)
        .map((pull) => pullView(state, pull)),
    );
  }
  if (method === "POST" && path === "pulls") {
    if (state.refs[body.head] === undefined)
      return respond({ message: "Validation Failed", errors: [{ field: "head" }] }, 422);
    if (state.pulls.some((pull) => pull.head === body.head && pull.base === body.base && pull.state === "open"))
      return respond({ message: "Validation Failed", errors: [{ message: "A pull request already exists" }] }, 422);
    const pull = {
      number: state.nextPull,
      title: body.title,
      body: body.body ?? "",
      head: body.head,
      base: body.base,
      headSha: state.refs[body.head],
      draft: body.draft === true,
      state: "open",
      merged: false,
      author,
    };
    state.nextPull += 1;
    state.pulls.push(pull);
    state.pullCreates = (state.pullCreates ?? 0) + 1;
    save(state);
    return respond(pullView(state, pull), 201);
  }
  const pullMatch = /^pulls\/(\d+)(\/.*)?$/u.exec(path);
  if (pullMatch !== null) {
    const pull = state.pulls.find((candidate) => candidate.number === Number(pullMatch[1]));
    if (pull === undefined) return respond({ message: "Not Found" }, 404);
    const rest = pullMatch[2] ?? "";
    if (method === "GET" && rest === "") return respond(pullView(state, pull));
    if (method === "GET" && rest === "/files") return respond(changedFiles(state, pull.base, pull.head));
    if (method === "GET" && (rest === "/comments" || rest === "/reviews" || rest === "/commits")) return respond([]);
    if (method === "PATCH" && rest === "") {
      Object.assign(pull, {
        title: body.title ?? pull.title,
        body: body.body ?? pull.body,
        state: body.state ?? pull.state,
      });
      save(state);
      return respond(pullView(state, pull));
    }
  }
  return undefined;
}

function graphql(state, body, persist) {
  const query = String(body?.query ?? "");
  const variables = body?.variables ?? {};
  if (query.includes("updateRefs")) {
    for (const update of variables.input?.refUpdates ?? []) {
      const name = String(update.name).replace(/^refs\/heads\//u, "");
      if ((state.refs[name] ?? null) !== (update.beforeOid === "0".repeat(40) ? null : update.beforeOid))
        return respond({ errors: [{ type: "STALE_DATA", message: "Reference update conflict" }] });
      if (update.afterOid === "0".repeat(40)) delete state.refs[name];
      else state.refs[name] = update.afterOid;
    }
    persist(state);
    return respond({ data: { updateRefs: { clientMutationId: null } } });
  }
  if (query.includes("markPullRequestReadyForReview")) {
    const pull = state.pulls.find(
      (candidate) =>
        `PR_${candidate.number}` === variables.input?.pullRequestId ||
        `PR_${candidate.number}` === variables.pullRequestId,
    );
    if (pull !== undefined) {
      pull.draft = false;
      persist(state);
      return respond({
        data: {
          markPullRequestReadyForReview: {
            pullRequest: { id: `PR_${pull.number}`, number: pull.number, state: "OPEN", isDraft: false },
          },
        },
      });
    }
  }
  return respond({ errors: [{ message: "Unmatched Golden Path GraphQL request" }] });
}

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    return nativeFetch(input, init);
  const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const rawBody = typeof init?.body === "string" ? init.body : init?.body === undefined ? undefined : String(init.body);
  const response = await handle(url, method, headers, rawBody);
  const role =
    process.env.INARI_GP_ROLE ?? process.argv.find((value) => value === "admission" || value === "executor") ?? "cli";
  appendFileSync(
    logFile,
    JSON.stringify({
      role,
      method,
      origin: url.origin,
      route: decodeURIComponent(url.pathname),
      search: url.search,
      status: response?.status ?? 404,
      unmatched: response === undefined,
      authorization: /gp-user/u.test(headers.get("authorization") ?? "")
        ? "user"
        : /gp-installation/u.test(headers.get("authorization") ?? "")
          ? "installation"
          : (headers.get("authorization") ?? "").startsWith("Bearer ey")
            ? "app-jwt"
            : "none",
    }) + "\n",
  );
  return response ?? respond({ message: "Unmatched Golden Path provider route" }, 404);
};
