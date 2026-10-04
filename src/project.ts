// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { deepEquals, type MedplumClient } from '@medplum/core';
import type { AccessPolicy } from '@medplum/fhirtypes';
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
      kind: '-';
      type: 'AccessPolicy';
      key: string;
      id: string;
      /** Listed but not deleted, without `--prune`. */
      kept?: true;
    };

export interface ProjectPlan {
  changes: ProjectChange[];
  /** Why nothing in the project can be applied. */
  blocked: string[];
  warnings: string[];
}

export interface ProjectOptions {
  /** Tag and converge an untagged resource with a key's name. */
  adopt?: boolean;
  /** Delete a tagged resource whose key left the config. */
  prune?: boolean;
}

/**
 * Plans the project's AccessPolicies against the config. Only the target
 * project's own resources are read: a linked project's are not this one's to
 * write, even when they carry Plumb's tag.
 */
export async function planProject(
  project: ProjectConfig,
  medplum: MedplumClient,
  options: ProjectOptions = {},
): Promise<ProjectPlan> {
  const current = medplum.getProject();
  const held: AccessPolicy[] = [];
  // Every policy, not a search by tag: a removed key and an untagged name are found in one read.
  for await (const page of medplum.searchResourcePages('AccessPolicy', { _count: '1000' })) {
    held.push(...page.filter((p) => p.meta?.project === current?.id));
  }
  const plan = planPolicies(project, held, options);
  const own = medplum.getProjectMembership()?.accessPolicy?.reference;
  const ownKey = held.find((p) => own === `AccessPolicy/${p.id}`);
  plan.warnings.push(...lockdownWarnings(project, ownKey && tagOf(ownKey)).map((w) => w.message));
  const links = current?.link?.length ?? 0;
  if (links > 0) plan.warnings.push(`linked projects: ${links}, not managed`);
  return plan;
}

const tagOf = (resource: AccessPolicy) =>
  resource.meta?.tag?.find((t) => t.system === PLUMB_SYSTEM)?.code;

/** The plan for the policies a project holds, found by Plumb's tag and never by id. */
export function planPolicies(
  project: ProjectConfig,
  held: AccessPolicy[],
  options: ProjectOptions = {},
): ProjectPlan {
  const plan: ProjectPlan = { changes: [], blocked: [], warnings: [] };
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
    const planned = planPolicy(key, desired, tagged.get(key) ?? [], untagged, options);
    if (typeof planned === 'string') plan.blocked.push(planned);
    else if (planned) plan.changes.push(planned);
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

/** One key's change, nothing when it is up to date, or why it is blocked. */
function planPolicy(
  key: string,
  desired: AccessPolicy,
  found: AccessPolicy[],
  untagged: AccessPolicy[],
  options: ProjectOptions,
): ProjectChange | string | undefined {
  const type = 'AccessPolicy';
  if (found.length > 1) {
    return `${type} "${key}": ${found.length} resources carry its tag; delete all but one, then push again.`;
  }
  const [current] = found;
  if (current) {
    const fields = differing(desired, current);
    if (fields.length === 0) return undefined;
    const resource = withTag(desired, key, current);
    return { kind: '~', type, key, id: current.id as string, fields, resource };
  }
  const [adoptable] = untagged;
  if (!adoptable) return { kind: '+', type, key, resource: withTag(desired, key) };
  if (untagged.length > 1) {
    return `${type} "${desired.name}" exists ${untagged.length} times untagged; delete all but one, then adopt it with --adopt.`;
  }
  if (!options.adopt) return `${type} "${desired.name}" exists untagged; adopt it with --adopt.`;
  return {
    kind: '~',
    type,
    key,
    id: adoptable.id as string,
    fields: differing(desired, adoptable),
    adopt: true,
    resource: withTag(desired, key, adoptable),
  };
}

/** The resource as the config wants it, carrying Plumb's tag beside any others it had. */
function withTag(desired: AccessPolicy, key: string, current?: AccessPolicy): AccessPolicy {
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

/** Writes the plan's changes, in order; a kept removal is skipped. Returns how many it wrote. */
export async function applyProject(plan: ProjectPlan, medplum: MedplumClient): Promise<number> {
  let written = 0;
  for (const change of plan.changes) {
    if (change.kind === '+') await medplum.createResource(change.resource);
    else if (change.kind === '~') await medplum.updateResource(change.resource);
    else if (!change.kept) await medplum.deleteResource(change.type, change.id);
    else continue;
    written++;
  }
  return written;
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
