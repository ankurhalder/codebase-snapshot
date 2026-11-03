// S2 (01 §2 / C3) — multi-line private keys: only the BEGIN line was redacted,
// so the body plus END marker survived and a real key was reconstructible.
//
// Check: no body line of any private key may appear in ANY emitted artifact,
// across terminated / unterminated / CRLF / EC / OPENSSH / PGP / .pem /
// preview-truncated / single-line-JSON shapes. Reconstruction is then attempted
// from the emitted part: with no body lines left there is nothing to rebuild.
import * as path from "node:path";
import { generateSnapshot, resolveConfig, scanAndRedactSecrets } from "../../dist/index.js";
import {
  assert,
  assertNotIncludes,
  check,
  finish,
  gitInit,
  readTree,
  selfTest,
  tmp,
  write,
} from "./v-lib.mjs";

selfTest();

const BODY = [
  "MIIEowIBAAKCAQEAzL1nQ7YQ0pKq8m2sVv3uJ1xH4tG6bN9dR2fS5hT8jW0kY3mZ6pQ",
  "PRIVBODYLINE2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "PRIVBODYLINE3bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "PRIVBODYLINE4cccccccccccccccccccccccccccccccccccccccccccccccccccccc",
];
const NEEDLES = [
  ["pem line 1", "MIIEowIBAAKCAQEAzL1nQ7YQ0pKq8m2sVv3uJ1xH4tG6bN9dR2"],
  ["pem line 2", "PRIVBODYLINE2"],
  ["pem line 3", "PRIVBODYLINE3"],
  ["pem line 4", "PRIVBODYLINE4"],
];

function scanAll(dir) {
  const tree = readTree(dir);
  return Object.entries(tree)
    .map(([name, text]) => `\n<<<${name}>>>\n${text}`)
    .join("");
}

check("S2.terminated", "a complete RSA private key leaves no body line in any artifact", () => {
  const dir = tmp("s2a");
  const git = gitInit(dir);
  write(
    dir,
    "keys/id_rsa",
    `-----BEGIN RSA PRIVATE KEY-----\n${BODY.join("\n")}\n-----END RSA PRIVATE KEY-----\n`
  );
  write(dir, "src/app.ts", "export const a = 1;\n");
  git.add("-f", ".");
  git.commit();
  generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
  const all = scanAll(path.join(dir, "snapshot"));
  for (const [label, needle] of NEEDLES) assertNotIncludes(all, needle, `leak of ${label}`);
  return "4/4 body lines absent";
});

check("S2.reconstruct", "the emitted part cannot be rebuilt into a key by re-adding the header", () => {
  const dir = tmp("s2r");
  write(dir, "keys/id_ed25519", `-----BEGIN OPENSSH PRIVATE KEY-----\n${BODY.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`);
  write(dir, "src/a.ts", "export const a = 1;\n");
  generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", includeSensitiveFiles: true }));
  const part = Object.values(readTree(path.join(dir, "snapshot"))).join("\n");
  // Old attack: replace the marker line with a BEGIN header and parse the result.
  const rebuilt = part
    .split("\n")
    .map((line) =>
      line.includes("REDACTED")
        ? "-----BEGIN OPENSSH PRIVATE KEY-----"
        : line
    )
    .join("\n");
  const reconstructedBody = BODY.filter((line) => rebuilt.includes(line));
  assert(reconstructedBody.length === 0, `reconstruction recovered ${reconstructedBody.length}/4 body lines`);
  assert(rebuilt.includes("-----BEGIN OPENSSH PRIVATE KEY-----"), "attack setup failed");
  return "0/4 body lines recoverable";
});

check("S2.unterminated", "a key whose END marker is missing still loses its body", () => {
  const dir = tmp("s2u");
  write(dir, "notes.txt", `before\n-----BEGIN RSA PRIVATE KEY-----\n${BODY.join("\n")}\nafter-key-junk\n`);
  generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", includeSensitiveFiles: true }));
  const all = scanAll(path.join(dir, "snapshot"));
  for (const [label, needle] of NEEDLES) assertNotIncludes(all, needle, `leak of ${label}`);
  return "4/4 body lines absent";
});

