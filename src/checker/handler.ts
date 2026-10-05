// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { Buffer } from 'node:buffer';
import { gunzipSync } from 'node:zlib';
import {
  type BotEvent,
  indexStructureDefinitionBundle,
  isDataTypeLoaded,
  loadDataType,
  MEDPLUM_VERSION,
  type MedplumClient,
  OperationOutcomeError,
  validateResource,
} from '@medplum/core';
import type { Resource, ResourceType, StructureDefinition } from '@medplum/fhirtypes';

// The checker bot: bundled with @medplum/core into one file, it runs inside the
// project, so stored resources never leave Medplum; only counts, reasons and
// ids come back.

/** One page's request, from `plumb validate`. */
export interface CheckerInput {
  resourceType: ResourceType;
  /** Canonical URLs of the selected profiles to validate stamps against. */
  profiles: string[];
  /**
   * Base64 of gzipped JSON `{ base, profiles }`: the base R4 definitions and
   * the profile closure the validator needs. Gzipped to fit the server's JSON
   * body limit, 1 MB by default.
   */
  definitions: string;
  /** The server's `_cursor` from the previous page; the first page has none. */
  cursor?: string;
}

// Medplum pages by cursor only from 20 a page, sorted by _lastUpdated; by
// offset, it stops at 10,000.
const PAGE_SIZE = '100';

/** Resources failing for one element path and message, indexes removed. */
export interface Reason {
  path: string;
  message: string;
  count: number;
}

export interface ProfileResult {
  checked: number;
  failing: string[];
  reasons: Reason[];
}

export interface PageResult {
  /** The `@medplum/core` version validating, bundled into the bot. */
  core: string;
  read: number;
  /** Resources stamped with at least one selected profile, each counted once. */
  stamped: number;
  /** Of those, the ones failing any of their selected profiles. */
  failing: number;
  /** Resources with no `meta.profile`: routing's job, not validated. */
  unstamped: number;
  /** Stamps that validate against nothing: `url|version`, and `meta.profile: []`. */
  silent: { versioned: number; empty: number };
  /** Stamps naming a profile not selected, by URL: the CLI tells loaded from unknown. */
  otherStamps: Record<string, number>;
  profiles: Record<string, ProfileResult>;
  /** The cursor for the next page, absent on the last. */
  next?: string;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<CheckerInput>,
): Promise<PageResult> {
  const { resourceType, profiles, definitions, cursor } = event.input;
  const selected = load(definitions, profiles);
  const bundle = await medplum.search(resourceType, {
    _count: PAGE_SIZE,
    _sort: '_lastUpdated',
    ...(cursor ? { _cursor: cursor } : {}),
  });
  const next = bundle.link?.find((l) => l.relation === 'next')?.url;
  const resources = (bundle.entry ?? []).flatMap((e) => (e.resource ? [e.resource] : []));
  await loadNestedTypes(medplum, resources);
  const page = checkPage(resources, selected);
  const nextCursor = next ? new URL(next).searchParams.get('_cursor') : null;
  return { ...page, ...(nextCursor ? { next: nextCursor } : {}) };
}

/** Indexes the definitions as the loader does, and returns the selected profiles by URL. */
function load(definitions: string, urls: string[]): Map<string, StructureDefinition> {
  const { base, profiles } = JSON.parse(
    gunzipSync(Buffer.from(definitions, 'base64')).toString('utf8'),
  ) as { base: StructureDefinition[]; profiles: StructureDefinition[] };
  indexStructureDefinitionBundle(base);
  for (const sd of profiles) loadDataType(sd);
  return new Map(profiles.filter((sd) => urls.includes(sd.url)).map((sd) => [sd.url, sd]));
}

/**
 * A contained resource, or a Bundle entry, can be of any type, and the input
 * carries only the checked type's base definition, so the rest come from the
 * server, which holds base R4.
 */
