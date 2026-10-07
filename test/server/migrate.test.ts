// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MedplumClient } from '@medplum/core';
import type { Basic, BundleEntry, Patient } from '@medplum/fhirtypes';
import { build } from 'esbuild';
import { beforeAll, describe, expect, test } from 'vitest';
import { applyBots, planBots } from '../../src/bots.js';
import { CHECKER_BUILD } from '../../src/checker/bundle.js';
import { installChecker } from '../../src/checker/install.js';
import type { PlumbConfig } from '../../src/config.js';
import { printFiles } from '../../src/emit/print.js';
import { writeFiles } from '../../src/emit/write.js';
import { type MigrateEnvOptions, migrateEnvironment, migrationStatus } from '../../src/migrate.js';
import { fetchPackages } from '../../src/packages.js';
import { PLUMB_SYSTEM } from '../../src/project.js';
import { push } from '../../src/push.js';
import { server } from './medplum.js';
import { newProject } from './setup.js';

const PATIENT = 'http://example.org/fhir/plumb-test/StructureDefinition/cardinality-patient';
const SYNTHETIC = join(import.meta.dirname, '../fixtures/profiles/fsh-generated/resources');
const BIRTHDATE = '20261006-patient-birthdate';
const GENDER = '20261007-patient-gender';
// More than one page of 20.
const STALE = 30;

const migration = (id: string, search: string, field: string, value: string) => `
import { defineMigration } from '../generated/index.js';
export default defineMigration({
  id: '${id}',
  resourceType: 'Patient',
  search: { '${search}': 'true' },
  transform: (patient) => (patient.${field} ? undefined : [{ op: 'add', path: '/${field}', value: '${value}' }]),
});
`;

