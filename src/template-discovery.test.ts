import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  InvalidTemplateSelectorError,
  TemplateDiscoveryError,
  TemplateFilesystemError,
  TemplateNameConflictError,
  TemplateNotFoundError,
  TemplateSelectionAmbiguousError,
  discoverTemplates,
  discoverTemplatesSync,
  selectIssueTemplate,
  selectPullRequestTemplate,
  selectTemplate,
} from "./template-discovery.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/template-discovery", import.meta.url));
const COMPLETE_FIXTURE = path.join(FIXTURES, "complete");
const CONFLICTING_NAMES_FIXTURE = path.join(FIXTURES, "conflicting-names");

test("discovers all supported GitHub-native locations in deterministic order", async () => {
  const discovery = await discoverTemplates(COMPLETE_FIXTURE);

  assert.deepEqual(
    discovery.templates.map(({ id, type, kind, name, path: templatePath }) => ({
      id,
      type,
      kind,
      name,
      path: templatePath,
    })),
    [
      {
        id: "issue-form:.github/ISSUE_TEMPLATE/bug.yml",
        type: "issue-form",
        kind: "issue",
        name: "bug",
        path: ".github/ISSUE_TEMPLATE/bug.yml",
      },
      {
        id: "issue-form:.github/ISSUE_TEMPLATE/question.yaml",
        type: "issue-form",
        kind: "issue",
        name: "question",
        path: ".github/ISSUE_TEMPLATE/question.yaml",
      },
      {
        id: "issue-markdown:.github/ISSUE_TEMPLATE/feature.md",
        type: "issue-markdown",
        kind: "issue",
        name: "feature",
        path: ".github/ISSUE_TEMPLATE/feature.md",
      },
      {
        id: "pull-request-default:.github/PULL_REQUEST_TEMPLATE.md",
        type: "pull-request-default",
        kind: "pull-request",
        name: "default",
        path: ".github/PULL_REQUEST_TEMPLATE.md",
      },
      {
        id: "pull-request:.github/PULL_REQUEST_TEMPLATE/maintenance.md",
        type: "pull-request",
        kind: "pull-request",
        name: "maintenance",
        path: ".github/PULL_REQUEST_TEMPLATE/maintenance.md",
      },
      {
        id: "pull-request:.github/PULL_REQUEST_TEMPLATE/release.md",
        type: "pull-request",
        kind: "pull-request",
        name: "release",
        path: ".github/PULL_REQUEST_TEMPLATE/release.md",
      },
    ],
  );
  assert.equal(discovery.repositoryRoot, path.resolve(COMPLETE_FIXTURE));
  assert.deepEqual(discovery.issueTemplates, discovery.templates.slice(0, 3));
  assert.deepEqual(discovery.pullRequestTemplates, discovery.templates.slice(3));
  assert.equal(
    discovery.templates.some(({ name }) => name === "config"),
    false,
  );
  assert.equal(
    discovery.templates.some(({ path: templatePath }) => templatePath.endsWith("README.txt")),
    false,
  );

  const secondDiscovery = await discoverTemplates(COMPLETE_FIXTURE);
  assert.deepEqual(secondDiscovery, discovery);
  assert.deepEqual(discoverTemplatesSync(COMPLETE_FIXTURE), discovery);
});

test("discovery does not parse template contents", async () => {
  const malformedIssueForm = path.join(CONFLICTING_NAMES_FIXTURE, ".github", "ISSUE_TEMPLATE", "bug.yml");
  const contents = await readFile(malformedIssueForm, "utf8");
  assert.equal(contents, "not: an Issue Form\n");

  const discovery = await discoverTemplates(CONFLICTING_NAMES_FIXTURE);
  assert.equal(discovery.issueTemplates.length, 2);
  assert.equal(
    discovery.issueTemplates.every(({ type }) => type === "issue-form"),
    true,
  );
});

test("selects by stable ID, path, and unique name", async () => {
  const discovery = await discoverTemplates(COMPLETE_FIXTURE);

  assert.equal(selectTemplate(discovery, "issue-form:.github/ISSUE_TEMPLATE/bug.yml").name, "bug");
  assert.equal(selectTemplate(discovery, ".github/ISSUE_TEMPLATE/feature.md").type, "issue-markdown");
  assert.equal(selectTemplate(discovery, "RELEASE").id, "pull-request:.github/PULL_REQUEST_TEMPLATE/release.md");
  assert.equal(selectIssueTemplate(discovery, { type: "issue-markdown", name: "feature" }).name, "feature");
  assert.equal(selectPullRequestTemplate(discovery, { kind: "pull-request", name: "maintenance" }).name, "maintenance");
});

