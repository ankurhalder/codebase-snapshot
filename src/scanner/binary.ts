import * as fs from "node:fs";
import * as path from "node:path";
import type { TextEncoding } from "../types.js";

export type { TextEncoding };

export const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".bmp",
  ".tiff",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".br",
  ".bz2",
  ".xz",
  ".zst",
  ".lz4",
  ".lzma",
  ".7z",
  ".rar",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".webm",
  ".mov",
  ".avi",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".wasm",
  ".node",
  ".exe",
  ".dll",
  ".dylib",
  ".so",
]);

export function isBinaryExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

export function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.includes(0);
}

/**
 * How many bytes are control characters that a text file has no business containing.
 *
 * Tab, newline and carriage return are text. So is U+007F only in the sense that it is printable
 * garbage; it counts here. C1 controls (U+0080–U+009F) are counted through their two-byte UTF-8
 * form, because a single-byte C1 is not valid UTF-8 at all and is caught by the validity check.
 */
function countControlBytes(buffer: Buffer): number {
  let count = 0;
  for (let index = 0; index < buffer.length; index++) {
    const byte = buffer[index] as number;
    if (byte < 0x20) {
      if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) count += 1;
      continue;
    }
    if (byte === 0x7f) {
      count += 1;
      continue;
    }
    if (byte === 0xc2 && index + 1 < buffer.length) {
      const next = buffer[index + 1] as number;
      if (next >= 0x80 && next <= 0x9f) {
        count += 1;
        index += 1;
      }
    }
  }
  return count;
}

/** Below this many control bytes a file is text with something odd in it, not a payload. */
const CONTROL_BYTES_FLOOR = 4;

export interface DecodedText {
  /** Decoded body. Empty when `binary` is true. */
  text: string;
  encoding: TextEncoding;
  /** Byte count that could not be decoded as UTF-8. Zero for well-formed input. */
  invalidBytes: number;
  /** True when the bytes are not text: a NUL, or a payload full of control characters. */
  binary: boolean;
  /** Human-readable reason the bytes were rejected, when `binary` is true. */
  binaryReason?: string;
}

/**
 * Counts the bytes that are not part of a well-formed UTF-8 sequence.
 *
 * `buffer.toString("utf8")` silently substitutes U+FFFD for every bad sequence, which is how a
 * Latin-1 source file used to reach the snapshot as `caf\uFFFD` with no warning anywhere. This
 * gives the caller the number it needs to say so.
 */
export function countInvalidUtf8Bytes(buffer: Buffer): number {
  let invalid = 0;
  let index = 0;
  const length = buffer.length;

  while (index < length) {
    const lead = buffer[index] as number;
    if (lead < 0x80) {
      index += 1;
      continue;
    }

    let continuation = 0;
    let codePoint = 0;
    let minimum = 0;

    if ((lead & 0xe0) === 0xc0) {
      continuation = 1;
      codePoint = lead & 0x1f;
      minimum = 0x80;
    } else if ((lead & 0xf0) === 0xe0) {
      continuation = 2;
      codePoint = lead & 0x0f;
      minimum = 0x800;
    } else if ((lead & 0xf8) === 0xf0) {
      continuation = 3;
      codePoint = lead & 0x07;
      minimum = 0x10000;
    } else {
      // A continuation byte with no lead, or one of the invalid lead bytes.
      invalid += 1;
      index += 1;
      continue;
    }

    if (index + continuation >= length) {
      // A sequence cut off by the end of the buffer. Count only the lead byte and let the loop
      // judge what follows: in `E9 0A` the 0xE9 is a broken lead, but 0x0A is an ordinary newline
      // and counting it as undecodable would overstate the damage.
      invalid += 1;
      index += 1;
      continue;
    }

    let wellFormed = true;
    for (let offset = 1; offset <= continuation; offset++) {
      const next = buffer[index + offset] as number;
      if ((next & 0xc0) !== 0x80) {
        wellFormed = false;
        break;
      }
      codePoint = (codePoint << 6) | (next & 0x3f);
    }

    const isSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
    if (!wellFormed || codePoint < minimum || codePoint > 0x10ffff || isSurrogate) {
      invalid += 1;
      index += 1;
      continue;
    }

    index += continuation + 1;
  }

  return invalid;
}

function readBomEncoding(buffer: Buffer): "utf-16le" | "utf-16be" | null {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return "utf-16le";
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return "utf-16be";
  }
  return null;
}

/**
 * Recognises a UTF-16 stream that has no BOM, from the NUL padding its ASCII characters carry.
 *
 * A UTF-16LE `hello` is `68 00 65 00 …`: the odd bytes are NUL. Requiring a strong majority on
 * one side and almost none on the other keeps genuine binary data — which spreads its NULs
 * evenly — out of the text path.
 */
function looksLikeUtf16(buffer: Buffer): "utf-16le" | "utf-16be" | null {
  if (buffer.length < 8 || buffer.length % 2 !== 0) return null;

  const sample = Math.min(buffer.length, 4096);
  let nulInLowByte = 0;
  let nulInHighByte = 0;
  const units = sample / 2;

  for (let index = 0; index < sample; index += 2) {
    if (buffer[index] === 0) nulInLowByte += 1;
    if (buffer[index + 1] === 0) nulInHighByte += 1;
  }

  if (nulInHighByte > units * 0.3 && nulInLowByte < units * 0.05) return "utf-16le";
  if (nulInLowByte > units * 0.3 && nulInHighByte < units * 0.05) return "utf-16be";
  return null;
}

