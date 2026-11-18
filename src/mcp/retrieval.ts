import type { FileEntry, Manifest } from "../types.js";

/**
 * The retrieval planner: which files answer a question, within a budget.
 *
 * This is the reason the product exists. A snapshot is a dump; a plan is an answer to "given this
 * question and 30k tokens, what should the reader actually open?" The plan is deterministic, it
 * explains every file it includes, and it never invents a path the snapshot does not carry.
 */

export interface PlannedFile {
  path: string;
  part: string;
  layer: string;
  kind: string;
  tokens: number;
  /** full body, or head only when the file is large relative to the budget. */
  mode: "full" | "head";
  /** Why it is here: which term matched, or which file pulled it in. */
  why: string;
}

export interface PlanForResult {
  question: string;
  budgetTokens: number;
  usedTokens: number;
  files: PlannedFile[];
  skipped: Array<{ path: string; reason: string }>;
  notes: string[];
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "what", "when", "where", "which", "how",
  "why", "does", "did", "are", "was", "were", "has", "have", "had", "can", "could", "should",
  "would", "will", "into", "about", "over", "under", "then", "than", "there", "here", "its",
  "it", "is", "a", "an", "of", "to", "in", "on", "at", "by", "or", "be", "not", "do", "if",
]);

function termsOf(question: string): string[] {
  const seen = new Set<string>();
  for (const raw of question.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    seen.add(raw);
    if (seen.size >= 40) break;
  }
  return [...seen];
}

/** Names a file exports or defines, lowercased. */
function symbolNames(file: FileEntry): string[] {
  const summary = file.summary;
  if (summary === undefined) return [];
  const names = new Set<string>();
  const record = summary as unknown as Record<string, unknown>;
  for (const key of ["exports", "functions", "classes", "interfaces", "types", "enums", "variables"]) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item.length > 1) names.add(item.toLowerCase());
    }
  }
  return [...names];
}

function tokensOf(file: FileEntry): number {
  return Math.max(1, Math.ceil(file.includedBytes / 4));
}

function isTest(file: FileEntry): boolean {
  return (
    file.layer === "test" ||
    /(^|\/)(tests?|__tests__|spec)\//.test(file.relativePath) ||
    /\.(test|spec)\.[a-z0-9]+$/i.test(file.relativePath)
  );
}

/** The files a specifier plausibly names, by suffix rather than by resolver. */
function resolveImport(from: string, specifier: string, byPath: Map<string, FileEntry>): FileEntry | null {
  if (!specifier.startsWith(".")) return null;
  const base = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const joined = specifier.startsWith("/") ? specifier.slice(1) : base + "/" + specifier;
  const parts: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  const path = parts.join("/");
  // A TypeScript repository writes "./user.js" and means "./user.ts"; extension-less specifiers
  // are common too. Both are tried before giving up, or the caller side of the graph is empty.
  const withoutExtension = path.replace(/\.[cm]?[jt]sx?$/, "");
  const candidates = [
    path,
    withoutExtension + ".ts",
    withoutExtension + ".tsx",
    withoutExtension + ".js",
    withoutExtension + ".jsx",
    withoutExtension + ".py",
    withoutExtension + ".go",
    withoutExtension + ".rs",
    withoutExtension + "/index.ts",
    path + ".ts",
    path + ".tsx",
    path + ".js",
    path + ".jsx",
    path + ".mjs",
    path + ".cjs",
    path + ".py",
    path + ".go",
    path + ".rs",
    path + ".java",
    path + "/index.ts",
    path + "/index.js",
  ];
  for (const candidate of candidates) {
    const found = byPath.get(candidate);
    if (found !== undefined) return found;
  }
  return null;
}

interface Scored {
  file: FileEntry;
  score: number;
  why: string;
}

