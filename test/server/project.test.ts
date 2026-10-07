// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccessPolicy, ClientApplication, Patient } from '@medplum/fhirtypes';
import { build } from 'esbuild';
import { beforeAll, describe, expect, test } from 'vitest';
import { CHECKER_BUILD } from '../../src/checker/bundle.js';
import type { PlumbConfig, ProjectConfig } from '../../src/config.js';
import { fetchPackages } from '../../src/packages.js';
import { applyProject, PLUMB_SYSTEM, type ProjectOptions, planProject } from '../../src/project.js';
import { type PushOptions, push } from '../../src/push.js';
import { connect, server } from './medplum.js';
import { linkProject, newProject, type TestProject } from './setup.js';

const CONFIG: ProjectConfig = {
  accessPolicies: {
    clinician: { resource: [{ resourceType: 'Patient' }, { resourceType: 'Observation' }] },
    reader: { name: 'Read only', resource: [{ resourceType: 'Patient', readonly: true }] },
  },
};

const tagOf = (p: AccessPolicy | ClientApplication) =>
  p.meta?.tag?.find((t) => t.system === PLUMB_SYSTEM)?.code;

// Each test file has a project of its own, so what it holds is only what these tests wrote.
describe.skipIf(!server)('the project step converges AccessPolicies', { timeout: 60_000 }, () => {
  let project: TestProject;
  beforeAll(async () => {
    project = await newProject();
  }, 60_000);

  // A fresh login for each plan, so nothing is read from a client's cache.
  const plan = async (config: ProjectConfig, options?: ProjectOptions) =>
    planProject(config, await connect(project), options);
  const converge = async (config: ProjectConfig, options?: ProjectOptions) =>
    applyProject(await plan(config, options), await connect(project));
  /** The project's policies by name, as stored. */
  const stored = async () => {
    const medplum = await connect(project);
    const policies = await medplum.searchResources('AccessPolicy', { _count: '100' });
    return new Map(policies.map((p) => [p.name, p]));
  };

  test('a push from empty creates the policies, tagged with their keys', async () => {
    const first = await plan(CONFIG);
    expect(first.changes.map((c) => [c.kind, c.key])).toEqual([
      ['+', 'clinician'],
      ['+', 'reader'],
    ]);
    expect(await applyProject(first, await connect(project))).toMatchObject({ written: 2 });
    const policies = await stored();
    expect(policies.get('clinician')).toMatchObject({
      resource: [{ resourceType: 'Patient' }, { resourceType: 'Observation' }],
    });
    expect(tagOf(policies.get('clinician') as AccessPolicy)).toBe('clinician');
    expect(tagOf(policies.get('Read only') as AccessPolicy)).toBe('reader');
  });

  test('a second push plans nothing and writes nothing', async () => {
    const before = await stored();
    const second = await plan(CONFIG);
    expect(second).toMatchObject({ changes: [], blocked: [] });
    const after = await stored();
    expect(after.get('clinician')?.meta?.versionId).toBe(before.get('clinician')?.meta?.versionId);
  });

  test('a changed policy is updated in place', async () => {
    const before = (await stored()).get('clinician');
    const changed: ProjectConfig = {
      accessPolicies: {
        ...CONFIG.accessPolicies,
        clinician: { resource: [{ resourceType: 'Patient' }] },
      },
    };
    const planned = await plan(changed);
    expect(planned.changes).toMatchObject([{ kind: '~', key: 'clinician', fields: ['resource'] }]);
    await applyProject(planned, await connect(project));
    const after = (await stored()).get('clinician');
    expect(after?.id).toBe(before?.id);
    expect(after?.resource).toEqual([{ resourceType: 'Patient' }]);
    expect((await plan(changed)).changes).toEqual([]);
    await converge(CONFIG);
  });

  test("an untagged policy with a key's name survives, and --adopt takes it over", async () => {
    const medplum = await connect(project);
    const untagged = await medplum.createResource<AccessPolicy>({
      resourceType: 'AccessPolicy',
      name: 'nurse',
      resource: [{ resourceType: '*' }],
    });
    const config: ProjectConfig = {
      accessPolicies: {
        ...CONFIG.accessPolicies,
        nurse: { resource: [{ resourceType: 'Patient' }] },
      },
    };
    const refused = await plan(config);
    expect(refused.blocked).toEqual([
      {
        code: 'untagged-access-policy',
        message: 'AccessPolicy "nurse" exists untagged; adopt it with --adopt.',
      },
    ]);
    expect((await stored()).get('nurse')?.meta?.versionId).toBe(untagged.meta?.versionId);

    const adopted = await plan(config, { adopt: true });
    expect(adopted.changes).toMatchObject([{ kind: '~', key: 'nurse', adopt: true }]);
    await applyProject(adopted, await connect(project));
    const nurse = (await stored()).get('nurse') as AccessPolicy;
    expect(nurse.id).toBe(untagged.id);
    expect(tagOf(nurse)).toBe('nurse');
    expect(nurse.resource).toEqual([{ resourceType: 'Patient' }]);
    expect((await plan(config)).changes).toEqual([]);
  });

  test('a removed key is kept without --prune and deleted with it', async () => {
    const kept = await plan(CONFIG);
    expect(kept.changes).toEqual([
      { kind: '-', type: 'AccessPolicy', key: 'nurse', id: expect.any(String), kept: true },
    ]);
    expect(await applyProject(kept, await connect(project))).toMatchObject({ written: 0 });
    expect((await stored()).has('nurse')).toBe(true);

    expect(await converge(CONFIG, { prune: true })).toMatchObject({ written: 1 });
    expect((await stored()).has('nurse')).toBe(false);
    expect((await plan(CONFIG, { prune: true })).changes).toEqual([]);
  });

  test("a linked project's tagged policy is neither planned nor touched", async () => {
    const linked = await newProject();
    const theirs = await (await connect(linked)).createResource<AccessPolicy>({
      resourceType: 'AccessPolicy',
      name: 'theirs',
      meta: { tag: [{ system: PLUMB_SYSTEM, code: 'theirs' }] },
    });
    await linkProject(project.projectId, linked.projectId);
    const planned = await plan(CONFIG, { prune: true });
    expect(planned.changes).toEqual([]);
    expect(planned.warnings).toContain('linked projects: 1, not managed');
    const after = await (await connect(linked)).readResource('AccessPolicy', theirs.id as string);
    expect(after.meta?.versionId).toBe(theirs.meta?.versionId);
  });
});

