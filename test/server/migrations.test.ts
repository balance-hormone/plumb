// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Patient, StructureDefinition } from '@medplum/fhirtypes';
import { build } from 'esbuild';
import { beforeAll, describe, expect, test } from 'vitest';
import { applyBots, planBots } from '../../src/bots.js';
import { CHECKER_BUILD } from '../../src/checker/bundle.js';
import { checkerInput } from '../../src/checker/input.js';
import { CHECKER_IDENTIFIER, installChecker } from '../../src/checker/install.js';
import { printFiles } from '../../src/emit/print.js';
import { writeFiles } from '../../src/emit/write.js';
import { loadProfiles } from '../../src/loader.js';
import { PLUMB_SYSTEM } from '../../src/project.js';
import { connect, server } from './medplum.js';
import { newProject } from './setup.js';

const PATIENT = 'http://example.org/fhir/plumb-test/StructureDefinition/cardinality-patient';
const SYNTHETIC = join(import.meta.dirname, '../fixtures/profiles/fsh-generated/resources');

const errorOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (err: { outcome?: { id?: string; issue?: { expression?: string[] }[] } }) => err.outcome,
  );

// Design 11's "Checked first": what the runner relies on Medplum to do.
describe.skipIf(!server)('Medplum, as the migration runner relies on it', () => {
  let medplum: MedplumClient;
  beforeAll(async () => {
    medplum = await connect(await newProject());
  });

  // Medplum 5.1.0 ignores If-Match on a PATCH and applies it, so the runner writes with PUT.
  test('a PUT against a stale version is a 412, precondition-failed', async () => {
    const patient = await medplum.createResource<Patient>({
      resourceType: 'Patient',
      active: true,
    });
    const stale = patient.meta?.versionId as string;
    await medplum.updateResource({ ...patient, active: false });
    const outcome = await errorOf(
      medplum.updateResource(
        { ...patient, gender: 'other' },
        { headers: { 'If-Match': `W/"${stale}"` } },
      ),
    );
    expect(outcome?.id).toBe('precondition-failed');
  });

  test("a PUT is validated against the record's meta.profile in a strict project", async () => {
    const sd = JSON.parse(
      readFileSync(join(SYNTHETIC, 'StructureDefinition-cardinality-patient.json'), 'utf8'),
    ) as StructureDefinition;
    await medplum.createResource(sd);
    const patient = await medplum.createResource<Patient>({
      resourceType: 'Patient',
      meta: { profile: [PATIENT] },
      birthDate: '1970-01-01',
      name: [{ family: 'Synthetic' }],
    });
    const outcome = await errorOf(medplum.updateResource({ ...patient, birthDate: undefined }));
    expect(outcome?.issue?.flatMap((i) => i.expression ?? [])).toContain('Patient.birthDate');
  });

  test('a PUT that changes nothing writes no version', async () => {
    const patient = await medplum.createResource<Patient>({
      resourceType: 'Patient',
      gender: 'other',
    });
    const patched = await medplum.updateResource({ ...patient });
    expect(patched.meta?.versionId).toBe(patient.meta?.versionId);
  });

  test('a cursor scan by _lastUpdated reads a record written mid-scan again', async () => {
    const tag = `${PLUMB_SYSTEM}|scan-${Date.now()}`;
    const [system, code] = tag.split('|') as [string, string];
    const created: Patient[] = [];
    for (let i = 0; i < 25; i++) {
      created.push(
        await medplum.createResource<Patient>({
          resourceType: 'Patient',
          meta: { tag: [{ system, code }] },
        }),
      );
    }
    const query = { _tag: tag, _sort: '_lastUpdated', _count: '20' };
    const first = await medplum.search('Patient', query);
    const cursor = new URL(
      first.link?.find((l) => l.relation === 'next')?.url ?? '',
    ).searchParams.get('_cursor');
    expect(cursor).toBeTruthy();
    const touched = created[0] as Patient;
    await medplum.updateResource({ ...touched, active: true });
    const second = await medplum.search('Patient', { ...query, _cursor: cursor as string });
    expect(second.entry?.map((e) => e.resource?.id)).toContain(touched.id);
  });
});

