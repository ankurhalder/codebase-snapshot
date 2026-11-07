import assert from "node:assert/strict";
import test from "node:test";

import { LANGUAGE_PROFILES, profileForPath, summarizeWithProfile } from "../dist/index.js";

/**
 * Language coverage, from the 0.9.9 audit.
 *
 * `src/scanner/language.ts` already knew `.sql`, `.graphql`, `.proto` and `.tf` by name, but
 * no profile claimed them — so a repository in one of those languages got a manifest with no
 * structure at all: an agent saw a list of files and no idea what was in them. Swift and Dart
 * were not even recognised as languages. These tests pin that each new profile runs, that its
 * output is a real outline rather than a list of every line, and that the summary is
 * deterministic.
 */

const summarize = (path, content) => {
  const result = summarizeWithProfile(path, content);
  assert.ok(result, `${path} must be claimed by a profile`);
  return result.summary;
};

test("every profile is registered exactly once per extension", () => {
  const claimed = new Map();
  for (const profile of LANGUAGE_PROFILES) {
    for (const extension of profile.extensions) {
      assert.equal(
        claimed.get(extension),
        undefined,
        `${extension} is claimed by both ${claimed.get(extension)} and ${profile.id}`
      );
      claimed.set(extension, profile.id);
    }
  }
  for (const extension of [".swift", ".dart", ".sql", ".graphql", ".gql", ".proto", ".tf", ".tfvars"]) {
    assert.ok(claimed.has(extension), `${extension} has no profile`);
  }
});

test("Swift: modifiers, protocol versus class, and explicit visibility", () => {
  const summary = summarize(
    "App/Store.swift",
    [
      "import Foundation",
      "import Combine",
      "",
      "@objc public final class Cache: NSObject {",
      "  private var entries: [String] = []",
      "  public func load() {}",
      "}",
      "public struct Point { let x: Double }",
      "protocol Repository {",
      "  func fetch()",
      "}",
      "enum Direction { case north }",
      "internal func helper() {}",
      "public let shared = Cache()",
    ].join("\n")
  );

  assert.deepEqual(summary.imports, ["Combine", "Foundation"]);
  assert.ok(summary.classes.includes("Cache"), "an @objc public final class is a class");
  assert.ok(summary.classes.includes("Point"));
  assert.deepEqual(summary.interfaces, ["Repository"], "protocol is the interface");
  assert.deepEqual(summary.enums, ["Direction"]);
  // Only column-zero declarations are collected, the same convention every other profile
  // follows: a method indented inside a type belongs to that type, and listing every method
  // of every type is the full body, not an outline.
  assert.ok(summary.functions.includes("helper"));
  assert.ok(!summary.functions.includes("load"), "a member function is not top-level");
  // `internal` is not an export; `public`/`open` is.
  assert.ok(summary.exports.includes("Cache"));
  assert.ok(summary.exports.includes("Point"));
  assert.ok(summary.exports.includes("shared"));
  assert.ok(!summary.exports.includes("helper"), "internal declarations are not exports");
});

test("Dart: classes, mixins, the underscore privacy rule and part directives", () => {
  const summary = summarize(
    "lib/src/cache.dart",
    [
      "import 'package:flutter/material.dart';",
      "part 'cache.g.dart';",
      "",
      "abstract class Store {",
      "  Future<void> load();",
      "}",
      "class _Private {}",
      "mixin CacheMixin {}",
      "enum Mode { fast, slow }",
      "void main() {}",
      "Future<List<String>> fetchAll() async => [];",
      "const int maxEntries = 10;",
    ].join("\n")
  );

  assert.deepEqual(summary.imports, ["package:flutter/material.dart"]);
  assert.ok(summary.directives.includes("part cache.g.dart"));
  assert.ok(summary.classes.includes("Store"));
  assert.ok(summary.classes.includes("_Private"));
  assert.ok(!summary.exports.includes("_Private"), "a leading underscore is private to its library");
  assert.ok(summary.types.includes("CacheMixin"));
  assert.deepEqual(summary.enums, ["Mode"]);
  assert.ok(summary.functions.includes("main"));
  assert.ok(summary.functions.includes("fetchAll"));
  assert.ok(summary.variables.includes("maxEntries"));
});

