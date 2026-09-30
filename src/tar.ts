// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

// Node has no tar reader, and FHIR packages are npm-style tarballs, so this
// reads the subset they use: ustar headers, pax and GNU long names, regular files.

export interface TarEntry {
  path: string;
  data: Buffer;
}

const BLOCK = 512;

function field(header: Buffer, start: number, length: number): string {
  const end = header.indexOf(0, start);
  return header.toString('utf8', start, end === -1 || end > start + length ? start + length : end);
}

function checksumOk(header: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  return sum === Number.parseInt(field(header, 148, 8).trim(), 8);
}

function paxPath(data: Buffer): string | undefined {
  for (const record of data.toString('utf8').split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match) return match[1];
  }
  return undefined;
}

function headerPath(header: Buffer): string {
  const name = field(header, 0, 100);
  const prefix = field(header, 257, 6) === 'ustar' ? field(header, 345, 155) : '';
  return prefix ? `${prefix}/${name}` : name;
}

interface Block {
  header: Buffer;
  data: Buffer;
  next: number;
}

/** The header at `offset` and the data after it, or undefined at the end marker. */
function readBlock(archive: Buffer, offset: number): Block | undefined {
  if (offset + BLOCK > archive.length) return undefined;
  const header = archive.subarray(offset, offset + BLOCK);
  if (header.every((byte) => byte === 0)) return undefined;
  if (!checksumOk(header)) throw new Error(`tar: bad header checksum at byte ${offset}`);
  const size = Number.parseInt(field(header, 124, 12).trim() || '0', 8);
  const start = offset + BLOCK;
  if (start + size > archive.length) throw new Error('tar: archive is truncated');
  return {
    header,
    data: archive.subarray(start, start + size),
    next: start + Math.ceil(size / BLOCK) * BLOCK,
  };
}

/** The regular files in an uncompressed tar archive, in order. Throws on a malformed one. */
export function readTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let longPath: string | undefined;
  for (let block = readBlock(archive, 0); block; block = readBlock(archive, block.next)) {
    const { header, data } = block;
    // A pax or GNU long-name entry names the entry after it.
    const type = String.fromCharCode(header[156] ?? 0);
    if (type === 'x' || type === 'L') {
      longPath = type === 'x' ? paxPath(data) : field(data, 0, data.length);
      continue;
    }
    if (type === '0' || type === '\0') entries.push({ path: longPath ?? headerPath(header), data });
    longPath = undefined;
  }
  return entries;
}
