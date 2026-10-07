// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Patient } from '@medplum/fhirtypes';
import { beforeAll, describe, expect, test } from 'vitest';
import type { LoadedConfig, PlumbConfig } from '../../src/config.js';
import { generate } from '../../src/generate.js';
import { migrationStatus } from '../../src/migrate.js';
import { connectAs, migrate } from '../../src/testing.js';
import { server } from './medplum.js';
import { newProject, type TestProject } from './setup.js';

const PATIENT = 'http://example.org/fhir/plumb-test/StructureDefinition/cardinality-patient';
const FOREIGN = 'http://example.org/fhir/StructureDefinition/foreign';
const SYNTHETIC = join(import.meta.dirname, '../fixtures/profiles/fsh-generated/resources');
const RESTAMP = 'plumb-restamp-Patient';

// Design 11's built-in restamp: records written before a profile was routed get its stamp.
describe.skipIf(!server)('the restamp migration', { timeout: 120_000 }, () => {
  let project: TestProject;
  let config: PlumbConfig;
  let lockPath: string;
  let foreign: Patient;

  beforeAll(async () => {
    project = await newProject();
    const medplum = await connectAs(project);
    await medplum.createResource<Patient>({
      resourceType: 'Patient',
      birthDate: '1970-01-01',
      name: [{ family: 'Unstamped' }],
    });
    foreign = await medplum.createResource<Patient>({
      resourceType: 'Patient',
      meta: { profile: [FOREIGN] },
      birthDate: '1970-01-01',
      name: [{ family: 'Foreign' }],
    });
    const dir = mkdtempSync(join(tmpdir(), 'plumb-restamp-'));
    config = {
      igs: [],
      profiles: [PATIENT],
      local: SYNTHETIC,
      out: join(dir, 'generated'),
      bots: { migrator: { file: join(dir, 'migrator.cjs') } },
      migrations: { bot: 'migrator', modules: [], restamp: true },
    };
    lockPath = join(dir, 'plumb.lock');
    const generated = await generate({ config, lockPath });
    expect(generated.errors).toEqual([]);
  }, 120_000);

  test('stamps the routed profile and keeps a URL Plumb does not manage', async () => {
    const result = await migrate(project, config as LoadedConfig, { lockPath, write: true });
    expect(result.errors).toEqual([]);
    expect(result.steps.find((s) => s.name === RESTAMP)?.summary).toMatch(/ 2 changed, /);
    const medplum = await connectAs(project);
    const patients = await medplum.searchResources('Patient', { _count: '20' });
    for (const patient of patients) expect(patient.meta?.profile).toContain(PATIENT);
    const kept = patients.find((p) => p.id === foreign.id);
    expect(kept?.meta?.profile).toEqual(expect.arrayContaining([FOREIGN, PATIENT]));
  });

  test('is applied until the routing changes, then pending again', async () => {
    const environment = { name: 'test', ...project };
    const before = await migrationStatus({ config, environment });
    expect(before.migrations[RESTAMP]?.status).toBe('applied');
    appendFileSync(join(config.out, '_routes.ts'), '\n');
    const after = await migrationStatus({ config, environment });
    expect(after.migrations[RESTAMP]?.status).toBe('pending');
    const again = await migrate(project, config as LoadedConfig, { lockPath, write: true });
    expect(again.steps.find((s) => s.name === RESTAMP)?.summary).toMatch(/ 0 changed, /);
  });
});
