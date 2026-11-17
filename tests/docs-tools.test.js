/**
 * The tool reference has to describe the tools that exist.
 *
 * A page with a plausible-looking example for an argument no tool accepts is worse than no page: a
 * reader sends it, gets an error, and trusts the next page less. This parses `docs/tools.md` and
 * checks every documented call against the real schema: the tool exists, every argument is one it
 * declares, and every required argument is present.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { buildTools } from "../dist/mcp.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const PAGE = fs.readFileSync(path.join(ROOT, "docs", "tools.md"), "utf8");
const tools = new Map(buildTools().map((tool) => [tool.name, tool]));

/** Every documented tool with the JSON call that follows its heading. */
function documented() {
  const entries = [];
  const lines = PAGE.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^- \*\*`(snapshot_[a-z_]+)`\*\*/.exec(lines[index]);
    if (heading === null) continue;
    let call = null;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^- \*\*`/.test(lines[cursor])) break;
      if (/^## /.test(lines[cursor])) break;
      if (lines[cursor].trim() !== "```json") continue;
      const body = [];
      for (cursor += 1; cursor < lines.length && lines[cursor].trim() !== "```"; cursor += 1) {
        body.push(lines[cursor]);
      }
      call = JSON.parse(body.join("\n"));
      break;
    }
    entries.push({ name: heading[1], call });
  }
  return entries;
}

test("every tool the reference documents exists", () => {
  const entries = documented();
  assert.ok(entries.length >= 20, "the page documents the tool set: " + entries.length);
  for (const entry of entries) {
    assert.ok(tools.has(entry.name), entry.name + " is a real tool");
  }
});

test("every documented call names the tool it is for, with arguments the tool accepts", () => {
  for (const entry of documented()) {
    assert.ok(entry.call !== null, entry.name + " has an example call");
    assert.equal(entry.call.name, entry.name, entry.name + " example calls itself");
    assert.equal(typeof entry.call.arguments, "object");
    const tool = tools.get(entry.name);
    const properties = tool.inputSchema.properties ?? {};
    for (const [argument, value] of Object.entries(entry.call.arguments)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(properties, argument),
        entry.name + " example passes \"" + argument + "\", which the schema does not declare"
      );
      const declared = properties[argument];
      const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
      if (declared.type === "integer" || declared.type === "number") {
        assert.equal(type, "number", entry.name + " expects a number for " + argument);
      } else if (declared.type === "array") {
        assert.equal(type, "array", entry.name + " expects an array for " + argument);
      } else if (declared.type === "string") {
        assert.equal(type, "string", entry.name + " expects a string for " + argument);
      } else if (declared.type === "boolean") {
        assert.equal(type, "boolean", entry.name + " expects a boolean for " + argument);
      }
    }
    for (const required of tool.inputSchema.required ?? []) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(entry.call.arguments, required),
        entry.name + " example is missing its required \"" + required + "\""
      );
    }
  }
});
