import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface GitInfo {
  branch: string;
  commit: string;
  isDirty: boolean;
}

export function getGitInfo(cwd: string, fallbackBranch = "main"): GitInfo {
  try {
    const branch = childProcess
      .execSync("git rev-parse --abbrev-ref HEAD", {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      })
      .trim() || fallbackBranch;

    const commit = childProcess
      .execSync("git rev-parse HEAD", {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      })
      .trim() || "unknown";

    const status = childProcess
      .execSync("git status --porcelain", {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      })
      .trim();

    return {
      branch,
      commit,
      isDirty: status.length > 0,
    };
  } catch {
    return {
      branch: fallbackBranch,
      commit: "unknown",
      isDirty: false,
    };
  }
}

export function collectFiles(
  cwd: string,
  excludePatterns: string[] = []
): string[] {
  let relativeFiles: string[] = [];

  try {
    const stdout = childProcess.execSync(
      "git ls-files --cached --others --exclude-standard",
      {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
      }
    );
    relativeFiles = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/\\/g, "/"));
  } catch {
    relativeFiles = walkDirectory(cwd, cwd);
  }

  const defaultIgnoredPaths = [
    "node_modules/",
    ".git/",
    "dist/",
    "build/",
    ".next/",
    ".turbo/",
    "coverage/",
    "out/",
    "snapshot/",
    "snapshot.tmp/",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
  ];

  return relativeFiles
    .filter((file) => {
      for (const p of defaultIgnoredPaths) {
        if (p.endsWith("/")) {
          if (file.startsWith(p) || file.includes(`/${p}`)) return false;
        } else {
          if (file === p || file.endsWith(`/${p}`)) return false;
        }
      }
      for (const pattern of excludePatterns) {
        if (file.includes(pattern)) return false;
      }
      return true;
    })
    .sort();
}

function walkDirectory(dir: string, baseDir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "dist" ||
        entry.name === "build" ||
        entry.name === ".next" ||
        entry.name === ".turbo" ||
        entry.name === "coverage" ||
        entry.name === "snapshot" ||
        entry.name === "snapshot.tmp"
      ) {
        continue;
      }
      results.push(...walkDirectory(fullPath, baseDir));
    } else if (entry.isFile()) {
      results.push(relPath);
    }
  }

  return results;
}

