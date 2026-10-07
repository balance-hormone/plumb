// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import { describe, expect, test } from 'vitest';
import { inOrder, pendingMigrations } from './migrate.js';
import type { Migration } from './migrations.js';
import { PLUMB_SYSTEM } from './project.js';

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

  test('ends on a cycle, which checkMigrations reports', () => {
    const ordered = inOrder([
      migration('20261001-a', ['20261002-b']),
      migration('20261002-b', ['20261001-a']),
    ]);
    expect(ordered.map((m) => m.id).sort()).toEqual(['20261001-a', '20261002-b']);
  });
});

describe("pendingMigrations, for push's gate", () => {
  // A project holding no ledger entries: every declared migration is pending.
  const empty = {
    getProject: () => ({ resourceType: 'Project', id: 'p1' }),
    searchOne: async () => undefined,
  } as unknown as MedplumClient;
  const modules = (...sources: [string, string][]) => {
    const dir = mkdtempSync(join(tmpdir(), 'plumb-pending-'));
    for (const [name, source] of sources) writeFileSync(join(dir, name), source);
    return join(dir, '*.ts');
  };
  const module = (id: string, dependsOn: string) =>
    `export default { id: '${id}', resourceType: 'Patient', dependsOn: ['${dependsOn}'], transform: () => undefined };`;

  test('lists a restamp applied before the routing changed', async () => {
    const out = mkdtempSync(join(tmpdir(), 'plumb-pending-out-'));
    writeFileSync(
      join(out, '_restamp.ts'),
      "export const restamps = [{ id: 'plumb-restamp-Patient', resourceType: 'Patient', transform: () => undefined }];",
    );
    writeFileSync(join(out, '_routes.ts'), '// the routing now');
    const state = { status: 'applied', hash: 'the routing then', counts: {}, pages: 1 };
    const applied = {
      getProject: () => ({ resourceType: 'Project', id: 'p1' }),
      searchOne: async () => ({
        resourceType: 'Basic',
        extension: [{ url: `${PLUMB_SYSTEM}#migration`, valueString: JSON.stringify(state) }],
      }),
    } as unknown as MedplumClient;
    const config = {
      igs: [],
      profiles: [],
      out,
      migrations: { bot: 'migrator', modules: [], restamp: true },
    };
    expect((await pendingMigrations(applied, config, ['Patient'])).pending).toEqual([
      { id: 'plumb-restamp-Patient', resourceType: 'Patient' },
    ]);
  });

  test('reports a dependsOn cycle instead of overflowing the stack', async () => {
    const config = {
      igs: [],
      profiles: [],
      out: '',
      migrations: {
        bot: 'migrator',
        modules: [
          modules(
            ['a.ts', module('20261001-a', '20261002-b')],
            ['b.ts', module('20261002-b', '20261001-a')],
          ),
        ],
      },
    };
    const found = await pendingMigrations(empty, config, ['Patient']);
    expect(found.pending).toEqual([]);
    expect(found.error).toMatch(/depends on itself through dependsOn/);
  });
});