test("SQL: created objects, case-insensitively, with schema prefixes stripped", () => {
  const summary = summarize(
    "migrations/0012_init.sql",
    [
      "-- create the accounts schema",
      "CREATE TABLE public.accounts (id uuid primary key);",
      "create table if not exists sessions (id uuid);",
      "CREATE OR REPLACE VIEW public.active_accounts AS SELECT 1;",
      "CREATE FUNCTION touch(ts timestamptz) RETURNS void AS $$ $$ LANGUAGE sql;",
      "ALTER TABLE public.accounts ADD COLUMN name text;",
    ].join("\n")
  );

  assert.deepEqual(summary.classes, ["accounts", "active_accounts", "sessions"]);
  assert.deepEqual(summary.functions, ["touch"]);
  assert.deepEqual(summary.exports, ["accounts", "active_accounts", "sessions", "touch"]);
});

test("GraphQL: types are types and operations are endpoints", () => {
  const summary = summarize(
    "schema.graphql",
    [
      "type Query {",
      "  user(id: ID!): User",
      "}",
      "interface Node { id: ID! }",
      "input UserFilter { name: String }",
      "enum Role { ADMIN USER }",
      "extend type User { role: Role }",
      "directive @auth on FIELD_DEFINITION",
    ].join("\n")
  );

  // `extend type User` names the same type the earlier `type User` would, so it lands in the
  // same bucket rather than inventing a second one.
  assert.deepEqual(summary.classes, ["Query", "User"]);
  assert.deepEqual(summary.interfaces, ["Node"]);
  assert.deepEqual(summary.types, ["UserFilter"]);
  assert.deepEqual(summary.enums, ["Role"]);
  assert.ok(summary.functions.includes("@auth"));

  const operations = summarize(
    "ops/user.graphql",
    ["query GetUser($id: ID!) {", "  user(id: $id) { id }", "}", "mutation Rename {", "  rename"]
      .join("\n")
  );
  assert.deepEqual(operations.routeHandlers, ["GetUser", "Rename"], "an operation is an endpoint");
});

test("Protobuf: messages, enums, services and rpcs", () => {
  const summary = summarize(
    "proto/user.proto",
    [
      'syntax = "proto3";',
      "package app.user.v1;",
      'import "google/protobuf/timestamp.proto";',
      "message User {",
      "  string id = 1;",
      "}",
      "enum Role { ROLE_UNSPECIFIED = 0; }",
      "service UserService {",
      "  rpc GetUser(GetUserRequest) returns (User);",
      "}",
    ].join("\n")
  );

  assert.deepEqual(summary.imports, ["google/protobuf/timestamp.proto"]);
  assert.ok(summary.directives.includes("package app.user.v1"));
  assert.deepEqual(summary.classes, ["User"]);
  assert.deepEqual(summary.enums, ["Role"]);
  assert.deepEqual(summary.interfaces, ["UserService"]);
  assert.deepEqual(summary.functions, ["GetUser"]);
});

test("Terraform: resources are named by type and name, and .tfvars is assignments", () => {
  const summary = summarize(
    "infra/main.tf",
    [
      "terraform {",
      '  required_version = ">= 1.5"',
      "}",
      'provider "aws" { region = "eu-west-1" }',
      'resource "aws_instance" "web" { ami = "ami-1" }',
      'resource "aws_instance" "worker" { ami = "ami-1" }',
      'module "network" { source = "./network" }',
      'variable "instance_count" { type = number }',
      'output "web_ip" { value = aws_instance.web.public_ip }',
    ].join("\n")
  );

  assert.deepEqual(summary.classes, ["aws_instance.web", "aws_instance.worker"]);
  assert.ok(summary.imports.includes("network"));
  assert.ok(summary.imports.includes("provider:aws"));
  assert.deepEqual(summary.variables, ["instance_count"]);
  assert.deepEqual(summary.exports, ["aws_instance.web", "aws_instance.worker", "web_ip"]);
  assert.ok(summary.directives.some((entry) => entry.startsWith("required_version")));

  const vars = summarize("infra/prod.tfvars", 'instance_count = 3\nregion = "eu-west-1"\n');
  assert.deepEqual(vars.variables, ["instance_count", "region"]);
});

test("a profile is chosen by extension, and unknown files still have none", () => {
  assert.equal(profileForPath("a/b.swift")?.id, "swift");
  assert.equal(profileForPath("a/b.dart")?.id, "dart");
  assert.equal(profileForPath("a/b.sql")?.id, "sql");
  assert.equal(profileForPath("a/b.proto")?.id, "protobuf");
  assert.equal(profileForPath("a/b.tfvars")?.id, "terraform");
  assert.equal(profileForPath("a/b.weird"), null);
});
