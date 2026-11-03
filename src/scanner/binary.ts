import * as fs from "node:fs";
import * as path from "node:path";

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
  ".bz2",
  ".xz",
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
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

/**
 * How much of a file is scanned for a NUL byte.
 *
 * Sampling only the first 8 KB meant a NUL at byte 9000 was emitted as text into
 * the parts. The whole file is scanned up to this cap; past it the head is
 * checked, because a text file that is 8 MB of clean UTF-8 and then binary is
 * rare and the cost of reading every large file twice is not.
 */
const BINARY_SCAN_BYTES = 8 * 1024 * 1024;
const CHUNK = 64 * 1024;

export function isBinaryFile(absolutePath: string): boolean {
  if (isBinaryExtension(absolutePath)) return true;

  let fd: number | undefined;
  try {
    fd = fs.openSync(absolutePath, "r");
    const buffer = Buffer.alloc(CHUNK);
    let position = 0;
    while (position < BINARY_SCAN_BYTES) {
      const wanted = Math.min(CHUNK, BINARY_SCAN_BYTES - position);
      const bytesRead = fs.readSync(fd, buffer, 0, wanted, position);
      if (bytesRead === 0) return false;
      if (isBinaryBuffer(buffer.subarray(0, bytesRead))) return true;
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
