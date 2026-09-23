/**
 * Bounded CommonMark/GFM Markdown structure adapter.
 *
 * Wraps the minimal mdast/micromark GFM parser stack (mdast-util-from-markdown
 * + mdast-util-gfm + micromark-extension-gfm) and exposes only the structure
 * Inari needs: headings, list/task-list items, opaque (fenced/indented code
 * and HTML) blocks, and a source-slicing helper. Callers are responsible for
 * semantic admission decisions; this module owns Markdown grammar and source
 * positions only. It never stringifies the AST to reconstruct free text -
 * every returned text value is a slice of the original source.
 */
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Code, Html, List, ListItem, Nodes } from "mdast";

/** An inclusive 1-based line range in the parsed source. */
export interface MarkdownSourceRange {
  readonly startLine: number;
  readonly endLine: number;
}

/** A top-level (document-root) ATX or setext heading. */
export interface MarkdownHeading extends MarkdownSourceRange {
  readonly depth: number;
  /** Literal source text of the heading title; never AST-stringified. */
  readonly title: string;
  /** True when an ATX heading marker is preceded by leading whitespace. */
  readonly indented: boolean;
}

/** One list item anywhere in the document, GFM task state included. */
export interface MarkdownListItem extends MarkdownSourceRange {
  /** `undefined` for an ordinary (non-task) item. */
  readonly checked: boolean | undefined;
  /** Literal source text following the task marker, confined to its first line; `""` for ordinary items. */
  readonly label: string;
  /** List-nesting depth; `0` for an item directly under the document root. */
  readonly depth: number;
  readonly blockquoted: boolean;
}

/** A fenced/indented code block or an HTML block, opaque to further Markdown recognition. */
export interface MarkdownOpaqueBlock extends MarkdownSourceRange {
  readonly kind: "fenced-code" | "indented-code" | "html";
}

export interface MarkdownStructure {
  readonly headings: readonly MarkdownHeading[];
  readonly listItems: readonly MarkdownListItem[];
  readonly opaqueBlocks: readonly MarkdownOpaqueBlock[];
  /** Exact original source text for an inclusive 1-based line range. */
  sourceSlice(range: MarkdownSourceRange): string;
}

const FENCE_PATTERN = /^ {0,3}(?:`{3,}|~{3,})/u;

/** Parse CommonMark/GFM source into the bounded structure Inari consumes. */
export function parseMarkdownStructure(rawSource: string): MarkdownStructure {
  // CommonMark's own preprocessing step discards a leading byte-order mark;
  // mdast's source offsets are computed against the BOM-stripped text, so
  // this module strips it up front to keep its own offset-based slicing
  // (heading titles) aligned with those offsets.
  const source = rawSource.replace(/^﻿/u, "");
  // Split on the same line-ending forms CommonMark treats as one line break
  // so `rawLines` indexing stays aligned with mdast's own 1-based line
  // numbers regardless of whether the caller has already normalized CRLF.
  const rawLines = source.split(/\r\n|\r|\n/u);
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });

  const headings = tree.children
    .filter((node): node is Extract<Nodes, { type: "heading" }> => node.type === "heading")
    .map((node) => extractHeading(node, rawLines, source));

  const listItems: MarkdownListItem[] = [];
  collectListItems(tree, 0, false, rawLines, listItems);

  const opaqueBlocks: MarkdownOpaqueBlock[] = [];
  collectOpaqueBlocks(tree, rawLines, opaqueBlocks);

  return {
    headings,
    listItems,
    opaqueBlocks,
    sourceSlice: (range) => rawLines.slice(range.startLine - 1, range.endLine).join("\n"),
  };
}

function extractHeading(
  node: Extract<Nodes, { type: "heading" }>,
  rawLines: readonly string[],
  source: string,
): MarkdownHeading {
  const position = node.position;
  if (position === undefined) throw new Error("Markdown heading is missing source position information.");

  const isSetext = position.end.line > position.start.line;
  if (isSetext) {
    const titleLine = position.end.line - 1;
    const title = (rawLines[titleLine - 1] ?? "").trim();
    return { startLine: titleLine, endLine: position.end.line, depth: node.depth, title, indented: false };
  }

  const children = node.children;
  const title =
    children.length === 0
      ? ""
      : source.slice(
          children[0]?.position?.start.offset ?? 0,
          children[children.length - 1]?.position?.end.offset ?? 0,
        );
  return {
    startLine: position.start.line,
    endLine: position.end.line,
    depth: node.depth,
    title,
    indented: position.start.column > 1,
  };
}

function collectListItems(
  node: Nodes,
  depth: number,
  blockquoted: boolean,
  rawLines: readonly string[],
  out: MarkdownListItem[],
): void {
  if (node.type === "list") {
    const list = node as List;
    for (const item of list.children) {
      out.push(extractListItem(item, depth, blockquoted, rawLines));
      collectListItems(item, depth + 1, blockquoted, rawLines, out);
    }
    return;
  }
  if (node.type === "blockquote") {
    for (const child of (node as Nodes & { children: Nodes[] }).children) {
      collectListItems(child, depth, true, rawLines, out);
    }
    return;
  }
  const children = (node as { children?: Nodes[] }).children;
  if (children !== undefined) {
    for (const child of children) collectListItems(child, depth, blockquoted, rawLines, out);
  }
}

function extractListItem(
  item: ListItem,
  depth: number,
  blockquoted: boolean,
  rawLines: readonly string[],
): MarkdownListItem {
  const position = item.position;
  if (position === undefined) throw new Error("Markdown list item is missing source position information.");

  const checked = item.checked === null || item.checked === undefined ? undefined : item.checked;
  const label = checked === undefined ? "" : extractTaskLabel(item, rawLines);
  return { startLine: position.start.line, endLine: position.end.line, checked, label, depth, blockquoted };
}

function extractTaskLabel(item: ListItem, rawLines: readonly string[]): string {
  const first = item.children[0];
  if (first === undefined || first.type !== "paragraph" || first.children.length === 0) return "";
  const start = first.children[0]?.position?.start;
  if (start === undefined) return "";
  const lineText = rawLines[start.line - 1] ?? "";
  return lineText.slice(start.column - 1).trim();
}

function collectOpaqueBlocks(node: Nodes, rawLines: readonly string[], out: MarkdownOpaqueBlock[]): void {
  if (node.type === "code") {
    const code = node as Code;
    const position = code.position;
    if (position !== undefined) {
      const kind = FENCE_PATTERN.test(rawLines[position.start.line - 1] ?? "") ? "fenced-code" : "indented-code";
      out.push({ startLine: position.start.line, endLine: position.end.line, kind });
    }
    return;
  }
  if (node.type === "html") {
    const html = node as Html;
    const position = html.position;
    if (position !== undefined) {
      out.push({ startLine: position.start.line, endLine: position.end.line, kind: "html" });
    }
    return;
  }
  const children = (node as { children?: Nodes[] }).children;
  if (children !== undefined) {
    for (const child of children) collectOpaqueBlocks(child, rawLines, out);
  }
}
