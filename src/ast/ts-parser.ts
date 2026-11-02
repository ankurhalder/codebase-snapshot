import ts from "typescript";
import type { SourceSummary } from "../types.js";

export function summarizeTypeScriptSource(
  relativePath: string,
  content: string
): SourceSummary {
  const summary: SourceSummary = {
    directives: [],
    imports: [],
    exports: [],
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

  const isJsx = relativePath.endsWith(".tsx") || relativePath.endsWith(".jsx");
  const sourceFile = ts.createSourceFile(
    relativePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const routeHandlerNames = new Set([
    "GET",
    "POST",
    "PUT",
    "DELETE",
    "PATCH",
    "HEAD",
    "OPTIONS",
  ]);

  function isExported(node: ts.Node): boolean {
    const modifiers = ts.canHaveModifiers(node)
      ? ts.getModifiers(node)
      : undefined;
    return Boolean(
      modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    );
  }

  function visit(node: ts.Node) {
    if (ts.isExpressionStatement(node)) {
      if (ts.isStringLiteral(node.expression)) {
        const text = node.expression.text;
        if (text === "use client" || text === "use server") {
          summary.directives.push(text);
        }
      }
    }

    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        summary.imports.push(node.moduleSpecifier.text);
      }
    }

    if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          summary.exports.push(el.name.text);
        }
      }
    }

    if (ts.isExportAssignment(node)) {
      summary.exports.push("default");
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      summary.functions.push(name);
      if (isExported(node)) summary.exports.push(name);
      if (routeHandlerNames.has(name)) summary.routeHandlers.push(name);
      if (/^use[A-Z0-9]/.test(name)) summary.hooks.push(name);
      if (/^[A-Z]/.test(name)) summary.reactComponents.push(name);
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.text;
      summary.classes.push(name);
      if (isExported(node)) summary.exports.push(name);
      if (/^[A-Z]/.test(name)) summary.reactComponents.push(name);
    }

    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;
      summary.interfaces.push(name);
      if (isExported(node)) summary.exports.push(name);
    }

    if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      summary.types.push(name);
      if (isExported(node)) summary.exports.push(name);
    }

    if (ts.isEnumDeclaration(node)) {
      const name = node.name.text;
      summary.enums.push(name);
      if (isExported(node)) summary.exports.push(name);
    }

    if (ts.isVariableStatement(node)) {
      const exported = isExported(node);
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const name = decl.name.text;
          summary.variables.push(name);
          if (exported) {
            summary.exports.push(name);
            if (routeHandlerNames.has(name)) summary.routeHandlers.push(name);
          }
          if (/^use[A-Z0-9]/.test(name)) summary.hooks.push(name);
          if (/^[A-Z]/.test(name)) summary.reactComponents.push(name);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  summary.directives = Array.from(new Set(summary.directives)).sort();
  summary.imports = Array.from(new Set(summary.imports)).sort();
  summary.exports = Array.from(new Set(summary.exports)).sort();
  summary.functions = Array.from(new Set(summary.functions)).sort();
  summary.classes = Array.from(new Set(summary.classes)).sort();
  summary.interfaces = Array.from(new Set(summary.interfaces)).sort();
  summary.types = Array.from(new Set(summary.types)).sort();
  summary.enums = Array.from(new Set(summary.enums)).sort();
  summary.variables = Array.from(new Set(summary.variables)).sort();
  summary.reactComponents = Array.from(new Set(summary.reactComponents)).sort();
  summary.hooks = Array.from(new Set(summary.hooks)).sort();
  summary.routeHandlers = Array.from(new Set(summary.routeHandlers)).sort();

  return summary;
}
