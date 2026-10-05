// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { deepEquals, type MedplumClient } from '@medplum/core';
import type {
  AccessPolicy,
  ClientApplication,
  ProjectMembership,
  Reference,
} from '@medplum/fhirtypes';
import { lockdownWarnings, type ProjectConfig } from './config.js';

/** The `meta.tag` system of what `push` manages; the code is the config key. */
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
}

/**
 * Plans the project's AccessPolicies and clients against the config. Only the
 * target project's own resources are read: a linked project's are not this
 * one's to write, even when they carry Plumb's tag.
 */
export async function planProject(
  project: ProjectConfig,
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
  // Policies first, which clients reference; removals last, clients before the policies they use.
  const removal = (c: ProjectChange) => c.kind === '-';
  plan.changes = [
    ...plan.changes.filter((c) => !removal(c)),
    ...planned.changes.filter((c) => !removal(c)),
    ...planned.changes.filter(removal),
    ...plan.changes.filter(removal),
  ];
  plan.blocked.push(...planned.blocked);
  const own = medplum.getProjectMembership()?.accessPolicy?.reference;
  const ownKey = held.find((p) => own === `AccessPolicy/${p.id}`);
  plan.warnings.push(...lockdownWarnings(project, ownKey && tagOf(ownKey)).map((w) => w.message));
  const links = current.link?.length ?? 0;
  if (links > 0) plan.warnings.push(`linked projects: ${links}, not managed`);
  return plan;
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

const tagOf = (resource: AccessPolicy | ClientApplication) =>
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

/**
 * The one resource a key manages: the one carrying its tag, or with `--adopt`
 * the one untagged resource with its name. Nothing when there is neither, or
 * why the key is blocked.
 */
function claim<T>(
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
function differing(desired: AccessPolicy, current: AccessPolicy): string[] {
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
): Promise<ProjectApplied> {
  const applied: ProjectApplied = { written: 0, created: [] };
  const policyIds = new Map(Object.entries(plan.policyIds));
  for (const change of plan.changes) {
    if (change.kind === '-' && change.kept) continue;
    const created = await applyChange(medplum, change, policyIds);
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
): Promise<string | undefined> {
  const policy = (key?: string): Reference<AccessPolicy> | undefined => {
    const id = key && policyIds.get(key);
    return id ? { reference: `AccessPolicy/${id}` } : undefined;
  };
  if (change.kind === '-') {
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
  const line = `${change.kind} ${change.type}  ${change.key}`;
  if (change.kind === '+') return line;
  if (change.kind === '-') return change.kept ? `${line} (kept: pass --prune to delete)` : line;
  const fields = change.fields.join(', ');
  return change.adopt ? `${line} (adopted${fields ? `; ${fields}` : ''})` : `${line} (${fields})`;
}
