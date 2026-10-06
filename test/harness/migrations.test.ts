// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { printFiles } from '../../src/emit/print.js';
import { newMigration } from '../../src/migrations.js';
import { typecheck } from './routes.js';

// Design 11's defineMigration, as `generate` writes it for a config with
// `migrations`: the types that hold a transform to its resource type.
const files = printFiles([], () => 'harness', undefined, [], [], undefined, true);

test('tsc holds a transform to its resource type and to JSON Patch', () => {
  const source = `
import { defineMigration } from './generated/index.js';

export const birthdate = defineMigration({
  id: '20261006-patient-birthdate',
  resourceType: 'Patient',
  search: { 'birthdate:missing': 'true' },
  transform(patient) {
    if (patient.birthDate) return undefined;
    return [{ op: 'add', path: '/birthDate', value: '1900-01-01' }];
  },
});

export const wrongType = defineMigration({
  id: '20261006-observation',
  resourceType: 'Observation',
  // @ts-expect-error an Observation has no birthDate
  transform: (observation) => (observation.birthDate ? undefined : []),
});

export const notAPatch = defineMigration({
  id: '20261006-not-a-patch',
  resourceType: 'Patient',
  // @ts-expect-error a transform returns JSON Patch operations
  transform: () => [{ op: 'set', path: '/active', value: true }],
});
`;
  expect(typecheck(files, source)).toEqual([]);
});

test('the module plumb migrate new scaffolds compiles against the generated code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plumb-migrate-new-'));
  const created = newMigration(
    {
      igs: [],
      profiles: [],
      out: join(dir, 'generated'),
      migrations: { bot: 'migrator', modules: [join(dir, '*.ts')] },
    },
    'patient-birthdate',
  );
  if (!created.ok) throw new Error(JSON.stringify(created.errors));
  expect(typecheck(files, readFileSync(created.file, 'utf8'))).toEqual([]);
});
