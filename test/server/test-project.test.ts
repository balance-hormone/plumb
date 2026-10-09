// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bundle, Patient } from '@medplum/fhirtypes';
import { beforeAll, describe, expect, test } from 'vitest';
import { bundledChecker } from '../../src/checker/install.js';
import type { LoadedConfig, PlumbConfig } from '../../src/config.js';
import { fetchPackages } from '../../src/packages.js';
import { push } from '../../src/push.js';
import { superAdmin } from '../../src/server.js';
import {
  type CreateTestProjectResult,
  createTestProject,
  type TestProject,
} from '../../src/testing.js';
import { connect, server } from './medplum.js';

const PATIENT = 'http://example.org/fhir/plumb-test/StructureDefinition/cardinality-patient';
const SYNTHETIC = join(import.meta.dirname, '../fixtures/profiles/fsh-generated/resources');
const SYSTEM = 'http://example.org/fhir/plumb-test/mrn';

const CONFIG: PlumbConfig = {
  igs: [],
  profiles: [PATIENT],
  local: SYNTHETIC,
  out: '',
  defaultProfile: { Patient: [PATIENT] },
  project: {
    settings: { email: 'support@example.org', beta: false },
    accessPolicies: {
      'front-desk': { name: 'Front desk', resource: [{ resourceType: 'Patient' }] },
    },
  },
  test: { settings: { beta: true } },
};

const patient = (family: string, extra: Partial<Patient> = {}): Patient => ({
  resourceType: 'Patient',
  identifier: [{ system: SYSTEM, value: family }],
  name: [{ family }],
  birthDate: '1990-01-01',
  ...extra,
});

/** Seed files: a batch of a patient, then a transaction that finds it by identifier. */
function seedFiles(bad = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'plumb-seed-'));
  const batch: Bundle = {
    resourceType: 'Bundle',
    type: 'batch',
    entry: [
      { request: { method: 'POST', url: 'Patient' }, resource: patient('Ada') },
      // Breaks the default profile: no birthDate.
      ...(bad
        ? [
            {
              request: { method: 'POST' as const, url: 'Patient' },
              resource: { ...patient('Bad'), birthDate: undefined },
            },
          ]
        : []),
    ],
  };
  const transaction: Bundle = {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [
      {
        request: { method: 'POST', url: 'Observation' },
        resource: {
          resourceType: 'Observation',
          status: 'final',
          code: { text: 'Synthetic' },
          subject: { reference: `Patient?identifier=${SYSTEM}|Ada` },
        },
      },
    ],
  };
  writeFileSync(join(dir, '1-patients.json'), JSON.stringify(batch));
  writeFileSync(join(dir, '2-observations.json'), JSON.stringify(transaction));
  return join(dir, '*.json');
}

