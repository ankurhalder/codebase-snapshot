export function generateProjectTree(filePaths: string[]): string {
  interface TreeNode {
    [key: string]: TreeNode;
  }

  const root: TreeNode = {};

  for (const filePath of filePaths) {
    const parts = filePath.split("/");
    let current = root;
    for (const part of parts) {
      if (!current[part]) {
        current[part] = {};
      }
      current = current[part];
    }
  }

  const lines: string[] = ["# Project Tree", "", "```text", "."];

  function formatNode(node: TreeNode, prefix: string) {
    const keys = Object.keys(node).sort((a, b) => {
      const aIsDir = Object.keys(node[a]).length > 0;
      const bIsDir = Object.keys(node[b]).length > 0;
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.localeCompare(b);
    });

    keys.forEach((key, index) => {
      const isLast = index === keys.length - 1;
      const connector = isLast ? "└── " : "├── ";
      lines.push(`${prefix}${connector}${key}`);

      const childPrefix = prefix + (isLast ? "    " : "│   ");
      formatNode(node[key], childPrefix);
    });
  }

  formatNode(root, "");
  lines.push("```", "");
  return lines.join("\n");
}
