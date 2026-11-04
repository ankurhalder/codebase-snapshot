import { fenceForText } from "../partitioner/chunker.js";
import { escapeControls } from "../terminal.js";

/**
 * Builds an ASCII directory tree.
 *
 * Ordering is a plain code-unit comparison, not `localeCompare`: the tree used
 * to sort differently depending on the machine's locale/ICU data. Directories
 * are suffixed with `/` so a file and a directory with the same name are no
 * longer indistinguishable, and the output is capped so a huge repository cannot
 * produce an unbounded report.
 *
 * The walk is iterative: the recursive version blew the stack on a repository
 * with ~6000 nested directories ("Maximum call stack size exceeded", exit 1, no
 * snapshot at all). Depth is also capped — a hostile checkout cannot force an
 * unbounded number of indentation levels through this report.
 */
const MAX_TREE_LINES = 20_000;
const MAX_TREE_DEPTH = 512;

interface TreeNode {
  children: Map<string, TreeNode>;
}

interface WalkFrame {
  node: TreeNode;
  prefix: string;
  depth: number;
  keys: string[];
  index: number;
}

function childKeys(node: TreeNode): string[] {
  return Array.from(node.children.keys()).sort((a, b) => {
    const aIsDir = node.children.get(a)!.children.size > 0;
    const bIsDir = node.children.get(b)!.children.size > 0;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function generateProjectTree(filePaths: string[]): string {
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

  const lines: string[] = ["."];
  let truncatedAt = -1;
  let depthTruncated = false;

  const stack: WalkFrame[] = [{ node: root, prefix: "", depth: 0, keys: childKeys(root), index: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.keys.length) {
      stack.pop();
      continue;
    }
    const key = frame.keys[frame.index];
    frame.index += 1;
    const isLast = frame.index === frame.keys.length;
    const child = frame.node.children.get(key)!;
    const isDirectory = child.children.size > 0;
    // Sorting stays on the raw name; only the rendered label is escaped, so a
    // bidi override in a name cannot reorder the tree visually or the list.
    const label = escapeControls(key);
    lines.push(`${frame.prefix}${isLast ? "└── " : "├── "}${label}${isDirectory ? "/" : ""}`);
    if (lines.length >= MAX_TREE_LINES) {
      truncatedAt = lines.length;
      break;
    }
    if (!isDirectory) continue;
    if (frame.depth + 1 > MAX_TREE_DEPTH) {
      depthTruncated = true;
      continue;
    }
    stack.push({
      node: child,
      prefix: frame.prefix + (isLast ? "    " : "│   "),
      depth: frame.depth + 1,
      keys: childKeys(child),
      index: 0,
    });
  }

  if (truncatedAt !== -1) {
    lines.push(`... [tree truncated at ${MAX_TREE_LINES} lines] ...`);
  } else if (depthTruncated) {
    lines.push(`... [tree truncated at ${MAX_TREE_DEPTH} levels] ...`);
  }

  // Chosen from the rendered tree: a filename may contain a backtick run, and a
  // fixed three-backtick fence would let it close the block.
  const fence = fenceForText(lines.join("\n"), 3);
  return ["# Project Tree", "", `${fence}text`, ...lines, fence, ""].join("\n");
}
