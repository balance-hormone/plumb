// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type {
  AccessPolicy,
  ClientApplication,
  Project,
  ProjectMembership,
  Resource,
} from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import type { ProjectConfig } from './config.js';
import {
  applyProject,
  claim,
  describeChange,
  type HeldClient,
  PLUMB_SYSTEM,
  type ProjectTarget,
  planClients,
  planFields,
  planPolicies,
  planProject,
  planSummary,
  searchAll,
  withPlumbTag,
} from './project.js';

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
  test('a Bot entry naming bots by key becomes criteria on their identifiers', () => {
    const runner = { resource: [{ resourceType: 'Bot', bots: ['send-reminder', 'intake'] }] };
    const [change] = planPolicies({ accessPolicies: { runner } }, []).changes;
    expect(change).toMatchObject({
      resource: {
        resource: [
          {
            resourceType: 'Bot',
            criteria: `Bot?identifier=${PLUMB_SYSTEM}|send-reminder,${PLUMB_SYSTEM}|intake`,
          },
        ],
      },
    });
    const held = (change as { resource: AccessPolicy }).resource;
    expect(planPolicies({ accessPolicies: { runner } }, [{ ...held, id: 'a' }]).changes).toEqual(
      [],
    );
  });

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
      policyIds: {},
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
        meta: { project: PROJECT_ID, versionId: '1', tag: [other, tag('clinician')] },
      },
    });
    expect(change && describeChange(change)).toBe(
      '~ AccessPolicy  clinician (ipAccessRule, resource)',
    );
  });

  test('keeps a hand-set meta.security on update', () => {
    const security = [{ system: 'http://example.org/security', code: 'restricted' }];
    const current = { ...CLINICIAN, meta: { ...CLINICIAN.meta, security } };
    const config: ProjectConfig = { accessPolicies: { clinician: { resource: [] } } };
    const [change] = planPolicies(config, [current]).changes;
    expect(change).toMatchObject({ resource: { meta: { security, tag: [tag('clinician')] } } });
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
      blocked: [
        {
          code: 'untagged-access-policy',
          message: 'AccessPolicy "clinician" exists untagged; adopt it with --adopt.',
        },
      ],
      warnings: [],
      policyIds: {},
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
      {
        code: 'shadowed-access-policy',
        message:
          'AccessPolicy "clinician": 2 resources carry its tag; delete all but one, then push again.',
      },
    ]);
    const untagged = held('u', { name: 'clinician' });
    const ambiguous = planPolicies(CONFIG, [untagged, { ...untagged, id: 'u2' }, CI_DEPLOY], {
      adopt: true,
    });
    expect(ambiguous.blocked).toEqual([
      {
        code: 'untagged-access-policy',
        message:
          'AccessPolicy "clinician" exists 2 times untagged; delete all but one, then adopt it with --adopt.',
      },
    ]);
  });
});

describe('claim', () => {
  test('names why a key is blocked: shadowed-<kind> or untagged-<kind>, the type by default', () => {
    const blocked = (found: number, untagged: number, kind?: string) => {
      const [tagged, bare] = [Array(found).fill({}), Array(untagged).fill({})];
      const claimed = claim('ValueSet', 'k', 'k', tagged, bare, {}, kind);
      return 'code' in claimed ? claimed.code : undefined;
    };
    expect(blocked(2, 0)).toBe('shadowed-value-set');
    expect(blocked(0, 1)).toBe('untagged-value-set');
    expect(blocked(0, 2)).toBe('untagged-value-set');
    expect(blocked(2, 0, 'content')).toBe('shadowed-content');
    expect(blocked(0, 1, 'content')).toBe('untagged-content');
    expect(blocked(1, 0)).toBeUndefined();
  });
});

