// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { deepEquals, type MedplumClient } from '@medplum/core';
import type {
  AccessPolicy,
  AccessPolicyResource,
  ClientApplication,
  Project,
  ProjectDefaultProfile,
  ProjectMembership,
  ProjectSetting,
  Reference,
  Resource,
} from '@medplum/fhirtypes';
import {
  type AccessPolicyEntry,
  lockdownWarnings,
  type PlumbConfig,
  type ProjectConfig,
} from './config.js';

/**
 * The `meta.tag` system of what `push` manages, with the config key as code,
 * and the checker bot's identifier system: one URL the package name keeps stable.
 */
export const PLUMB_SYSTEM = 'https://www.npmjs.com/package/plumb-fhir';

/** One write `push` plans in the project: `+` create, `~` update, `-` remove. */
export type ProjectChange =
  | { kind: '+'; type: 'AccessPolicy'; key: string; resource: AccessPolicy }
  | {
      kind: '~';
      type: 'AccessPolicy';
      key: string;
      id: string;
      /** The top-level fields that differ from the config. */
      fields: string[];
      /** An untagged resource, tagged and taken over with `--adopt`. */
      adopt?: true;
      resource: AccessPolicy;
    }
  | {
      kind: '+';
      type: 'ClientApplication';
      key: string;
      /** The key of the membership's policy. */
      accessPolicy?: string;
      admin: boolean;
    }
  | {
      kind: '~';
      type: 'ClientApplication';
      key: string;
      id: string;
      membership: string;
      /** `name`, and the membership's `accessPolicy` and `admin`, where they differ. */
      fields: string[];
      adopt?: true;
      accessPolicy?: string;
      admin: boolean;
    }
  | {
      kind: '~';
      type: 'Project';
      key: 'project';
      id: string;
      /** Each setting, secret and default that differs, as the plan prints it. */
      fields: string[];
      write: ProjectWrite;
    }
  | {
      kind: '-';
      type: 'AccessPolicy' | 'ClientApplication';
      key: string;
      id: string;
      /** A client's membership, deleted with it. */
      membership?: string;
      /** Listed but not deleted, without `--prune`. */
      kept?: true;
    };

/**
 * What `push` will write. It holds no resource a secret could be read from:
 * a client is planned by its ids, and read again when it is written.
 */
export interface ProjectPlan {
  changes: ProjectChange[];
  /** Why nothing in the project can be applied. */
  blocked: string[];
  warnings: string[];
  /** The ids of the policies the project already holds, by key, for clients to reference. */
  policyIds: Record<string, string>;
}

/**
 * The Project fields `push` writes, each only when it differs. A secret is
 * named with the variable that holds it, never its value.
 */
interface ProjectWrite {
  setting?: ProjectSetting[];
  secret?: { name: string; env: string }[];
  defaultProfile?: ProjectDefaultProfile[];
  /** Each role's policy, by key. */
  defaultAccessPolicies?: ProjectConfig['defaultAccessPolicies'];
}

type Role = NonNullable<ProjectConfig['defaultAccessPolicies']>[number]['profileType'];

/** What the project step plans from: `project`, with the environment's settings, and v0.3's `defaultProfile`. */
export type ProjectTarget = ProjectConfig & Pick<PlumbConfig, 'defaultProfile'>;

// @medplum/fhirtypes 5.1.0 has no defaultAccessPolicies on Project.
type ProjectFields = Project & {
  defaultAccessPolicies?: { profileType: Role; accessPolicy: Reference<AccessPolicy> }[];
};

/** A client the project holds, with the membership that carries its access. */
export interface HeldClient {
  client: ClientApplication;
  membership?: ProjectMembership;
}

export interface ProjectOptions {
  /** Tag and converge an untagged resource with a key's name. */
  adopt?: boolean;
  /** Delete a tagged resource whose key left the config. */
  prune?: boolean;
  /** Where `{ env }` secrets are read from. */
  env?: Record<string, string | undefined>;
}

/**
 * Plans the project's AccessPolicies, clients and own fields against the
 * config. Only the target project's own resources are read: a linked
 * project's are not this one's to write, even when they carry Plumb's tag.
 */
