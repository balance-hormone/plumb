// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { AccessPolicy } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import type { ProjectConfig } from './config.js';
import { describeChange, PLUMB_SYSTEM, planPolicies, planProject, planSummary } from './project.js';

const PROJECT_ID = 'p1';
const tag = (code: string) => ({ system: PLUMB_SYSTEM, code });
const held = (id: string, fields: Partial<AccessPolicy>, project = PROJECT_ID): AccessPolicy => ({
  resourceType: 'AccessPolicy',
  id,
  ...fields,
  meta: { project, versionId: '1', ...fields.meta },
});

const CONFIG: ProjectConfig = {
  accessPolicies: {
    clinician: { resource: [{ resourceType: 'Patient' }] },
    'ci-deploy': { name: 'CI deploy', resource: [{ resourceType: 'StructureDefinition' }] },
  },
};
const CLINICIAN = held('a', {
  name: 'clinician',
  resource: [{ resourceType: 'Patient' }],
  meta: { tag: [tag('clinician')] },
});
const CI_DEPLOY = held('b', {
  name: 'CI deploy',
  resource: [{ resourceType: 'StructureDefinition' }],
  meta: { tag: [tag('ci-deploy')] },
});

describe('planPolicies', () => {
  test('creates each policy from empty, tagged with its key and named by it unless given', () => {
    const plan = planPolicies(CONFIG, []);
    expect(plan).toEqual({
      changes: [
        {
          kind: '+',
          type: 'AccessPolicy',
          key: 'clinician',
          resource: {
            resourceType: 'AccessPolicy',
            name: 'clinician',
            resource: [{ resourceType: 'Patient' }],
            meta: { tag: [tag('clinician')] },
          },
        },
        expect.objectContaining({ kind: '+', key: 'ci-deploy' }),
      ],
      blocked: [],
      warnings: [],
    });
    expect(plan.changes.map(describeChange)).toEqual([
      '+ AccessPolicy  clinician',
      '+ AccessPolicy  ci-deploy',
    ]);
    expect(planSummary(plan)).toBe('plan: 2 to create, 0 to update, 0 to remove');
  });

  test('plans nothing for a project that matches', () => {
    expect(planPolicies(CONFIG, [CLINICIAN, CI_DEPLOY]).changes).toEqual([]);
  });

  test('updates a changed policy in place, naming the fields and keeping other tags', () => {
    const other = { system: 'http://example.org/tags', code: 'reviewed' };
    const current = { ...CLINICIAN, meta: { ...CLINICIAN.meta, tag: [other, tag('clinician')] } };
    const config: ProjectConfig = {
      accessPolicies: {
        clinician: {
          resource: [{ resourceType: 'Patient', readonly: true }],
          ipAccessRule: [{ value: '10.0.0.0/8', action: 'allow' }],
        },
      },
    };
    const [change] = planPolicies(config, [current]).changes;
    expect(change).toEqual({
      kind: '~',
      type: 'AccessPolicy',
      key: 'clinician',
      id: 'a',
      fields: ['ipAccessRule', 'resource'],
      resource: {
        resourceType: 'AccessPolicy',
        id: 'a',
        name: 'clinician',
        resource: [{ resourceType: 'Patient', readonly: true }],
        ipAccessRule: [{ value: '10.0.0.0/8', action: 'allow' }],
        meta: { tag: [other, tag('clinician')] },
      },
    });
    expect(change && describeChange(change)).toBe(
      '~ AccessPolicy  clinician (ipAccessRule, resource)',
    );
  });

  test('lists a tagged policy whose key left the config, and removes it only with prune', () => {
    const config: ProjectConfig = {
      accessPolicies: { clinician: CONFIG.accessPolicies?.clinician ?? {} },
    };
    const kept = planPolicies(config, [CLINICIAN, CI_DEPLOY]);
    expect(kept.changes).toEqual([
      { kind: '-', type: 'AccessPolicy', key: 'ci-deploy', id: 'b', kept: true },
    ]);
    expect(kept.changes.map(describeChange)).toEqual([
      '- AccessPolicy  ci-deploy (kept: pass --prune to delete)',
    ]);
    expect(planSummary(kept)).toBe('plan: 0 to create, 0 to update, 0 to remove');
    const pruned = planPolicies(config, [CLINICIAN, CI_DEPLOY], { prune: true });
    expect(pruned.changes).toEqual([
      { kind: '-', type: 'AccessPolicy', key: 'ci-deploy', id: 'b' },
    ]);
    expect(planSummary(pruned)).toBe('plan: 0 to create, 0 to update, 1 to remove');
  });

  test("never touches an untagged policy with a key's name, unless adopted", () => {
    const untagged = held('u', { name: 'clinician', resource: [{ resourceType: '*' }] });
    const config: ProjectConfig = {
      accessPolicies: { clinician: CONFIG.accessPolicies?.clinician ?? {} },
    };
    const refused = planPolicies(config, [untagged]);
    expect(refused).toEqual({
      changes: [],
      blocked: ['AccessPolicy "clinician" exists untagged; adopt it with --adopt.'],
      warnings: [],
    });
    expect(planSummary(refused)).toBe('refusing: see below');

    const [adopted] = planPolicies(config, [untagged], { adopt: true }).changes;
    expect(adopted).toMatchObject({
      kind: '~',
      id: 'u',
      fields: ['resource'],
      adopt: true,
      resource: { id: 'u', meta: { tag: [tag('clinician')] } },
    });
    expect(adopted && describeChange(adopted)).toBe(
      '~ AccessPolicy  clinician (adopted; resource)',
    );
  });

  test('refuses two resources with one tag, or two untagged with one name', () => {
    const twice = planPolicies(CONFIG, [CLINICIAN, { ...CLINICIAN, id: 'a2' }, CI_DEPLOY]);
    expect(twice.blocked).toEqual([
      'AccessPolicy "clinician": 2 resources carry its tag; delete all but one, then push again.',
    ]);
    const untagged = held('u', { name: 'clinician' });
    const ambiguous = planPolicies(CONFIG, [untagged, { ...untagged, id: 'u2' }, CI_DEPLOY], {
      adopt: true,
    });
    expect(ambiguous.blocked).toEqual([
      'AccessPolicy "clinician" exists 2 times untagged; delete all but one, then adopt it with --adopt.',
    ]);
  });
});