/** Push's options for a project, with the checker bundle built once per file. */
let code: string | undefined;
async function pushOptions(project: TestProject, config: PlumbConfig): Promise<PushOptions> {
  const lockPath = join(mkdtempSync(join(tmpdir(), 'plumb-project-')), 'plumb.lock');
  await fetchPackages({ igs: [], lockPath });
  code ??= (await build({ ...CHECKER_BUILD, write: false })).outputFiles[0]?.text ?? '';
  return {
    config,
    environment: { name: 'test', ...project },
    lockPath,
    checker: { code, version: '0.6.0' },
    reportPath: join(lockPath, '../.plumb/validate-test.json'),
  };
}

describe.skipIf(!server)(
  'push runs the project step once the gate passes',
  { timeout: 60_000 },
  () => {
    test('--dry-run plans the project and writes nothing; a push then writes it', async () => {
      const project = await newProject();
      const options = await pushOptions(project, {
        igs: [],
        profiles: [],
        out: '',
        project: CONFIG,
      });

      const dry = await push({ ...options, dryRun: true });
      expect(dry.ok).toBe(true);
      expect(dry.steps.at(-1)).toMatchObject({
        name: 'project',
        summary: 'plan: 2 to create, 0 to update, 0 to remove',
        warnings: [
          '+ AccessPolicy  clinician',
          '+ AccessPolicy  reader',
          'strictMode on, features: bots',
        ],
      });
      // A fresh login each time, so the second read is not the first one's cache.
      const policies = async () => {
        const medplum = await connect(project);
        return (await medplum.searchResources('AccessPolicy', { _count: '100' })).filter(tagOf);
      };
      expect(await policies()).toEqual([]);

      const wet = await push(options);
      expect(wet.ok).toBe(true);
      expect(wet.steps.at(-1)).toMatchObject({ name: 'project', summary: 'applied 2 changes' });
      expect((await policies()).map(tagOf).sort()).toEqual(['clinician', 'reader']);
    });
  },
);

const PATIENT = 'http://example.org/fhir/plumb-test/StructureDefinition/cardinality-patient';
const SYNTHETIC = join(import.meta.dirname, '../fixtures/profiles/fsh-generated/resources');