export async function planProject(
  project: ProjectTarget,
  medplum: MedplumClient,
  options: ProjectOptions = {},
): Promise<ProjectPlan> {
  // The login's copy of the project leaves out its links, so it is read whole.
  const current = await medplum.readResource('Project', medplum.getProject()?.id as string);
  const ours = <R extends AccessPolicy | ClientApplication>(page: R[]) =>
    page.filter((r) => r.meta?.project === current.id);
  // Every resource of a type, not a search by tag: a removed key and an untagged name are found in one read.
  const held: AccessPolicy[] = [];
  for await (const page of medplum.searchResourcePages('AccessPolicy', { _count: '1000' })) {
    held.push(...ours(page));
  }
  const apps: ClientApplication[] = [];
  for await (const page of medplum.searchResourcePages('ClientApplication', { _count: '1000' })) {
    apps.push(...ours(page));
  }
  const plan = planPolicies(project, held, options);
  const clients = await withMemberships(medplum, apps, Object.keys(project.clients ?? {}));
  const planned = planClients(project, clients, plan.policyIds, options);
  const fields = planFields(project, current, plan.policyIds, options.env ?? {});
  // Policies first, which clients and the Project reference; removals last, clients before the policies they use.
  const removal = (c: ProjectChange) => c.kind === '-';
  plan.changes = [
    ...plan.changes.filter((c) => !removal(c)),
    ...planned.changes.filter((c) => !removal(c)),
    ...fields.changes,
    ...planned.changes.filter(removal),
    ...plan.changes.filter(removal),
  ];
  plan.blocked.push(...planned.blocked, ...fields.blocked);
  // Only a super admin can change these, so they are reported, never written. A Project read
  // hides strictMode from an admin, and the login's copy leaves out features.
  const strict = medplum.getProject()?.strictMode;
  plan.warnings.push(
    `strictMode ${strict ? 'on' : 'off; only a super admin can turn it on'}, features: ${current.features?.join(', ') || 'none'}`,
  );
  const own = medplum.getProjectMembership()?.accessPolicy?.reference;
  const ownKey = held.find((p) => own === `AccessPolicy/${p.id}`);
  plan.warnings.push(...lockdownWarnings(project, ownKey && tagOf(ownKey)).map((w) => w.message));
  const links = current.link?.length ?? 0;
  if (links > 0) plan.warnings.push(`linked projects: ${links}, not managed`);
  return plan;
}

/** A setting's type follows its value: the four a ProjectSetting holds. */
function toSetting(name: string, value: string | boolean | number): ProjectSetting {
  if (typeof value === 'string') return { name, valueString: value };
  if (typeof value === 'boolean') return { name, valueBoolean: value };
  return Number.isInteger(value) ? { name, valueInteger: value } : { name, valueDecimal: value };
}

const valueType = (setting: ProjectSetting) => Object.keys(setting).find((k) => k !== 'name');

/**
 * The Project's settings, secrets and defaults against the config, as one
 * update. Settings and secrets the config does not name are left alone: a
 * ProjectSetting has no tag to tell one Plumb set from one set by hand.
 */
export function planFields(
  project: ProjectTarget,
  current: ProjectFields,
  policyIds: Record<string, string>,
  env: Record<string, string | undefined>,
): Pick<ProjectPlan, 'changes' | 'blocked'> {
  const parts = [
    planSettings(project, current),
    planSecrets(project, current, env),
    planDefaults(project, current, policyIds),
  ];
  const write: ProjectWrite = Object.assign({}, ...parts.map((p) => p.write));
  const fields = parts.flatMap((p) => p.fields);
  const blocked = parts.flatMap((p) => p.blocked ?? []);
  if (fields.length === 0) return { changes: [], blocked };
  const id = current.id as string;
  return { changes: [{ kind: '~', type: 'Project', key: 'project', id, fields, write }], blocked };
}

interface FieldPlan {
  write: ProjectWrite;
  fields: string[];
  blocked?: string[];
}

function planSettings(project: ProjectTarget, current: ProjectFields): FieldPlan {
  const setting = Object.entries(project.settings ?? {})
    .map(([name, value]) => toSetting(name, value))
    .filter(
      (s) =>
        !deepEquals(
          s,
          current.setting?.find((h) => h.name === s.name),
        ),
    );
  return {
    write: setting.length > 0 ? { setting } : {},
    fields: setting.map((s) => `setting ${s.name} (${valueType(s)})`),
  };
}

