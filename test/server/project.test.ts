// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccessPolicy, ClientApplication } from '@medplum/fhirtypes';
import { build } from 'esbuild';
import { beforeAll, describe, expect, test } from 'vitest';
import { CHECKER_BUILD } from '../../src/checker/bundle.js';
import type { ProjectConfig } from '../../src/config.js';
import { fetchPackages } from '../../src/packages.js';
import { applyProject, PLUMB_SYSTEM, type ProjectOptions, planProject } from '../../src/project.js';
import { push } from '../../src/push.js';
import { connect, server } from './medplum.js';
import { linkProject, newProject, type TestServer } from './setup.js';

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
  let project: TestServer;
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
      'AccessPolicy "nurse" exists untagged; adopt it with --adopt.',
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

describe.skipIf(!server)(
  'push runs the project step once the gate passes',
  { timeout: 60_000 },
  () => {
    test('--dry-run plans the project and writes nothing; a push then writes it', async () => {
      const project = await newProject();
      const lockPath = join(mkdtempSync(join(tmpdir(), 'plumb-project-')), 'plumb.lock');
      await fetchPackages({ igs: [], lockPath });
      const code = (await build({ ...CHECKER_BUILD, write: false })).outputFiles[0]?.text ?? '';
      const options = {
        config: { igs: [], profiles: [], out: '', project: CONFIG },
        environment: { name: 'test', ...project },
        lockPath,
        checker: { code, version: '0.6.0' },
        reportPath: join(lockPath, '../.plumb/validate-test.json'),
      };

      const dry = await push({ ...options, dryRun: true });
      expect(dry.ok).toBe(true);
      expect(dry.steps.at(-1)).toMatchObject({
        name: 'project',
        summary: 'plan: 2 to create, 0 to update, 0 to remove',
        warnings: ['+ AccessPolicy  clinician', '+ AccessPolicy  reader'],
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
