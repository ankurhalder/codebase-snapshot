/**
 * Builds an ASCII directory tree.
 *
 * Ordering is a plain code-unit comparison, not `localeCompare`: the tree used
 * to sort differently depending on the machine's locale/ICU data. Directories
 * are suffixed with `/` so a file and a directory with the same name are no
 * longer indistinguishable, and the output is capped so a huge repository cannot
 * produce an unbounded report.
 */
const MAX_TREE_LINES = 20_000;

export function generateProjectTree(filePaths: string[]): string {
  interface TreeNode {
    children: Map<string, TreeNode>;
  }

  const root: TreeNode = { children: new Map() };

  for (const filePath of filePaths) {
    const parts = filePath.split("/").filter((part) => part.length > 0);
    let current = root;
    for (const part of parts) {
      let child = current.children.get(part);
      if (!child) {
        child = { children: new Map() };
        current.children.set(part, child);
      }
      current = child;
    }
  }

  const lines: string[] = ["# Project Tree", "", "```text", "."];
  let truncatedAt = -1;

  function walk(node: TreeNode, prefix: string): void {
    if (truncatedAt !== -1) return;

    const keys = Array.from(node.children.keys()).sort((a, b) => {
      const aIsDir = node.children.get(a)!.children.size > 0;
      const bIsDir = node.children.get(b)!.children.size > 0;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });

    keys.forEach((key, index) => {
      if (truncatedAt !== -1) return;
      const isLast = index === keys.length - 1;
      const child = node.children.get(key)!;
      const isDirectory = child.children.size > 0;
      lines.push(`${prefix}${isLast ? "└── " : "├── "}${key}${isDirectory ? "/" : ""}`);
      if (lines.length >= MAX_TREE_LINES) {
        truncatedAt = lines.length;
        return;
      }
      walk(child, prefix + (isLast ? "    " : "│   "));
    });
  }

  walk(root, "");

  if (truncatedAt !== -1) {
    lines.push(`... [tree truncated at ${MAX_TREE_LINES} lines] ...`);
  }

  lines.push("```", "");
  return lines.join("\n");
}
