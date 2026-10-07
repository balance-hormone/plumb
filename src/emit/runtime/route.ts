// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

// _routes.ts from `interface Row` to the writes (write.ts). printRoutes writes
// its imports, the profile types and the `routes` table above it.
import type { Resource } from '@medplum/fhirtypes';
import type { Route } from '../routes.js';
import { matches } from './plumb.js';

// One URL stands in for the selected profiles, so a lookup by profile is
// never undefined, as in a generated file.
export type ProfileTypes = { 'http://example.org/fhir/StructureDefinition/example': Resource };
export type ProfileUrl = keyof ProfileTypes;

/** The generated file's table; here, the rows `routeTo` was given. */
let routes: Partial<Record<string, readonly Row[]>> = {};

/**
 * The profile `route` picks for a resource among its type's rows, or why it
 * refuses. The checker routes unstamped resources with it, so it routes as a
 * generated `route` does: by the same code.
 */
export function routeTo(
  rows: readonly Route[],
  resource: Resource,
): { profile: string } | { refused: 'none' | 'ambiguous' } {
  // The checker's rows name any profile, where ProfileUrl here names one.
  routes = { [resource.resourceType]: rows as readonly Row[] };
  try {
    // The table holds the resource's type, so route picks a profile or throws.
    return { profile: route(resource) as string };
  } catch (err) {
    if (!(err instanceof RoutingError)) throw err;
    return { refused: err.message.startsWith('no profile matches') ? 'none' : 'ambiguous' };
  }
}

// Generated files hold what follows this line.
interface Row {
  readonly profile: ProfileUrl;
  readonly parents: readonly string[];
  readonly keys: readonly (readonly [string, readonly unknown[]])[];
}

/** Thrown when no selected profile, or several unrelated ones, match a resource. */
export class RoutingError extends Error {
  /** The profiles that matched, or every routed profile on the type when none did. */
  readonly candidates: readonly ProfileUrl[];
  constructor(message: string, candidates: readonly ProfileUrl[]) {
    super(message);
    this.name = 'RoutingError';
    this.candidates = candidates;
  }
}

/**
 * The selected profile a resource's content selects: every row whose keys all
 * match, less any that is a parent of another match. `undefined` when no
 * selected profile constrains the resource's type. Throws a RoutingError when
 * none, or several unrelated ones, match: it never guesses.
 */
export function route(resource: Resource): ProfileUrl | undefined {
  const table: Partial<Record<string, readonly Row[]>> = routes;
  const rows = table[resource.resourceType];
  if (!rows) return undefined;
  const fields = resource as unknown as Record<string, unknown>;
  const matched = rows.filter((row) =>
    row.keys.every(([element, patterns]) => patterns.some((p) => matches(fields[element], p))),
  );
  const best = matched.filter((row) => !matched.some((other) => other.parents.includes(row.profile)));
  if (best.length === 1) return best[0]?.profile;
  const type = resource.resourceType;
  const shown = best.length === 0 ? rows : best;
  const width = Math.max(0, ...shown.map((row) => short(row.profile).length));
  throw new RoutingError(
    [
      best.length === 0
        ? `no profile matches this ${type}.`
        : `${best.length} unrelated profiles match this ${type}.`,
      ...shown.map((row) => `  ${short(row.profile).padEnd(width)}   ${needs(row, type)}`),
      'Pass { profile } to choose one, or { profile: false } to write it unprofiled.',
    ].join('\n'),
    shown.map((row) => row.profile),
  );
}

const short = (url: string) => url.slice(url.lastIndexOf('/') + 1);

function needs(row: Row, type: string): string {
  if (row.keys.length === 0) return `matches any ${type}`;
  return `needs ${row.keys.map(([element, patterns]) => `${element} ${patterns.map(describe).join(' or ')}`).join(', ')}`;
}

/** A pattern as a reader would say it: a coding as system|code, an object by its fields. */
function describe(pattern: unknown): string {
  if (typeof pattern !== 'object' || pattern === null) return String(pattern);
  const { system, code, coding } = pattern as { system?: unknown; code?: unknown; coding?: unknown };
  if (Array.isArray(coding)) return coding.map(describe).join(' and ');
  if (typeof code === 'string' && Object.keys(pattern).every((k) => ['system', 'code', 'display'].includes(k))) {
    return typeof system === 'string' ? `${system}|${code}` : code;
  }
  return Object.entries(pattern)
    .map(([key, value]) => `${key} ${describe(value)}`)
    .join(', ');
}
