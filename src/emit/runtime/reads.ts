// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

// The end of _reads.ts. printReads writes its imports and the tables declared here.
import type { Reference, Resource, ResourceType } from '@medplum/fhirtypes';
import { missing } from './plumb.js';
import type { ProfileTypes, ProfileUrl } from './route.js';

declare const required: Record<ProfileUrl, readonly (readonly string[])[]>;
declare const accepts: Partial<Record<string, readonly string[]>>;
declare const typeOf: Partial<Record<string, ResourceType>>;

// Generated files hold what follows this line.
/** A record that failed a read, and the paths it lacks. */
export interface ProfileReadFailure {
  readonly reference: string;
  readonly missing: readonly string[];
}

/**
 * Thrown when a resource read as a profile is not stamped with it, lacks what
 * its type requires, or was asked for in a way that cannot hold the type. The
 * message names records and paths, never their values.
 */
export class ProfileReadError<U extends ProfileUrl = ProfileUrl> extends Error {
  readonly profile: U;
  readonly reason: 'unstamped' | 'missing' | 'refused';
  readonly failed: readonly ProfileReadFailure[];
  /**
   * The records that passed, typed once `ProfileReadError.is` narrows the error.
   * Not enumerable: loggers and error trackers copy an error's enumerable
   * properties into their reports, and these hold clinical data.
   */
  declare readonly passed: readonly ProfileTypes[U][];

  constructor(
    profile: U,
    reason: 'unstamped' | 'missing' | 'refused',
    failed: readonly ProfileReadFailure[],
    passed: readonly ProfileTypes[U][] = [],
    message = describe(profile, reason, failed),
  ) {
    super(message);
    this.name = 'ProfileReadError';
    this.profile = profile;
    this.reason = reason;
    this.failed = failed;
    Object.defineProperty(this, 'passed', { value: passed, enumerable: false });
  }

  /** Whether `err` is a ProfileReadError for the profile, which types its `passed`. */
  static is<U extends ProfileUrl>(err: unknown, profile: U): err is ProfileReadError<U> {
    return err instanceof ProfileReadError && err.profile === profile;
  }
}

const short = (url: string) => url.slice(url.lastIndexOf('/') + 1);

function describe(profile: ProfileUrl, reason: string, failed: readonly ProfileReadFailure[]): string {
  const name = short(profile);
  const [first] = failed;
  if (reason === 'unstamped' && first) {
    return [
      `${first.reference} is not a ${name}.`,
      `  unstamped  meta.profile holds neither ${name} nor a selected profile deriving from it.`,
    ].join('\n');
  }
  const width = Math.max(0, ...failed.map((f) => f.reference.length));
  return [
    failed.length === 1 && first ? `${first.reference} is not a ${name}.` : `${failed.length} records are not a ${name}.`,
    ...(failed.length === 1
      ? (first?.missing ?? []).map((path) => `  missing  ${path}`)
      : failed.map((f) => `  ${f.reference.padEnd(width)}   missing  ${f.missing.join(', ')}`)),
    'Stamped records lack required data when written while the project was loose,',
    'when an AccessPolicy hides the field, or when the profile tightened since.',
    'See `plumb validate --env <env>`.',
  ].join('\n');
}

/** Whether `meta.profile` holds the profile's bare URL, or a selected profile deriving from it. */
function stampedAs(resource: Resource, profile: ProfileUrl): boolean {
  return resource.meta?.profile?.some((url) => accepts[profile]?.includes(url)) ?? false;
}

const referenceOf = (resource: Resource) =>
  resource.id ? `${resource.resourceType}/${resource.id}` : `${resource.resourceType} with no id`;

/** The rows of the profile's `required` the resource lacks, as paths from its type. */
const lacks = (resource: Resource, profile: ProfileUrl) =>
  missing(resource, required[profile]).map((path) => `${resource.resourceType}.${path}`);

/**
 * Whether the resource is the profile's: stamped with it or a selected profile
 * deriving from it, and holding every path its type requires. Pure and offline;
 * asProfiled, pickProfiled and the reads all run this check.
 */
export function isProfiled<U extends ProfileUrl>(resource: Resource, profile: U): resource is Resource & ProfileTypes[U] {
  return stampedAs(resource, profile) && missing(resource, required[profile]).length === 0;
}

/** The resource as the profile's type, or a ProfileReadError saying why it is not. */
export function asProfiled<U extends ProfileUrl>(resource: Resource, profile: U): ProfileTypes[U] {
  if (isProfiled(resource, profile)) return resource;
  const reference = referenceOf(resource);
  if (!stampedAs(resource, profile)) throw new ProfileReadError(profile, 'unstamped', [{ reference, missing: [] }]);
  throw new ProfileReadError(profile, 'missing', [{ reference, missing: lacks(resource, profile) }]);
}

