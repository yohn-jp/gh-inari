import assert from "node:assert/strict";
import { test } from "node:test";
import {
  projectToJsonSchema,
  type CanonicalContract,
  type CanonicalField,
  type JsonSchema,
  validateSemanticInput,
} from "./index.js";
import { pullRequestContractFixture } from "./fixtures.js";

test("schema and semantic validation agree for every supported constraint class", () => {
  const cases: readonly {
    readonly name: string;
    readonly contract: CanonicalContract;
    readonly inputs: readonly Record<string, unknown>[];
  }[] = [
    {
      name: "native string constraints",
      contract: contractWithField("summary", {
        constraints: { minLength: 2, maxLength: 3, pattern: "^[A-Z]" },
      }),
      inputs: [{ summary: "A" }, { summary: "AB" }, { summary: "ABC" }, { summary: "ABCD" }, { summary: "ab" }],
    },
    {
      name: "supplemental string and linked-Issue constraints",
      contract: contractWithField("summary", {
        supplemental: { required: true, minLength: 8, maxLength: 40, pattern: "^Fix", linkedIssue: true },
      }),
      inputs: [
        {},
        { summary: "       " },
        { summary: "Fix this Closes #1" },
        { summary: "Fix this without a reference" },
        { summary: "Other Closes #1" },
      ],
    },
    {
      name: "required default and whitespace semantics",
      contract: contractWithField("summary", { required: "required", defaultValue: "Default summary" }),
      inputs: [{}, { summary: "   " }, { summary: "😀" }, { summary: "A real summary" }],
    },
    {
      name: "Unicode code-point string length",
      contract: contractWithField("summary", { constraints: { minLength: 2, maxLength: 2 } }),
      inputs: [{ summary: "😀" }, { summary: "😀a" }, { summary: "😀😀" }, { summary: "😀😀a" }],
    },
    {
      name: "checklist cardinality and completion constraints",
      contract: contractWithField("acceptance", {
        supplemental: {
          required: true,
          minItems: 1,
          maxItems: 2,
          checklistMinCompleted: 2,
          checklistRequireComplete: true,
        },
      }),
      inputs: [
        {},
        { acceptance: [] },
        { acceptance: ["tests"] },
        { acceptance: ["tests", "build"] },
        { acceptance: ["tests", "tests"] },
        { acceptance: ["tests", "build", "extra"] },
      ],
    },
  ];

  for (const { name, contract, inputs } of cases) {
    const schema = projectToJsonSchema(contract);
    for (const input of inputs) {
      const semantic = validateSemanticInput(contract, input).valid;
      const projected = schemaAccepts(schema, input);
      assert.equal(projected, semantic, `${name}: ${JSON.stringify(input)}`);
    }
  }
});

test("required defaults are optional at the object boundary but still constrained when supplied", () => {
  const contract = contractWithField("summary", { required: "required", defaultValue: "Default summary" });
  const schema = projectToJsonSchema(contract);
  assert.deepEqual(schema.required, undefined);
  assert.equal(schema.properties.summary?.pattern, "\\S");
  assert.equal(validateSemanticInput(contract, {}).values.summary, "Default summary");
  assert.equal(validateSemanticInput(contract, { summary: "   " }).valid, false);
  assert.equal(schemaAccepts(schema, {}), true);
  assert.equal(schemaAccepts(schema, { summary: "   " }), false);
});

function contractWithField(
  fieldId: string,
  options: {
    readonly constraints?: CanonicalField["constraints"];
    readonly supplemental?: Record<string, unknown>;
    readonly required?: CanonicalField["required"];
    readonly defaultValue?: string;
  },
): CanonicalContract {
  const source = structuredClone(pullRequestContractFixture) as unknown as CanonicalContract;
  const sections = source.sections.map((section) => {
    if (!section.fields.some((field) => field.id === fieldId)) return section;
    return {
      ...section,
      fields: section.fields.map((field) => {
        if (field.id !== fieldId) return field;
        return {
          ...field,
          ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
          ...(options.required === undefined ? {} : { required: options.required }),
          ...(options.defaultValue === undefined ? {} : { defaultValue: options.defaultValue }),
        } as CanonicalField;
      }),
    };
  });
  return {
    ...source,
    sections,
    supplementalConstraints: {
      fields: options.supplemental === undefined ? [] : [{ fieldId, ...options.supplemental }],
    },
  };
}

function schemaAccepts(schema: JsonSchema, input: unknown): boolean {
  if (schema.type !== "object" || !isRecord(input)) return false;
  if (schema.additionalProperties === false && Object.keys(input).some((key) => !(key in (schema.properties ?? {})))) {
    return false;
  }
  if ((schema.required ?? []).some((key) => !Object.prototype.hasOwnProperty.call(input, key))) return false;
  return Object.entries(input).every(([key, value]) => {
    const property = schema.properties?.[key];
    return property !== undefined && nodeAccepts(property, value);
  });
}

function nodeAccepts(schema: JsonSchema, value: unknown): boolean {
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.pattern !== undefined && (typeof value !== "string" || !matches(schema.pattern, value))) return false;
  if (schema.type === "string") {
    if (typeof value !== "string") return false;
    if (schema.enum !== undefined && !schema.enum.includes(value)) return false;
    const length = Array.from(value).length;
    if (schema.minLength !== undefined && length < schema.minLength) return false;
    if (schema.maxLength !== undefined && length > schema.maxLength) return false;
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return false;
    if (schema.uniqueItems && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) return false;
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items !== undefined && value.some((entry) => !nodeAccepts(schema.items as JsonSchema, entry)))
      return false;
  } else if (schema.type === "object" && !isRecord(value)) {
    return false;
  }
  return (schema.allOf ?? []).every((rule) => {
    if (rule.contains !== undefined && Array.isArray(value)) {
      const minimum = rule.minContains ?? 1;
      return value.filter((entry) => nodeAccepts(rule.contains as JsonSchema, entry)).length >= minimum;
    }
    return nodeAccepts(rule, value);
  });
}

function matches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, "u").test(value);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