/** `true` must exist and is never changed; `{ env }` is set from its variable when it differs. */
function planSecrets(
  project: ProjectTarget,
  current: ProjectFields,
  env: Record<string, string | undefined>,
): FieldPlan {
  const secret: NonNullable<ProjectWrite['secret']> = [];
  const blocked: string[] = [];
  for (const [name, source] of Object.entries(project.secrets ?? {})) {
    const held = current.secret?.find((s) => s.name === name);
    if (source === true) {
      if (!held) blocked.push(`secret ${name} is not in the project: set it in the console.`);
    } else if (!env[source.env]) {
      blocked.push(`${source.env} is not set: it holds secret ${name}.`);
    } else if (held?.valueString !== env[source.env]) {
      secret.push({ name, env: source.env });
    }
  }
  return {
    write: secret.length > 0 ? { secret } : {},
    fields: secret.map((s) => `secret ${s.name} (value changed)`),
    blocked,
  };
}

/** Each default, when the config declares it, is the whole field. */
function planDefaults(
  project: ProjectTarget,
  current: ProjectFields,
  policyIds: Record<string, string>,
): FieldPlan {
  const plan: FieldPlan = { write: {}, fields: [] };
  if (project.defaultProfile) {
    const desired = Object.entries(project.defaultProfile).map(([resourceType, profile]) => ({
      resourceType,
      profile,
    })) as ProjectDefaultProfile[];
    const types = changedKeys(
      desired.map((d) => [d.resourceType, d.profile]),
      (current.defaultProfile ?? []).map((d) => [d.resourceType, d.profile]),
    );
    if (types.length > 0) {
      plan.write.defaultProfile = desired;
      plan.fields.push(`defaultProfile ${types.join(', ')}`);
    }
  }
  if (project.defaultAccessPolicies) {
    // A policy this plan creates has no id yet, so a role naming it always changes.
    const ref = (key: string) => (policyIds[key] ? `AccessPolicy/${policyIds[key]}` : `new ${key}`);
    const roles = changedKeys(
      project.defaultAccessPolicies.map((d) => [d.profileType, ref(d.accessPolicy)]),
      (current.defaultAccessPolicies ?? []).map((d) => [d.profileType, d.accessPolicy.reference]),
    );
    if (roles.length > 0) {
      plan.write.defaultAccessPolicies = project.defaultAccessPolicies;
      plan.fields.push(`defaultAccessPolicies ${roles.join(', ')}`);
    }
  }
  return plan;
}

/** The keys whose values differ between two lists of entries, either way round. */
function changedKeys(desired: [string, unknown][], current: [string, unknown][]): string[] {
  const want = new Map(desired);
  const have = new Map(current);
  return [...new Set([...want.keys(), ...have.keys()])].filter(
    (k) => !deepEquals(want.get(k), have.get(k)),
  );
}

/** The clients Plumb could manage, tagged or named by a key, each with its membership. */
async function withMemberships(
  medplum: MedplumClient,
  apps: ClientApplication[],
  keys: string[],
): Promise<HeldClient[]> {
  const clients: HeldClient[] = [];
  for (const client of apps) {
    if (tagOf(client) === undefined && !keys.includes(client.name ?? '')) continue;
    const membership = await medplum.searchOne('ProjectMembership', {
      profile: `ClientApplication/${client.id}`,
    });
    clients.push({ client, ...(membership ? { membership } : {}) });
  }
  return clients;
}

export const tagOf = (resource: Resource) =>
  resource.meta?.tag?.find((t) => t.system === PLUMB_SYSTEM)?.code;

/** The plan for the policies a project holds, found by Plumb's tag and never by id. */
export function planPolicies(
  project: ProjectConfig,
  held: AccessPolicy[],
  options: ProjectOptions = {},
): ProjectPlan {
  const plan: ProjectPlan = { changes: [], blocked: [], warnings: [], policyIds: {} };
  const policies = project.accessPolicies ?? {};
  const type = 'AccessPolicy' as const;
  const tagged = Map.groupBy(
    held.filter((p) => tagOf(p) !== undefined),
    (p) => tagOf(p) as string,
  );
  for (const [key, config] of Object.entries(policies)) {
    const desired: AccessPolicy = {
      resourceType: 'AccessPolicy',
      ...config,
      ...(config.resource ? { resource: config.resource.map(botCriteria) } : {}),
      name: config.name ?? key,
    };
    const untagged = held.filter((p) => tagOf(p) === undefined && p.name === desired.name);
    const claimed = claim(
      type,
      key,
      desired.name as string,
      tagged.get(key) ?? [],
      untagged,
      options,
    );
    if (typeof claimed === 'string') {
      plan.blocked.push(claimed);
      continue;
    }
    if (claimed.current) plan.policyIds[key] = claimed.current.id as string;
    const planned = planPolicy(key, desired, claimed);
    if (planned) plan.changes.push(planned);
  }
  // A tagged policy whose key left the config is listed, and deleted only with --prune.
  const kept = options.prune ? {} : { kept: true as const };
  plan.changes.push(
    ...[...tagged]
      .filter(([key]) => !Object.hasOwn(policies, key))
      .flatMap(([key, found]) =>
        found.map((p) => ({ kind: '-' as const, type, key, id: p.id as string, ...kept })),
      ),
  );
  return plan;
}

