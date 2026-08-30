import { inflateRawSync } from 'node:zlib';

/**
 * Dependency-free ZIP reader — deliberately hand-written.
 *
 * A skill is plain text and nothing else. An imported archive may contain
 * `install.js`, `run.sh`, a binary — and the guarantee we make to the user is
 * that those are *listed and never touched*. That guarantee is only as auditable
 * as the code enforcing it, so this is ~120 readable lines instead of an unzip
 * dependency whose extraction surface we would have to trust (and which
 * `server/package.json` deliberately does not carry).
 *
 * The rules, all enforced below:
 *   1. Only the central directory is parsed. Nothing is written to disk, ever.
 *   2. ONLY entries whose name ends in `.md` are decompressed. Every other entry
 *      is returned as `{ name, skipped: true }` — its bytes are never passed to
 *      zlib and never interpreted.
 *   3. Only compression method 0 (stored) and 8 (deflate) are read; anything
 *      else is skipped rather than guessed at.
 *   4. Names with `..` segments, absolute paths, or backslashes are rejected
 *      outright — even though we never write files, a traversal name is a signal
 *      the archive is hostile and it must never reach a downstream consumer.
 *   5. Total inflated bytes and entry count are capped, so a zip bomb costs a
 *      bounded amount of memory.
 */

/** Max bytes we will inflate across ALL markdown entries in one archive. */
export const MAX_TOTAL_INFLATED_BYTES = 2 * 1024 * 1024;
/** Max central-directory entries we will even look at. */
export const MAX_ENTRIES = 2_000;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export interface ZipMarkdownEntry {
  name: string;
  skipped: false;
  content: string;
}

export interface ZipSkippedEntry {
  name: string;
  skipped: true;
}

export type ZipEntry = ZipMarkdownEntry | ZipSkippedEntry;

export class ZipError extends Error {}

/** Reject anything that could escape a directory if a caller ever wrote it out. */
export function isUnsafeEntryName(name: string): boolean {
  if (!name) return true;
  if (name.includes('\\')) return true;
  if (name.startsWith('/')) return true;
  if (/^[a-zA-Z]:/.test(name)) return true;
  return name.split('/').includes('..');
}

function isMarkdown(name: string): boolean {
  return !name.endsWith('/') && name.toLowerCase().endsWith('.md');
}

/** Locate the End-of-Central-Directory record by scanning backwards from EOF
 *  (its position is variable because of the optional trailing comment). */
function findEocd(buf: Buffer): number {
  const start = Math.max(0, buf.length - EOCD_MIN_SIZE - 0xffff);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new ZipError('Not a ZIP archive (no end-of-central-directory record)');
}

/**
 * Read an archive's entry table, inflating markdown only.
 *
 * Returns one record per central-directory entry, in archive order. Directory
 * entries are dropped; everything else is either markdown (with content) or
 * `skipped: true`.
 */
export function readZipEntries(buf: Buffer): ZipEntry[] {
  if (buf.length < EOCD_MIN_SIZE) throw new ZipError('Not a ZIP archive (too short)');

  const eocd = findEocd(buf);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset >= buf.length) throw new ZipError('Corrupt ZIP (central directory out of range)');
  if (totalEntries > MAX_ENTRIES) throw new ZipError(`ZIP has too many entries (> ${MAX_ENTRIES})`);

  const entries: ZipEntry[] = [];
  let inflatedTotal = 0;
  let pos = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (pos + CENTRAL_HEADER_SIZE > buf.length) break;
    if (buf.readUInt32LE(pos) !== CENTRAL_SIGNATURE) break;

    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + CENTRAL_HEADER_SIZE, pos + CENTRAL_HEADER_SIZE + nameLen);
    pos += CENTRAL_HEADER_SIZE + nameLen + extraLen + commentLen;

    if (isUnsafeEntryName(name)) {
      throw new ZipError(`Unsafe path in archive: ${name}`);
    }
    if (name.endsWith('/')) continue; // directory entry — nothing to report

    // RULE 2: the extension decides, BEFORE any bytes are handed to zlib.
    if (!isMarkdown(name) || (method !== METHOD_STORED && method !== METHOD_DEFLATE)) {
      entries.push({ name, skipped: true });
      continue;
    }

    const data = readLocalData(buf, localOffset, compressedSize);
    const content =
      method === METHOD_STORED ? data : inflateRawSync(data, { maxOutputLength: MAX_TOTAL_INFLATED_BYTES });

    inflatedTotal += content.length;
    if (inflatedTotal > MAX_TOTAL_INFLATED_BYTES) {
      throw new ZipError('Archive markdown exceeds the inflate budget');
    }
    entries.push({ name, skipped: false, content: content.toString('utf8') });
  }

  return entries;
}

/** Slice the compressed bytes for one entry out of its local file header. */
function readLocalData(buf: Buffer, localOffset: number, compressedSize: number): Buffer {
  if (localOffset + LOCAL_HEADER_SIZE > buf.length) {
    throw new ZipError('Corrupt ZIP (local header out of range)');
  }
  if (buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
    throw new ZipError('Corrupt ZIP (bad local file header)');
  }
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + LOCAL_HEADER_SIZE + nameLen + extraLen;
  const end = start + compressedSize;
  if (end > buf.length) throw new ZipError('Corrupt ZIP (entry data out of range)');
  return buf.subarray(start, end);
}
