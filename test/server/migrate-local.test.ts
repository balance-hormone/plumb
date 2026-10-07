// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Basic, Patient } from '@medplum/fhirtypes';
import { beforeAll, describe, expect, test } from 'vitest';
import { bundledChecker } from '../../src/checker/install.js';
import type { PlumbConfig } from '../../src/config.js';
import { printFiles } from '../../src/emit/print.js';
import { writeFiles } from '../../src/emit/write.js';
import { migrateEnvironment, migrationStatus } from '../../src/migrate.js';
import { fetchPackages } from '../../src/packages.js';
import { PLUMB_SYSTEM } from '../../src/project.js';
import { connectAs, migrate } from '../../src/testing.js';
import { server } from './medplum.js';
import { newProject, type TestProject } from './setup.js';

const PATIENT = 'http://example.org/fhir/plumb-test/StructureDefinition/cardinality-patient';
const SYNTHETIC = join(import.meta.dirname, '../fixtures/profiles/fsh-generated/resources');
const BIRTHDATE = '20261006-patient-birthdate';

// The runner in this process, as `plumb migrate --local` and a project's own
// tests run it: no migration bot, no checker bot, nothing deployed.
describe.skipIf(!server)('migrate, run locally', { timeout: 120_000 }, () => {
  let project: TestProject;
  let config: PlumbConfig;
  let lockPath: string;

  beforeAll(async () => {
    project = await newProject();
    const medplum = await connectAs(project);
    for (let i = 0; i < 3; i++) {
      await medplum.createResource<Patient>({
        resourceType: 'Patient',
        meta: { profile: [PATIENT] },
        name: [{ family: 'S' }],
      });
    }
    const dir = mkdtempSync(join(tmpdir(), 'plumb-migrate-local-'));
    mkdirSync(join(dir, 'migrations'));
    writeFileSync(
      join(dir, `migrations/${BIRTHDATE}.ts`),
      `import { defineMigration } from '../generated/index.js';
export default defineMigration({
  id: '${BIRTHDATE}',
  resourceType: 'Patient',
  search: { 'birthdate:missing': 'true' },
  transform: (p) => (p.birthDate ? undefined : [{ op: 'add', path: '/birthDate', value: '1900-01-01' }]),
});
`,
    );
    writeFiles(
      join(dir, 'generated'),
      printFiles([], () => 'test', undefined, [], [], undefined, [`../migrations/${BIRTHDATE}.js`]),
    );
    config = {
      igs: [],
      profiles: [PATIENT],
      local: SYNTHETIC,
      out: join(dir, 'generated'),
      bots: { migrator: { file: join(dir, 'migrator.cjs') } },
      migrations: { bot: 'migrator', modules: [join(dir, 'migrations/*.ts')] },
    };
    lockPath = join(dir, 'plumb.lock');
    await fetchPackages({ igs: [], lockPath });
  }, 120_000);

  test('refuses an environment not marked synthetic before reading anything', async () => {
    const result = await migrateEnvironment({
      config,
      environment: {
        name: 'prod',
        baseUrl: 'http://127.0.0.1:9/',
        clientId: 'x',
        clientSecret: 'y',
      },
      lockPath,
      checker: bundledChecker(),
      local: true,
    });
    expect(result.errors).toEqual([expect.objectContaining({ code: 'not-synthetic' })]);
    expect(result.steps).toEqual([]);
  });

  test('a dry run counts and forecasts with no bot deployed, and writes nothing', async () => {
    const result = await migrate(project, config, { lockPath });
    expect(result.errors).toEqual([]);
    expect(result.migrations[BIRTHDATE]).toMatchObject({
      counts: { read: 3, changed: 3, failed: 0 },
      forecast: { checked: 3, failing: 0 },
    });
    expect(result.steps.map((s) => s.name)).not.toContain('migrator');
  });

  test('a write migrates the records and keeps the ledger, as the bot would', async () => {
    const result = await migrate(project, config, { lockPath, write: true });
    expect(result.ok).toBe(true);
    const medplum = await connectAs(project);
    expect(await medplum.searchResources('Patient', { 'birthdate:missing': 'true' })).toHaveLength(
      0,
    );
    const ledger = (await medplum.searchOne('Basic', {
      _tag: `${PLUMB_SYSTEM}|${BIRTHDATE}`,
    })) as Basic;
    expect(JSON.parse(ledger.extension?.[0]?.valueString ?? '{}')).toMatchObject({
      status: 'applied',
      counts: { changed: 3 },
    });
  });
});

