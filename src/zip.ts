/**
 * Read a small, well-formed ZIP (the skill bundle the app publishes) with nothing but
 * node:zlib. Walks the central directory, supports stored (0) and deflate (8) entries,
 * refuses path traversal. Not a general ZIP library — no zip64, no encryption, no
 * data-descriptor-only entries; those never occur in our own bundles.
 */
import * as zlib from 'node:zlib';

export interface ZipEntry {
  path: string;
  data: Buffer;
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
/** Bundles are ~30 KB; anything past this is not a skill bundle. */
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export function readZip(buf: Buffer): ZipEntry[] {
  if (buf.length > MAX_TOTAL_BYTES) throw new Error('zip too large');
  // EOCD is at the very end when there is no comment; scan back a little to be tolerant.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== CDH_SIG) throw new Error('corrupt zip (central directory)');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory marker
    assertSafePath(name);

    if (buf.readUInt32LE(localOffset) !== LFH_SIG) throw new Error('corrupt zip (local header)');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp, { maxOutputLength: MAX_TOTAL_BYTES });
    else throw new Error(`unsupported zip compression method ${method}`);
    if (data.length !== rawSize) throw new Error(`size mismatch for ${name}`);
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('zip expands too large');
    entries.push({ path: name, data });
  }
  return entries;
}

/** Entry names are written to disk under a directory we choose — never let them climb out. */
function assertSafePath(name: string): void {
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..') || name.includes('\\')) {
    throw new Error(`unsafe path in zip: ${name}`);
  }
}