/** A `bots` entry as the criteria Medplum matches: each bot by its identifier, never its id. */
function botCriteria({ bots, ...entry }: AccessPolicyEntry): AccessPolicyResource {
  if (!bots) return entry;
  const identifiers = bots.map((key) => `${PLUMB_SYSTEM}|${key}`).join(',');
  return { ...entry, criteria: `Bot?identifier=${identifiers}` };
}

/**
 * The one resource a key manages: the one carrying its tag, or with `--adopt`
 * the one untagged resource with its name. Nothing when there is neither, or
 * why the key is blocked.
 */
export function claim<T>(
  type: string,
  key: string,
  name: string,
  found: T[],
  untagged: T[],
  options: ProjectOptions,
): { current?: T; adopt?: true } | string {
  if (found.length > 1) {
    return `${type} "${key}": ${found.length} resources carry its tag; delete all but one, then push again.`;
  }
  if (found[0]) return { current: found[0] };
  if (untagged.length === 0) return {};
  if (untagged.length > 1) {
    return `${type} "${name}" exists ${untagged.length} times untagged; delete all but one, then adopt it with --adopt.`;
  }
  if (!options.adopt) return `${type} "${name}" exists untagged; adopt it with --adopt.`;
  return { current: untagged[0], adopt: true };
}

/** One policy's change, or nothing when it is up to date. */
function planPolicy(
  key: string,
  desired: AccessPolicy,
  { current, adopt }: { current?: AccessPolicy; adopt?: true },
): ProjectChange | undefined {
  const type = 'AccessPolicy';
  if (!current) return { kind: '+', type, key, resource: withTag(desired, key) };
  const fields = differing(desired, current);
  if (fields.length === 0 && !adopt) return undefined;
  const resource = withTag(desired, key, current);
  return {
    kind: '~',
    type,
    key,
    id: current.id as string,
    fields,
    ...(adopt ? { adopt } : {}),
    resource,
  };
}

/**
 * The plan for the clients a project holds: each one's name, and its
 * membership's policy and `admin`. A policy the plan creates has no id yet,
 * so a client that names one is always updated.
 */
export function planClients(
  project: ProjectConfig,
  held: HeldClient[],
  policyIds: Record<string, string>,
  options: ProjectOptions = {},
): Pick<ProjectPlan, 'changes' | 'blocked'> {
  const plan: Pick<ProjectPlan, 'changes' | 'blocked'> = { changes: [], blocked: [] };
  const clients = project.clients ?? {};
  const type = 'ClientApplication' as const;
  const tagged = Map.groupBy(
    held.filter((h) => tagOf(h.client) !== undefined),
    (h) => tagOf(h.client) as string,
  );
  for (const [key, config] of Object.entries(clients)) {
    const untagged = held.filter((h) => tagOf(h.client) === undefined && h.client.name === key);
    const claimed = claim(type, key, key, tagged.get(key) ?? [], untagged, options);
    if (typeof claimed === 'string') {
      plan.blocked.push(claimed);
      continue;
    }
    const planned = planClient(key, config, claimed, policyIds);
    if (typeof planned === 'string') plan.blocked.push(planned);
    else if (planned) plan.changes.push(planned);
  }
  const kept = options.prune ? {} : { kept: true as const };
  plan.changes.push(
    ...[...tagged]
      .filter(([key]) => !Object.hasOwn(clients, key))
      .flatMap(([key, found]) =>
        found.map(({ client, membership }) => ({
          kind: '-' as const,
          type,
          key,
          id: client.id as string,
          ...(membership ? { membership: membership.id as string } : {}),
          ...kept,
        })),
      ),
  );
  return plan;
}