export function planForQuestion(
  manifest: Manifest,
  question: string,
  options: { maxTokens?: number; includeTests?: boolean } = {}
): PlanForResult {
  const budget = Math.max(500, options.maxTokens ?? 30000);
  const terms = termsOf(question);
  const byPath = new Map(manifest.files.map((file) => [file.relativePath, file]));
  const importers = new Map<string, string[]>();
  const importsOf = new Map<string, string[]>();
  for (const entry of manifest.indexes.imports.byFile) {
    importsOf.set(entry.path, entry.imports);
    for (const specifier of entry.imports) {
      const target = resolveImport(entry.path, specifier, byPath);
      if (target === null) continue;
      const list = importers.get(target.relativePath);
      if (list === undefined) importers.set(target.relativePath, [entry.path]);
      else list.push(entry.path);
    }
  }
  const centrality = new Map(manifest.indexes.imports.centralFiles.map((entry) => [entry.path, entry.importedByCount]));
  const wantsTests = options.includeTests === true || terms.some((term) => term === "test" || term === "tests" || term === "spec");

  const scored: Scored[] = [];
  for (const file of manifest.files) {
    if (isTest(file) && !wantsTests) continue;
    const path = file.relativePath.toLowerCase();
    const words = path.split(/[^a-z0-9_]+/).filter((word) => word.length >= 3);
    let score = 0;
    const reasons: string[] = [];
    for (const term of terms) {
      if (path.includes(term)) {
        score += 8;
        reasons.push("path:" + term);
        continue;
      }
      // The question says "authenticated"; the file is "auth.ts". A term that merely contains a
      // path word (or the reverse) is the same subject, and exact substring matching missed it.
      const partial = words.find(
        (word) => word.length >= 3 && (term.startsWith(word) || word.startsWith(term))
      );
      if (partial !== undefined) {
        score += 6;
        reasons.push("path:" + partial);
      }
    }
    for (const name of symbolNames(file)) {
      for (const term of terms) {
        // `charge` and `chargeCard` are the same subject; so are `authenticated` and `auth`.
        // Exact substring matching alone missed both, which made a real question plan nothing.
        const shared = Math.min(name.length, term.length);
        if (
          name.includes(term) ||
          term.includes(name) ||
          (shared >= 4 && name.slice(0, shared) === term.slice(0, shared))
        ) {
          score += 5;
          reasons.push("symbol:" + term);
          break;
        }
      }
    }
    if (terms.includes(file.layer.toLowerCase())) {
      score += 2;
      reasons.push("layer:" + file.layer);
    }
    if (terms.includes(file.kind.toLowerCase())) {
      score += 2;
      reasons.push("kind:" + file.kind);
    }
    const hub = centrality.get(file.relativePath) ?? 0;
    score += Math.min(5, hub / 10);
    if (score <= 0) continue;
    scored.push({ file, score, why: reasons.slice(0, 3).join(", ") || "centrality " + hub });
  }

  // An empty snapshot is a different fact from a question that matched nothing, and the notes
  // used to say both at once ("no file matched … the plan falls back" and "the budget is too
  // small for any file"), which is false twice. Say the one true thing and stop.
  const notes: string[] = [];
  if (manifest.files.length === 0) {
    notes.push("The snapshot holds no files; there is nothing to plan. Check manifest.skipped for why paths were not emitted.");
    return { question, budgetTokens: budget, usedTokens: 0, files: [], skipped: [], notes };
  }
  if (scored.length === 0) {
    const hubs = manifest.indexes.imports.centralFiles.slice(0, 12);
    for (const hub of hubs) {
      const file = byPath.get(hub.path);
      if (file !== undefined) scored.push({ file, score: 1, why: "hub, " + hub.importedByCount + " importers" });
    }
    // Say the fallback only when it produced something; otherwise the later note says plainly that
    // nothing matched and there was nothing to fall back on, and two notes would say it twice.
    if (scored.length > 0) {
      notes.push("No file matched the question's terms; the plan falls back to the most-imported files.");
    }
  }

  scored.sort((left, right) => right.score - left.score || left.file.relativePath.localeCompare(right.file.relativePath));

  const chosen = new Map<string, PlannedFile>();
  const skipped: Array<{ path: string; reason: string }> = [];
  let used = 0;

  const take = (file: FileEntry, why: string, mode: "full" | "head"): boolean => {
    const existing = chosen.get(file.relativePath);
    if (existing !== undefined) return false;
    const tokens = tokensOf(file);
    const cost = mode === "head" ? Math.ceil(tokens / 2) : tokens;
    if (used + cost > budget) return false;
    used += cost;
    chosen.set(file.relativePath, {
      path: file.relativePath,
      part: file.part,
      layer: file.layer,
      kind: file.kind,
      tokens: cost,
      mode,
      why,
    });
    return true;
  };

  for (const item of scored) {
    const tokens = tokensOf(item.file);
    if (used + tokens <= budget) {
      take(item.file, item.why, "full");
      continue;
    }
    // A file that is large relative to what is left is worth its head: the imports and signatures
    // at the top are usually enough to answer "does this matter?", and a skip answer is not.
    if (tokens <= budget * 2 && used + Math.ceil(tokens / 2) <= budget) {
      take(item.file, item.why, "head");
      continue;
    }
    skipped.push({ path: item.file.relativePath, reason: "does not fit the remaining budget" });
  }

  // Pull in the imports of the strongest matches: a file's own dependencies are usually the next
  // question, and they are cheap compared with a second round trip.
  const seeded = [...chosen.values()].slice(0, 6);
  for (const seed of seeded) {
    for (const specifier of importsOf.get(seed.path) ?? []) {
      const target = resolveImport(seed.path, specifier, byPath);
      if (target === null || chosen.has(target.relativePath)) continue;
      if (isTest(target) && !wantsTests) continue;
      if (!take(target, "imported by " + seed.path, "full")) {
        if (!take(target, "imported by " + seed.path, "head")) {
          skipped.push({ path: target.relativePath, reason: "does not fit the remaining budget" });
        }
      }
    }
  }

  // Then the callers of the strongest matches: "who uses this" is the other half of "what does
  // this use", and a plan that answers only the first half sends the reader to edit a function
  // without knowing what depends on it. Two per seed, capped, so the section cannot crowd out
  // the answer.
  let callerBudget = 4;
  for (const seed of [...chosen.values()].slice(0, 3)) {
    for (const caller of importers.get(seed.path) ?? []) {
      if (callerBudget <= 0) break;
      if (chosen.has(caller)) continue;
      const file = byPath.get(caller);
      if (file === undefined) continue;
      if (isTest(file) && !wantsTests) continue;
      if (take(file, "imports " + seed.path, "full")) {
        callerBudget -= 1;
      } else if (take(file, "imports " + seed.path, "head")) {
        callerBudget -= 1;
      }
    }
  }

  // "Nothing fit the budget" used to be printed even when there was no candidate at all, which
  // sent the reader looking at the budget for a problem that was in the question. Three states,
  // three sentences.
  if (chosen.size === 0) {
    if (scored.length === 0) {
      notes.push("No candidate file matched the question, and this snapshot has no centrality data to fall back on.");
    } else {
      const cheapest = scored.reduce((minimum, item) => Math.min(minimum, Math.ceil(item.file.includedBytes / 4)), Infinity);
      notes.push("Nothing fit the budget: the cheapest candidate costs about " + formatNumber(cheapest) + " tokens.");
    }
  }
  notes.push(
    formatNumber(chosen.size) + " file(s) chosen of " +
      formatNumber(manifest.files.length) + " in the snapshot; " +
      formatNumber(skipped.length) + " skipped for budget."
  );
  if (!wantsTests) notes.push("Tests were excluded; ask for them explicitly to include them.");

  return {
    question,
    budgetTokens: budget,
    usedTokens: used,
    files: [...chosen.values()],
    skipped: skipped.slice(0, 20),
    notes,
  };
}

function formatNumber(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
