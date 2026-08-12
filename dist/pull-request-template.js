import { readFile as readFileAsync } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertCanonicalContract, CANONICAL_IR_VERSION, CONTRACT_SCHEMA_VERSION, } from "./contract/ir.js";
import { discoverTemplates, discoverTemplatesSync, selectPullRequestTemplate, } from "./template-discovery.js";
/** A typed failure raised when the supported PR-template subset cannot be represented safely. */
export class PullRequestTemplateError extends Error {
    code;
    details;
    constructor(code, message, details = {}, options) {
        super(message, options);
        this.name = "PullRequestTemplateError";
        this.code = code;
        this.details = details;
    }
    toJSON() {
        return { code: this.code, message: this.message, details: this.details };
    }
}
/**
 * Parse one repository-native PR template into the existing canonical IR.
 *
 * The identity is deliberately the discovery-layer identity. This keeps
 * filesystem discovery and parsing as separate concerns while ensuring the
 * compiled contract cannot be detached from a native template path.
 */
export function parsePullRequestTemplate(markdown, identity) {
    assertPullRequestIdentity(identity);
    if (typeof markdown !== "string") {
        throw new PullRequestTemplateError("PR_TEMPLATE_UNSUPPORTED_CONSTRUCT", "Pull request template content must be a string.", { reason: "non-string template content" });
    }
    const lines = normalizeSource(markdown).split("\n");
    const lexedLines = lexLines(lines);
    assertNoUnsupportedTaskContexts(lexedLines);
    const headings = findHeadings(lexedLines);
    const sections = [];
    const usedIds = new Set();
    if (headings.length === 0) {
        const content = trimBlankLines(lines.join("\n"));
        if (content === undefined) {
            throw new PullRequestTemplateError("PR_TEMPLATE_EMPTY", "Pull request template contains no renderable content.");
        }
        if (containsTopLevelTask(lexedLines)) {
            throw new PullRequestTemplateError("PR_TEMPLATE_UNSUPPORTED_CONSTRUCT", "A top-level checklist requires a heading section in the supported PR-template representation.", { construct: "top-level checklist" });
        }
        sections.push(createDocumentationSection(content, 0, usedIds));
    }
    else {
        const preamble = trimBlankLines(lines.slice(0, headings[0]?.start ?? 0).join("\n"));
        if (preamble !== undefined)
            sections.push(createDocumentationSection(preamble, sections.length, usedIds, "preamble_content"));
        headings.forEach((heading, headingIndex) => {
            const nextHeading = headings[headingIndex + 1];
            const bodyStart = heading.end + 1;
            const bodyEnd = nextHeading?.start ?? lines.length;
            const body = lexedLines.slice(bodyStart, bodyEnd);
            sections.push(...createInputSections(heading, body, sections.length, usedIds));
        });
    }
    const contract = {
        irVersion: CANONICAL_IR_VERSION,
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        artifactKind: "pull_request",
        templateIdentity: {
            id: toCanonicalIdentifier(identity.id, "template"),
            name: identity.name,
            path: identity.path,
            source: "pull_request_template",
        },
        nativeMetadata: {
            source: "pull_request_template",
            path: identity.path,
        },
        sections,
        supplementalConstraints: { fields: [] },
    };
    assertCanonicalContract(contract);
    return contract;
}
/** Compile one discovered native PR template from a repository root. */
export async function compilePullRequestTemplate(repositoryRoot = process.cwd(), selector) {
    const discovery = await discoverTemplates(repositoryRoot);
    const identity = selectPullRequestTemplate(discovery, selector);
    return parsePullRequestTemplate(await readTemplate(discovery.repositoryRoot, identity), identity);
}
/** Synchronous counterpart for callers that already operate synchronously. */
export function compilePullRequestTemplateSync(repositoryRoot = process.cwd(), selector) {
    const discovery = discoverTemplatesSync(repositoryRoot);
    const identity = selectPullRequestTemplate(discovery, selector);
    return parsePullRequestTemplate(readTemplateSync(discovery.repositoryRoot, identity), identity);
}
/** Compile all native PR templates in the discovery layer's stable order. */
export async function compilePullRequestTemplates(repositoryRoot = process.cwd()) {
    const discovery = await discoverTemplates(repositoryRoot);
    return Promise.all(discovery.pullRequestTemplates.map(async (identity) => parsePullRequestTemplate(await readTemplate(discovery.repositoryRoot, identity), identity)));
}
/** Synchronous counterpart of compilePullRequestTemplates. */
export function compilePullRequestTemplatesSync(repositoryRoot = process.cwd()) {
    const discovery = discoverTemplatesSync(repositoryRoot);
    return discovery.pullRequestTemplates.map((identity) => parsePullRequestTemplate(readTemplateSync(discovery.repositoryRoot, identity), identity));
}
/**
 * Render the structural portion of a validated PR contract as canonical GFM.
 * No placeholder, requirement, or policy is invented when the IR does not
 * contain one.
 */
