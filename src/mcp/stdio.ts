#!/usr/bin/env node

/** Local stdio transport for the native Inari MCP catalog. */

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createInariMcpServer, type InariMcpServerOptions } from "./server.js";

export interface InariMcpStdioOptions extends InariMcpServerOptions {
  /** Repository working directory used by the local GitHub adapter. */
  readonly repositoryRoot?: string;
  /** Default GitHub repository target used when a tool omits `repository`. */
  readonly repository?: string;
}

interface ParsedStdioArgs {
  readonly help: boolean;
  readonly version: boolean;
  readonly repositoryRoot?: string;
  readonly repository?: string;
}

function parseStdioArgs(argv: readonly string[]): ParsedStdioArgs {
  let help = false;
  let version = false;
  let repositoryRoot: string | undefined;
  let repository: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--version") {
      version = true;
      continue;
    }
    if (argument === "--repo" || argument === "--repository") {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("-")) {
        throw new Error(`${argument} requires a repository value.`);
      }
      if (argument === "--repo") repositoryRoot = value;
      else repository = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option "${argument}".`);
  }
  return {
    help,
    version,
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
    ...(repository === undefined ? {} : { repository }),
  };
}

function packageVersion(): string {
  const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  try {
    const value = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
    return typeof value.version === "string" ? value.version : "unknown";
  } catch {
    return "unknown";
  }
}

function printHelp(): void {
  process.stdout.write(
    "Inari native MCP server\n\nUsage:\n  inari mcp serve [--repo <path>] [--repository <owner/name>]\n\nTransport:\n  MCP stdio (the semantic tool catalog is transport-neutral)\n",
  );
}

/** Start the native server on a caller-provided stdio transport. */
export async function startInariMcpStdio(options: InariMcpStdioOptions = {}): Promise<void> {
  const server = createInariMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const close = async (): Promise<void> => {
    await server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

/** Run the command-line stdio entrypoint. */
export async function runInariMcpStdio(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let parsed: ParsedStdioArgs;
  try {
    parsed = parseStdioArgs(argv);
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (parsed.help) {
    printHelp();
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  await startInariMcpStdio({
    ...(parsed.repositoryRoot === undefined ? {} : { repositoryRoot: parsed.repositoryRoot }),
    ...(parsed.repository === undefined ? {} : { repository: parsed.repository }),
  });
  return 0;
}

let invokedPath: string | undefined;
try {
  invokedPath = process.argv[1] === undefined ? undefined : realpathSync(path.resolve(process.argv[1]));
} catch {
  invokedPath = undefined;
}
if (invokedPath === fileURLToPath(import.meta.url)) {
  runInariMcpStdio()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
