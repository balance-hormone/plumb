// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MedplumClient } from '@medplum/core';
import type {
  Bundle,
  BundleEntry,
  Encounter,
  Patient,
  Resource,
  StructureDefinition,
} from '@medplum/fhirtypes';
import { build } from 'esbuild';
import { beforeAll, describe, expect, test } from 'vitest';
import { CHECKER_BUILD } from '../../src/checker/bundle.js';
import { type ValidateEnvOptions, validateEnvironment } from '../../src/conformance.js';
import { fetchPackages } from '../../src/packages.js';
import { findChecker, push } from '../../src/push.js';
import { server } from './medplum.js';
import { newProject, type TestServer } from './setup.js';

const PLUMB = 'http://example.org/fhir/plumb-test/StructureDefinition';
const PATIENT = `${PLUMB}/cardinality-patient`;
const ENCOUNTER = `${PLUMB}/fixed-pattern-encounter`;
const OBSERVATION = `${PLUMB}/sliced-observation`;
const NAMING = `${PLUMB}/naming-patient-a`;
const FIXTURES = join(import.meta.dirname, '../fixtures');
const SYNTHETIC = join(FIXTURES, 'profiles/fsh-generated/resources');
// More than the checker's page of 100, so Patients take two pages.
const CONFORMING = 101;

const json = <T>(path: string) => JSON.parse(readFileSync(path, 'utf8')) as T;
const definition = (name: string) =>
  json<StructureDefinition>(join(SYNTHETIC, `StructureDefinition-${name}.json`));
const encounter = json<{ fixtures: { name: string; resource: Encounter }[] }>(
  join(FIXTURES, 'contracts/fixed-pattern-encounter.json'),
).fixtures.find((f) => f.name === 'all values match')?.resource as Encounter;

const post = (resource: Resource): BundleEntry => ({
  request: { method: 'POST', url: resource.resourceType },
  resource,
});
const named = (meta?: Patient['meta']): Patient => ({
  resourceType: 'Patient',
  ...(meta ? { meta } : {}),
  name: [{ family: 'Synthetic' }],
});

