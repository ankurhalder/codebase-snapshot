import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A zip writer, stored entries only, no dependencies.
 *
 * The point is to hand someone the snapshot directory as one file from the browser. Deflate would
 * be smaller, but a store-only archive is a few hundred lines instead of a compression library, and
 * the payload is text that the snapshot itself already budgeted. The format is the one every
 * operating system can open, and a test reads the central directory back to prove it.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_RECORD = 0x06054b50;
/** Bit 11: names are UTF-8. The flag every modern extractor understands. */
const UTF8_FLAG = 0x0800;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS time and date, fixed at the epoch-adjacent value when the source says nothing better. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipEntry {
  /** Path inside the archive, forward slashes. */
  name: string;
  content: Buffer;
  /** Modification time; defaults to now. */
  mtime?: Date;
}

export interface ZipOptions {
  /** Root directory whose files become the entries; overrides `entries`. */
  directory?: string;
  entries?: readonly ZipEntry[];
  /** Skip these names, relative to the directory. */
  skip?: (relative: string) => boolean;
}

/** Every regular file under `root`, relative and forward-slashed. */
export function walkFiles(root: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : prefix + "/" + entry.name;
    if (entry.isDirectory()) files.push(...walkFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

export function writeZip(options: ZipOptions): Buffer {
  const entries: ZipEntry[] = [...(options.entries ?? [])];
  if (options.directory !== undefined) {
    const root = options.directory;
    for (const relative of walkFiles(root)) {
      if (options.skip !== undefined && options.skip(relative)) continue;
      const full = path.join(root, relative);
      const stat = fs.statSync(full);
      entries.push({ name: relative, content: fs.readFileSync(full), mtime: stat.mtime });
    }
  }
  if (entries.length > 65535) {
    throw new Error("zip: too many entries for the non-zip64 writer (" + entries.length + ")");
  }

  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const data = entry.content;
    const crc = crc32(data);
    const { time, date } = dosDateTime(entry.mtime ?? new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, data);

    const entryHeader = Buffer.alloc(46);
    entryHeader.writeUInt32LE(CENTRAL_HEADER, 0);
    entryHeader.writeUInt16LE(20, 4);
    entryHeader.writeUInt16LE(20, 6);
    entryHeader.writeUInt16LE(UTF8_FLAG, 8);
    entryHeader.writeUInt16LE(0, 10);
    entryHeader.writeUInt16LE(time, 12);
    entryHeader.writeUInt16LE(date, 14);
    entryHeader.writeUInt32LE(crc, 16);
    entryHeader.writeUInt32LE(data.length, 20);
    entryHeader.writeUInt32LE(data.length, 24);
    entryHeader.writeUInt16LE(name.length, 28);
    entryHeader.writeUInt16LE(0, 30);
    entryHeader.writeUInt16LE(0, 32);
    entryHeader.writeUInt16LE(0, 34);
    entryHeader.writeUInt16LE(0, 36);
    entryHeader.writeUInt32LE(0, 38);
    entryHeader.writeUInt32LE(offset, 42);
    central.push(entryHeader, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_RECORD, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralBuffer, end]);
}