check("S2.crlf", "CRLF private key is masked as a block", () => {
  const dir = tmp("s2c");
  write(dir, "id_rsa", `-----BEGIN RSA PRIVATE KEY-----\r\n${BODY.join("\r\n")}\r\n-----END RSA PRIVATE KEY-----\r\n`);
  generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", includeSensitiveFiles: true }));
  assertNotIncludes(scanAll(path.join(dir, "snapshot")), "PRIVBODYLINE2", "crlf leak");
  return "masked";
});

check("S2.headers", "EC / ENCRYPTED / PGP / PKCS#8 headers are all recognised", () => {
  const cases = [
    "-----BEGIN EC PRIVATE KEY-----",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----",
    "-----BEGIN DSA PRIVATE KEY-----",
  ];
  const bodies = [];
  cases.forEach((header, index) => {
    const end = header.replace("BEGIN", "END");
    const body = [`BODYCASE${index}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`];
    bodies.push([`case${index}`, body[0]]);
    const { redacted } = scanAndRedactSecrets(`${header}\n${body[0]}\n${end}\n`, [], "x");
    assert(!redacted.includes(body[0]), `header ${header} left its body in place`);
  });
  return `${cases.length}/${cases.length} headers block-masked`;
});

check("S2.preview-truncated", "a key inside a >200 KB file is masked before preview truncation", () => {
  const dir = tmp("s2p");
  const filler = "const pad = 1;\n".repeat(30000); // ~420 KB, > largeFileBytes
  write(dir, "src/big.ts", `${filler}-----BEGIN RSA PRIVATE KEY-----\n${BODY.join("\n")}\n-----END RSA PRIVATE KEY-----\n${filler}`);
  generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
  const all = scanAll(path.join(dir, "snapshot"));
  for (const [label, needle] of NEEDLES) assertNotIncludes(all, needle, `leak of ${label}`);
  return "masked inside a 420 KB file";
});

check("S2.json-singleline", "a key embedded in one JSON line (literal \\n escapes) is masked", () => {
  const dir = tmp("s2j");
  const escaped = `-----BEGIN RSA PRIVATE KEY-----\\n${BODY.join("\\n")}\\n-----END RSA PRIVATE KEY-----`;
  write(dir, "keys.json", `{"private_key": "${escaped}"}\n`);
  generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
  const all = scanAll(path.join(dir, "snapshot"));
  for (const [label, needle] of NEEDLES) assertNotIncludes(all, needle, `leak of ${label}`);
  return "masked";
});

check("S2.line-numbers", "masking preserves line numbers of later findings", () => {
  const content = `line1\n-----BEGIN RSA PRIVATE KEY-----\n${BODY.join("\n")}\n-----END RSA PRIVATE KEY-----\nAKIAIOSFODNN7EXAMPLE\n`;
  const { findings } = scanAndRedactSecrets(content, [
    { rule: "pem", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { rule: "aws", pattern: /AKIA[0-9A-Z]{16}/ },
  ], "f");
  const keyBlock = findings.find((f) => f.rule === "private-key-block");
  const aws = findings.find((f) => f.rule === "aws");
  assert(keyBlock && keyBlock.line === 2, `private-key-block line was ${keyBlock?.line}, expected 2`);
  assert(aws && aws.line === 8, `aws finding line was ${aws?.line}, expected 8`);
  return "block line 2, following finding line 8";
});

// Adversarial shapes that are NOT part of the reported finding: documented, not asserted.
check("S2.adversarial-observations", "record residual PEM shapes (informational)", () => {
  const notes = [];
  const blankLineBody = `-----BEGIN RSA PRIVATE KEY-----\n${BODY[0]}\n\n${BODY[1]}\n`;
  const a = scanAndRedactSecrets(blankLineBody, [], "x").redacted;
  notes.push(`blank-line-in-body retains post-blank body: ${a.includes(BODY[1])}`);
  const indented = `tls.key: |\n    -----BEGIN RSA PRIVATE KEY-----\n    ${BODY[0]}\n    ${BODY[1]}\n`;
  const b = scanAndRedactSecrets(indented, [], "x").redacted;
  notes.push(`indented+unterminated retains body: ${b.includes(BODY[1])}`);
  const lower = `-----begin rsa private key-----\n${BODY[0]}\n`;
  const c = scanAndRedactSecrets(lower, [], "x").redacted;
  notes.push(`lowercase header retains body: ${c.includes(BODY[0])}`);
  return notes.join(" | ");
});

finish();