test("missing and ambiguous selections fail closed with typed errors", async () => {
  const discovery = await discoverTemplates(COMPLETE_FIXTURE);

  assert.throws(
    () => selectTemplate(discovery),
    (error: unknown) =>
      error instanceof TemplateSelectionAmbiguousError && error.code === "TEMPLATE_SELECTION_AMBIGUOUS",
  );
  assert.throws(
    () => selectIssueTemplate(discovery),
    (error: unknown) => error instanceof TemplateSelectionAmbiguousError,
  );
  assert.throws(
    () => selectTemplate(discovery, "does-not-exist"),
    (error: unknown) => error instanceof TemplateNotFoundError && error.code === "TEMPLATE_NOT_FOUND",
  );
  assert.throws(
    () => selectTemplate(discovery, {}),
    (error: unknown) => error instanceof InvalidTemplateSelectorError && error.code === "INVALID_TEMPLATE_SELECTOR",
  );
});

test("duplicate and conflicting names fail closed while exact IDs remain selectable", async () => {
  const discovery = await discoverTemplates(CONFLICTING_NAMES_FIXTURE);

  assert.throws(
    () => selectIssueTemplate(discovery, { name: "bug" }),
    (error: unknown) => error instanceof TemplateNameConflictError && error.code === "TEMPLATE_NAME_CONFLICT",
  );
  assert.throws(
    () => selectPullRequestTemplate(discovery, { name: "default" }),
    (error: unknown) => error instanceof TemplateNameConflictError,
  );
  assert.equal(
    selectIssueTemplate(discovery, "issue-form:.github/ISSUE_TEMPLATE/bug.yml").path,
    ".github/ISSUE_TEMPLATE/bug.yml",
  );
  assert.equal(
    selectPullRequestTemplate(discovery, "pull-request-default:.github/PULL_REQUEST_TEMPLATE.md").name,
    "default",
  );
});

test("a repository without .github has an empty discovery result", async () => {
  await withTemporaryRepository(async (repositoryRoot) => {
    const discovery = await discoverTemplates(repositoryRoot);
    assert.deepEqual(discovery.templates, []);
    assert.deepEqual(discovery.issueTemplates, []);
    assert.deepEqual(discovery.pullRequestTemplates, []);
    assert.throws(
      () => selectTemplate(discovery),
      (error: unknown) => error instanceof TemplateNotFoundError && error.code === "TEMPLATE_NOT_FOUND",
    );
  });
});

test("malformed template filesystem shapes fail closed", async () => {
  await withTemporaryRepository(async (repositoryRoot) => {
    const githubPath = path.join(repositoryRoot, ".github");
    await writeFile(githubPath, "not a directory\n");
    await assert.rejects(
      discoverTemplates(repositoryRoot),
      (error: unknown) => error instanceof TemplateFilesystemError && error.code === "TEMPLATE_FILESYSTEM_MALFORMED",
    );
  });

  await withTemporaryRepository(async (repositoryRoot) => {
    const githubPath = path.join(repositoryRoot, ".github");
    await mkdir(githubPath);
    await writeFile(path.join(githubPath, "ISSUE_TEMPLATE"), "not a directory\n");
    await assert.rejects(
      discoverTemplates(repositoryRoot),
      (error: unknown) => error instanceof TemplateFilesystemError,
    );
  });

  await withTemporaryRepository(async (repositoryRoot) => {
    const githubPath = path.join(repositoryRoot, ".github");
    await mkdir(path.join(githubPath, "ISSUE_TEMPLATE"), { recursive: true });
    await mkdir(path.join(githubPath, "PULL_REQUEST_TEMPLATE.md"));
    await assert.rejects(
      discoverTemplates(repositoryRoot),
      (error: unknown) => error instanceof TemplateFilesystemError,
    );
  });

  await withTemporaryRepository(async (repositoryRoot) => {
    const issueDirectory = path.join(repositoryRoot, ".github", "ISSUE_TEMPLATE");
    await mkdir(path.join(issueDirectory, "nested"), { recursive: true });
    await writeFile(path.join(issueDirectory, "nested", "bug.md"), "## Bug\n");
    await assert.rejects(
      discoverTemplates(repositoryRoot),
      (error: unknown) => error instanceof TemplateFilesystemError,
    );
  });

  await withTemporaryRepository(async (repositoryRoot) => {
    const issueDirectory = path.join(repositoryRoot, ".github", "ISSUE_TEMPLATE");
    await mkdir(issueDirectory, { recursive: true });
    const target = path.join(repositoryRoot, "outside.md");
    await writeFile(target, "## Outside\n");
    await symlink(target, path.join(issueDirectory, "linked.md"));
    await assert.rejects(
      discoverTemplates(repositoryRoot),
      (error: unknown) => error instanceof TemplateFilesystemError,
    );
  });
});

async function withTemporaryRepository<T>(callback: (repositoryRoot: string) => Promise<T>): Promise<T> {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "inari-template-discovery-"));
  try {
    return await callback(repositoryRoot);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
}
