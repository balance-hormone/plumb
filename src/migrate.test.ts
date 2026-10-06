// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest';
import { inOrder } from './migrate.js';
import type { Migration } from './migrations.js';

const migration = (id: string, dependsOn?: string[]): Migration => ({
  id,
  resourceType: 'Patient',
  transform: () => undefined,
  from: `${id}.ts`,
  ...(dependsOn ? { dependsOn } : {}),
});

describe('inOrder', () => {
  test('runs a dependency first, and otherwise in id order', () => {
    const ordered = inOrder([
      migration('20261003-c'),
      migration('20261001-a', ['20261004-d']),
      migration('20261004-d', ['20261002-b']),
      migration('20261002-b'),
    ]);
    expect(ordered.map((m) => m.id)).toEqual([
      '20261002-b',
      '20261004-d',
      '20261001-a',
      '20261003-c',
    ]);
  });
});
