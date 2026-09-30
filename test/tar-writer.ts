// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { gzipSync } from 'node:zlib';

export interface TarFile {
  path: string;
  data: string | Buffer;
  /** Tar type flag; '0' is a regular file. */
  type?: string;
  /** Write a long path as a pax header rather than splitting it into prefix and name. */
  pax?: boolean;
}

function header(path: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(path) > 100) {
    const cut = path.lastIndexOf('/', 155);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
  }
  h.write(name, 0, 100);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write(prefix, 345, 155);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

function entry(path: string, data: Buffer, type: string): Buffer[] {
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return [header(path, data.length, type), data, pad];
}

/** A tar archive of the files, as npm and the FHIR registry produce them. */
export function tar(files: TarFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    const data = Buffer.from(file.data);
    if (file.pax) {
      // A pax record is "<length> path=<path>\n", where length counts its own digits.
      const record = ` path=${file.path}\n`;
      let length = record.length;
      while (String(length).length + record.length !== length) {
        length = String(length).length + record.length;
      }
      parts.push(...entry('PaxHeader', Buffer.from(`${length}${record}`), 'x'));
      parts.push(...entry('placeholder', data, file.type ?? '0'));
    } else {
      parts.push(...entry(file.path, data, file.type ?? '0'));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export function tgz(files: TarFile[]): Buffer {
  return gzipSync(tar(files));
}
