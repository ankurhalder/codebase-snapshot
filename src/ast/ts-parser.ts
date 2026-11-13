import ts from "typescript";
import type { SourceSummary } from "../types.js";

const ROUTE_HANDLER_NAMES = new Set([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
]);

/**
 * Receivers whose `.verb("path", handler)` registers an HTTP route.
 *
 * The Next.js App Router shape is an *exported* identifier named `GET`/`POST`; an Express,
 * Hono, Koa or Fastify application registers `router.get("/x", handler)`, which the summary
 * ignored — every route in such a repository had `methods: []`. The receiver list is
 * deliberately narrow: `headers.get("content-type")` is a Map lookup, not a route, and a
 * receiver named `cache.get` is not one either.
 */
const ROUTE_RECEIVERS = new Set(["app", "router", "server", "fastify", "api", "route"]);

/** Lower-case verbs accepted as route registrations. */
const ROUTE_REGISTRATION_VERBS = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
]);

/**
 * The identifiers a binding declares, into `into`.
 *
 * `export const { a, b } = obj` / `export const [first] = pair` declare real exports, and the
 * old `if (!ts.isIdentifier(declaration.name)) continue` skipped every one of them: a module
 * whose whole public surface was a destructured export was summarised as having none. A
 * destructuring pattern binds its *leaves*, so the walk recurses through nested patterns, and a
 * rename (`{ a: renamed }`) is reported under the name it binds rather than the property name.
 */
function bindingNames(name: ts.BindingName, into: string[]): void {
  if (ts.isIdentifier(name)) {
    into.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    bindingNames(element.name, into);
  }
}

/** The names an object literal binds, for `module.exports = { a, b }`. */
function objectLiteralNames(node: ts.ObjectLiteralExpression): string[] {
  const names: string[] = [];
  for (const property of node.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      names.push(property.name.text);
      continue;
    }
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      names.push(name.text);
    }
  }
  return names;
}

/**
 * The CommonJS export names one assignment declares, or `null` when it is not one.
 *
 * A `.cjs` module's public surface is `module.exports = { … }` / `exports.handler = …`, and the
 * summary only recognised `export` declarations — so a CommonJS module was reported as exporting
 * nothing. The two canonical forms cover what a reader needs; a dynamic `Object.assign` or a
 * computed property is left out rather than guessed at.
 */
function cjsExportedNames(expression: ts.BinaryExpression): string[] | null {
  const left = expression.left;
  if (!ts.isPropertyAccessExpression(left)) return null;

  const isModuleExports =
    left.name.text === "exports" &&
    ts.isIdentifier(left.expression) &&
    left.expression.text === "module";
  if (isModuleExports) {
    const right = expression.right;
    if (ts.isObjectLiteralExpression(right)) return objectLiteralNames(right);
    if (ts.isIdentifier(right)) return [right.text];
    return [];
  }

  if (ts.isIdentifier(left.expression) && left.expression.text === "exports") {
    return [left.name.text];
  }

  const parent = left.expression;
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.name.text === "exports" &&
    ts.isIdentifier(parent.expression) &&
    parent.expression.text === "module"
  ) {
    return [left.name.text];
  }
  return null;
}

/**
 * Counts syntactic errors through TypeScript's public transpile API.
 *
 * Used only when the parser's internal `parseDiagnostics` field is absent. `transpileModule`
 * reports syntax problems and ignores type errors, which is exactly what this summary wants:
 * a valid program with a type mistake must not be described as unparsable.
 */
function countSyntacticErrors(fileName: string, content: string): number {
  const result = ts.transpileModule(content, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
    },
    reportDiagnostics: true,
  });
  return (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  ).length;
}

/**
 * Extracts a structural summary from a JS/TS source file.
 *
 * The traversal is an explicit stack, not recursion: a generated file with a
 * long `a && b && …` chain used to overflow the call stack inside our own
 * visitor and abort the entire snapshot. Callers should still treat a throw as
 * possible (TypeScript's own parser recurses), so wrap the call.
 */
