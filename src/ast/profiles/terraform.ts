import type { LanguageProfile } from "./shared.js";
import { eachLine, emptySummary, finalizeSummary } from "./shared.js";

/**
 * Terraform and HCL.
 *
 * The unit of a Terraform file is a block, so each block is one entry: `resource` and `data`
 * blocks are the infrastructure (classes), `variable` and `locals` are the inputs,
 * `output` is what the module publishes, and `module` is a dependency — recorded as an
 * import, because that is what it is.
 *
 * Blocks are named `type.name` because both halves are load-bearing: two `aws_instance`
 * resources in one file are different things, and a summary that listed only the type would
 * describe neither of them.
 */
const BLOCK = /^\s*(resource|data|module|provider|variable|output|locals|terraform)\b\s*("([^"]+)")?\s*("([^"]+)")?/;
const TERRAFORM_VERSION = /^\s*required_version\s*=\s*"([^"]+)"/;

export const terraformProfile: LanguageProfile = {
  id: "terraform",
  extensions: [".tf", ".tfvars"],
  summarize(_path, content) {
    const summary = emptySummary();

    eachLine(content, (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return;

      const version = TERRAFORM_VERSION.exec(line);
      if (version) {
        summary.directives.push(`required_version ${version[1]}`);
        return;
      }

      // A `.tfvars` file is `name = value` assignments, not blocks.
      if (/^[A-Za-z_][\w-]*\s*=/.test(trimmed)) {
        summary.variables.push(/^([A-Za-z_][\w-]*)/.exec(trimmed)?.[1] ?? trimmed);
        return;
      }

      const block = BLOCK.exec(line);
      if (!block) return;
      const keyword = block[1] as string;
      const first = block[3];
      const second = block[5];

      switch (keyword) {
        case "resource":
        case "data": {
          if (!first || !second) return;
          const name = `${first}.${second}`;
          summary.classes.push(name);
          summary.exports.push(name);
          return;
        }
        case "module": {
          if (!first) return;
          summary.imports.push(first);
          return;
        }
        case "variable": {
          if (!first) return;
          summary.variables.push(first);
          return;
        }
        case "output": {
          if (!first) return;
          summary.exports.push(first);
          return;
        }
        case "provider": {
          if (!first) return;
          summary.imports.push(`provider:${first}`);
          return;
        }
        default: {
          // `locals`, `terraform`: a block with no name of its own.
          summary.directives.push(keyword);
        }
      }
    });

    return { summary: finalizeSummary(summary), quality: "heuristic" };
  },
};
