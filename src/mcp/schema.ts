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

  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") return [`"${path}" must be a string`];
      const problems: string[] = [];
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        problems.push(`"${path}" must be at least ${schema.minLength} character(s)`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        problems.push(`"${path}" must be at most ${schema.maxLength} character(s)`);
      }
      return problems;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || Number.isNaN(value)) {
        return [`"${path}" must be a number`];
      }
      if (schema.type === "integer" && !Number.isInteger(value)) {
        return [`"${path}" must be an integer`];
      }
      const problems: string[] = [];
      if (schema.minimum !== undefined && value < schema.minimum) {
        problems.push(`"${path}" must be >= ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        problems.push(`"${path}" must be <= ${schema.maximum}`);
      }
      return problems;
    }
    case "boolean":
      return typeof value === "boolean" ? [] : [`"${path}" must be a boolean`];
    case "array": {
      if (!Array.isArray(value)) return [`"${path}" must be an array`];
      if (!schema.items) return [];
      const problems: string[] = [];
      value.forEach((item, index) => {
        problems.push(...checkValue(`${path}[${index}]`, schema.items as JsonSchema, item));
      });
      return problems;
    }
    case "object":
      return isJsonObject(value) ? [] : [`"${path}" must be an object`];
    default:
      return [];
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
