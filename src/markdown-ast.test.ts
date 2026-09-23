import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdownStructure } from "./markdown-ast.js";

test("recognizes ATX and ambiguous indented ATX headings with source ranges", () => {
  const structure = parseMarkdownStructure("## Summary\n\nBody text.\n\n# Title ##\n");
  assert.deepEqual(
    structure.headings.map((heading) => ({ ...heading })),
    [
      { startLine: 1, endLine: 1, depth: 2, title: "Summary", indented: false },
      { startLine: 5, endLine: 5, depth: 1, title: "Title", indented: false },
    ],
  );

  const indented = parseMarkdownStructure("  ## Indented\n");
  assert.equal(indented.headings[0]?.indented, true);
  assert.equal(indented.headings[0]?.title, "Indented");
});

test("recognizes setext headings and captures only the title's final source line", () => {
  const structure = parseMarkdownStructure("Summary\n=======\n\n### Tasks\n1. [ ] First\n2. [x] Second\n");
  assert.deepEqual(
    structure.headings.map((heading) => ({
      startLine: heading.startLine,
      endLine: heading.endLine,
      depth: heading.depth,
      title: heading.title,
    })),
    [
      { startLine: 1, endLine: 2, depth: 1, title: "Summary" },
      { startLine: 4, endLine: 4, depth: 3, title: "Tasks" },
    ],
  );
});

test("headings preserve literal inline Markdown syntax via source slicing, not AST stringification", () => {
  const structure = parseMarkdownStructure("## **Bold** \\# Title\n");
  assert.equal(structure.headings[0]?.title, "**Bold** \\# Title");
});

test("an empty heading has an empty title", () => {
  const structure = parseMarkdownStructure("##\n");
  assert.deepEqual(structure.headings[0], { startLine: 1, endLine: 1, depth: 2, title: "", indented: false });
});

test("recognizes ordinary and GFM task-list items, including nesting depth and blockquote context", () => {
  const structure = parseMarkdownStructure("- [ ] Task\n- Ordinary\n- [x] Done\n");
  assert.deepEqual(
    structure.listItems.map((item) => ({ ...item })),
    [
      { startLine: 1, endLine: 1, checked: false, label: "Task", depth: 0, blockquoted: false },
      { startLine: 2, endLine: 2, checked: undefined, label: "", depth: 0, blockquoted: false },
      { startLine: 3, endLine: 3, checked: true, label: "Done", depth: 0, blockquoted: false },
    ],
  );

  const nested = parseMarkdownStructure("- [ ] Parent\n  - [ ] Child\n    - [ ] Grandchild\n");
  assert.deepEqual(
    nested.listItems.map((item) => ({ label: item.label, depth: item.depth })),
    [
      { label: "Parent", depth: 0 },
      { label: "Child", depth: 1 },
      { label: "Grandchild", depth: 2 },
    ],
  );

  const blockquoted = parseMarkdownStructure("> - [ ] Blockquoted\n");
  assert.equal(blockquoted.listItems[0]?.blockquoted, true);

  const orderedParen = parseMarkdownStructure("1) [ ] Paren marker\n");
  assert.equal(orderedParen.listItems[0]?.checked, false);
  assert.equal(orderedParen.listItems[0]?.label, "Paren marker");
});

test("task labels preserve inline Markdown syntax and are confined to the item's first source line", () => {
  const formatted = parseMarkdownStructure("- [ ] **Bold** label\n");
  assert.equal(formatted.listItems[0]?.label, "**Bold** label");

  const lazyContinuation = parseMarkdownStructure("- [ ] Task\n  continued text\n");
  assert.equal(lazyContinuation.listItems.length, 1);
  assert.equal(lazyContinuation.listItems[0]?.label, "Task");
});

test("recognizes fenced code blocks and keeps heading/task-shaped content inside them out of structure", () => {
  const structure = parseMarkdownStructure("```markdown\n## Not a section\n- [ ] Not a task\n```\n");
  assert.equal(structure.headings.length, 0);
  assert.equal(structure.listItems.length, 0);
  assert.deepEqual(structure.opaqueBlocks, [{ startLine: 1, endLine: 4, kind: "fenced-code" }]);
});

test("recognizes indented code blocks distinctly from fenced code blocks", () => {
  const structure = parseMarkdownStructure("    plain indented code\n");
  assert.deepEqual(structure.opaqueBlocks, [{ startLine: 1, endLine: 1, kind: "indented-code" }]);
});

test("recognizes HTML blocks, including comments that never close within the document", () => {
  const closed = parseMarkdownStructure("<!-- note -->\n\nBody\n");
  assert.deepEqual(closed.opaqueBlocks, [{ startLine: 1, endLine: 1, kind: "html" }]);
  assert.equal(closed.headings.length, 0);

  const unclosed = parseMarkdownStructure("<!-- unclosed\n## Hidden\n");
  assert.equal(unclosed.headings.length, 0);
  assert.equal(unclosed.opaqueBlocks.length, 1);
  assert.equal(unclosed.opaqueBlocks[0]?.kind, "html");
  const raw = unclosed.sourceSlice(unclosed.opaqueBlocks[0]!);
  assert.ok(raw.startsWith("<!--"));
  assert.equal(raw.includes("-->"), false);
});

test("sourceSlice returns the exact original text for a given inclusive line range", () => {
  const source = "## Title\n\nFirst paragraph line one.\nFirst paragraph line two.\n\n- [ ] Item\n";
  const structure = parseMarkdownStructure(source);
  assert.equal(
    structure.sourceSlice({ startLine: 3, endLine: 4 }),
    "First paragraph line one.\nFirst paragraph line two.",
  );
  assert.equal(structure.sourceSlice({ startLine: 1, endLine: 1 }), "## Title");
});

test("normalizes CRLF line endings to the same structure and line numbers as LF source", () => {
  const lf = parseMarkdownStructure("## Summary\r\n\r\n- [ ] Task\r\ncontinued\r\n");
  assert.deepEqual(
    lf.headings.map((heading) => ({ startLine: heading.startLine, endLine: heading.endLine, title: heading.title })),
    [{ startLine: 1, endLine: 1, title: "Summary" }],
  );
  assert.deepEqual(
    lf.listItems.map((item) => ({ startLine: item.startLine, checked: item.checked, label: item.label })),
    [{ startLine: 3, checked: false, label: "Task" }],
  );
});

test("strips a leading byte-order mark before computing heading positions and titles", () => {
  const structure = parseMarkdownStructure("﻿## Summary\n\nBody\n");
  assert.deepEqual(structure.headings, [{ startLine: 1, endLine: 1, depth: 2, title: "Summary", indented: false }]);
});