describe('planClients', () => {
  const client = (
    id: string,
    name: string,
    membership: Partial<ProjectMembership>,
    key?: string,
  ): HeldClient => ({
    client: {
      resourceType: 'ClientApplication',
      id,
      name,
      ...(key ? { meta: { tag: [tag(key)] } } : {}),
    },
    membership: {
      resourceType: 'ProjectMembership',
      id: `m-${id}`,
      project: { reference: `Project/${PROJECT_ID}` },
      user: { reference: `ClientApplication/${id}` },
      profile: { reference: `ClientApplication/${id}` },
      ...membership,
    },
  });
  const CLIENTS: ProjectConfig = {
    clients: { ci: { accessPolicy: 'deploy', admin: true }, app: {} },
  };

  test('creates each client with its policy key and admin', () => {
    const plan = planClients(CLIENTS, [], {});
    expect(plan.changes).toEqual([
      { kind: '+', type: 'ClientApplication', key: 'ci', accessPolicy: 'deploy', admin: true },
      { kind: '+', type: 'ClientApplication', key: 'app', admin: false },
    ]);
    expect(plan.changes.map(describeChange)).toEqual([
      '+ ClientApplication  ci',
      '+ ClientApplication  app',
    ]);
  });

  test('plans nothing for clients whose names and memberships match', () => {
    const held = [
      client('c', 'ci', { admin: true, accessPolicy: { reference: 'AccessPolicy/p' } }, 'ci'),
      client('a', 'app', {}, 'app'),
    ];
    expect(planClients(CLIENTS, held, { deploy: 'p' })).toEqual({ changes: [], blocked: [] });
  });

  test("updates a renamed client, and its membership's policy and admin, in place", () => {
    const held = [
      client('c', 'renamed', { admin: false }, 'ci'),
      client('a', 'app', { admin: true }, 'app'),
    ];
    const plan = planClients(CLIENTS, held, { deploy: 'p' });
    expect(plan.changes).toEqual([
      {
        kind: '~',
        type: 'ClientApplication',
        key: 'ci',
        id: 'c',
        membership: 'm-c',
        fields: ['name', 'accessPolicy', 'admin'],
        accessPolicy: 'deploy',
        admin: true,
      },
      {
        kind: '~',
        type: 'ClientApplication',
        key: 'app',
        id: 'a',
        membership: 'm-a',
        fields: ['admin'],
        admin: false,
      },
    ]);
    // A policy this plan creates has no id yet, so the membership is always set.
    expect(planClients(CLIENTS, [held[0] as HeldClient], {}).changes[0]).toMatchObject({
      fields: ['name', 'accessPolicy', 'admin'],
    });
  });

  test('blocks a tagged client without a membership', () => {
    const { client: orphan } = client('o', 'app', {}, 'app');
    expect(planClients(CLIENTS, [{ client: orphan }], {}).blocked).toEqual([
      {
        code: 'client-without-membership',
        message: 'ClientApplication "app" has no ProjectMembership; delete it, then push again.',
      },
    ]);
  });

  test('adopts an untagged client only with adopt, and prunes a removed key with its membership', () => {
    const untagged = client('u', 'app', {});
    expect(planClients(CLIENTS, [untagged], {}).blocked).toEqual([
      {
        code: 'untagged-client-application',
        message: 'ClientApplication "app" exists untagged; adopt it with --adopt.',
      },
    ]);
    expect(planClients(CLIENTS, [untagged], {}, { adopt: true }).changes).toContainEqual(
      expect.objectContaining({ kind: '~', key: 'app', id: 'u', fields: [], adopt: true }),
    );
    const removed = client('r', 'old', {}, 'old');
    expect(planClients(CLIENTS, [removed], {}).changes).toContainEqual({
      kind: '-',
      type: 'ClientApplication',
      key: 'old',
      id: 'r',
      membership: 'm-r',
      kept: true,
    });
    expect(planClients(CLIENTS, [removed], {}, { prune: true }).changes).toContainEqual({
      kind: '-',
      type: 'ClientApplication',
      key: 'old',
      id: 'r',
      membership: 'm-r',
    });
  });
});

describe('applyProject', () => {
  test("keeps a renamed client's hand-set meta.security", async () => {
    const security = [{ system: 'http://example.org/security', code: 'restricted' }];
    const client: ClientApplication = {
      resourceType: 'ClientApplication',
      id: 'c1',
      name: 'old',
      meta: { project: PROJECT_ID, security },
    };
    const written: Resource[] = [];
    const medplum = {
      readResource: async () => client,
      updateResource: async (r: Resource) => written.push(r) && r,
    } as unknown as MedplumClient;
    const change = { kind: '~', type: 'ClientApplication', key: 'ci', id: 'c1' } as const;
    const plan = { blocked: [], warnings: [], policyIds: {} };
    const changes = [{ ...change, membership: 'm1', fields: ['name'], admin: false }];
    await applyProject({ ...plan, changes }, medplum);
    expect(written).toEqual([
      { ...client, name: 'ci', meta: { project: PROJECT_ID, security, tag: [tag('ci')] } },
    ]);
  });
});

