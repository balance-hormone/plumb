// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

// The end of _routes.ts, after route.ts. printRoutes fills in STAMPS and MANAGED.
import type { Resource } from '@medplum/fhirtypes';
import { type ProfileTypes, type ProfileUrl, route } from './route.js';

declare const STAMPS: Record<ProfileUrl, readonly string[]>;
declare const MANAGED: readonly string[];

// Generated files hold what follows this line.
/**
 * The part of a `MedplumClient` the writes use, so the generated code needs no
 * `@medplum/core` declarations of its own: a MedplumClient is one.
 */
export interface ProfiledClient {
  createResource<T extends Resource>(resource: T): Promise<T>;
  updateResource<T extends Resource>(resource: T): Promise<T>;
}

/** What a write to each selected profile stamps: the type's defaults it does not derive from, then the profile. */
const stamps: Record<ProfileUrl, readonly string[]> = STAMPS;

/** Every URL Plumb stamps. A write replaces these in `meta.profile`, and keeps any other. */
const managed: ReadonlySet<string> = new Set<string>(MANAGED);

/**
 * A copy of the resource stamped for the profile: the URLs Plumb does not
 * manage, then the profile's stamps. With no profile, only the other URLs
 * stay, and an empty `meta.profile` is left out: it would skip the server's
 * `defaultProfile`.
 */
function stamped<T extends Resource>(resource: T, profile: ProfileUrl | false | undefined): T {
  const { profile: current = [], ...meta } = resource.meta ?? {};
  const kept = current.filter((url) => !managed.has(url.split('|')[0] ?? url));
  const profiles = [...kept, ...(profile ? stamps[profile] : [])];
  const { meta: _, ...rest } = resource;
  if (profiles.length > 0) return { ...rest, meta: { ...meta, profile: profiles } } as T;
  return (Object.keys(meta).length > 0 ? { ...rest, meta } : rest) as T;
}

/**
 * Creates the resource held to the profile its content selects, stamped with
 * that profile and the project's defaults. `{ profile }` chooses one instead,
 * and `{ profile: false }` writes it with no Plumb stamp, so the server's own
 * default applies. Rejects with a RoutingError, before anything is written,
 * when the content selects no single profile. The resource passed is not changed.
 */
export function createProfiled<U extends ProfileUrl>(
  medplum: ProfiledClient,
  resource: ProfileTypes[U],
  options: { profile: U },
): Promise<ProfileTypes[U]>;
export function createProfiled<T extends Resource>(
  medplum: ProfiledClient,
  resource: T,
  options?: { profile: false },
): Promise<T>;
export async function createProfiled(
  medplum: ProfiledClient,
  resource: Resource,
  options: { profile?: ProfileUrl | false } = {},
): Promise<Resource> {
  return medplum.createResource(stamped(resource, options.profile ?? route(resource)));
}

declare const plumbStamped: unique symbol;

/**
 * What stampProfiled returns carries this, so `plumb check` can tell a stamped
 * write from a raw one, through a variable too. Optional, so it asks nothing of
 * a caller and changes nothing it can assign.
 */
type Stamped = { readonly [plumbStamped]?: true };

/**
 * The copy createProfiled would write, stamped and not written, for the writes
 * it cannot make: a conditional create, an upsert, a batch or transaction
 * entry. Options and errors as createProfiled; a RoutingError is thrown.
 */
export function stampProfiled<U extends ProfileUrl>(
  resource: ProfileTypes[U],
  options: { profile: U },
): ProfileTypes[U] & Stamped;
export function stampProfiled<T extends Resource>(
  resource: T,
  options?: { profile: false },
): T & Stamped;
export function stampProfiled(
  resource: Resource,
  options: { profile?: ProfileUrl | false } = {},
): Resource {
  return stamped(resource, options.profile ?? route(resource));
}

/**
 * Updates the resource held to the profile its new content selects: the
 * stamps Plumb manages are replaced, and any other URL in `meta.profile` is
 * kept. Options and errors as createProfiled.
 */
export function updateProfiled<U extends ProfileUrl>(
  medplum: ProfiledClient,
  resource: ProfileTypes[U],
  options: { profile: U },
): Promise<ProfileTypes[U]>;
export function updateProfiled<T extends Resource>(
  medplum: ProfiledClient,
  resource: T,
  options?: { profile: false },
): Promise<T>;
export async function updateProfiled(
  medplum: ProfiledClient,
  resource: Resource,
  options: { profile?: ProfileUrl | false } = {},
): Promise<Resource> {
  return medplum.updateResource(stamped(resource, options.profile ?? route(resource)));
}
