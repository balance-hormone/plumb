// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MARKER } from './print.js';
import { writeFiles } from './write.js';

const plumbFile = (body: string) => `${MARKER} from x. Do not edit.\n${body}\n`;
const outDir = () => join(mkdtempSync(join(tmpdir(), 'plumb-out-')), 'generated');

describe('writeFiles', () => {
  test('creates the folder and writes every file', () => {
    const out = outDir();
    const result = writeFiles(
      out,
      new Map([
        ['A.ts', plumbFile('a')],
        ['index.ts', plumbFile('i')],
      ]),
    );
    expect(result).toEqual({ ok: true, written: ['A.ts', 'index.ts'], removed: [], errors: [] });
    expect(readFileSync(join(out, 'A.ts'), 'utf8')).toBe(plumbFile('a'));
  });

  test('leaves unchanged files alone and removes files for profiles no longer listed', () => {
    const out = outDir();
    writeFiles(
      out,
      new Map([
        ['A.ts', plumbFile('a')],
        ['B.ts', plumbFile('b')],
      ]),
    );
    const result = writeFiles(
      out,
      new Map([
        ['A.ts', plumbFile('a')],
        ['C.ts', plumbFile('c')],
      ]),
    );
    expect(result).toEqual({ ok: true, written: ['C.ts'], removed: ['B.ts'], errors: [] });
    expect(readdirSync(out).sort()).toEqual(['A.ts', 'C.ts']);
  });

  test('foreign-file: refuses to touch a folder holding a file Plumb did not write', () => {
    const out = outDir();
    writeFiles(out, new Map([['A.ts', plumbFile('a')]]));
    writeFileSync(join(out, 'mine.ts'), 'export const mine = 1;\n');
    mkdirSync(join(out, 'nested'));
    const result = writeFiles(out, new Map([['B.ts', plumbFile('b')]]));
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => [e.code, e.file])).toEqual([
      ['foreign-file', 'mine.ts'],
      ['foreign-file', 'nested'],
    ]);
    expect(existsSync(join(out, 'A.ts'))).toBe(true);
    expect(existsSync(join(out, 'B.ts'))).toBe(false);
  });
});