describe('planProject', () => {
  /** Just what planProject reads of a logged-in client. */
  const client = (
    policies: AccessPolicy[],
    { link = 0, accessPolicy }: { link?: number; accessPolicy?: string } = {},
  ) =>
    ({
      getProject: () => ({ resourceType: 'Project', id: PROJECT_ID }),
      readResource: async () => ({
        resourceType: 'Project',
        id: PROJECT_ID,
        link: Array.from({ length: link }, (_, i) => ({ project: { reference: `Project/l${i}` } })),
      }),
      getProjectMembership: () => ({
        resourceType: 'ProjectMembership',
        ...(accessPolicy ? { accessPolicy: { reference: `AccessPolicy/${accessPolicy}` } } : {}),
      }),
      async *searchResourcePages() {
        yield policies;
      },
    }) as unknown as MedplumClient;

  test("plans only the project's own policies, and reports its links once", async () => {
    // A linked project's policy can carry Plumb's tag too: it is not this project's to write.
    const linked = held('l', { name: 'old', meta: { tag: [tag('old')] } }, 'linked');
    const plan = await planProject(CONFIG, client([CLINICIAN, CI_DEPLOY, linked], { link: 2 }));
    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([
      '"ci-deploy" writes StructureDefinition, which bypasses push\'s profile gate.',
      'linked projects: 2, not managed',
    ]);
  });

  test("does not warn that push's own policy writes StructureDefinition", async () => {
    const plan = await planProject(CONFIG, client([CLINICIAN, CI_DEPLOY], { accessPolicy: 'b' }));
    expect(plan.warnings).toEqual([]);
  });
});
