import {
  bindHandlers,
  compileProduct,
  defineCommands,
  option,
  positional,
  type CompiledField,
} from "@yohn-jp/cli-canon";
import type { NodeDelegatedCommandSource } from "@yohn-jp/cli-canon/node";
import type { CliResult } from "@yohn-jp/cli-canon/node";
import type { ProductPackageIdentity } from "@yohn-jp/cli-canon";
import { z } from "zod";
import { executeCliArtifactReconciliation, type CliDependencies } from "./cli-core.js";
import {
  getOption,
  INARI_COMMANDS,
  commandExample,
  commandUsage,
  type CommandDefinition,
  type CommandOptionDefinition,
} from "./command-contract.js";

const PRODUCT_NAME = "inari";
const DELEGATED_SOURCE_ID = "inari-legacy-command-core";
const RESERVED_SHELL_FLAGS = new Set(["--help", "-h", "--version", "--json"]);
const ARTIFACT_NUMBER = z
  .string()
  .regex(/^[1-9]\d*$/u, "expected a positive integer")
  .transform(Number)
  .refine(Number.isSafeInteger, "expected a safe positive integer");

/** #1194: these routes converge to Canon for command identity, grammar, Help, and dispatch. */
export const ARTIFACT_RECONCILIATION_COMMANDS = defineCommands({
  "issue.reconcile": {
    route: ["issue", "reconcile"],
    summary: "Safely reconcile one existing Issue through the Core artifact reconciler.",
    examples: ["inari issue reconcile 42"],
    input: {
      number: positional(ARTIFACT_NUMBER, { metavar: "number" }),
      repository: option("--repository", z.string(), {
        aliases: ["-R"],
        metavar: "repository",
        description: "GitHub repository override.",
        placement: "after-route",
      }),
    },
    result: z.unknown(),
  },
  "pr.reconcile": {
    route: ["pr", "reconcile"],
    summary: "Safely reconcile one existing pull request through the Core artifact reconciler.",
    examples: ["inari pr reconcile 42"],
    input: {
      number: positional(ARTIFACT_NUMBER, { metavar: "number" }),
      repository: option("--repository", z.string(), {
        aliases: ["-R"],
        metavar: "repository",
        description: "GitHub repository override.",
        placement: "after-route",
      }),
    },
    result: z.unknown(),
  },
});

function artifactReconciliationHandlers(dependencies: CliDependencies) {
  return bindHandlers(ARTIFACT_RECONCILIATION_COMMANDS)({
    "issue.reconcile": ({ number, repository }) =>
      executeCliArtifactReconciliation("issue", number, repository, dependencies),
    "pr.reconcile": ({ number, repository }) =>
      executeCliArtifactReconciliation("pr", number, repository, dependencies),
  });
}

export function compileInariCliProduct(
  packageMetadata: ProductPackageIdentity,
  description: string,
  dependencies: CliDependencies = {},
) {
  return compileProduct({
    name: PRODUCT_NAME,
    description,
    packageMetadata,
    commands: ARTIFACT_RECONCILIATION_COMMANDS,
    handlers: artifactReconciliationHandlers(dependencies),
  });
}