// The ledger and the counts are exact, so this file has a project of its own.
describe.skipIf(!server)('plumb migrate', { timeout: 120_000 }, () => {
  let medplum: MedplumClient;
  let options: MigrateEnvOptions;
  let config: PlumbConfig;
  let dir: string;

  const ledger = async (id: string) =>
    (await medplum.searchOne('Basic', { _tag: `${PLUMB_SYSTEM}|${id}` })) as Basic | undefined;
  const state = async (id: string) =>
    JSON.parse((await ledger(id))?.extension?.[0]?.valueString ?? '{}') as Record<string, unknown>;
  const missing = async (search: string) =>
    (await medplum.searchResources('Patient', { [search]: 'true', _count: '100' })).length;

  beforeAll(async () => {
    const project = await newProject();
    medplum = new MedplumClient({ baseUrl: project.baseUrl });
    await medplum.startClientLogin(project.clientId, project.clientSecret);
    const post = (resource: Patient): BundleEntry => ({
      request: { method: 'POST', url: 'Patient' },
      resource,
    });
    const stamped: Patient = {
      resourceType: 'Patient',
      meta: { profile: [PATIENT] },
      name: [{ family: 'S' }],
    };
    await medplum.executeBatch({
      resourceType: 'Bundle',
      type: 'batch',
      entry: [
        ...Array.from({ length: STALE }, () => post({ ...stamped })),
        post({ ...stamped, birthDate: '1970-01-01' }),
      ],
    });

    dir = mkdtempSync(join(tmpdir(), 'plumb-migrate-'));
    mkdirSync(join(dir, 'migrations'));
    writeFileSync(
      join(dir, `migrations/${BIRTHDATE}.ts`),
      migration(BIRTHDATE, 'birthdate:missing', 'birthDate', '1900-01-01'),
    );
    writeFileSync(
      join(dir, `migrations/${GENDER}.ts`),
      migration(GENDER, 'gender:missing', 'gender', 'unknown'),
    );
    writeFiles(
      join(dir, 'generated'),
      printFiles([], () => 'test', undefined, [], [], undefined, [
        `../migrations/${BIRTHDATE}.js`,
        `../migrations/${GENDER}.js`,
      ]),
    );
    writeFileSync(join(dir, 'entry.ts'), "export { handler } from './generated/_migrator.js';\n");
    const file = join(dir, 'migrator.cjs');
    await build({
      entryPoints: [join(dir, 'entry.ts')],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      outfile: file,
      footer: { js: 'Object.assign(exports, module.exports);' },
    });
    config = {
      igs: [],
      profiles: [PATIENT],
      local: SYNTHETIC,
      out: join(dir, 'generated'),
      bots: { migrator: { file, runtime: 'vmcontext' } },
      migrations: { bot: 'migrator', modules: [join(dir, 'migrations/*.ts')] },
    };
    const lockPath = join(dir, 'plumb.lock');
    await fetchPackages({ igs: [], lockPath });
    const code = (await build({ ...CHECKER_BUILD, write: false })).outputFiles[0]?.text ?? '';
    await installChecker(medplum, { code, version: '0.2.0', resourceTypes: ['Patient'] });
    options = {
      config,
      environment: { name: 'test', ...project },
      lockPath,
      checker: { code, version: '0.2.0' },
      pageSize: 20,
      ids: [BIRTHDATE],
    };
  }, 120_000);

  test('stops until push deploys the migration bot', async () => {
    const result = await migrateEnvironment(options);
    expect(result.errors).toEqual([
      expect.objectContaining({ step: 'migrator', code: 'migrator-missing' }),
    ]);
    await applyBots(await planBots(medplum, config.bots ?? {}), medplum);
  });

  test('a dry run counts and forecasts, and writes nothing, the ledger included', async () => {
    const result = await migrateEnvironment(options);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.migrations[BIRTHDATE]).toMatchObject({
      status: 'pending',
      ran: true,
      counts: { read: STALE, changed: STALE, unchanged: 0, conflict: 0, failed: 0 },
      forecast: { checked: STALE, failing: 0 },
    });
    expect(await missing('birthdate:missing')).toBe(STALE);
    expect(await ledger(BIRTHDATE)).toBeUndefined();
  });

  const pushed = () => {
    const { onPage: _onPage, ...shared } = options;
    return push({ ...shared, reportPath: join(dir, '.plumb', 'validate-test.json') });
  };
  const gateNotes = (result: Awaited<ReturnType<typeof push>>) =>
    result.steps.find((s) => s.name === 'gate')?.warnings ?? [];

  test("push's gate refuses, naming the pending migrations on the failing type", async () => {
    const refused = await pushed();
    expect(refused.ok).toBe(false);
    expect(gateNotes(refused)).toEqual([
      `pending: ${BIRTHDATE} (Patient)`,
      `pending: ${GENDER} (Patient)`,
      'Refusing to load: run plumb migrate --env test --write, or see plumb validate --env test.',
    ]);
  });

  test('a write stopped after a page is paused, and the next write resumes it', async () => {
    const controller = new AbortController();
    const stopped = await migrateEnvironment({
      ...options,
      write: true,
      signal: controller.signal,
      onPage: () => controller.abort(),
    });
    expect(stopped.errors).toEqual([expect.objectContaining({ code: 'migration-paused' })]);
    expect(await state(BIRTHDATE)).toMatchObject({
      status: 'paused',
      pages: 1,
      counts: { changed: 20 },
    });
    expect(await missing('birthdate:missing')).toBe(STALE - 20);

    const resumed = await migrateEnvironment({ ...options, write: true });
    expect(resumed.ok).toBe(true);
    expect(resumed.migrations[BIRTHDATE]).toMatchObject({
      status: 'paused',
      resumed: true,
      counts: { changed: STALE, failed: 0, conflict: 0 },
    });
    expect(await missing('birthdate:missing')).toBe(0);
    const applied = await state(BIRTHDATE);
    expect(applied).toMatchObject({ status: 'applied', pages: 2, counts: { changed: STALE } });
    expect(applied.cursor).toBeUndefined();
    expect(applied.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('once the records are migrated, push loads the profile', async () => {
    const loaded = await pushed();
    expect(loaded.steps.find((s) => s.name === 'gate')?.failed).toBeUndefined();
    expect(loaded.plan.map((p) => [p.url, p.action])).toContainEqual([PATIENT, 'create']);
  });

  test('an applied migration is not run again', async () => {
    const before = (await ledger(BIRTHDATE))?.meta?.versionId;
    const result = await migrateEnvironment({ ...options, write: true });
    expect(result.migrations[BIRTHDATE]).toMatchObject({ status: 'applied', ran: false });
    expect((await ledger(BIRTHDATE))?.meta?.versionId).toBe(before);
  });

  test('of two runs started together, one runs and the other is migration-running', async () => {
    // In the same millisecond, as two CI jobs can be: the lease must still tell them apart.
    const instant = new Date();
    const both = await Promise.all(
      [0, 1].map(() =>
        migrateEnvironment({ ...options, ids: [GENDER], write: true, now: () => instant }),
      ),
    );
    // The messages too, so a failure says what the losing run hit.
    const errors = both.map((r) => r.errors);
    expect(errors.map((e) => e.map((x) => x.code)).sort(), JSON.stringify(errors)).toEqual([
      [],
      ['migration-running'],
    ]);
    expect(await missing('gender:missing')).toBe(0);
    expect(await state(GENDER)).toMatchObject({ status: 'applied' });
  });

  test('a run whose lease is ten minutes old is taken over', async () => {
    const held = (await ledger(GENDER)) as Basic;
    const stale = new Date(Date.now() - 11 * 60_000).toISOString();
    await medplum.updateResource<Basic>({
      ...held,
      extension: [
        {
          ...held.extension?.[0],
          url: held.extension?.[0]?.url as string,
          valueString: JSON.stringify({
            ...(await state(GENDER)),
            status: 'running',
            lease: stale,
          }),
        },
      ],
    });
    const result = await migrateEnvironment({ ...options, ids: [GENDER], write: true });
    expect(result.errors).toEqual([]);
    expect(await state(GENDER)).toMatchObject({ status: 'applied' });
  });

  const statuses = async () =>
    Object.fromEntries(
      Object.entries((await migrationStatus(options)).migrations).map(([id, m]) => [
        id,
        [m.status, m.module],
      ]),
    );

  test('status reports each migration applied, and passes', async () => {
    const status = await migrationStatus(options);
    expect(status.ok).toBe(true);
    expect(await statuses()).toEqual({
      [BIRTHDATE]: ['applied', true],
      [GENDER]: ['applied', true],
    });
  });

  test('a module edited after it was applied fails status and a write, until --rerun', async () => {
    appendFileSync(join(dir, `migrations/${BIRTHDATE}.ts`), '// edited\n');
    expect((await migrationStatus(options)).ok).toBe(false);
    expect((await statuses())[BIRTHDATE]).toEqual(['edited', true]);
    const refused = await migrateEnvironment({ ...options, write: true });
    expect(refused.errors).toEqual([expect.objectContaining({ code: 'migration-edited' })]);

    const rerun = await migrateEnvironment({ ...options, write: true, rerun: [BIRTHDATE] });
    expect(rerun.errors).toEqual([]);
    // Every record already has a birth date, so the fresh pass reads none.
    expect(rerun.migrations[BIRTHDATE]).toMatchObject({
      status: 'applied',
      ran: true,
      counts: { read: 0 },
    });
    expect((await statuses())[BIRTHDATE]).toEqual(['applied', true]);
  });

  test('a write refuses a migration whose dependency is not applied; status shows it pending', async () => {
    const later = '20261009-patient-active';
    writeFileSync(
      join(dir, `migrations/${later}.ts`),
      `import { defineMigration } from '../generated/index.js';
export default defineMigration({
  id: '${later}',
  resourceType: 'Patient',
  dependsOn: ['20261008-patient-language'],
  transform: () => undefined,
});
`,
    );
    writeFileSync(
      join(dir, 'migrations/20261008-patient-language.ts'),
      migration('20261008-patient-language', 'language:missing', 'language', 'en'),
    );
    const refused = await migrateEnvironment({ ...options, ids: [later], write: true });
    expect(refused.errors).toEqual([expect.objectContaining({ code: 'unmet-dependency' })]);
    expect(refused.errors[0]?.message).toContain('depends on 20261008-patient-language');
    expect((await statuses())[later]).toEqual(['pending', true]);
    rmSync(join(dir, `migrations/${later}.ts`));
    rmSync(join(dir, 'migrations/20261008-patient-language.ts'));
  });

  test("an applied migration whose module is gone is listed, and doesn't fail status", async () => {
    rmSync(join(dir, `migrations/${GENDER}.ts`));
    const status = await migrationStatus(options);
    expect(status.migrations[GENDER]).toMatchObject({ status: 'applied', module: false });
    expect(status.ok).toBe(true);
  });
});
