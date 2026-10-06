// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { PlumbConfig } from './config.js';
import { checkMigrations, loadMigrations, type Migration, newMigration } from './migrations.js';

const FIXTURE = join(import.meta.dirname, '../test/fixtures/migrations');
const migration = (fields: Partial<Migration>): Migration => ({
  id: '20261006-patient-birthdate',
  resourceType: 'Patient',
  transform: () => undefined,
  from: 'birthdate.ts',
  ...fields,
});
const messages = (migrations: Migration[]) => checkMigrations(migrations).map((e) => e.message);

describe('loadMigrations', () => {
  test("collects each module's default export, by module", async () => {
    const loaded = await loadMigrations([join(FIXTURE, '*.ts')]);
    expect(loaded.ok && loaded.migrations.map((m) => [m.id, m.from])).toEqual([
      ['20261006-patient-birthdate', join(FIXTURE, '20261006-patient-birthdate.ts')],
    ]);
  });

  test('invalid-migration for a module without a default-exported migration', async () => {
    const loaded = await loadMigrations([join(FIXTURE, 'bad/*.ts')]);
    expect(!loaded.ok && loaded.errors.map((e) => [e.code, e.message])).toEqual([
      [
        'invalid-migration',
        `${join(FIXTURE, 'bad/no-default.ts')} does not default-export a migration made by defineMigration.`,
      ],
    ]);
  });

  test('invalid-migration for a path that matches nothing', async () => {
    const loaded = await loadMigrations([join(FIXTURE, 'missing/*.ts')]);
    expect(!loaded.ok && loaded.errors.map((e) => e.code)).toEqual(['invalid-migration']);
  });
});

describe('checkMigrations', () => {
  test('accepts migrations with dated ids, known types, indexed searches and met dependencies', () => {
    expect(
      checkMigrations([
        migration({ search: { 'birthdate:missing': 'true', _tag: 'http://example.org|x' } }),
        migration({
          id: '20261007-observation-subject',
          resourceType: 'Observation',
          search: { 'subject.name': 'Synthetic' },
          dependsOn: ['20261006-patient-birthdate'],
        }),
      ]),
    ).toEqual([]);
  });

  test('an id used twice, or not starting with a date', () => {
    expect(
      messages([migration({}), migration({ from: 'again.ts' }), migration({ id: 'birthdate' })]),
    ).toEqual([
      'again.ts (20261006-patient-birthdate) has the id birthdate.ts has too.',
      'birthdate.ts (birthdate) needs an id of a date and a name, as 20261006-patient-birthdate.',
    ]);
  });

  test('an unknown type, a search parameter Medplum does not index, or one the runner sets', () => {
    expect(
      messages([
        migration({ id: '20261006-a', resourceType: 'Patients' }),
        migration({ id: '20261006-b', search: { favourite: 'blue' } }),
        migration({ id: '20261006-c', search: { _count: '10' } }),
      ]),
    ).toEqual([
      'birthdate.ts (20261006-a) "Patients" is not a resource type.',
      'birthdate.ts (20261006-b) searches by "favourite", which Medplum does not index for Patient.',
      'birthdate.ts (20261006-c) sets "_count", which the runner sets.',
    ]);
  });

  test('a dependency no module declares, and a cycle', () => {
    expect(
      messages([
        migration({ id: '20261006-a', dependsOn: ['20261006-missing'] }),
        migration({ id: '20261006-b', dependsOn: ['20261006-c'] }),
        migration({ id: '20261006-c', dependsOn: ['20261006-b'] }),
      ]),
    ).toEqual([
      'birthdate.ts (20261006-a) depends on 20261006-missing, which no module declares.',
      'birthdate.ts (20261006-b) depends on itself through dependsOn.',
      'birthdate.ts (20261006-c) depends on itself through dependsOn.',
    ]);
  });
});

describe('newMigration', () => {
  const project = () => {
    const dir = mkdtempSync(join(tmpdir(), 'plumb-migrations-'));
    const config: PlumbConfig = {
      igs: [],
      profiles: [],
      out: join(dir, 'src/fhir/generated'),
      bots: { migrator: { file: join(dir, 'dist/migrator.cjs') } },
      migrations: { bot: 'migrator', modules: [join(dir, 'src/migrations/*.ts')] },
    };
    return { dir, config };
  };
  const now = new Date('2026-10-06T12:00:00Z');

  test("scaffolds a dated module in the first pattern's folder, importing the generated code", () => {
    const { dir, config } = project();
    const created = newMigration(config, 'patient-birthdate', now);
    const file = join(dir, 'src/migrations/20261006-patient-birthdate.ts');
    expect(created).toEqual({ ok: true, file });
    const text = readFileSync(file, 'utf8');
    expect(text).toContain("import { defineMigration } from '../fhir/generated/index.js';");
    expect(text).toContain("id: '20261006-patient-birthdate',");
  });

  test('refuses a name that is not kebab-case, an existing file, and a config without modules', () => {
    const { dir, config } = project();
    const message = (result: ReturnType<typeof newMigration>) =>
      !result.ok && result.errors[0]?.message;
    expect(message(newMigration(config, 'Patient Birthdate', now))).toMatch(/lowercase words/);
    newMigration(config, 'patient-birthdate', now);
    expect(message(newMigration(config, 'patient-birthdate', now))).toMatch(/already exists/);
    expect(message(newMigration({ ...config, migrations: undefined }, 'x', now))).toMatch(
      /no "migrations.modules"/,
    );
    expect(existsSync(join(dir, 'src/migrations/20261006-Patient Birthdate.ts'))).toBe(false);
  });
});