describe.skipIf(!server)('createTestProject', { timeout: 120_000 }, () => {
  let lockPath: string;
  let created: CreateTestProjectResult;
  let project: TestProject;
  beforeAll(async () => {
    lockPath = join(mkdtempSync(join(tmpdir(), 'plumb-test-project-')), 'plumb.lock');
    await fetchPackages({ igs: [], lockPath });
    created = await createTestProject(CONFIG as LoadedConfig, { lockPath, seed: [seedFiles()] });
    if (!created.ok) throw new Error(created.error.message);
    project = created;
  }, 120_000);

  test('the project is converged, and a second push plans nothing', async () => {
    expect(created.push.errors).toEqual([]);
    const medplum = await connect(project);
    // A project admin's read leaves out super-admin fields, and so does 5.1.0's login.
    expect(await (await superAdmin()).readResource('Project', project.projectId)).toMatchObject({
      strictMode: true,
      features: ['bots'],
    });
    const stored = await medplum.readResource('Project', project.projectId);
    // test.settings merge over project.settings.
    expect(stored.setting).toEqual([
      { name: 'email', valueString: 'support@example.org' },
      { name: 'beta', valueBoolean: true },
    ]);
    expect(await medplum.searchOne('AccessPolicy', { name: 'Front desk' })).toBeDefined();

    const again = await push({
      config: {
        ...CONFIG,
        environments: undefined,
        project: { ...CONFIG.project, settings: { email: 'support@example.org', beta: true } },
      },
      environment: { name: 'test', ...project },
      lockPath,
      checker: bundledChecker(),
      reportPath: join(lockPath, '../validate-test.json'),
      check: true,
    });
    expect(again.errors).toEqual([]);
    expect(again.ok).toBe(true);
  });

  test('a write that breaks a profile is refused; an unstamped one gets the default', async () => {
    const medplum = await connect(project);
    await expect(
      medplum.createResource({ resourceType: 'Patient', meta: { profile: [PATIENT] } }),
    ).rejects.toThrow(/name|birthDate/);
    const unstamped = await medplum.createResource(patient('Grace'));
    expect(unstamped.meta?.profile).toEqual([PATIENT]);
  });

  test('the seed loads in order', async () => {
    const medplum = await connect(project);
    const [observation] = await medplum.searchResources('Observation');
    const ada = await medplum.searchOne('Patient', { identifier: `${SYSTEM}|Ada` });
    expect(observation?.subject?.reference).toBe(`Patient/${ada?.id}`);
  });

  test('a seed entry the server refuses fails the setup, naming it', async () => {
    const refused = await createTestProject(CONFIG as LoadedConfig, {
      lockPath,
      seed: [seedFiles(true)],
    });
    expect(!refused.ok && refused.error.code).toBe('seed-refused');
    expect(!refused.ok && refused.error.message).toMatch(
      /1-patients\.json, entry 1, was refused: .*birthDate/,
    );
  });

  test('options override strictMode and features', async () => {
    const loose = await createTestProject(
      { ...CONFIG, project: undefined, defaultProfile: undefined } as LoadedConfig,
      { lockPath, strictMode: false, features: ['bots', 'cron'] },
    );
    if (!loose.ok) throw new Error(loose.error.message);
    expect(await (await superAdmin()).readResource('Project', loose.projectId)).toMatchObject({
      strictMode: false,
      features: ['bots', 'cron'],
    });
  });
});

describe.skipIf(!server)('a test project runs the declared bots', { timeout: 120_000 }, () => {
  test('on vmcontext, from the test build, triggered through a Subscription', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plumb-test-bots-'));
    // The Lambda bundle is an ES module vmcontext cannot run; the test build is CommonJS.
    const lambda = join(dir, 'echo.mjs');
    writeFileSync(lambda, 'export const handler = async () => ({});');
    const build = join(dir, 'echo.test.cjs');
    writeFileSync(build, 'exports.handler = async (medplum, event) => ({ id: event.input.id });');
    const lockPath = join(dir, 'plumb.lock');
    await fetchPackages({ igs: [], lockPath });
    const created = await createTestProject(
      {
        igs: [],
        profiles: [],
        out: '',
        bots: {
          echo: { file: lambda, cron: '0 3 * * *', environmentOverrides: { test: { cron: null } } },
        },
        subscriptions: { 'new-patient': { criteria: 'Patient', bot: 'echo' } },
        test: { bots: { echo: { file: build } } },
      } as PlumbConfig as LoadedConfig,
      { lockPath },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const admin = await superAdmin();
    expect((await admin.readResource('Project', created.projectId)).features).toEqual([
      'bots',
      'cron',
    ]);
    const medplum = await connect(created);
    const bot = await medplum.searchOne('Bot', { name: 'echo' });
    expect(bot).toMatchObject({ runtimeVersion: 'vmcontext', cronString: '0 3 * * *' });
    expect(bot?.executableCode?.title).toMatch(/^echo-[0-9a-f]{16}\.cjs$/);

    const written = await medplum.createResource(patient('Grace'));
    let events: unknown[] = [];
    for (let i = 0; i < 60 && events.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 500));
      events = await medplum.searchResources('AuditEvent', { entity: `Bot/${bot?.id}` });
    }
    expect(JSON.stringify(events)).toContain(written.id);
  });
});