// A module edited while its pass is paused would leave the pages already
// written with the old transform's output: it is refused as edited until
// --rerun, and the run that follows uses the edited module, not a cached one.
describe.skipIf(!server)('migrate, with a module edited mid-pass', { timeout: 120_000 }, () => {
  let project: TestProject;
  let config: PlumbConfig;
  let lockPath: string;
  let module: string;
  const GENDER = '20261007-patient-gender';
  const source = (gender: string) => `export default {
  id: '${GENDER}',
  resourceType: 'Patient',
  search: { 'gender:missing': 'true' },
  transform: (p) => (p.gender ? undefined : [{ op: 'add', path: '/gender', value: '${gender}' }]),
};
`;

  beforeAll(async () => {
    project = await newProject();
    const medplum = await connectAs(project);
    for (let i = 0; i < 25; i++) {
      await medplum.createResource<Patient>({ resourceType: 'Patient', name: [{ family: 'E' }] });
    }
    const dir = mkdtempSync(join(tmpdir(), 'plumb-migrate-edited-'));
    mkdirSync(join(dir, 'migrations'));
    module = join(dir, `migrations/${GENDER}.ts`);
    writeFileSync(module, source('unknown'));
    writeFiles(
      join(dir, 'generated'),
      printFiles([], () => 'test', undefined, [], [], undefined, [`../migrations/${GENDER}.js`]),
// The run reads what the server last updated before it started, by the
// server's clock: a CLI whose clock is behind must not skip records.
describe.skipIf(!server)('migrate, with the CLI clock skewed', { timeout: 120_000 }, () => {
  let project: TestProject;
  let config: PlumbConfig;
  let lockPath: string;

  beforeAll(async () => {
    project = await newProject();
    const dir = mkdtempSync(join(tmpdir(), 'plumb-migrate-skew-'));
    mkdirSync(join(dir, 'migrations'));
    writeFileSync(
      join(dir, `migrations/${BIRTHDATE}.ts`),
      `import { defineMigration } from '../generated/index.js';
export default defineMigration({
  id: '${BIRTHDATE}',
  resourceType: 'Patient',
  search: { 'birthdate:missing': 'true' },
  transform: (p) => (p.birthDate ? undefined : [{ op: 'add', path: '/birthDate', value: '1900-01-01' }]),
});
`,
    );
    writeFiles(
      join(dir, 'generated'),
      printFiles([], () => 'test', undefined, [], [], undefined, [`../migrations/${BIRTHDATE}.js`]),
    );
    config = {
      igs: [],
      profiles: [PATIENT],
      local: SYNTHETIC,
      out: join(dir, 'generated'),
      bots: { migrator: { file: join(dir, 'migrator.cjs') } },
      migrations: { bot: 'migrator', modules: [join(dir, 'migrations/*.ts')] },
    };
    lockPath = join(dir, 'plumb.lock');
    await fetchPackages({ igs: [], lockPath });
  }, 120_000);

  const options = () => ({
    config,
    environment: { name: 'test', ...project, synthetic: true },
    lockPath,
    checker: bundledChecker(),
    local: true,
    write: true,
    pageSize: 20,
  });

  test('is refused as edited, then --rerun runs the edited module', async () => {
    const medplum = await connectAs(project);
    const controller = new AbortController();
    await migrateEnvironment({
      ...options(),
      signal: controller.signal,
      onPage: () => controller.abort(),
    });
    expect(await medplum.searchResources('Patient', { gender: 'unknown' })).toHaveLength(20);

    writeFileSync(module, source('other'));
    const refused = await migrateEnvironment(options());
    expect(refused.errors).toEqual([expect.objectContaining({ code: 'migration-edited' })]);
    expect(await medplum.searchResources('Patient', { 'gender:missing': 'true' })).toHaveLength(5);
    const status = await migrationStatus({ config, environment: options().environment });
    expect(status.migrations[GENDER]?.status).toBe('edited');

    const rerun = await migrateEnvironment({ ...options(), rerun: [GENDER] });
    expect(rerun.ok).toBe(true);
    expect(await medplum.searchResources('Patient', { gender: 'other' })).toHaveLength(5);
  const run = (skew: number, write: boolean, rerun?: string[]) =>
    migrateEnvironment({
      config,
      environment: { name: 'test', ...project, synthetic: true },
      lockPath,
      checker: bundledChecker(),
      local: true,
      write,
      now: () => new Date(Date.now() + skew),
      ...(rerun ? { rerun } : {}),
    });

  test('a dry run and a write with a slow clock read every record once', async () => {
    const medplum = await connectAs(project);
    for (let i = 0; i < 3; i++) {
      await medplum.createResource<Patient>({ resourceType: 'Patient', name: [{ family: 'S' }] });
    }
    const dry = await run(-120_000, false);
    expect(dry.migrations[BIRTHDATE]).toMatchObject({ counts: { read: 3, changed: 3 } });
    const written = await run(-120_000, true);
    expect(written.migrations[BIRTHDATE]).toMatchObject({ counts: { read: 3, changed: 3 } });
    expect(await medplum.searchResources('Patient', { 'birthdate:missing': 'true' })).toHaveLength(
      0,
    );
  });

  test('a write with a fast clock does not read its own writes again', async () => {
    const medplum = await connectAs(project);
    for (let i = 0; i < 3; i++) {
      await medplum.createResource<Patient>({ resourceType: 'Patient', name: [{ family: 'F' }] });
    }
    // Applied by the test before, so run again: a fresh pass over what is now stale.
    const written = await run(120_000, true, [BIRTHDATE]);
    expect(written.migrations[BIRTHDATE]).toMatchObject({ counts: { read: 3, changed: 3 } });
  });
});
