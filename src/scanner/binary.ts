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
  const checkLength = Math.min(buffer.length, 8192);
  for (let index = 0; index < checkLength; index++) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

export function isBinaryFile(absolutePath: string): boolean {
  if (isBinaryExtension(absolutePath)) return true;

  let fd: number | undefined;
  try {
    fd = fs.openSync(absolutePath, "r");
    const buffer = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
    if (bytesRead === 0) return false;
    return isBinaryBuffer(buffer.subarray(0, bytesRead));
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
