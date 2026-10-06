// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Encounter, Patient, Project, StructureDefinition } from '@medplum/fhirtypes';
import { build } from 'esbuild';
import { beforeAll, describe, expect, test } from 'vitest';
import { CHECKER_BUILD } from '../../src/checker/bundle.js';
import { fetchPackages } from '../../src/packages.js';
import { type PushOptions, push } from '../../src/push.js';
import { connect, server } from './medplum.js';
import { newProject, type TestProject } from './setup.js';

const PLUMB = 'http://example.org/fhir/plumb-test/StructureDefinition';
const PATIENT = `${PLUMB}/cardinality-patient`;
const ENCOUNTER = `${PLUMB}/fixed-pattern-encounter`;
const FIXTURES = join(import.meta.dirname, '../fixtures');
const SYNTHETIC = join(FIXTURES, 'profiles/fsh-generated/resources');

const file = (name: string) => `StructureDefinition-${name}.json`;
const encounters = (
  JSON.parse(readFileSync(join(FIXTURES, 'contracts/fixed-pattern-encounter.json'), 'utf8')) as {
    fixtures: { name: string; resource: Encounter }[];
  }
).fixtures;
const encounter = (name: string) => encounters.find((f) => f.name === name)?.resource as Encounter;

// Push writes profiles, so this file has a project of its own. Each push waits
// on the checker's async jobs, polled once a second.
describe.skipIf(!server)('push loads profiles through the gate', { timeout: 60_000 }, () => {
  let project: TestProject;
  let medplum: MedplumClient;
  let local: string;
  let options: PushOptions;
  let failing: Patient;

  // A plain array: searchResources' result also carries its bundle.
  const held = async (url: string) => [
    ...(await medplum.searchResources('StructureDefinition', { url })),
  ];

  beforeAll(async () => {
    project = await newProject();
    medplum = await connect(project);
    // The profile is not loaded yet, so the server accepts a resource that fails it.
    failing = await medplum.createResource<Patient>({
      resourceType: 'Patient',
      meta: { profile: [PATIENT] },
      name: [{ family: 'Synthetic' }],
    });

    const dir = mkdtempSync(join(tmpdir(), 'plumb-gate-'));
    // A local copy of the profiles, so a test can edit one.
    local = join(dir, 'profiles');
    mkdirSync(local);
    for (const name of ['cardinality-patient', 'fixed-pattern-encounter']) {
      copyFileSync(join(SYNTHETIC, file(name)), join(local, file(name)));
    }
    const lockPath = join(dir, 'plumb.lock');
    await fetchPackages({ igs: [], lockPath });
    const code = (await build({ ...CHECKER_BUILD, write: false })).outputFiles[0]?.text ?? '';
    options = {
      config: { igs: [], profiles: [PATIENT], local, out: '' },
      environment: { name: 'test', ...project },
      lockPath,
      checker: { code, version: '0.2.0' },
      reportPath: join(dir, '.plumb', 'validate-test.json'),
    };
  }, 60_000);

  test('refuses, and loads nothing, while a stored resource would fail', async () => {
    const result = await push(options);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.plan).toEqual([{ url: PATIENT, version: '0.1.0', action: 'create' }]);
    expect(result.steps.at(-1)).toMatchObject({
      name: 'gate',
      failed: true,
      summary: '1 stored resource would fail cardinality-patient',
      warnings: [expect.stringMatching(/^Refusing to load/)],
    });
    expect(result.gate?.profiles[PATIENT]).toMatchObject({ checked: 1, failing: 1 });
    expect(await held(PATIENT)).toEqual([]);
  });

  test('--dry-run stops after the gate', async () => {
    failing = await medplum.updateResource({ ...failing, birthDate: '1970-01-01' });
    const result = await push({ ...options, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.steps.at(-1)).toMatchObject({
      name: 'gate',
      warnings: ['Dry run: nothing loaded.'],
    });
    expect(await held(PATIENT)).toEqual([]);
  });

  test('loads once nothing fails, re-checks, and a second push loads nothing', async () => {
    const result = await push(options);
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.name).slice(-3)).toEqual(['gate', 'apply', 'recheck']);
    expect(result.recheck?.profiles[PATIENT]).toMatchObject({ checked: 1, failing: 0 });
    expect((await held(PATIENT)).map((sd) => sd.version)).toEqual(['0.1.0']);
    // The test project is strict, so push has nothing to say about strict mode.
    expect(result.steps.at(-1)?.warnings).toEqual([]);

    const again = await push(options);
    expect(again.ok).toBe(true);
    expect(again.plan).toEqual([
      { url: PATIENT, version: '0.1.0', held: '0.1.0', action: 'unchanged' },
    ]);
    expect(again.steps.at(-1)?.name).toBe('plan');
  });

  test('a profile changed without a version bump is flagged and updated in place', async () => {
    const path = join(local, file('cardinality-patient'));
    const sd = JSON.parse(readFileSync(path, 'utf8')) as StructureDefinition;
    writeFileSync(path, JSON.stringify({ ...sd, description: 'Edited, same version.' }));
    const result = await push(options);
    expect(result.ok).toBe(true);
    expect(result.plan).toEqual([
      { url: PATIENT, version: '0.1.0', held: '0.1.0', action: 'update', edited: true },
    ]);
    expect(result.steps.find((s) => s.name === 'plan')?.warnings).toEqual([
      `${PATIENT}|0.1.0: changed without a version bump.`,
    ]);
    expect((await held(PATIENT)).map((sd) => sd.description)).toEqual(['Edited, same version.']);
  });

  test('the re-check catches a failing write made between the gate and loading', async () => {
    let written = false;
    const result = await push({
      ...options,
      config: { ...options.config, profiles: [PATIENT, ENCOUNTER] },
      // After the gate has read the Encounters, and before the profile loads.
      onPage: async (type) => {
        if (type !== 'Encounter' || written) return;
        written = true;
        await medplum.createResource({
          ...encounter('status in-progress'),
          meta: { profile: [ENCOUNTER] },
        });
      },
    });
    expect(result.ok).toBe(false);
    expect(result.steps.find((s) => s.name === 'gate')?.failed).toBeUndefined();
    expect(result.steps.at(-1)).toMatchObject({
      name: 'recheck',
      failed: true,
      summary: '1 stored resource fails fixed-pattern-encounter',
    });
    // Loaded and kept, as Postgres keeps a NOT VALID constraint.
    expect(await held(ENCOUNTER)).toHaveLength(1);
  });

  test('a project admin cannot set strictMode', async () => {
    const id = medplum.getProject()?.id as string;
    const stored = await medplum.readResource('Project', id);
    // The write succeeds; the server restores the hidden field.
    await medplum.updateResource<Project>({ ...stored, strictMode: false });
    const again = await connect(project);
    expect(again.getProject()?.strictMode).toBe(true);
  });
});