/** The resource as the config wants it, carrying Plumb's tag beside any others it had. */
function withTag<T extends AccessPolicy | ClientApplication>(
  desired: T,
  key: string,
  current?: T,
): T {
  const others = current?.meta?.tag?.filter((t) => t.system !== PLUMB_SYSTEM) ?? [];
  return {
    ...desired,
    ...(current ? { id: current.id } : {}),
    meta: { tag: [...others, { system: PLUMB_SYSTEM, code: key }] },
  };
}

/** The top-level fields that differ, leaving out the server's id and meta. */
export function differing(desired: Resource, current: Resource): string[] {
  const want = new Map(Object.entries(desired));
  const have = new Map(Object.entries(current));
  const keys = new Set([...want.keys(), ...have.keys()]);
  return [...keys]
    .filter((k) => k !== 'id' && k !== 'meta' && !deepEquals(want.get(k), have.get(k)))
    .sort();
}

/** One client's change, nothing when it is up to date, or why it is blocked. */
function planClient(
  key: string,
  config: NonNullable<ProjectConfig['clients']>[string],
  { current, adopt }: { current?: HeldClient; adopt?: true },
  policyIds: Record<string, string>,
): ProjectChange | string | undefined {
  const type = 'ClientApplication';
  const desired = {
    ...(config.accessPolicy ? { accessPolicy: config.accessPolicy } : {}),
    admin: config.admin === true,
  };
  if (!current) return { kind: '+', type, key, ...desired };
  const { client, membership } = current;
  if (!membership) return `${type} "${key}" has no ProjectMembership; delete it, then push again.`;
  const policy = config.accessPolicy && policyIds[config.accessPolicy];
  // A policy this plan creates has no id yet, so a membership naming it always changes.
  const policyChanged = config.accessPolicy
    ? !policy || membership.accessPolicy?.reference !== `AccessPolicy/${policy}`
    : membership.accessPolicy !== undefined;
  const fields = [
    client.name !== key && 'name',
    policyChanged && 'accessPolicy',
    (membership.admin === true) !== desired.admin && 'admin',
  ].filter((f) => typeof f === 'string');
  if (fields.length === 0 && !adopt) return undefined;
  return {
    kind: '~',
    type,
    key,
    id: client.id as string,
    membership: membership.id as string,
    fields,
    ...(adopt ? { adopt } : {}),
    ...desired,
  };
}

/** What `applyProject` wrote. A created client's secret is never kept: read it in the console. */
export interface ProjectApplied {
  written: number;
  /** The id of each client created, by key. */
  created: { key: string; id: string }[];
}

/** Writes the plan's changes, in order; a kept removal is skipped. */
export async function applyProject(
  plan: ProjectPlan,
  medplum: MedplumClient,
  env: Record<string, string | undefined> = {},
): Promise<ProjectApplied> {
  const applied: ProjectApplied = { written: 0, created: [] };
  const policyIds = new Map(Object.entries(plan.policyIds));
  for (const change of plan.changes) {
    if (change.kind === '-' && change.kept) continue;
    const created = await applyChange(medplum, change, policyIds, env);
    if (created) applied.created.push({ key: change.key, id: created });
    applied.written++;
  }
  return applied;
}

/** Writes one change; returns a created client's id. */
async function applyChange(
  medplum: MedplumClient,
  change: ProjectChange,
  policyIds: Map<string, string>,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  const policy = (key?: string): Reference<AccessPolicy> | undefined => {
    const id = key && policyIds.get(key);
    return id ? { reference: `AccessPolicy/${id}` } : undefined;
  };
  if (change.type === 'Project') {
    await updateFields(medplum, change.id, change.write, policy, env);
  } else if (change.kind === '-') {
    if (change.membership) await medplum.deleteResource('ProjectMembership', change.membership);
    await medplum.deleteResource(change.type, change.id);
  } else if (change.type === 'AccessPolicy') {
    const written = await (change.kind === '+'
      ? medplum.createResource(change.resource)
      : medplum.updateResource(change.resource));
    // A client later in the plan may name a policy just created.
    policyIds.set(change.key, written.id as string);
  } else if (change.kind === '+') {
    return createClient(medplum, change, policy(change.accessPolicy));
  } else {
    await updateClient(medplum, change, policy(change.accessPolicy));
  }
  return undefined;
}

