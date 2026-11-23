/**
 * A JSON Schema checker for tool arguments, sized to the schemas this server publishes.
 *
 * The alternative was Ajv, which is the right answer for arbitrary schemas and the wrong one for
 * a package whose single dependency is a compiler. Every schema here is a flat object of scalar
 * properties, so the checker is small, readable and — unlike a general-purpose validator — it can
 * reject unknown properties by default, which is what turns an agent's typo (`maxPartByte`) into a
 * named error instead of a silently ignored option.
 */
import type { InputSchema, JsonObject, JsonSchema } from "./protocol.js";
import { isJsonObject } from "./protocol.js";

/** Human-readable problems, each prefixed with the argument path that caused it. */
export function validateArguments(schema: InputSchema, value: unknown): string[] {
  if (value === undefined) value = {};
  if (!isJsonObject(value)) return ["arguments must be a JSON object"];

  const problems: string[] = [];
  const known = new Set(Object.keys(schema.properties));

  for (const key of Object.keys(value)) {
    if (!known.has(key) && schema.additionalProperties !== true) {
      const allowed = [...known].sort().join(", ");
      problems.push(`unknown argument "${key}" (accepted: ${allowed || "none"})`);
    }
  }

  for (const required of schema.required ?? []) {
    if (value[required] === undefined) problems.push(`missing required argument "${required}"`);
  }

  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    const argument = value[key];
    if (argument === undefined) continue;
    problems.push(...checkValue(key, propertySchema, argument));
  }

  return problems;
}

function checkValue(path: string, schema: JsonSchema, value: unknown): string[] {
  if (schema.enum && !schema.enum.includes(value as string)) {
    return [`"${path}" must be one of: ${schema.enum.join(", ")}`];
  }

  const declared: readonly string[] =
    schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (declared.length > 0 && !declared.some((type) => matchesType(type, value))) {
    // Preserve the sequence callers learned: an integer field first says "must be a number" for a
    // non-number, and only a fractional number says "must be an integer".
    if (declared.length === 1 && declared[0] === "integer" && typeof value !== "number") {
      return [`"${path}" must be a number`];
    }
    const article = (type: string): string =>
      type === "integer" || type === "object" || type === "array" ? `an ${type}` : `a ${type}`;
    return [`"${path}" must be ${declared.map(article).join(" or ")}`];
  }

  const problems: string[] = [];
  if (declared.includes("string") && typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      problems.push(`"${path}" must be at least ${schema.minLength} character(s)`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      problems.push(`"${path}" must be at most ${schema.maxLength} character(s)`);
    }
  }
  if (
    (declared.includes("number") || declared.includes("integer")) &&
    typeof value === "number" &&
    !Number.isNaN(value)
  ) {
    if (declared.includes("integer") && !declared.includes("number") && !Number.isInteger(value)) {
      problems.push(`"${path}" must be an integer`);
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      problems.push(`"${path}" must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      problems.push(`"${path}" must be <= ${schema.maximum}`);
    }
  }
  if (declared.includes("array") && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      problems.push(...checkValue(`${path}[${index}]`, schema.items as JsonSchema, item));
    });
  }
  return problems;
}

/** True when a value is one of the JSON types the schema names. */
function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && !Number.isNaN(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return isJsonObject(value);
    default:
      return false;
  }
}

/**
 * Fills defaults into a validated argument object.
 *
 * Only top-level scalar defaults are supported, which is every default this server declares. A
 * default is applied before the handler runs so handlers never repeat `args.x ?? default`.
 */
export function applyDefaults(schema: InputSchema, value: JsonObject): JsonObject {
  const out: JsonObject = { ...value };
  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    if (out[key] === undefined && propertySchema.default !== undefined) {
      out[key] = propertySchema.default;
    }
  }
  return out;
}

/**
 * Accepts a numeric argument that arrived as a digit string.
 *
 * Reported from a real client: the same `snapshot_read` call succeeded through one code path and
 * was rejected through another, because one of them serialised `fromLine` as `"1"`. A digit string
 * is the same value in a different spelling, and the caller cannot fix what their client did — so
 * refusing it makes the tool unusable there while teaching nobody anything.
 *
 * This is not a relaxation of type checking: only fields the schema declares as numbers are
 * touched, only strings that parse to a finite number are converted, and anything else still fails
 * validation with the type message. `"ten"`, `""` and `"1.5"` for an integer all still fail.
 */
export function coerceNumericStrings(schema: InputSchema, value: JsonObject): JsonObject {
  const out: JsonObject = { ...value };
  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    const raw = out[key];
    if (typeof raw !== "string") continue;
    const declared = Array.isArray(propertySchema.type)
      ? propertySchema.type
      : propertySchema.type === undefined
        ? []
        : [propertySchema.type];
    if (!declared.includes("number") && !declared.includes("integer")) continue;
    if (raw.trim().length === 0) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) out[key] = parsed;
  }
  return out;
}
