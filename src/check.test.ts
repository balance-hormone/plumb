// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import * as ts from 'typescript5';
import { describe, expect, test } from 'vitest';
import {
  checkRoot,
  compareBaseline,
  countFindings,
  enforcedTypes,
  type Finding,
  findRawAccess,
} from './check.js';

const BASE = join(import.meta.dirname, '../test/fixtures/check');

function find() {
  return findRawAccess({
    ts,
    base: BASE,
    tsconfig: [join(BASE, 'tsconfig.json')],
    profiledTypes: new Set(['Patient', 'Goal', 'Coverage']),
    out: join(BASE, 'generated'),
    ignore: ['**/*.stories.ts'],
  }).findings.map(
    (f) => `${f.file}:${f.line} ${f.method} ${f.resourceTypes.join('|')} → ${f.instead}`,
  );
}

describe('findRawAccess', () => {
  test('reports raw access to profiled types, by the type the checker infers', {
    timeout: 30_000,
  }, () => {
    expect(find()).toEqual([
      'src/reads.ts:7 readResource Patient → readProfiled',
      'src/reads.ts:9 searchResources Goal → searchProfiled',
      'src/reads.ts:12 searchOne Patient → searchProfiled',
      'src/suppressed.ts:9 searchResources Goal → a plumb-check comment needs a reason',
      'src/writes.ts:22 createResource Goal → createProfiled, updateProfiled or stampProfiled',
      'src/writes.ts:28 createResource Coverage → createProfiled, updateProfiled or stampProfiled',
      // A union of two Goal shapes is one type, named once.
      'src/writes.ts:29 createResource Goal → createProfiled, updateProfiled or stampProfiled',
    ]);
  });
});

const finding = (file: string, method = 'readResource'): Finding => ({
  file,
  line: 1,
  column: 1,
  method,
  resourceTypes: ['Patient'],
  instead: 'readProfiled',
});

describe('the baseline', () => {
  test('accepts what it counts, and fails a new key or a grown count', () => {
    const baseline = countFindings([finding('a.ts'), finding('a.ts'), finding('b.ts')]);
    expect(compareBaseline([finding('a.ts'), finding('a.ts'), finding('b.ts')], baseline)).toEqual({
      fresh: [],
      fixed: 0,
      accepted: 3,
    });
    const grown = compareBaseline([finding('b.ts'), finding('b.ts'), finding('c.ts')], baseline);
    expect(grown.fresh.map((f) => f.file)).toEqual(['b.ts', 'b.ts', 'c.ts']);
    expect(grown.fixed).toBe(2);
  });

  test('keys by file, method and types, never by line', () => {
    expect(countFindings([finding('a.ts'), { ...finding('a.ts'), line: 40 }])).toEqual({
      'a.ts|readResource|Patient': 2,
    });
  });
});

// A monorepo keeps its config in one package and checks code in others.
describe('checkRoot', () => {
  test('is the deepest folder holding the config and every tsconfig', () => {
    expect(
      checkRoot('/repo/packages/types/plumb.config.ts', [
        '/repo/apps/web/tsconfig.json',
        '/repo/apps/kiosk/tsconfig.json',
      ]),
    ).toBe('/repo');
    expect(checkRoot('/repo/plumb.config.ts', ['/repo/tsconfig.json'])).toBe('/repo');
  });
});

// A profile keyed on content (a code) holds only some resources of its type,
// so raw access to the type is not wrong; a profile with no keys holds all.
describe('enforcedTypes', () => {
  test('a type with an unkeyed profile or a default profile; not one keyed on content', () => {
    const route = (keys: number) => ({
      profile: 'p',
      parents: [],
      keys: Array.from({ length: keys }, () => ['code', []] as [string, unknown[]]),
    });
    expect(
      [
        ...enforcedTypes(
          { Patient: [route(0)], Observation: [route(1)], Goal: [route(1), route(0)] },
          { Condition: ['http://example.org/condition'] },
        ),
      ].sort(),
    ).toEqual(['Condition', 'Goal', 'Patient']);
  });
});