/**
 * The resources stamped with the profile, or a selected profile deriving from
 * it, each checked and typed; the others are left out. Throws a
 * ProfileReadError when a stamped one lacks what its type requires, with the
 * ones that passed in `passed`.
 */
export function pickProfiled<U extends ProfileUrl>(resources: readonly Resource[], profile: U): ProfileTypes[U][] {
  const passed: ProfileTypes[U][] = [];
  const failed: ProfileReadFailure[] = [];
  for (const resource of resources) {
    if (isProfiled(resource, profile)) passed.push(resource);
    else if (stampedAs(resource, profile)) failed.push({ reference: referenceOf(resource), missing: lacks(resource, profile) });
  }
  if (failed.length > 0) throw new ProfileReadError(profile, 'missing', failed, passed);
  return passed;
}

/** A resource as the server returns it, with its id. The same as `WithId` in @medplum/core. */
type WithId<T> = T & { id: string };

/**
 * The part of a `MedplumClient` the reads use, so the generated code needs no
 * `@medplum/core` declarations of its own: a MedplumClient is one.
 */
export interface ProfiledReader {
  readResource(resourceType: ResourceType, id: string): Promise<Resource>;
  readReference(reference: Reference): Promise<Resource>;
  searchResources(resourceType: ResourceType, query: string[][]): Promise<Resource[]>;
}

/**
 * A search query, in any form `medplum.searchResources` takes: a string, a
 * URLSearchParams or any other list of pairs, or a record. Typed without
 * URLSearchParams, so the generated code compiles without the DOM lib.
 */
export type ProfiledQuery =
  | string
  | Iterable<readonly string[]>
  | Record<string, string | number | boolean | readonly (string | number | boolean)[] | undefined>;

/**
 * Reads the resource by id, or by reference, and returns it as the profile's
 * type, or rejects with a ProfileReadError when it is not stamped with the
 * profile or lacks what the type requires.
 */
export async function readProfiled<U extends ProfileUrl>(
  medplum: ProfiledReader,
  profile: U,
  idOrReference: string | Reference<Resource & ProfileTypes[U]>,
): Promise<WithId<ProfileTypes[U]>> {
  const resource =
    typeof idOrReference === 'string'
      ? await medplum.readResource(typeOf[profile] as ResourceType, idOrReference)
      : await medplum.readReference(idOrReference);
  return asProfiled(resource, profile) as WithId<ProfileTypes[U]>;
}

// Each returns a subset, which is not the profile's type, or mixes other resources into the results.
const subsets = ['_elements', '_fields', '_summary'];
const includes = ['_include', '_revinclude'];

/**
 * Searches the profile's type for resources stamped with the profile, or a
 * selected profile deriving from it, and returns them typed. One that lacks
 * what the type requires rejects the search with a ProfileReadError holding
 * the rest in `passed`. A query asking for a subset or included resources is
 * refused before any request.
 */
export async function searchProfiled<U extends ProfileUrl>(
  medplum: ProfiledReader,
  profile: U,
  query: ProfiledQuery = {},
): Promise<WithId<ProfileTypes[U]>[]> {
  const params = searchParams(query);
  for (const [key] of params) {
    const name = key?.split(':')[0] ?? '';
    if (subsets.includes(name) || includes.includes(name)) throw refusal(profile, name);
  }
  params.push(['_profile', (accepts[profile] ?? [profile]).join(',')]);
  const found = await medplum.searchResources(typeOf[profile] as ResourceType, params);
  return pickProfiled(found, profile) as WithId<ProfileTypes[U]>[];
}

function searchParams(query: ProfiledQuery): string[][] {
  if (typeof query === 'string') {
    return query
      .replace(/^\?/, '')
      .split('&')
      .filter((pair) => pair !== '')
      .map((pair) => {
        const at = pair.indexOf('=');
        const [key, value] = at === -1 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
        return [decode(key), decode(value)];
      });
  }
  const pairs = Symbol.iterator in query ? [...(query as Iterable<readonly string[]>)] : Object.entries(query);
  const params: string[][] = [];
  for (const [key, value] of pairs) {
    for (const v of [value].flat()) if (key !== undefined && v !== undefined) params.push([key, String(v)]);
  }
  return params;
}

// As URLSearchParams decodes: '+' is a space.
const decode = (text: string) => decodeURIComponent(text.replace(/\+/g, ' '));

function refusal(profile: ProfileUrl, name: string): ProfileReadError {
  const why = subsets.includes(name)
    ? `a subset is not a ${short(profile)}. Use medplum.searchResources for a subset.`
    : 'included resources would be mixed into the results. Read them with medplum.searchResources, or with readProfiled from a reference.';
  return new ProfileReadError(profile, 'refused', [], [], `searchProfiled(${short(profile)}) refuses ${name}: ${why}`);
}