describe('planFields', () => {
  const PROJECT: Project = {
    resourceType: 'Project',
    id: PROJECT_ID,
    setting: [{ name: 'kept', valueString: 'set by hand' }],
    secret: [
      { name: 'API_KEY', valueString: 'old' },
      { name: 'BY_HAND', valueString: 'x' },
    ],
  };
  const fields = (target: ProjectTarget, env: Record<string, string> = {}, ids = {}) =>
    planFields(target, PROJECT, ids, { env });

  test('types each setting by its value, and leaves settings it does not name', () => {
    const plan = fields({ settings: { email: 'a@example.org', beta: false, max: 25, ratio: 0.5 } });
    expect(plan.changes).toEqual([
      {
        kind: '~',
        type: 'Project',
        key: 'project',
        id: PROJECT_ID,
        fields: [
          'setting email (valueString)',
          'setting beta (valueBoolean)',
          'setting max (valueInteger)',
          'setting ratio (valueDecimal)',
        ],
        write: {
          setting: [
            { name: 'email', valueString: 'a@example.org' },
            { name: 'beta', valueBoolean: false },
            { name: 'max', valueInteger: 25 },
            { name: 'ratio', valueDecimal: 0.5 },
          ],
        },
      },
    ]);
    expect(fields({ settings: { kept: 'set by hand' } }).changes).toEqual([]);
  });

  test('sets an { env } secret that differs, naming the variable and never the value', () => {
    const plan = fields({ secrets: { API_KEY: { env: 'API_KEY_VAR' } } }, { API_KEY_VAR: 'new' });
    expect(plan.changes).toMatchObject([
      {
        fields: ['secret API_KEY (value changed)'],
        write: { secret: [{ name: 'API_KEY', env: 'API_KEY_VAR' }] },
      },
    ]);
    expect(JSON.stringify(plan)).not.toContain('new"');
    expect(fields({ secrets: { API_KEY: { env: 'V' } } }, { V: 'old' }).changes).toEqual([]);
  });

  test('an unset variable leaves a held secret alone, and blocks only when it is missing', () => {
    const plan = fields({ secrets: { API_KEY: { env: 'UNSET' }, NEW: { env: 'UNSET_TOO' } } });
    expect(plan).toEqual({
      changes: [],
      blocked: [{ code: 'unset-variable', message: 'UNSET_TOO is not set: it holds secret NEW.' }],
      warnings: ['secret API_KEY not compared: UNSET is not set.'],
    });
  });

  test('blocks on a missing true secret, and never changes a true one', () => {
    const plan = fields({ secrets: { BY_HAND: true, MISSING: true } });
    expect(plan).toEqual({
      changes: [],
      blocked: [
        {
          code: 'missing-secret',
          message: 'secret MISSING is not in the project: set it in the console.',
        },
      ],
      warnings: [],
    });
  });

  test('a held secret scoped to other environments is reported, and removed only with --prune', () => {
    const kept = planFields({}, PROJECT, {}, { outOfScopeSecrets: ['API_KEY', 'NOT_HELD'] });
    expect(kept).toEqual({
      changes: [],
      blocked: [],
      warnings: ['secret API_KEY is held but scoped to other environments; --prune removes it.'],
    });
    const pruned = planFields(
      {},
      PROJECT,
      {},
      { outOfScopeSecrets: ['API_KEY', 'NOT_HELD'], prune: true },
    );
    expect(pruned.changes).toMatchObject([
      {
        fields: ['secret API_KEY (not in this environment)'],
        write: { removeSecret: ['API_KEY'] },
      },
    ]);
  });

  test('writes defaultProfile and defaultAccessPolicies whole, naming what changed', () => {
    const plan = fields(
      {
        defaultProfile: { Patient: ['http://example.org/p'] },
        defaultAccessPolicies: [
          { profileType: 'Practitioner', accessPolicy: 'clinician' },
          { profileType: 'Patient', accessPolicy: 'portal' },
        ],
      },
      {},
      { clinician: 'a' },
    );
    expect(plan.changes[0]).toMatchObject({
      fields: ['defaultProfile Patient', 'defaultAccessPolicies Practitioner, Patient'],
      write: { defaultProfile: [{ resourceType: 'Patient', profile: ['http://example.org/p'] }] },
    });
    const current = {
      ...PROJECT,
      defaultProfile: [{ resourceType: 'Patient' as const, profile: ['http://example.org/p'] }],
      defaultAccessPolicies: [
        { profileType: 'Practitioner' as const, accessPolicy: { reference: 'AccessPolicy/a' } },
      ],
    };
    const same = planFields(
      {
        defaultProfile: { Patient: ['http://example.org/p'] },
        defaultAccessPolicies: [{ profileType: 'Practitioner', accessPolicy: 'clinician' }],
      },
      current,
      { clinician: 'a' },
      {},
    );
    expect(same.changes).toEqual([]);
    // A policy this plan creates has no id yet.
    expect(
      planFields(
        { defaultAccessPolicies: [{ profileType: 'Practitioner', accessPolicy: 'clinician' }] },
        current,
        {},
        {},
      ).changes[0],
    ).toMatchObject({ fields: ['defaultAccessPolicies Practitioner'] });
  });
});

