import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseTemplateResolutionConfig,
  resolveTemplate,
  TemplateResolutionError,
  type TemplateResolutionCandidate,
} from "./template-resolver.js";

function candidate(id: string, kind: "issue" | "pr", name = id): TemplateResolutionCandidate<{ readonly id: string }> {
  return {
    id,
    kind,
    name,
    paths: [`.github/templates/${id}.template`],
    value: { id },
  };
}

test("explicit selector wins over a configured default for both Issue and PR", async () => {
  for (const kind of ["issue", "pr"] as const) {
    const result = await resolveTemplate({
      candidates: [candidate("configured", kind), candidate("explicit", kind)],
      selector: "explicit",
      configuredDefault: "missing-default",
    });
    assert.equal(result.id, "explicit", kind);
  }
});

test("configured defaults are selected before sole-candidate and interactive resolution", async () => {
  for (const kind of ["issue", "pr"] as const) {
    const result = await resolveTemplate({
      candidates: [candidate("other", kind), candidate("configured", kind)],
      configuredDefault: "configured",
      dependencies: { isInteractive: () => false },
    });
    assert.equal(result.id, "configured", kind);
  }
});

test("a sole candidate is selected without a selector or TTY", async () => {
  const result = await resolveTemplate({
    candidates: [candidate("only", "issue")],
    dependencies: { isInteractive: () => false },
  });
  assert.equal(result.id, "only");
});

test("multiple candidates use the deterministic interactive choice seam", async () => {
  const result = await resolveTemplate({
    candidates: [candidate("zulu", "pr"), candidate("alpha", "pr"), candidate("bravo", "pr")],
    dependencies: {
      isInteractive: () => true,
      select: ({ candidates }) => {
        assert.deepEqual(
          candidates.map((entry) => entry.id),
          ["alpha", "bravo", "zulu"],
        );
        return candidates[1]?.id ?? "";
      },
    },
  });
  assert.equal(result.id, "bravo");
});

test("multiple non-interactive candidates fail with bounded identifiers and recovery", async () => {
  const candidates = Array.from({ length: 20 }, (_, index) =>
    candidate(`template-${String(index).padStart(2, "0")}`, "issue"),
  );
  await assert.rejects(
    resolveTemplate({ candidates, dependencies: { isInteractive: () => false } }),
    (error: unknown) => {
      assert.ok(error instanceof TemplateResolutionError);
      assert.equal(error.code, "TEMPLATE_RESOLUTION_AMBIGUOUS");
      assert.equal(error.details.candidates.length, 8);
      assert.equal(error.details.candidateCount, 20);
      assert.equal(error.details.candidatesTruncated, true);
      assert.equal(error.details.recovery[0]?.action, "provide-explicit-selector");
      assert.match(error.message, /--template <template>/u);
      assert.doesNotMatch(error.message, /template-19/u);
      return true;
    },
  );
});

test("invalid and unavailable configured defaults fail closed", async () => {
  await assert.rejects(
    resolveTemplate({
      candidates: [candidate("one", "issue"), candidate("two", "issue")],
      configuredDefault: {} as never,
    }),
    (error: unknown) =>
      error instanceof TemplateResolutionError && error.code === "TEMPLATE_RESOLUTION_DEFAULT_INVALID",
  );
  await assert.rejects(
    resolveTemplate({
      candidates: [candidate("one", "issue"), candidate("two", "issue")],
      configuredDefault: "not-available",
    }),
    (error: unknown) =>
      error instanceof TemplateResolutionError && error.code === "TEMPLATE_RESOLUTION_DEFAULT_UNAVAILABLE",
  );
});

test("explicit selectors preserve id, path, and case-insensitive name compatibility", async () => {
  const templates = [candidate("feature", "issue", "Feature"), candidate("bug", "issue", "Bug")];
  assert.equal((await resolveTemplate({ candidates: templates, selector: "feature" })).id, "feature");
  assert.equal(
    (await resolveTemplate({ candidates: templates, selector: ".github/templates/bug.template" })).id,
    "bug",
  );
  assert.equal((await resolveTemplate({ candidates: templates, selector: "FEATURE" })).id, "feature");
});

test("the documented repository configuration parses one canonical default authority", () => {
  assert.deepEqual(parseTemplateResolutionConfig("version: 1\ndefaults:\n  issue: feature\n  pr: default\n"), {
    version: 1,
    defaults: { issue: "feature", pr: "default" },
  });
  assert.throws(
    () => parseTemplateResolutionConfig('version: 1\ndefaults:\n  issue: ""\n'),
    (error: unknown) => error instanceof TemplateResolutionError && error.code === "TEMPLATE_CONFIG_INVALID",
  );
});