/**
 * Reads the Project, merges the planned fields into it and writes it back in
 * one update; what push does not manage stays as read. A secret's value is
 * read from its variable here, and goes nowhere but the Project.
 */
async function updateFields(
  medplum: MedplumClient,
  id: string,
  write: ProjectWrite,
  policy: (key?: string) => Reference<AccessPolicy> | undefined,
  env: Record<string, string | undefined>,
): Promise<void> {
  const project: ProjectFields = await medplum.readResource('Project', id);
  const merge = (held: ProjectSetting[] = [], next: ProjectSetting[]) => [
    ...held.filter((h) => !next.some((n) => n.name === h.name)),
    ...next,
  ];
  if (write.setting) project.setting = merge(project.setting, write.setting);
  if (write.secret) {
    const secrets = write.secret.map(({ name, env: variable }) => {
      const value = env[variable];
      if (!value) throw new Error(`${variable} is not set: it holds secret ${name}.`);
      return { name, valueString: value };
    });
    project.secret = merge(project.secret, secrets);
  }
  if (write.defaultProfile) project.defaultProfile = write.defaultProfile;
  if (write.defaultAccessPolicies) {
    project.defaultAccessPolicies = write.defaultAccessPolicies.map((d) => ({
      profileType: d.profileType,
      accessPolicy: policy(d.accessPolicy) as Reference<AccessPolicy>,
    }));
  }
  await medplum.updateResource(project);
}

type ClientChange<K extends '+' | '~'> = Extract<
  ProjectChange,
  { type: 'ClientApplication'; kind: K }
>;

/**
 * Creates a client through the admin endpoint, which makes its membership too,
 * then tags it and sets its membership. Returns its id; the response's secret
 * goes no further.
 */
async function createClient(
  medplum: MedplumClient,
  change: ClientChange<'+'>,
  accessPolicy: Reference<AccessPolicy> | undefined,
): Promise<string> {
  const created = await medplum.post<ClientApplication>(
    `admin/projects/${medplum.getProject()?.id}/client`,
    { name: change.key, ...(accessPolicy ? { accessPolicy } : {}) },
  );
  const id = created.id as string;
  const membership = await medplum.searchOne('ProjectMembership', {
    profile: `ClientApplication/${id}`,
  });
  if (!membership)
    throw new Error(`ClientApplication ${change.key} (${id}) has no ProjectMembership.`);
  await updateClient(
    medplum,
    {
      ...change,
      kind: '~',
      id,
      membership: membership.id as string,
      fields: ['admin'],
      adopt: true,
    },
    accessPolicy,
  );
  return id;
}

/** Tags and names a client, and sets its membership's policy and `admin`. */
async function updateClient(
  medplum: MedplumClient,
  change: ClientChange<'~'>,
  accessPolicy: Reference<AccessPolicy> | undefined,
): Promise<void> {
  if (change.adopt || change.fields.includes('name')) {
    const client = await medplum.readResource('ClientApplication', change.id);
    await medplum.updateResource(withTag({ ...client, name: change.key }, change.key, client));
  }
  if (change.fields.some((f) => f === 'accessPolicy' || f === 'admin')) {
    const { accessPolicy: _, ...membership } = await medplum.readResource(
      'ProjectMembership',
      change.membership,
    );
    await medplum.updateResource({
      ...membership,
      ...(accessPolicy ? { accessPolicy } : {}),
      admin: change.admin,
    });
  }
}

/** The plan step's line: what it will write. */
export function planSummary(plan: ProjectPlan): string {
  const count = (kind: ProjectChange['kind']) =>
    plan.changes.filter((c) => c.kind === kind && !('kept' in c)).length;
  if (plan.blocked.length > 0) return 'refusing: see below';
  return `plan: ${count('+')} to create, ${count('~')} to update, ${count('-')} to remove`;
}

/** One change as the plan prints it. */
export function describeChange(change: ProjectChange): string {
  if (change.type === 'Project') return `~ Project  ${change.fields.join(', ')}`;
  const line = `${change.kind} ${change.type}  ${change.key}`;
  if (change.kind === '+') return line;
  if (change.kind === '-') return change.kept ? `${line} (kept: pass --prune to delete)` : line;
  const fields = change.fields.join(', ');
  return change.adopt ? `${line} (adopted${fields ? `; ${fields}` : ''})` : `${line} (${fields})`;
}
