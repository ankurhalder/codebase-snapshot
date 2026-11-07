import * as path from "node:path";

export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".json": "json",
  ".jsonc": "json",
  ".md": "markdown",
  ".mdx": "mdx",
  ".css": "css",
  ".scss": "scss",
  ".sass": "scss",
  ".less": "less",
  ".html": "html",
  ".vue": "vue",
  ".svelte": "svelte",
  ".sql": "sql",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".ps1": "powershell",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".dart": "dart",
  ".toml": "toml",
  ".ini": "ini",
  ".env": "dotenv",
  ".xml": "xml",
  ".svg": "xml",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "protobuf",
  ".tf": "hcl",
  ".tfvars": "hcl",
};

export const LANGUAGE_BY_BASENAME: Record<string, string> = {
  Dockerfile: "dockerfile",
  Containerfile: "dockerfile",
  Makefile: "makefile",
  ".gitignore": "gitignore",
  ".npmignore": "gitignore",
  ".dockerignore": "gitignore",
  ".editorconfig": "editorconfig",
};

export function detectLanguage(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const base = path.posix.basename(normalized);
  if (LANGUAGE_BY_BASENAME[base]) return LANGUAGE_BY_BASENAME[base];
  // `.env`, `.env.local`, `.env.production`, …
  if (base === ".env" || base.startsWith(".env.")) return "dotenv";
  const ext = path.posix.extname(base).toLowerCase();
  return LANGUAGE_BY_EXTENSION[ext] ?? "text";
}