describe('planProject', () => {
  /** Just what planProject reads of a logged-in client. */
  const client = (
    policies: AccessPolicy[],
    { link = 0, accessPolicy }: { link?: number; accessPolicy?: string } = {},
  ) =>
    ({
      getProject: () => ({ resourceType: 'Project', id: PROJECT_ID, strictMode: true }),
      readResource: async () => ({
        resourceType: 'Project',
        id: PROJECT_ID,
        features: ['bots'],
        link: Array.from({ length: link }, (_, i) => ({ project: { reference: `Project/l${i}` } })),
      }),
      getProjectMembership: () => ({
        resourceType: 'ProjectMembership',
        ...(accessPolicy ? { accessPolicy: { reference: `AccessPolicy/${accessPolicy}` } } : {}),
      }),
      async *searchResourcePages(type: string) {
        yield type === 'AccessPolicy' ? policies : [];
      },
    }) as unknown as MedplumClient;

  test("plans only the project's own policies, and reports its links once", async () => {
    // A linked project's policy can carry Plumb's tag too: it is not this project's to write.
    const linked = held('l', { name: 'old', meta: { tag: [tag('old')] } }, 'linked');
    const plan = await planProject(CONFIG, client([CLINICIAN, CI_DEPLOY, linked], { link: 2 }));
    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([
      'strictMode on, features: bots',
      '"ci-deploy" writes StructureDefinition, which bypasses push\'s profile gate.',
      'linked projects: 2, not managed',
    ]);
  });

  test("does not warn that push's own policy writes StructureDefinition", async () => {
    const plan = await planProject(CONFIG, client([CLINICIAN, CI_DEPLOY], { accessPolicy: 'b' }));
    expect(plan.warnings).toEqual(['strictMode on, features: bots']);
  });
});

describe('withPlumbTag', () => {
  const other = { system: 'http://example.org/tags', code: 'reviewed' };
  const security = [{ system: 'http://example.org/security', code: 'restricted' }];
  const desired: AccessPolicy = { resourceType: 'AccessPolicy', name: 'clinician' };

  test('a new resource carries only its own meta and the tag', () => {
    expect(withPlumbTag({ ...desired, meta: { tag: [other] } }, 'clinician')).toEqual({
      ...desired,
      meta: { tag: [other, tag('clinician')] },
    });
  });

  test("keeps the server copy's meta and id, less its old Plumb tag", () => {
    const current = held('a', { meta: { security, tag: [other, tag('old')] } });
    expect(withPlumbTag(desired, 'clinician', current)).toEqual({
      ...desired,
      id: 'a',
      meta: { project: PROJECT_ID, versionId: '1', security, tag: [other, tag('clinician')] },
    });
  });

  test("merges the desired meta over the server copy's, listing a tag both carry once", () => {
    const current = held('a', { meta: { profile: ['http://example.org/old'], tag: [other] } });
    const merged = withPlumbTag(
      { ...desired, meta: { profile: ['http://example.org/new'], tag: [other] } },
      'clinician',
      current,
    );
    expect(merged.meta).toEqual({
      project: PROJECT_ID,
      versionId: '1',
      profile: ['http://example.org/new'],
      tag: [other, tag('clinician')],
    });
  });
});

describe('searchAll', () => {
  test('reads every page, so a resource past the first is found', async () => {
    const page = (ids: string[]) => ids.map((id) => ({ resourceType: 'Subscription', id }));
    const medplum = {
      async *searchResourcePages() {
        yield page(['a', 'b']);
        yield page(['c']);
      },
    } as unknown as MedplumClient;
    const found = await searchAll(medplum, 'Subscription', {});
    expect(found.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});
