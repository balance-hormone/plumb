// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest';
import { tar } from '../test/tar-writer.js';
import { readTar } from './tar.js';

const text = (entries: ReturnType<typeof readTar>) =>
  entries.map((e) => [e.path, e.data.toString()]);

describe('readTar', () => {
  test('reads regular files and skips everything else', () => {
    const archive = tar([
      { path: 'package/', data: '', type: '5' },
      { path: 'package/package.json', data: '{"name":"x"}' },
      { path: 'package/link', data: '', type: '2' },
      { path: 'package/a.json', data: 'A' },
    ]);
    expect(text(readTar(archive))).toEqual([
      ['package/package.json', '{"name":"x"}'],
      ['package/a.json', 'A'],
    ]);
  });

  test('joins the ustar prefix to the name', () => {
    const path = `package/${'d'.repeat(90)}/${'f'.repeat(60)}.json`;
    expect(text(readTar(tar([{ path, data: 'x' }])))).toEqual([[path, 'x']]);
  });

  test('takes the path from a pax header', () => {
    const path = `package/${'p'.repeat(200)}.json`;
    expect(text(readTar(tar([{ path, data: 'x', pax: true }])))).toEqual([[path, 'x']]);
  });

  test('takes the path from a GNU long-name entry', () => {
    const path = `package/${'g'.repeat(200)}.json`;
    const archive = tar([
      { path: '././@LongLink', data: `${path}\0`, type: 'L' },
      { path: 'placeholder', data: 'x' },
    ]);
    expect(text(readTar(archive))).toEqual([[path, 'x']]);
  });

  test('rejects a corrupt header', () => {
    const archive = tar([{ path: 'package/a.json', data: 'A' }]);
    archive[0] = 0x21;
    expect(() => readTar(archive)).toThrow(/checksum/);
  });

  test('rejects an entry that runs past the end', () => {
    const archive = tar([{ path: 'package/a.json', data: 'A'.repeat(2000) }]);
    expect(() => readTar(archive.subarray(0, 1024))).toThrow(/truncated/);
  });
});