async function loadNestedTypes(medplum: MedplumClient, resources: Resource[]): Promise<void> {
  const types = new Set<string>();
  const walk = (value: unknown, root: boolean): void => {
    if (Array.isArray(value)) for (const item of value) walk(item, false);
    else if (typeof value === 'object' && value !== null) {
      const { resourceType } = value as { resourceType?: unknown };
      if (!root && typeof resourceType === 'string') types.add(resourceType);
      for (const child of Object.values(value)) walk(child, false);
    }
  };
  for (const resource of resources) walk(resource, true);
  for (const type of types) {
    if (isDataTypeLoaded(type)) continue;
    const sd = await medplum.searchOne('StructureDefinition', {
      url: `http://hl7.org/fhir/StructureDefinition/${type}`,
    });
    if (sd) loadDataType(sd);
  }
}

/** Validates each resource against the selected profiles it is stamped with. */
function checkPage(
  resources: Resource[],
  selected: Map<string, StructureDefinition>,
): Omit<PageResult, 'next'> {
  const result: Omit<PageResult, 'next'> = {
    core: MEDPLUM_VERSION,
    read: resources.length,
    stamped: 0,
    failing: 0,
    unstamped: 0,
    silent: { versioned: 0, empty: 0 },
    otherStamps: {},
    profiles: {},
  };
  const tallies = new Map<string, Tally>();
  // Whether the resource was checked, and whether it passed every check.
  const stamp = (url: string, resource: Resource): { checked: boolean; passed: boolean } => {
    const profile = selected.get(url);
    if (url.includes('|')) result.silent.versioned++;
    else if (!profile) result.otherStamps[url] = (result.otherStamps[url] ?? 0) + 1;
    else {
      const tally = tallies.get(url) ?? new Tally();
      tallies.set(url, tally);
      return { checked: true, passed: tally.add(resource, profile) };
    }
    return { checked: false, passed: true };
  };
  for (const resource of resources) {
    const stamps = resource.meta?.profile;
    if (stamps === undefined) result.unstamped++;
    else if (stamps.length === 0) result.silent.empty++;
    const checks = (stamps ?? []).map((url) => stamp(url, resource));
    if (checks.some((c) => c.checked)) result.stamped++;
    if (checks.some((c) => !c.passed)) result.failing++;
  }
  for (const [url, tally] of tallies) result.profiles[url] = tally.result();
  return result;
}

/** One profile's counts, failing ids and reasons across a page. */
class Tally {
  private checked = 0;
  private readonly failing: string[] = [];
  private readonly reasons = new Map<string, Reason>();

  /** Checks the resource, returning whether it passed. */
  add(resource: Resource, profile: StructureDefinition): boolean {
    this.checked++;
    const failures = errors(resource, profile);
    if (failures.length > 0) this.failing.push(resource.id ?? '');
    // A reason counts resources, so a resource failing it twice counts once.
    const seen = new Set<string>();
    for (const { path, message } of failures) {
      const key = `${path}\n${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const reason = this.reasons.get(key) ?? { path, message, count: 0 };
      reason.count++;
      this.reasons.set(key, reason);
    }
    return failures.length === 0;
  }

  result(): ProfileResult {
    const reasons = [...this.reasons.values()].sort((a, b) => b.count - a.count);
    return { checked: this.checked, failing: this.failing, reasons };
  }
}

// `component[2]` and `component[5]` are one reason, so array indexes go.
const withoutIndexes = (text: string) => text.replace(/\[\d+\]/g, '');

/** The error issues Medplum's validator reports, as validateProfiled counts them. */
function errors(resource: Resource, profile: StructureDefinition) {
  let issues: ReturnType<typeof validateResource>;
  try {
    issues = validateResource(resource, { profile });
  } catch (err) {
    // validateResource throws with every issue when any is an error.
    if (!(err instanceof OperationOutcomeError)) throw err;
    issues = err.outcome.issue ?? [];
  }
  return issues
    .filter((i) => i.severity === 'error' || i.severity === 'fatal')
    .map((i) => ({
      path: withoutIndexes(i.expression?.[0] ?? ''),
      message: withoutIndexes(i.details?.text ?? ''),
    }));
}