function decodeUtf16(buffer: Buffer, encoding: "utf-16le" | "utf-16be"): string {
  // Node's TextDecoder does not promise `utf-16be`, so byte-swap into little endian instead.
  const littleEndian =
    encoding === "utf-16le" ? buffer : Buffer.from(buffer.subarray(0, buffer.length - (buffer.length % 2))).swap16();
  return new TextDecoder("utf-16le").decode(littleEndian);
}

/**
 * Decodes a file buffer to text without guessing silently.
 *
 * Order matters. A UTF-16 file is mostly NUL bytes, and NUL is perfectly valid UTF-8, so asking
 * "is this valid UTF-8?" first would answer yes and hand the caller a string full of NULs. The
 * BOM check and the UTF-16 shape test therefore run before the UTF-8 validity test.
 */
export function decodeText(buffer: Buffer): DecodedText {
  const bomEncoding = readBomEncoding(buffer);
  if (bomEncoding) {
    const text = decodeUtf16(buffer.subarray(2), bomEncoding);
    return { text, encoding: bomEncoding, invalidBytes: 0, binary: false };
  }

  if (buffer.includes(0)) {
    const shape = looksLikeUtf16(buffer);
    if (shape) {
      return { text: decodeUtf16(buffer, shape), encoding: shape, invalidBytes: 0, binary: false };
    }
    const offset = buffer.indexOf(0);
    return {
      text: "",
      encoding: "utf-8",
      invalidBytes: 0,
      binary: true,
      binaryReason: `NUL byte at offset ${offset}`,
    };
  }

  const invalidBytes = countInvalidUtf8Bytes(buffer);
  if (invalidBytes === 0) {
    // Valid UTF-8 is not the same thing as text. A blob of 0x07 bytes decodes perfectly and used
    // to be emitted as `language=text`, `inclusionMode=full`, with the raw control bytes inside
    // the part — the one way a binary file could still reach an artifact, because it has no NUL.
    const controlBytes = countControlBytes(buffer);
    if (controlBytes > CONTROL_BYTES_FLOOR && controlBytes * 100 > buffer.length) {
      return {
        text: "",
        encoding: "utf-8",
        invalidBytes: 0,
        binary: true,
        binaryReason: `${controlBytes} control byte(s) in ${buffer.length} B; valid UTF-8 but not text`,
      };
    }
    return {
      text: new TextDecoder("utf-8").decode(buffer),
      encoding: "utf-8",
      invalidBytes: 0,
      binary: false,
    };
  }

  // A compressed blob that is not in `BINARY_EXTENSIONS` fails UTF-8 decoding rather than
  // containing a NUL, so it used to reach the parts as mojibake: ripgrep's 186-byte
  // `sherlock.br` (Brotli, 79 undecodable bytes) was emitted `full` as 341 bytes of U+FFFD —
  // the one case where the artifact is larger than the source and says nothing.
  //
  // The bar is deliberately high — at least 32 undecodable bytes AND at least a third of the
  // file — because a *text* file can be a third non-ASCII in the wrong encoding: a Latin-1
  // French or German document is full of single bytes that are invalid UTF-8, and turning those
  // into `binary` skips would drop real source files. Compressed data sits far above this line
  // (Brotli's fixture is 42%).
  if (invalidBytes >= 32 && invalidBytes * 3 >= buffer.length) {
    return {
      text: "",
      encoding: "utf-8",
      invalidBytes,
      binary: true,
      binaryReason: `${invalidBytes} of ${buffer.length} bytes are not UTF-8; treated as binary`,
    };
  }

  // Keep the file — dropping a whole source file is worse than a substitute glyph — but record
  // exactly how much was unreadable so the manifest and the report can say it out loud.
  return {
    text: buffer.toString("utf8"),
    encoding: "utf-8-lossy",
    invalidBytes,
    binary: false,
  };
}

/**
 * How much of a file is scanned for a NUL byte before the read is abandoned.
 *
 * Sampling only the first 8 KB meant a NUL at byte 9000 was emitted as text into the parts. The
 * whole file is scanned up to this cap; past it the head is checked, because refusing to read a
 * multi-gigabyte blob into memory to look for one byte is the right trade. Files that pass the
 * head check are checked again in full on the buffer the generator already read for its content,
 * so the cap no longer decides whether a NUL is found.
 */
const BINARY_SCAN_BYTES = 8 * 1024 * 1024;
const CHUNK = 64 * 1024;
const SHAPE_SAMPLE_BYTES = 4096;

export function isBinaryFile(absolutePath: string): boolean {
  if (isBinaryExtension(absolutePath)) return true;

  let fd: number | undefined;
  try {
    fd = fs.openSync(absolutePath, "r");
    const buffer = Buffer.alloc(CHUNK);
    let sample: Buffer | undefined;
    let position = 0;

    while (position < BINARY_SCAN_BYTES) {
      const wanted = Math.min(CHUNK, BINARY_SCAN_BYTES - position);
      const bytesRead = fs.readSync(fd, buffer, 0, wanted, position);
      if (bytesRead === 0) return false;

      const chunk = buffer.subarray(0, bytesRead);
      if (sample === undefined) {
        sample = Buffer.from(chunk.subarray(0, SHAPE_SAMPLE_BYTES));
      }

      if (chunk.includes(0)) {
        // NUL bytes are either the padding of a UTF-16 text file or the mark of a binary blob.
        const shape = readBomEncoding(sample) ?? looksLikeUtf16(sample);
        return shape === null;
      }

      position += bytesRead;
    }

    return false;
  } catch {
    return false;
  } finally {
    // The descriptor used to leak whenever readSync threw.
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}