// Counts are exact, so this file has a project of its own. Each run waits on
// several async jobs, polled once a second.
describe.skipIf(!server)('plumb validate', { timeout: 60_000 }, () => {
  let project: TestServer;
  let medplum: MedplumClient;
  let options: ValidateEnvOptions;
  let failingId: string;
  let full: Awaited<ReturnType<typeof validateEnvironment>>;

  beforeAll(async () => {
    project = await newProject();
    medplum = new MedplumClient({ baseUrl: project.baseUrl });
    await medplum.startClientLogin(project.clientId, project.clientSecret);

    const failing = await medplum.createResource(named({ profile: [PATIENT] }));
    failingId = failing.id as string;
    const seed: Bundle = {
      resourceType: 'Bundle',
      type: 'batch',
      entry: [
        ...Array.from({ length: CONFORMING }, () =>
          post({ ...named({ profile: [PATIENT] }), birthDate: '1970-01-01' }),
        ),
        // Stamps that validate against nothing: neither profile is in the project yet.
        post(named({ profile: [`${PATIENT}|1.0.0`] })),
        post(named({ profile: ['http://example.org/fhir/StructureDefinition/no-such-profile'] })),
        post(named({ profile: [NAMING] })),
        post(named()),
        post({ ...encounter, meta: { profile: [ENCOUNTER] } }),
        post({ ...encounter, meta: { profile: [ENCOUNTER] } }),
        post({ resourceType: 'Observation', status: 'final', code: { text: 'Synthetic' } }),
      ],
    };
    const created = await medplum.executeBatch(seed);
    expect(created.entry?.every((e) => e.response?.status.startsWith('201'))).toBe(true);
    // Loaded after the seed, so the server never enforced them on it. Two versions of one URL
    // shadow each other; the other profile is held but not selected.
    const { id: _, ...patient } = definition('cardinality-patient');
    await medplum.createResource({ ...patient, version: '1.9.0' });
    await medplum.createResource({ ...patient, version: '1.10.0' });
    const { id: __, ...naming } = definition('naming-patient-a');
    await medplum.createResource(naming);

    const dir = mkdtempSync(join(tmpdir(), 'plumb-validate-'));
    const lockPath = join(dir, 'plumb.lock');
    await fetchPackages({ igs: [], lockPath });
    const code = (await build({ ...CHECKER_BUILD, write: false })).outputFiles[0]?.text ?? '';
    options = {
      config: { igs: [], profiles: [PATIENT, ENCOUNTER, OBSERVATION], local: SYNTHETIC, out: '' },
      environment: { name: 'test', ...project },
      lockPath,
      checker: { code, version: '0.2.0' },
      reportPath: join(dir, '.plumb', 'validate-test.json'),
    };
  }, 60_000);

  test('stops until push installs this plumb checker', async () => {
    const missing = await validateEnvironment(options);
    expect(missing.errors).toEqual([
      expect.objectContaining({ step: 'checker', code: 'checker-missing' }),
    ]);
    expect(missing.errors[0]?.message).toContain('Run plumb push --env test.');

    expect((await push({ ...options, checker: { ...options.checker, version: '0.1.0' } })).ok).toBe(
      true,
    );
    const outdated = await validateEnvironment(options);
    expect(outdated.errors[0]).toMatchObject({ step: 'checker', code: 'checker-outdated' });
    expect(outdated.errors[0]?.message).toContain('is 0.1.0, not this plumb');

    expect((await push(options)).ok).toBe(true);
  });

  test('reports failures, reasons, stamps, shadowing and the kinds of empty', async () => {
    full = await validateEnvironment(options);
    expect(full.errors).toEqual([]);
    expect(full.ok).toBe(false);
    expect(full.steps.map((s) => [s.name, s.failed ?? false])).toEqual([
      ['load', false],
      ['connect', false],
      ['checker', false],
      ['profiles', true],
      ['validate', true],
    ]);
    expect(full.shadowed).toEqual([
      { url: PATIENT, versions: ['1.10.0', '1.9.0'], picked: '1.9.0' },
    ]);
    expect(full.types.Patient).toEqual({
      exists: CONFORMING + 5,
      read: CONFORMING + 5,
      unstamped: 1,
      silent: { unknown: 1, versioned: 1, empty: 0 },
      otherProfiles: { [NAMING]: 1 },
    });
    expect(full.profiles[PATIENT]).toEqual({
      resourceType: 'Patient',
      checked: CONFORMING + 1,
      failing: 1,
      reasons: [expect.objectContaining({ path: 'Patient.birthDate', count: 1 })],
    });
    // All passed, and none carries a selected profile.
    expect(full.types.Encounter).toMatchObject({ exists: 2, read: 2, unstamped: 0 });
    expect(full.profiles[ENCOUNTER]).toMatchObject({ checked: 2, failing: 0 });
    expect(full.types.Observation).toMatchObject({ exists: 1, read: 1, unstamped: 1 });
    expect(full.profiles[OBSERVATION]).toMatchObject({ checked: 0, failing: 0 });

    // Failing ids go to the gitignored file only.
    expect(JSON.stringify(full)).not.toContain(failingId);
    const saved = json<{ complete: boolean; profiles: Record<string, { failing: string[] }> }>(
      options.reportPath,
    );
    expect(saved.complete).toBe(true);
    expect(saved.profiles[PATIENT]?.failing).toEqual([failingId]);
    expect(readFileSync(join(options.reportPath, '../.gitignore'), 'utf8')).toBe('*\n');
  });

  test('an interrupted run resumes from its last cursor', async () => {
    const interrupted = await validateEnvironment({
      ...options,
      onPage: (type) => {
        if (type === 'Patient') throw new Error('Interrupted');
      },
    });
    expect(interrupted.errors).toEqual([expect.objectContaining({ step: 'validate' })]);

    const pages: string[] = [];
    const resumed = await validateEnvironment({
      ...options,
      resume: true,
      onPage: (type) => pages.push(type),
    });
    // Encounter, Observation and the first Patient page were saved; only the second runs.
    expect(resumed.resumed).toBe(3);
    expect(pages).toEqual(['Patient']);
    expect(resumed.types).toEqual(full.types);
    expect(resumed.profiles).toEqual(full.profiles);
  });

  test('nothing readable is told apart from nothing stored', async () => {
    const bot = await findChecker(medplum);
    const membership = await medplum.searchOne('ProjectMembership', { profile: `Bot/${bot?.id}` });
    if (!membership?.accessPolicy) throw new Error('The checker has no AccessPolicy.');
    const policy = await medplum.readReference(membership.accessPolicy);
    await medplum.updateResource({
      ...policy,
      resource: policy.resource?.map((r) =>
        r.resourceType === 'Observation' ? { ...r, criteria: 'Observation?status=cancelled' } : r,
      ),
    });
    const result = await validateEnvironment(options);
    expect(result.types.Observation).toMatchObject({ exists: 1, read: 0 });
    expect(result.steps.at(-1)?.summary).toBe('1 of 3 profiles would fail');
    expect(existsSync(options.reportPath)).toBe(true);
  });
});
