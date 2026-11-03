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
  const isJsx = lowerPath.endsWith(".tsx") || lowerPath.endsWith(".jsx");

  const sourceFile = ts.createSourceFile(
    relativePath,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  // A file with syntax errors still produces a (partial) summary. Recording the
  // count lets the caller say so instead of presenting a broken file as clean.
  // `parseDiagnostics` is part of the compiler's implementation surface, hence
  // the narrowing cast rather than a public API call.
  const parseErrors =
    (sourceFile as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics
      ?.length ?? 0;
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

  const stack: ts.Node[] = [sourceFile];
  while (stack.length > 0) {
    const node = stack.pop() as ts.Node;

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      summary.imports.push(node.moduleSpecifier.text);
    }

    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        summary.imports.push(node.moduleSpecifier.text);
        if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
          summary.exports.push(node.exportClause.name.text);
        } else if (!node.exportClause) {
          // `export * from "./x"`
          summary.reExports.push(node.moduleSpecifier.text);
        }
      }
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          summary.exports.push(element.name.text);
        }
      }
    }

    if (ts.isExportAssignment(node)) {
      summary.exports.push("default");
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
        if (!ts.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
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

    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push(children[index]);
    }
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