describe.skipIf(!server)(
  "push writes the Project's settings, secrets and defaults",
  { timeout: 60_000 },
  () => {
    let project: TestProject;
    let options: PushOptions;
    const SECRET = 'synthetic-secret-value';
    beforeAll(async () => {
      project = await newProject();
      options = await pushOptions(project, {
        igs: [],
        profiles: [PATIENT],
        local: SYNTHETIC,
        out: '',
        defaultProfile: { Patient: [PATIENT] },
        project: {
          settings: { email: 'support@example.org', beta: false, maxUploadMb: 25, ratio: 0.5 },
          secrets: { API_KEY: { env: 'PLUMB_TEST_API_KEY' } },
        },
      });
    }, 60_000);
    const stored = async () => (await connect(project)).readResource('Project', project.projectId);

    test('settings store as their types, the secret is set, and defaultProfile takes effect', async () => {
      const result = await push({ ...options, env: { PLUMB_TEST_API_KEY: SECRET } });
      expect(result.errors).toEqual([]);
      const plan = result.steps.find((s) => s.name === 'project');
      expect(plan?.warnings).toEqual([
        '~ Project  setting email (valueString), setting beta (valueBoolean), setting maxUploadMb (valueInteger), setting ratio (valueDecimal), secret API_KEY (value changed), defaultProfile Patient',
        'strictMode on, features: bots',
      ]);
      // No plan, step or --json output ever holds a secret's value.
      expect(JSON.stringify(result)).not.toContain(SECRET);

      const current = await stored();
      expect(current.setting).toEqual([
        { name: 'email', valueString: 'support@example.org' },
        { name: 'beta', valueBoolean: false },
        { name: 'maxUploadMb', valueInteger: 25 },
        { name: 'ratio', valueDecimal: 0.5 },
      ]);
      expect(current.secret).toEqual([{ name: 'API_KEY', valueString: SECRET }]);
      expect(current.defaultProfile).toEqual([{ resourceType: 'Patient', profile: [PATIENT] }]);

      // A super-admin field is reported from the login, and the write left it as it was.
      const fresh = await connect(project);
      expect(fresh.getProject()?.strictMode).toBe(true);
      // An unstamped write is validated against, and stamped with, the configured default.
      await expect(fresh.createResource({ resourceType: 'Patient' })).rejects.toThrow(
        /name|birthDate/,
      );
      const patient = await fresh.createResource<Patient>({
        resourceType: 'Patient',
        name: [{ family: 'Synthetic' }],
        birthDate: '1990-01-01',
      });
      expect(patient.meta?.profile).toEqual([PATIENT]);
    });

    test('a second push leaves an unchanged secret and the Project alone', async () => {
      const before = await stored();
      const result = await push({ ...options, env: { PLUMB_TEST_API_KEY: SECRET } });
      expect(result.ok).toBe(true);
      expect(result.steps.at(-1)).toMatchObject({
        name: 'project',
        summary: 'plan: 0 to create, 0 to update, 0 to remove',
      });
      expect((await stored()).meta?.versionId).toBe(before.meta?.versionId);
    });

    test('a missing true secret or an unset variable fails the plan and writes nothing', async () => {
      const before = await stored();
      const config = {
        ...options.config,
        project: { secrets: { API_KEY: { env: 'PLUMB_TEST_UNSET' }, BY_HAND: true as const } },
      };
      const result = await push({ ...options, config, env: {} });
      expect(result.ok).toBe(false);
      expect(result.steps.at(-1)).toMatchObject({
        name: 'project',
        failed: true,
        warnings: expect.arrayContaining([
          'PLUMB_TEST_UNSET is not set: it holds secret API_KEY.',
          'secret BY_HAND is not in the project: set it in the console.',
        ]),
      });
      expect((await stored()).meta?.versionId).toBe(before.meta?.versionId);
    });
  },
);

describe.skipIf(!server)('push --check finds drift', { timeout: 60_000 }, () => {
  test('a converged project passes; a hand edit fails it, naming the field, and nothing is written', async () => {
    const project = await newProject();
    const options = await pushOptions(project, {
      igs: [],
      profiles: [PATIENT],
      local: SYNTHETIC,
      out: '',
      project: { ...CONFIG, settings: { email: 'support@example.org' } },
    });
    // Before the first push, everything is drift: the profile and the project.
    const before = await push({ ...options, check: true });
    expect(before.ok).toBe(false);
    expect(before.steps.map((s) => s.name)).toEqual([
      'load',
      'connect',
      'plan',
      'project',
      'check',
    ]);
    expect(before.steps.at(-1)).toMatchObject({
      summary: 'drift: 1 profile, 3 project changes',
      failed: true,
    });

    expect((await push(options)).ok).toBe(true);
    const converged = await push({ ...options, check: true });
    expect(converged.ok).toBe(true);
    expect(converged.steps.at(-1)).toMatchObject({ name: 'check', summary: 'no drift' });

    // Edits made by hand in the console.
    const medplum = await connect(project);
    const policies = await medplum.searchResources('AccessPolicy', { _count: '100' });
    const clinician = policies.find((p) => tagOf(p) === 'clinician') as AccessPolicy;
    await medplum.updateResource({ ...clinician, resource: [{ resourceType: '*' }] });
    const stored = await medplum.readResource('Project', project.projectId);
    await medplum.updateResource({
      ...stored,
      setting: [{ name: 'email', valueString: 'someone@example.org' }],
    });

    const drifted = await push({ ...options, check: true });
    expect(drifted.ok).toBe(false);
    expect(drifted.steps.find((s) => s.name === 'project')?.warnings).toEqual(
      expect.arrayContaining([
        '~ AccessPolicy  clinician (resource)',
        '~ Project  setting email (valueString)',
      ]),
    );
    expect(drifted.steps.at(-1)).toMatchObject({
      summary: 'drift: 2 project changes',
      warnings: ['Run plumb push --env test to converge.'],
      failed: true,
    });
    const after = await (await connect(project)).readResource(
      'AccessPolicy',
      clinician.id as string,
    );
    expect(after.resource).toEqual([{ resourceType: '*' }]);
  });
});