export function renderPullRequestTemplate(input) {
    assertCanonicalContract(input);
    if (input.artifactKind !== "pull_request") {
        throw new PullRequestTemplateError("PR_TEMPLATE_NOT_PULL_REQUEST", "Only pull request contracts can be rendered as pull request templates.");
    }
    const blocks = input.sections.map(renderSection).filter((block) => block.length > 0);
    if (blocks.length === 0) {
        throw new PullRequestTemplateError("PR_TEMPLATE_EMPTY", "Pull request contract contains no renderable sections.");
    }
    return `${blocks.join("\n\n")}\n`;
}
function createDocumentationSection(content, order, usedIds, base = "content") {
    const id = uniqueOrThrow(toCanonicalIdentifier(base, "content"), usedIds, undefined, "literal content section");
    return {
        id,
        kind: "documentation",
        content,
        render: { order },
        nativeMetadata: { elementType: "markdown", sourceId: id, markdown: content },
        fields: [],
    };
}
function createInputSections(heading, body, order, usedIds) {
    const id = uniqueOrThrow(toCanonicalIdentifier(heading.title, "section"), usedIds, heading.line, "heading section");
    const checklist = parseChecklistBody(body);
    const field = checklist === undefined
        ? createStringField(id, heading.title, body)
        : createChecklistField(id, heading.title, checklist);
    const sections = [
        {
            id,
            title: heading.title,
            kind: "input",
            render: { order, headingLevel: heading.level },
            nativeMetadata: { elementType: "heading", sourceId: id, headingLevel: heading.level },
            fields: [field],
        },
    ];
    if (checklist?.trailingContent !== undefined) {
        sections.push(createDocumentationSection(checklist.trailingContent, order + 1, usedIds, `content_after_${id}`));
    }
    return sections;
}
function createStringField(id, label, body) {
    const placeholder = trimBlankLines(body.map((line) => line.text).join("\n"));
    return {
        id,
        label,
        type: "string",
        required: "unknown",
        render: { order: 0 },
        nativeMetadata: {
            elementType: "pr_section",
            sourceId: id,
            ...(placeholder === undefined ? {} : { placeholder }),
        },
    };
}
function createChecklistField(id, label, body) {
    const items = [];
    const itemIds = new Set();
    const checked = [];
    body.items.forEach((item, index) => {
        const itemId = toCanonicalIdentifier(item.label, "item", index + 1);
        if (itemIds.has(itemId)) {
            throw new PullRequestTemplateError("PR_TEMPLATE_AMBIGUOUS_STRUCTURE", `Checklist item labels produce duplicate structural identity "${itemId}".`, { line: item.line, construct: "checklist item identity" });
        }
        itemIds.add(itemId);
        items.push({ id: itemId, label: item.label, required: false });
        if (item.checked)
            checked.push(itemId);
    });
    const defaultValue = checked.length === 0 ? undefined : checked;
    return {
        id,
        label,
        type: "checklist",
        required: "unknown",
        items,
        render: { order: 0 },
        nativeMetadata: {
            elementType: "pr_section",
            sourceId: id,
            ...(body.placeholder === undefined ? {} : { placeholder: body.placeholder }),
            ...(defaultValue === undefined ? {} : { defaultValue }),
            options: items.map((item) => ({ value: item.id })),
        },
        ...(defaultValue === undefined ? {} : { defaultValue }),
    };
}
function parseChecklistBody(body) {
    const tasks = [];
    body.forEach((line, sourceIndex) => {
        if (line.protected || line.text.trim().length === 0)
            return;
        const listItem = parseListItem(line.text);
        if (listItem === undefined)
            return;
        if (listItem.indent > 0 && listItem.task !== undefined) {
            throw new PullRequestTemplateError("PR_TEMPLATE_UNSUPPORTED_CONSTRUCT", "Nested task lists are not representable in the canonical PR section model.", { line: line.line, construct: "nested checklist" });
        }
        if (listItem.task === undefined) {
            return;
        }
        if (listItem.indent > 0) {
            throw new PullRequestTemplateError("PR_TEMPLATE_UNSUPPORTED_CONSTRUCT", "Indented checklist items are not representable in the canonical PR section model.", { line: line.line, construct: "nested checklist" });
        }
        tasks.push({
            line: line.line,
            sourceIndex,
            checked: listItem.task.checked,
            label: listItem.task.label,
        });
    });
    if (tasks.length === 0)
        return undefined;
    const firstTask = tasks[0];
    const lastTask = tasks[tasks.length - 1];
    if (firstTask === undefined || lastTask === undefined)
        return undefined;
    for (let index = firstTask.sourceIndex + 1; index < lastTask.sourceIndex; index += 1) {
        const line = body[index];
        if (line !== undefined &&
            !line.protected &&
            line.text.trim().length > 0 &&
            parseListItem(line.text)?.task === undefined) {
            throw new PullRequestTemplateError("PR_TEMPLATE_AMBIGUOUS_STRUCTURE", "Checklist items must form one contiguous structural block.", { line: line.line, construct: "checklist block" });
        }
    }
    const placeholder = trimBlankLines(body
        .slice(0, firstTask.sourceIndex)
        .map((line) => line.text)
        .join("\n"));
    const trailingContent = trimBlankLines(body
        .slice(lastTask.sourceIndex + 1)
        .map((line) => line.text)
        .join("\n"));
    return {
        items: tasks,
        ...(placeholder === undefined ? {} : { placeholder }),
        ...(trailingContent === undefined ? {} : { trailingContent }),
    };
}
function parseListItem(text) {
    const match = /^(?<indent>[ \t]*)(?<marker>[-+*]|\d+[.)])(?:[ \t]+)(?<rest>.*)$/u.exec(text);
    if (match === null)
        return undefined;
    const indentText = match.groups?.indent ?? "";
    const indent = [...indentText].reduce((total, character) => total + (character === "\t" ? 4 : 1), 0);
    const rest = match.groups?.rest ?? "";
    const taskMatch = /^\[([ xX])\](?:[ \t]+(.+)|[ \t]*)$/u.exec(rest);
    if (taskMatch === null)
        return { indent };
    const label = taskMatch[2]?.trim() ?? "";
    if (label.length === 0) {
        throw new PullRequestTemplateError("PR_TEMPLATE_UNSUPPORTED_CONSTRUCT", "Checklist items must contain a non-empty label.", { construct: "empty checklist item" });
    }
    return { indent, task: { checked: taskMatch[1]?.toLowerCase() === "x", label } };
}
function containsTopLevelTask(lexed) {
    return lexed.some((line) => !line.protected && parseListItem(line.text)?.task !== undefined);
}
function assertNoUnsupportedTaskContexts(lines) {
    for (const line of lines) {
        if (!line.protected && /^ {0,3}>[ \t]+(?:[-+*]|\d+[.)])[ \t]+\[[ xX]\]/u.test(line.text)) {
            throw new PullRequestTemplateError("PR_TEMPLATE_UNSUPPORTED_CONSTRUCT", "Checklist items inside blockquotes are not representable in the canonical PR section model.", { line: line.line, construct: "blockquote checklist" });
        }
    }
}
function findHeadings(lines) {
    const headings = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined || line.protected)
            continue;
        const atx = parseAtxHeading(line.text);
        if (atx !== undefined) {
            headings.push({ start: index, end: index, line: line.line, level: atx.level, title: atx.title });
            continue;
        }
        if (/^[ \t]+#{1,6}(?:[ \t]+|$)/u.test(line.text)) {
            throw new PullRequestTemplateError("PR_TEMPLATE_UNSUPPORTED_CONSTRUCT", "Indented headings are not supported because their list/block context is ambiguous.", { line: line.line, construct: "indented heading" });
        }
        const underline = lines[index + 1];
        if (underline === undefined || underline.protected || !/^([=-])\1{1,}[ \t]*$/u.test(underline.text))
            continue;
        const title = line.text.trim();
        if (title.length === 0 || isBlockLikeLine(line.text))
            continue;
        const level = underline.text.trimStart().startsWith("=") ? 1 : 2;
        headings.push({ start: index, end: index + 1, line: line.line, level, title });
        index += 1;
    }
    return headings;
}
function parseAtxHeading(text) {
    const match = /^(?<marks>#{1,6})(?:[ \t]+(?<title>.*?)|[ \t]*)$/u.exec(text);
    if (match === null)
        return undefined;
    let title = (match.groups?.title ?? "").trim();
    title = title.replace(/[ \t]+#+[ \t]*$/u, "").trim();
    if (title.length === 0) {
        throw new PullRequestTemplateError("PR_TEMPLATE_UNSUPPORTED_CONSTRUCT", "Headings must contain a title.", {
            construct: "empty heading",
        });
    }
    return { level: match.groups?.marks?.length ?? 1, title };
}
function isBlockLikeLine(text) {
    return /^(?:[ \t]*)(?:[-+*]|\d+[.)])[ \t]+|[ \t]*>|[ \t]*```|[ \t]*~~~|[ \t]*#/u.test(text);
}
function lexLines(lines) {
    const lexed = [];
    let fence;
    let commentStart;
    let commentOpen = false;
    lines.forEach((text, index) => {
        const line = index + 1;
        if (fence !== undefined) {
            lexed.push({ text, line, protected: true });
            if (isClosingFence(text, fence))
                fence = undefined;
            return;
        }
        if (commentOpen) {
            lexed.push({ text, line, protected: true });
            if (text.includes("-->") === true)
                commentOpen = false;
            return;
        }
        const openingFence = parseOpeningFence(text);
        if (openingFence !== undefined) {
            fence = openingFence;
            lexed.push({ text, line, protected: true });
            return;
        }
        const commentIndex = text.indexOf("<!--");
        if (commentIndex >= 0) {
            lexed.push({ text, line, protected: true });
            if (text.indexOf("-->", commentIndex + 4) < 0) {
                commentOpen = true;
                commentStart = line;
            }
            return;
        }
        lexed.push({ text, line, protected: false });
    });
    if (commentOpen) {
        throw new PullRequestTemplateError("PR_TEMPLATE_UNSUPPORTED_CONSTRUCT", "HTML comment is not closed.", {
            line: commentStart,
            construct: "unclosed HTML comment",
        });
    }
    return lexed;
}
function parseOpeningFence(text) {
    const match = /^(?: {0,3})(?<marker>`{3,}|~{3,})/u.exec(text);
    if (match === null)
        return undefined;
    const marker = match.groups?.marker;
    if (marker === undefined)
        return undefined;
    return { character: marker[0], length: marker.length };
}
function isClosingFence(text, fence) {
    const escapedCharacter = fence.character === "`" ? "`" : "~";
    const pattern = new RegExp(`^ {0,3}${escapedCharacter}{${fence.length},}[ \\t]*$`, "u");
    return pattern.test(text);
}
function normalizeSource(markdown) {
    return markdown.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
}
function trimBlankLines(value) {
    const lines = value.split("\n");
    while (lines[0] !== undefined && lines[0].trim().length === 0)
        lines.shift();
    while (lines.at(-1) !== undefined && lines.at(-1)?.trim().length === 0)
        lines.pop();
    if (lines.length === 0)
        return undefined;
    const result = lines.join("\n");
    return result.length === 0 ? undefined : result;
}
function uniqueOrThrow(base, usedIds, line, construct) {
    if (usedIds.has(base)) {
        throw new PullRequestTemplateError("PR_TEMPLATE_AMBIGUOUS_STRUCTURE", `Structural identity "${base}" is not unique in the template.`, { line, construct });
    }
    usedIds.add(base);
    return base;
}
function toCanonicalIdentifier(value, prefix, fallbackIndex) {
    let identifier = "";
    for (const character of value.normalize("NFKC")) {
        if (/^[A-Za-z0-9_-]$/u.test(character)) {
            identifier += character.toLocaleLowerCase("en-US");
        }
        else if (/^[\u0000-\u007F]$/u.test(character)) {
            if (!identifier.endsWith("_"))
                identifier += "_";
        }
        else {
            const codePoint = character.codePointAt(0);
            identifier += `_${(codePoint ?? 0).toString(16)}_`;
        }
    }
    identifier = identifier.replace(/^_+|_+$/gu, "");
    if (identifier.length === 0)
        identifier = `${prefix}_${fallbackIndex ?? 1}`;
    if (!/^[A-Za-z]/u.test(identifier))
        identifier = `${prefix}_${identifier}`;
    return identifier;
}
function assertPullRequestIdentity(identity) {
    if (identity.kind !== "pull-request") {
        throw new PullRequestTemplateError("PR_TEMPLATE_NOT_PULL_REQUEST", "Only repository-native pull request template identities can be compiled.", { path: identity.path, reason: "identity kind is not pull-request" });
    }
}
async function readTemplate(repositoryRoot, identity) {
    try {
        return await readFileAsync(path.join(repositoryRoot, identity.path), "utf8");
    }
    catch (error) {
        throw new PullRequestTemplateError("PR_TEMPLATE_READ_FAILED", `Cannot read pull request template ${identity.path}.`, { path: identity.path, reason: "filesystem read failed" }, { cause: error });
    }
}
function readTemplateSync(repositoryRoot, identity) {
    try {
        return readFileSync(path.join(repositoryRoot, identity.path), "utf8");
    }
    catch (error) {
        throw new PullRequestTemplateError("PR_TEMPLATE_READ_FAILED", `Cannot read pull request template ${identity.path}.`, { path: identity.path, reason: "filesystem read failed" }, { cause: error });
    }
}
function renderSection(section) {
    if (section.kind === "documentation") {
        const content = trimBlankLines(section.content ?? "");
        if (content === undefined)
            return "";
        if (section.title === undefined)
            return content;
        const level = section.render.headingLevel ?? section.nativeMetadata.headingLevel;
        if (level === undefined) {
            throw new PullRequestTemplateError("PR_TEMPLATE_UNSUPPORTED_CONSTRUCT", `Documentation section "${section.id}" has a title but no heading level.`, { construct: "documentation heading" });
        }
        return [`${"#".repeat(level)} ${section.title}`, content].join("\n\n");
    }
    if (section.title === undefined) {
        throw new PullRequestTemplateError("PR_TEMPLATE_UNSUPPORTED_CONSTRUCT", `Input section "${section.id}" has no heading title.`, { construct: "input section heading" });
    }
    const level = section.render.headingLevel ?? section.nativeMetadata.headingLevel;
    if (level === undefined) {
        throw new PullRequestTemplateError("PR_TEMPLATE_UNSUPPORTED_CONSTRUCT", `Input section "${section.id}" has no heading level.`, { construct: "input section heading" });
    }
    const blocks = [`${"#".repeat(level)} ${section.title}`];
    section.fields.forEach((field) => {
        if (field.type === "string") {
            appendOptionalBlock(blocks, field.nativeMetadata.placeholder);
            return;
        }
        if (field.type === "checklist") {
            appendOptionalBlock(blocks, field.nativeMetadata.placeholder);
            const checked = new Set(field.defaultValue ?? []);
            blocks.push(field.items.map((item) => `- [${checked.has(item.id) ? "x" : " "}] ${item.label}`).join("\n"));
            return;
        }
        throw new PullRequestTemplateError("PR_TEMPLATE_UNSUPPORTED_CONSTRUCT", `Field type "${field.type}" cannot be rendered by the PR-template compiler.`, { construct: "non-structural PR field" });
    });
    return blocks.join("\n\n");
}
function appendOptionalBlock(blocks, value) {
    const block = value === undefined ? undefined : trimBlankLines(value);
    if (block !== undefined)
        blocks.push(block);
}
//# sourceMappingURL=pull-request-template.js.map