function sameRoute(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function startsWithRoute(route: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length < route.length && prefix.every((segment, index) => segment === route[index]);
}

function routeKey(route: readonly string[]): string {
  return route.join("\u0000");
}

function asRoute(route: readonly string[]): readonly [string, ...string[]] {
  const [first, ...rest] = route;
  if (first === undefined) throw new Error("A delegated command route must contain at least one segment.");
  return [first, ...rest];
}

function primaryFlag(option: CommandOptionDefinition): string | undefined {
  return option.aliases.find((alias) => alias.startsWith("--"));
}

function fieldForOption(option: CommandOptionDefinition, required = false): CompiledField | undefined {
  const flag = primaryFlag(option);
  if (flag === undefined || option.aliases.some((alias) => RESERVED_SHELL_FLAGS.has(alias))) return undefined;

  const aliases = option.aliases.filter((alias) => alias !== flag && !RESERVED_SHELL_FLAGS.has(alias));
  if (option.valueType === "boolean" && option.arity === "none") {
    return {
      key: option.key,
      kind: "flag",
      flag,
      aliases,
      required,
      placement: "anywhere",
      description: option.description,
    };
  }

  return {
    key: option.key,
    kind: "option",
    flag,
    aliases,
    repeatable: option.repeatable,
    required,
    valueArity: option.arity === "optional" ? "optional" : "required",
    optionLookingValuePolicy: "consume",
    placement: "anywhere",
    ...(option.placeholder === undefined ? {} : { metavar: option.placeholder }),
    description: option.description,
  };
}

export function commandRequiredOptionIds(entry: CommandDefinition): ReadonlySet<string> {
  const prefix = `${entry.path.join(" ")}${entry.positionalSyntax === undefined ? "" : ` ${entry.positionalSyntax}`}`;
  const usageTail = commandUsage(entry).slice(prefix.length);
  const required = new Set<string>();
  for (const optionId of entry.optionIds) {
    const flag = primaryFlag(getOption(optionId));
    if (flag === undefined) continue;
    const index = usageTail.indexOf(flag);
    if (index < 0) continue;
    if (usageTail.lastIndexOf("[", index) <= usageTail.lastIndexOf("]", index)) required.add(optionId);
  }
  return required;
}

function commandFields(
  entries: readonly CommandDefinition[],
  requiredEntries: readonly CommandDefinition[],
): readonly CompiledField[] {
  const fields = new Map<string, CompiledField>();
  const required = new Set(requiredEntries.flatMap((entry) => [...commandRequiredOptionIds(entry)]));
  for (const entry of entries) {
    for (const optionId of entry.optionIds) {
      const field = fieldForOption(getOption(optionId), required.has(optionId));
      if (field !== undefined) {
        const existing = fields.get(field.key);
        fields.set(
          field.key,
          existing?.required === true && field.required !== true ? { ...field, required: true } : field,
        );
      }
    }

    if (entry.positionalSyntax !== undefined) {
      const positional = /^(\[|<)(.+?)(\]|>)$/u.exec(entry.positionalSyntax);
      if (positional !== null) {
        const key = positional[2] ?? "argument";
        fields.set(key, {
          key,
          kind: "positional",
          required: positional[1] === "<",
          metavar: key,
        });
      }
    }
  }
  return [...fields.values()];
}

function hasExecutableDescendant(route: readonly string[]): boolean {
  return INARI_COMMANDS.some((entry) => startsWithRoute(entry.path, route));
}

function routeCommands(): readonly {
  readonly entries: readonly CommandDefinition[];
  readonly route: readonly [string, ...string[]];
}[] {
  const byRoute = new Map<string, CommandDefinition[]>();
  for (const entry of INARI_COMMANDS) {
    if (entry.path.length === 0) continue;
    const key = routeKey(entry.path);
    const existing = byRoute.get(key);
    if (existing === undefined) byRoute.set(key, [entry]);
    else existing.push(entry);
  }

  // Canon 0.2 cannot compose an executable command at the same route as its
  // child group. Keep exact child descriptors; root.setup uses the bounded
  // pre-Canon transition in cli.ts until Canon can represent this shape.
  return [...byRoute.values()]
    .filter((entries) => !hasExecutableDescendant(entries[0]?.path ?? []))
    .map((entries) => ({
      entries,
      route: asRoute(entries[0]?.path ?? []),
    }));
}

function delegatedGroups(
  commands: ReturnType<typeof routeCommands>,
): NonNullable<NodeDelegatedCommandSource["groups"]> {
  const representedRoutes = new Set(commands.map(({ route }) => routeKey(route)));
  const prefixes = new Map<string, readonly [string, ...string[]]>();

  for (const { route } of commands) {
    for (let length = 1; length < route.length; length += 1) {
      const prefix = asRoute(route.slice(0, length));
      const key = routeKey(prefix);
      if (!representedRoutes.has(key)) prefixes.set(key, prefix);
    }
  }

  return [...prefixes.values()].map((route) => {
    const executableParent = INARI_COMMANDS.find(
      (entry) => sameRoute(entry.path, route) && hasExecutableDescendant(entry.path),
    );
    return {
      id: `${DELEGATED_SOURCE_ID}.group.${route.join(".")}`,
      route,
      summary: executableParent?.summary ?? `${route.at(-1)} commands`,
      examples: routeExamples(route),
    };
  });
}

function routeExamples(route: readonly string[]): readonly string[] {
  return INARI_COMMANDS.filter(
    (entry) => entry.path.length > 0 && (sameRoute(entry.path, route) || startsWithRoute(entry.path, route)),
  )
    .map((entry) => commandExample(entry.id))
    .filter((example, index, examples) => examples.indexOf(example) === index);
}

export function createLegacyDelegatedCommandSource(
  execute: NodeDelegatedCommandSource["execute"],
): NodeDelegatedCommandSource {
  const commands = routeCommands();
  return {
    kind: "delegated",
    id: DELEGATED_SOURCE_ID,
    groups: delegatedGroups(commands),
    commands: commands.map(({ entries, route }) => ({
      id: entries.map((entry) => entry.id).join("+"),
      route,
      summary: entries.map((entry) => entry.summary).join(" "),
      examples: routeExamples(route),
      // Keep each nested command on its exact contract entry so discovery,
      // option grammar, and delegated execution share the same route owner.
      fields: commandFields(entries, entries),
    })),
    execute: async (request) => (await execute(request)) as CliResult,
  };
}
