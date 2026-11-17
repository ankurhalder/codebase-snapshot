/**
 * Prompts: seven jobs, each one naming the tools it expects the agent to call.
 *
 * A prompt that names a tool the server does not serve is a dead end for the agent that follows it,
 * so the test checks every tool name mentioned against the served list.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildPrompts, buildTools } from "../dist/mcp.js";

const prompts = new Map(buildPrompts().map((prompt) => [prompt.name, prompt]));
const tools = new Set(buildTools().map((tool) => tool.name));

test("the expected prompts exist, each with a description", () => {
  for (const name of ["orient", "keep-current", "audit", "review", "explain", "onboard", "security-review"]) {
    const prompt = prompts.get(name);
    assert.ok(prompt, name + " is served");
    assert.ok(prompt.description.length > 20, name + " describes itself");
  }
});

test("every tool a prompt names is a tool the server serves", () => {
  for (const prompt of prompts.values()) {
    const text = prompt.build({}).messages.map((message) => message.content.text).join("\n");
    for (const match of text.matchAll(/snapshot_[a-z_]+/g)) {
      assert.ok(tools.has(match[0]), prompt.name + " names " + match[0] + ", which is not served");
    }
  }
});

test("a required argument reaches the prompt text", () => {
  const review = prompts.get("review");
  const text = review.build({ change: "adds rate limiting" }).messages[0].content.text;
  assert.match(text, /adds rate limiting/);

  const explain = prompts.get("explain");
  assert.match(explain.build({ path: "src/auth.ts" }).messages[0].content.text, /src\/auth\.ts/);
});

test("a missing optional argument still yields the base prompt", () => {
  const orient = prompts.get("orient");
  const text = orient.build({}).messages[0].content.text;
  assert.match(text, /snapshot_status/);
  assert.doesNotMatch(text, /Focus for this pass/);
});

test("the security prompt says what it cannot see", () => {
  const text = prompts.get("security-review").build({}).messages[0].content.text;
  assert.match(text, /cannot see/);
  assert.match(text, /Do not modify files/);
});