// The runner as a project deploys it: the generated _migrator.ts around a
// migration module, bundled for vmcontext, asking Plumb's checker for the forecast.
describe.skipIf(!server)('the migration bot', { timeout: 120_000 }, () => {
  let medplum: MedplumClient;
  let migratorId: string;
  const forecast = {
    checker: CHECKER_IDENTIFIER,
    ...(() => {
      const loaded = loadProfiles({ packages: [], igs: [], local: SYNTHETIC, profiles: [PATIENT] });
      const { profiles, definitions } = checkerInput(loaded, 'Patient');
      return { profiles, definitions };
    })(),
  };
  let start: string;

  beforeAll(async () => {
    medplum = await connect(await newProject());
    const dir = mkdtempSync(join(tmpdir(), 'plumb-migrator-'));
    mkdirSync(join(dir, 'migrations'));
    writeFileSync(
      join(dir, 'migrations/20261006-patient-birthdate.ts'),
      `import { defineMigration } from '../generated/index.js';
export default defineMigration({
  id: '20261006-patient-birthdate',
  resourceType: 'Patient',
  search: { 'birthdate:missing': 'true' },
  transform: (patient) =>
    patient.birthDate ? undefined : [{ op: 'add', path: '/birthDate', value: '1900-01-01' }],
});
`,
    );
    const files = printFiles([], () => 'test', undefined, [], [], undefined, [
      '../migrations/20261006-patient-birthdate.js',
    ]);
    writeFiles(join(dir, 'generated'), files);
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
    await applyBots(await planBots(medplum, { migrator: { file, runtime: 'vmcontext' } }), medplum);
    migratorId = (await medplum.searchOne('Bot', { identifier: `${PLUMB_SYSTEM}|migrator` }))
      ?.id as string;
    const code = (await build({ ...CHECKER_BUILD, write: false })).outputFiles[0]?.text ?? '';
    await installChecker(medplum, { code, version: 'test', resourceTypes: ['Patient'] });

    for (const family of ['A', 'B']) {
      await medplum.createResource<Patient>({
        resourceType: 'Patient',
        meta: { profile: [PATIENT] },
        name: [{ family }],
      });
    }
    await medplum.createResource<Patient>({
      resourceType: 'Patient',
      meta: { profile: [PATIENT] },
      name: [{ family: 'C' }],
      birthDate: '1970-01-01',
    });
    start = new Date(Date.now() + 1000).toISOString();
  }, 120_000);

  const page = (input: object) =>
    medplum.executeBot(
      migratorId,
      { id: '20261006-patient-birthdate', start, ...input },
      'application/json',
    );

  test('a dry run counts the records, writes nothing, and the checker forecasts them', async () => {
    const result = await page({ forecast });
    expect(result).toMatchObject({ read: 2, changed: 2, unchanged: 0, failed: 0, written: [] });
    expect(result.forecast).toMatchObject({ stamped: 2, failing: 0 });
    expect(await medplum.searchResources('Patient', { 'birthdate:missing': 'true' })).toHaveLength(
      2,
    );
  });

  test('a write patches each record, and a second run finds nothing to do', async () => {
    const written = await page({ write: true });
    expect(written).toMatchObject({ changed: 2, failed: 0, conflict: 0 });
    expect(written.written.map((w: { versionId: string }) => w.versionId)).toHaveLength(2);
    expect(await medplum.searchResources('Patient', { 'birthdate:missing': 'true' })).toHaveLength(
      0,
    );
    // A record no longer matches the search once it has a birth date.
    expect(await page({ write: true })).toMatchObject({ read: 0, changed: 0, written: [] });
  });
});
