import * as path from "node:path";

export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".mdx": "mdx",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".sql": "sql",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sh": "bash",
  ".bash": "bash",
  ".ps1": "powershell",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".toml": "toml",
  ".env": "bash",
  ".dockerfile": "dockerfile",
  ".xml": "xml",
  ".svg": "xml",
};

export const LANGUAGE_BY_BASENAME: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  ".gitignore": "gitignore",
  ".npmignore": "gitignore",
  ".editorconfig": "editorconfig",
};

export function detectLanguage(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const base = path.posix.basename(normalized);
  if (LANGUAGE_BY_BASENAME[base]) return LANGUAGE_BY_BASENAME[base];
  if (base.startsWith(".env")) return "bash";
  const ext = path.posix.extname(base).toLowerCase();
  return LANGUAGE_BY_EXTENSION[ext] ?? "text";
}