export function summarizeTypeScriptSource(
  relativePath: string,
  content: string
): SourceSummary {
  const summary: SourceSummary = {
    directives: [],
    imports: [],
    exports: [],
    reExports: [],
    functions: [],
    classes: [],
    interfaces: [],
    types: [],
    enums: [],
    variables: [],
    reactComponents: [],
    hooks: [],
    routeHandlers: [],
  };

  const lowerPath = relativePath.toLowerCase();
  const scriptKind = /.tsx$/.test(lowerPath)
    ? ts.ScriptKind.TSX
    : /.jsx$/.test(lowerPath)
      ? ts.ScriptKind.JSX
      : /.(?:js|mjs|cjs)$/.test(lowerPath)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;

  const sourceFile = ts.createSourceFile(
    relativePath,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKind
  );

  // A file with syntax errors still produces a (partial) summary. Recording the
  // count lets the caller say so instead of presenting a broken file as clean.
  //
  // `parseDiagnostics` is the compiler's own parse result and is free — but it is not part of
  // TypeScript's public surface, so a future version could rename it and every broken file
  // would be reported as clean. When the field is not an array, the public `transpileModule`
  // path (syntactic diagnostics only) answers the same question. The fast path is used because
  // it costs nothing on a file that was parsed anyway.
  const parsedDiagnostics = (
    sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  const parseErrors = Array.isArray(parsedDiagnostics)
    ? parsedDiagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
        .length
    : countSyntacticErrors(relativePath, content);
  if (parseErrors > 0) summary.parseErrors = parseErrors;

  // Module directives ("use client" / "use server") are only meaningful in the
  // prologue: the first run of string-literal expression statements.
  for (const statement of sourceFile.statements) {
    if (
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression)
    ) {
      const text = statement.expression.text;
      if (text === "use client" || text === "use server") {
        summary.directives.push(text);
      }
      continue;
    }
    break;
  }

  const isExported = (node: ts.Node): boolean => {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return Boolean(modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
  };

  const isDefault = (node: ts.Node): boolean => {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return Boolean(modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
  };

  /**
   * True when `node` renders something: it contains JSX, or a `createElement`
   * call. A PascalCase *name* alone is not evidence of a component — every
   * `class Calc` and every `const Config = {...}` used to be listed as one.
   */
  const rendersJsx = (node: ts.Node): boolean => {
    const pending: ts.Node[] = [node];
    while (pending.length > 0) {
      const current = pending.pop() as ts.Node;
      if (
        ts.isJsxElement(current) ||
        ts.isJsxSelfClosingElement(current) ||
        ts.isJsxFragment(current)
      ) {
        return true;
      }
      if (ts.isCallExpression(current)) {
        const callee = current.expression;
        const calleeName = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : "";
        if (calleeName === "createElement") return true;
      }
      // A block body matters: `ts.forEachChild` stops as soon as the callback
      // returns a truthy value, and `push` returns the array length.
      ts.forEachChild(current, (child) => {
        pending.push(child);
      });
    }
    return false;
  };

  /** `Component` / `PureComponent`, optionally behind a namespace (`React.`). */
  const REACT_BASE_CLASS = /(?:^|\.)(?:PureComponent|Component)$/;

  const extendsReactBase = (node: ts.ClassDeclaration): boolean => {
    const heritage = (node.heritageClauses ?? []).find(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
    );
    const expression = heritage?.types[0]?.expression;
    if (!expression) return false;
    const text = ts.isIdentifier(expression) ? expression.text : expression.getText(sourceFile);
    return REACT_BASE_CLASS.test(text);
  };

  const recordFunctionLike = (name: string, exported: boolean, node: ts.Node): void => {
    summary.functions.push(name);
    if (exported) {
      summary.exports.push(name);
      if (ROUTE_HANDLER_NAMES.has(name)) summary.routeHandlers.push(name);
    }
    if (/^use[A-Z0-9]/.test(name)) summary.hooks.push(name);
    if (/^[A-Z]/.test(name) && rendersJsx(node)) summary.reactComponents.push(name);
  };

  /** Exports declared through the CommonJS forms, merged in after the walk. */
  const cjsExports: string[] = [];

  const stack: ts.Node[] = [sourceFile];
  while (stack.length > 0) {
    const node = stack.pop() as ts.Node;

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      summary.imports.push(node.moduleSpecifier.text);
    }

    // `import foo = require("./x")`. Only the external form is an import edge; `import A = B.C`
    // is a type alias and has no module behind it.
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      summary.imports.push(node.moduleReference.expression.text);
    }

    // `require("./x")` and `import("./x")`. Neither is an `ImportDeclaration`, so both were
    // invisible: a CommonJS project, and any code that lazy-loads with `await import()`, recorded
    // no import edges at all — which is what `manifest.indexes.imports`, `snapshot_dependents` and
    // `--with-dependents` are built from. Only a string-literal argument counts: a computed
    // specifier is an expression, and guessing at which module it names would put a wrong edge in
    // the graph, which is worse than a missing one.
    if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const firstArgument = node.arguments[0];
      if (firstArgument !== undefined && ts.isStringLiteral(firstArgument)) {
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
        if (isDynamicImport || isRequire) summary.imports.push(firstArgument.text);
      }
      // Express/Hono/Koa/Fastify route registration: `router.get("/x", handler)`.
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        ROUTE_RECEIVERS.has(callee.expression.text) &&
        ROUTE_REGISTRATION_VERBS.has(callee.name.text.toLowerCase()) &&
        firstArgument !== undefined &&
        ts.isStringLiteral(firstArgument)
      ) {
        summary.routeHandlers.push(callee.name.text.toUpperCase());
      }
    }

    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        summary.imports.push(node.moduleSpecifier.text);
        // `export { a } from "./x"` re-exports just as `export * from "./x"` does; only the star
        // form was recorded, so a barrel file written with named re-exports looked like a leaf.
        summary.reExports.push(node.moduleSpecifier.text);
        if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
          summary.exports.push(node.exportClause.name.text);
        }
      }
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          // The **exported** name, which is `element.name`. In `export { handler as GET }` that
          // is `GET`, and it is what the consuming module actually sees.
          const exported = element.name.text;
          summary.exports.push(exported);
          // `export { handler as GET }` and `export { GET } from "./handlers"` are how the App
          // Router declares a route in a directory that keeps the implementations elsewhere.
          // The summary listed the export and left `routeHandlers` empty, so these routes were
          // invisible to `manifest.indexes.routes[].methods`.
          if (ROUTE_HANDLER_NAMES.has(exported)) summary.routeHandlers.push(exported);
        }
      }
    }

    if (
      ts.isExpressionStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const cjsNames = cjsExportedNames(node.expression);
      if (cjsNames !== null) cjsExports.push(...cjsNames);
    }

    if (ts.isExportAssignment(node)) {
      summary.exports.push("default");
      // `export default () => <div />` is a component with no name to record, so it is recorded
      // as what it is exported as. Without this the anonymous form was the one React component
      // shape missing from `reactComponents`, while the named forms were all present.
      if (rendersJsx(node.expression)) summary.reactComponents.push("default");
    }

    if (ts.isFunctionDeclaration(node)) {
      const exported = isExported(node);
      if (node.name) {
        recordFunctionLike(node.name.text, exported, node);
        // `export default function Foo() {}` is reachable both as `Foo` and as
        // the default export; only the anonymous form used to record `default`.
        if (isDefault(node)) summary.exports.push("default");
      } else if (isDefault(node)) {
        // `export default function () {}`
        summary.exports.push("default");
      }
    }

    if (ts.isClassDeclaration(node)) {
      if (node.name) {
        summary.classes.push(node.name.text);
        if (isExported(node)) summary.exports.push(node.name.text);
        if (isDefault(node)) summary.exports.push("default");
        // A component class extends Component/PureComponent or renders JSX;
        // the name-only rule listed plain classes such as `class Calc` as
        // React components.
        if (
          /^[A-Z]/.test(node.name.text) &&
          (extendsReactBase(node) || rendersJsx(node))
        ) {
          summary.reactComponents.push(node.name.text);
        }
      } else if (isDefault(node)) {
        summary.exports.push("default");
      }
    }

    if (ts.isInterfaceDeclaration(node)) {
      summary.interfaces.push(node.name.text);
      if (isExported(node)) summary.exports.push(node.name.text);
    }

    if (ts.isTypeAliasDeclaration(node)) {
      summary.types.push(node.name.text);
      if (isExported(node)) summary.exports.push(node.name.text);
    }

    if (ts.isEnumDeclaration(node)) {
      summary.enums.push(node.name.text);
      if (isExported(node)) summary.exports.push(node.name.text);
    }

    if (ts.isVariableStatement(node)) {
      const exported = isExported(node);
      for (const declaration of node.declarationList.declarations) {
        const bound: string[] = [];
        bindingNames(declaration.name, bound);
        for (const name of bound) {
          summary.variables.push(name);
          if (exported) {
            summary.exports.push(name);
            // Route handlers are only handlers when exported, matching the rule
            // applied to function declarations.
            if (ROUTE_HANDLER_NAMES.has(name)) summary.routeHandlers.push(name);
          }
          if (/^use[A-Z0-9]/.test(name)) summary.hooks.push(name);
          // Arrow/function components and `memo`/`forwardRef` wrappers render JSX
          // in their initializer; a plain `const Config = {...}` does not.
          if (
            /^[A-Z]/.test(name) &&
            declaration.initializer !== undefined &&
            rendersJsx(declaration.initializer)
          ) {
            summary.reactComponents.push(name);
          }
        }
      }
    }

    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push(children[index]);
    }
  }

  // CommonJS exports are recorded alongside ESM ones, and `exportsKind` says which module
  // system the reader is looking at. A mixed file keeps both and is called `mixed`.
  if (cjsExports.length > 0) {
    summary.exportsKind = summary.exports.length > 0 ? "mixed" : "cjs";
    summary.exports.push(...cjsExports);
  }

  const dedupeSorted = (values: string[]): string[] =>
    Array.from(new Set(values)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  summary.directives = dedupeSorted(summary.directives);
  summary.imports = dedupeSorted(summary.imports);
  summary.exports = dedupeSorted(summary.exports);
  summary.reExports = dedupeSorted(summary.reExports);
  summary.functions = dedupeSorted(summary.functions);
  summary.classes = dedupeSorted(summary.classes);
  summary.interfaces = dedupeSorted(summary.interfaces);
  summary.types = dedupeSorted(summary.types);
  summary.enums = dedupeSorted(summary.enums);
  summary.variables = dedupeSorted(summary.variables);
  summary.reactComponents = dedupeSorted(summary.reactComponents);
  summary.hooks = dedupeSorted(summary.hooks);
  summary.routeHandlers = dedupeSorted(summary.routeHandlers);

  return summary;
}
