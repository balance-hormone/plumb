// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type {
  Encounter,
  Observation,
  Patient,
  Project,
  StructureDefinition,
} from '@medplum/fhirtypes';
import { build } from 'esbuild';
import { beforeAll, describe, expect, test } from 'vitest';
import { CHECKER_BUILD } from '../../src/checker/bundle.js';
import { serverTime, validateEnvironment } from '../../src/conformance.js';
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
    expect(result.plan).toEqual([
      { resourceType: 'StructureDefinition', url: PATIENT, version: '0.1.0', action: 'create' },
    ]);
    expect(result.steps.at(-1)).toMatchObject({
      name: 'gate',
      failed: true,
      summary: '1 stored resource would fail cardinality-patient',
      warnings: [
        'Full scan: no receipt from plumb validate.',
        expect.stringMatching(/^Refusing to load/),
      ],
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
      warnings: ['Full scan: no receipt from plumb validate.', 'Dry run: nothing loaded.'],
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
      {
        resourceType: 'StructureDefinition',
        url: PATIENT,
        version: '0.1.0',
        held: '0.1.0',
        action: 'unchanged',
      },
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
      {
        resourceType: 'StructureDefinition',
        url: PATIENT,
        version: '0.1.0',
        held: '0.1.0',
        action: 'update',
        edited: true,
      },
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
    // The patient profile is loaded and unchanged, so its records are not read.
    expect(result.steps.find((s) => s.name === 'gate')).toMatchObject({
      summary:
        '0 Encounter stamped fixed-pattern-encounter checked, nothing would fail; 1 unchanged profile skipped',
    });
    expect(result.steps.find((s) => s.name === 'gate')?.failed).toBeUndefined();
    expect(Object.keys(result.gate?.types ?? {})).toEqual(['Encounter']);
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

// Push loads a selected profile's parents too, so the gate checks what is
// stamped with them, although the config does not select them.
describe.skipIf(!server)('the gate checks the parents push loads', { timeout: 60_000 }, () => {
  test('refuses while a resource stamped only with a planned parent would fail it', async () => {
    const project = await newProject();
    const medplum = await connect(project);
    const parent = `${PLUMB}/parent-observation`;
    const child = `${PLUMB}/child-observation`;
    // No subject or effective[x], which the parent requires.
    await medplum.createResource<Observation>({
      resourceType: 'Observation',
      meta: { profile: [parent] },
      status: 'final',
      code: { text: 'Synthetic' },
    });
    const dir = mkdtempSync(join(tmpdir(), 'plumb-gate-parent-'));
    const local = join(dir, 'profiles');
    mkdirSync(local);
    for (const name of ['parent-observation', 'child-observation']) {
      copyFileSync(join(SYNTHETIC, file(name)), join(local, file(name)));
    }
    const lockPath = join(dir, 'plumb.lock');
    await fetchPackages({ igs: [], lockPath });
    const code = (await build({ ...CHECKER_BUILD, write: false })).outputFiles[0]?.text ?? '';
    const result = await push({
      config: { igs: [], profiles: [child], local, out: '' },
      environment: { name: 'test', ...project },
      lockPath,
      checker: { code, version: '0.2.0' },
      reportPath: join(dir, '.plumb', 'validate-test.json'),
    });
    expect(result.ok).toBe(false);
    expect(result.plan.map((p) => [p.url, p.action]).sort()).toEqual([
      [child, 'create'],
      [parent, 'create'],
    ]);
    expect(result.steps.at(-1)).toMatchObject({ name: 'gate', failed: true });
    expect(result.gate?.profiles[parent]).toMatchObject({ checked: 1, failing: 1 });
    expect(await medplum.searchResources('StructureDefinition', { url: parent })).toHaveLength(0);
  });
});

// Medplum validates against whichever copy of a URL sorts "newest" as text, so
// push loads nothing over two of them.
describe.skipIf(!server)('push refuses a shadowed profile', { timeout: 60_000 }, () => {
  test('two held copies of a selected profile stop push before the gate, writing nothing', async () => {
    const project = await newProject();
    const medplum = await connect(project);
    const { id: _, ...sd } = JSON.parse(
      readFileSync(join(SYNTHETIC, file('cardinality-patient')), 'utf8'),
    ) as StructureDefinition;
    await medplum.createResource({ ...sd, version: '1.9.0' });
    await medplum.createResource({ ...sd, version: '1.10.0' });
    const dir = mkdtempSync(join(tmpdir(), 'plumb-gate-shadowed-'));
    const lockPath = join(dir, 'plumb.lock');
    await fetchPackages({ igs: [], lockPath });
    const code = (await build({ ...CHECKER_BUILD, write: false })).outputFiles[0]?.text ?? '';
    const result = await push({
      config: { igs: [], profiles: [PATIENT], local: SYNTHETIC, out: '' },
      environment: { name: 'test', ...project },
      lockPath,
      checker: { code, version: '0.2.0' },
      reportPath: join(dir, '.plumb', 'validate-test.json'),
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.plan).toEqual([
      { resourceType: 'StructureDefinition', url: PATIENT, version: '0.1.0', action: 'shadowed' },
    ]);
    expect(result.gate).toBeUndefined();
    expect(result.steps.at(-1)).toMatchObject({
      name: 'plan',
      failed: true,
      summary: 'refusing: profiles are shadowed',
      warnings: [
        `${PATIENT}: the project holds more than one; delete all but one, then push again.`,
      ],
    });
    const held = await (await connect(project)).searchResources('StructureDefinition', {
      url: PATIENT,
    });
    expect(held.map((d) => d.version).sort()).toEqual(['1.10.0', '1.9.0']);
  });
});

// A passing validate records a receipt, so the deploy after it reads only
// what was updated since, as Postgres validates a NOT VALID constraint apart
// from the ALTER that adds it.
describe.skipIf(!server)('push gates from a validate receipt', { timeout: 120_000 }, () => {
  let project: TestProject;
  let medplum: MedplumClient;
  let local: string;
  let options: PushOptions;
  const conforming = (): Patient => ({
    resourceType: 'Patient',
    meta: { profile: [PATIENT] },
    name: [{ family: 'Synthetic' }],
    birthDate: '1970-01-01',
  });
  const receipts = async () => [
    ...(await medplum.searchResources('Basic', {
      code: 'https://www.npmjs.com/package/plumb-fhir|validation',
    })),
  ];
  const gate = (result: Awaited<ReturnType<typeof push>>) =>
    result.steps.find((s) => s.name === 'gate');

  beforeAll(async () => {
    project = await newProject();
    medplum = await connect(project);
    await medplum.createResource(conforming());
    await medplum.createResource(conforming());
    const dir = mkdtempSync(join(tmpdir(), 'plumb-receipt-'));
    local = join(dir, 'profiles');
    mkdirSync(local);
    copyFileSync(
      join(SYNTHETIC, file('cardinality-patient')),
      join(local, file('cardinality-patient')),
    );
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

  test('without a receipt the gate reads everything, and says so', async () => {
    // Installs the checker, which validate needs.
    const result = await push({ ...options, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.receipt).toBeUndefined();
    expect(gate(result)).toMatchObject({
      summary: '2 Patient stamped cardinality-patient checked, nothing would fail',
      warnings: ['Full scan: no receipt from plumb validate.', 'Dry run: nothing loaded.'],
    });
  });

  test('a failing validate records no receipt', async () => {
    const failing = await medplum.createResource<Patient>({
      ...conforming(),
      birthDate: undefined,
    });
    const result = await validateEnvironment(options);
    expect(result.ok).toBe(false);
    expect(result.receipt).toBeUndefined();
    expect(await receipts()).toEqual([]);
    await medplum.updateResource({ ...failing, birthDate: '1970-01-01' });
  });

  test('a passing validate records each profile, its version and hash, and when it began', async () => {
    // Past the second of the last write, so the receipt's window starts after it.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const before = await serverTime(medplum);
    const result = await validateEnvironment(options);
    expect(result.ok).toBe(true);
    const [held] = await receipts();
    expect(result.receipt).toEqual({ id: held?.id, began: expect.any(String) });
    // The second the run began: not before the second this test asked the time.
    expect(Date.parse(result.receipt?.began ?? '')).toBeGreaterThanOrEqual(
      Date.parse(before) - 1000,
    );
    expect(JSON.parse(held?.extension?.[0]?.valueString ?? '{}')).toEqual({
      began: result.receipt?.began,
      checker: expect.stringMatching(/^plumb-checker/),
      profiles: [{ url: PATIENT, version: '0.1.0', hash: expect.stringMatching(/^[0-9a-f]{64}$/) }],
    });
    expect(result.steps.at(-1)?.warnings).toContain(
      `Receipt Basic/${held?.id}: push checks only what is updated from ${result.receipt?.began}.`,
    );
    // Validated again, it replaces the receipt rather than adding one.
    await validateEnvironment(options);
    expect((await receipts()).map((r) => r.id)).toEqual([held?.id]);
  });

  test('a receipt for another version of the profile means a full scan', async () => {
    const path = join(local, file('cardinality-patient'));
    const original = readFileSync(path, 'utf8');
    const sd = JSON.parse(original) as StructureDefinition;
    writeFileSync(path, JSON.stringify({ ...sd, version: '0.2.0' }));
    try {
      const result = await push({ ...options, dryRun: true });
      expect(result.ok).toBe(true);
      expect(result.receipt).toBeUndefined();
      const [held] = await receipts();
      expect(gate(result)).toMatchObject({
        summary: '3 Patient stamped cardinality-patient checked, nothing would fail',
        warnings: [
          `Full scan: receipt Basic/${held?.id} covers cardinality-patient 0.1.0, not 0.2.0.`,
          'Dry run: nothing loaded.',
        ],
      });
    } finally {
      writeFileSync(path, original);
    }
  });

  test('with a receipt the gate reads only what was updated since, and still refuses', async () => {
    const [held] = await receipts();
    const { began } = JSON.parse(held?.extension?.[0]?.valueString ?? '{}') as { began: string };
    const failing = await medplum.createResource<Patient>({
      ...conforming(),
      birthDate: undefined,
    });
    const refused = await push({ ...options, dryRun: true });
    expect(refused.ok).toBe(false);
    expect(refused.receipt).toEqual({ id: held?.id, since: began });
    expect(gate(refused)).toMatchObject({
      failed: true,
      summary: `incremental since ${began} (receipt Basic/${held?.id}): 1 stored resource would fail cardinality-patient`,
    });
    expect(refused.gate?.types.Patient).toMatchObject({ stamped: 1, failing: 1 });
    await medplum.updateResource({ ...failing, birthDate: '1970-01-01' });
    // Past the second of that write, which a run starting in it reads again.
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const result = await push(options);
    expect(result.ok).toBe(true);
    expect(gate(result)).toMatchObject({
      summary: `incremental since ${began} (receipt Basic/${held?.id}): 1 Patient stamped cardinality-patient checked, nothing would fail`,
      warnings: [],
    });
    // The re-check reads from the gate's start: nothing was written since.
    expect(result.steps.at(-1)).toMatchObject({
      name: 'recheck',
      summary: `incremental since ${result.gate?.began}: 0 Patient stamped cardinality-patient checked, nothing fails`,
    });
    const loaded = await medplum.searchResources('StructureDefinition', { url: PATIENT });
    expect(loaded.map((sd) => sd.version)).toEqual(['0.1.0']);
  });
});
