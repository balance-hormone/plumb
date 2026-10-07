// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

// Routing rows: the content that selects each profile, from its own fixed
// and pattern values, its required slices, and the config's rows (design 03).
import type { InternalSchemaElement } from '@medplum/core';
import type { Coding } from '@medplum/fhirtypes';
import type { RouteRow as ConfigRow, PlumbConfig } from '../config.js';
import type { LoadProfilesResult } from '../loader.js';
import { matches } from './runtime/plumb.js';
import { discriminatorValues } from './transform.js';

/**
 * A first-level element and the patterns, any one of which it must hold, in
 * the FHIR pattern sense `matches` (runtime/plumb.ts) implements.
 */
type RouteKey = [element: string, patterns: unknown[]];

export interface Route {
  profile: string;
  /** The profile's `baseDefinition` chain, as far as it runs through selected profiles. */
  parents: string[];
  keys: RouteKey[];
}

export interface Routing {
  routes: Record<string, Route[]>;
  /** Every selected profile, routed or not: each can be chosen with `{ profile }`. */
  profiles: string[];
  /**
   * What a write held to each selected profile stamps: its type's
   * `defaultProfile` less any it derives from, which it already holds, then
   * the profile. A stamp replaces Medplum's default, so the defaults go too.
   */
  stamps: Record<string, string[]>;
  /** Every URL Plumb stamps, which an update replaces; other URLs in `meta.profile` are kept. */
  managed: string[];
  /** The stamps a read accepts as each selected profile: its URL, then each selected profile deriving from it. */
  accepts: Record<string, string[]>;
  /** The pairs of profiles one resource could match. */
  warnings: string[];
}

/** The routes of each resource type, and the pairs of profiles one resource could match. */
export function routingRows(
  loaded: Pick<LoadProfilesResult, 'profiles' | 'definitions'>,
  config: Pick<PlumbConfig, 'routes' | 'defaultProfile'> = {},
): Routing {
  const selected = new Set(loaded.profiles.map((p) => p.url));
  const parentsOf = new Map(
    loaded.profiles.map(({ url, sd }) => [url, parents(sd.baseDefinition, loaded, selected)]),
  );
  const routes: Record<string, Route[]> = {};
  for (const { url, sd, schema } of loaded.profiles) {
    const row = config.routes?.[url];
    // A type whose profiles are all out of routing still has rows, so route refuses rather than skip it.
    routes[sd.type] ??= [];
    if (row === false) continue;
    const keys = generatedKeys(schema.elements);
    if (row) keys.push(...configKeys(row, schema.elements));
    const route = { profile: url, parents: parentsOf.get(url) ?? [], keys };
    routes[sd.type]?.push(route);
  }
  const warnings = Object.entries(routes).flatMap(([type, rows]) => ambiguous(type, rows));
  const defaults = config.defaultProfile ?? {};
  const stamps = Object.fromEntries(
    loaded.profiles.map(({ url, sd }) => {
      const derivesFrom = ancestors(sd.baseDefinition, loaded);
      const kept = (defaults[sd.type] ?? []).filter((d) => d !== url && !derivesFrom.includes(d));
      return [url, [...kept, url]];
    }),
  );
  const managed = [...new Set([...selected, ...Object.values(defaults).flat()])];
  const accepts = Object.fromEntries(
    [...selected].map((url) => [
      url,
      [url, ...[...selected].filter((child) => parentsOf.get(child)?.includes(url))],
    ]),
  );
  return { routes, profiles: [...selected], stamps, managed, accepts, warnings };
}

/** Each fixed or pattern value on a required first-level element, and each required slice's discriminator values. */
function generatedKeys(elements: Record<string, InternalSchemaElement>): RouteKey[] {
  const keys: RouteKey[] = [];
  for (const [path, e] of Object.entries(elements)) {
    if (path.includes('.')) continue;
    // An optional element's value applies only when present, so it selects nothing.
    const value = e.min > 0 ? (e.fixed ?? e.pattern) : undefined;
    if (value) keys.push([typedName(path, value.type), [value.value]]);
    keys.push(...requiredSlices(path, e));
  }
  return keys;
}

function requiredSlices(path: string, e: InternalSchemaElement): RouteKey[] {
  const { slicing } = e;
  if (!slicing) return [];
  return slicing.slices.flatMap((slice): RouteKey[] => {
    const values = slice.min >= 1 ? discriminatorValues(slicing, slice) : undefined;
    return values ? [[path, [values]]] : [];
  });
}

/** `value[x]` fixed to a CodeableConcept is held as `valueCodeableConcept`. */
const typedName = (path: string, type: string) =>
  path.endsWith('[x]') ? `${path.slice(0, -3)}${type[0]?.toUpperCase()}${type.slice(1)}` : path;

/** A config row's values as patterns: a coding inside a CodeableConcept, else as written. */
function configKeys(row: ConfigRow, elements: Record<string, InternalSchemaElement>): RouteKey[] {
  return Object.entries(row).map(([element, values]) => {
    const type = elements[element]?.type[0]?.code;
    return [
      element,
      values.map((v) =>
        type === 'CodeableConcept' && typeof v === 'object' ? { coding: [v as Coding] } : v,
      ),
    ];
  });
}

/** The `baseDefinition` chain, as bare URLs. */
function ancestors(base: string | undefined, loaded: Pick<LoadProfilesResult, 'definitions'>) {
  const chain: string[] = [];
  for (let url = base; url; ) {
    const bare = url.split('|')[0] as string;
    chain.push(bare);
    const sd = loaded.definitions.get(bare)?.resource;
    url = sd?.resourceType === 'StructureDefinition' ? sd.baseDefinition : undefined;
  }
  return chain;
}

const parents = (
  base: string | undefined,
  loaded: Pick<LoadProfilesResult, 'definitions'>,
  selected: Set<string>,
) => ancestors(base, loaded).filter((url) => selected.has(url));

/**
 * Unrelated profiles whose keys conflict on no element: one resource could
 * match both, so `route` would refuse it. Two keys on an element conflict
 * when no pattern of one holds a pattern of the other.
 */
function ambiguous(type: string, rows: Route[]): string[] {
  const warnings: string[] = [];
  rows.forEach((a, i) => {
    for (const b of rows.slice(i + 1)) {
      if (a.parents.includes(b.profile) || b.parents.includes(a.profile)) continue;
      if (a.keys.some((ka) => b.keys.some((kb) => conflict(ka, kb)))) continue;
      warnings.push(
        `${name(a.profile)} and ${name(b.profile)} can both match ${/^[AEIOU]/.test(type) ? 'an' : 'a'} ${type}; add a routes row to tell them apart.`,
      );
    }
  });
  return warnings;
}

const conflict = ([ea, pa]: RouteKey, [eb, pb]: RouteKey) =>
  ea === eb && pa.every((x) => pb.every((y) => !matches(x, y) && !matches(y, x)));

const name = (url: string) => url.slice(url.lastIndexOf('/') + 1);
