// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import type { Resource } from '@medplum/fhirtypes';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { baseType, compileCases, generateTypes, type ProfileType } from './compile.js';
import { contractTables, usCoreCases } from './fixtures.js';
import { type GeneratedRoutes, generatedRoutes, type Reader } from './routes.js';

// Design 04: the presence check follows the type. A fixture that compiles
// passes it; one that fails it does not compile; and one that tsc reports
// missing an element the base type does not require fails it.
const profiles = contractTables.map((table) => table.profile);
const generated = await generatedRoutes(profiles);
const types = generateTypes('reads', profiles);
const failing = contractTables.flatMap((table) =>
  table.fixtures.filter((f) => !f.compiles).map((fixture) => ({ table, fixture })),
);
// Compiled as if they should, so each one's diagnostics say why it does not.
const diagnostics = compileCases(
  'reads',
  failing.flatMap(({ table, fixture }) => [
    { type: types.get(table.profile) as ProfileType, resource: fixture.resource, compiles: true },
    { type: baseType(fixture.resource), resource: fixture.resource, compiles: true },
  ]),
);
const forMissing = new Set(
  failing
    .filter((_, i) => {
      const profiled = diagnostics[2 * i] ?? [];
      const base = diagnostics[2 * i + 1] ?? [];
      return base.length === 0 && profiled.some((d) => /is missing in type/.test(d));
    })
    .map(({ fixture }) => fixture),
);

describe.each(contractTables)('$file', (table) => {
  test.each(table.fixtures)('$name', (fixture) => {
    const missing = generated.missing(fixture.resource, table.profile);
    if (fixture.compiles) expect(missing).toEqual([]);
    if (forMissing.has(fixture)) expect(missing).not.toEqual([]);
  });
});

test('fixtures fail to compile for a missing element', () => {
  expect(forMissing.size).toBeGreaterThan(10);
});

const PLUMB = 'http://example.org/fhir/plumb-test/StructureDefinition';
const stamp = (resource: Resource, ...profile: string[]): Resource => ({
  ...resource,
  meta: { ...resource.meta, profile },
});
const caught = (run: () => unknown) => {
  try {
    run();
  } catch (err) {
    return err as InstanceType<GeneratedRoutes['ProfileReadError']>;
  }
  throw new Error('did not throw');
};

describe('isProfiled and asProfiled, on the synthetic profiles', () => {
  const parent = `${PLUMB}/parent-observation`;
  const child = `${PLUMB}/child-observation`;
  const table = contractTables.find((t) => t.profile === child);
  const conforming = table?.fixtures.find((f) => f.conforms && f.compiles)?.resource as Resource;

  test('a resource compiling against its type passes once stamped, and not before', () => {
    expect(generated.isProfiled(stamp(conforming, child), child)).toBe(true);
    expect(generated.isProfiled(conforming, child)).toBe(false);
  });

  test('a child stamp is its parent; a versioned stamp is not the profile', () => {
    expect(generated.isProfiled(stamp(conforming, child), parent)).toBe(true);
    expect(generated.isProfiled(stamp(conforming, parent), child)).toBe(false);
    expect(generated.isProfiled(stamp(conforming, `${child}|0.1.0`), child)).toBe(false);
  });

  test('asProfiled returns the resource, or names the record and paths, never values', () => {
    const stamped = stamp({ ...conforming, id: 'obs-1' }, child);
    expect(generated.asProfiled(stamped, child)).toBe(stamped);

    const { subject: _, ...rest } = stamped as Resource & { subject?: unknown };
    const missing = caught(() => generated.asProfiled(rest as Resource, child));
    expect(missing).toBeInstanceOf(generated.ProfileReadError);
    expect(missing.reason).toBe('missing');
    expect(missing.failed).toEqual([
      { reference: 'Observation/obs-1', missing: ['Observation.subject'] },
    ]);
    expect(missing.message).toBe(
      [
        'Observation/obs-1 is not a child-observation.',
        '  missing  Observation.subject',
        'Stamped records lack required data when written while the project was loose,',
        'when an AccessPolicy hides the field, or when the profile tightened since.',
        'See `plumb validate --env <env>`.',
      ].join('\n'),
    );

    const unstamped = caught(() => generated.asProfiled(conforming, child));
    expect(unstamped.reason).toBe('unstamped');
    expect(unstamped.message).toBe(
      [
        'Observation with no id is not a child-observation.',
        '  unstamped  meta.profile holds neither child-observation nor a selected profile deriving from it.',
      ].join('\n'),
    );
  });
});

test('types: isProfiled narrows, pickProfiled is typed, and is() types passed', () => {
  const child = `${PLUMB}/child-observation`;
  const diagnostics = generated.typecheck(`
import type { Resource } from '@medplum/fhirtypes';
import type { ChildObservation } from './generated/ChildObservation.js';
import { asProfiled, isProfiled, pickProfiled, ProfileReadError } from './generated/index.js';

declare const resource: Resource;
declare const resources: Resource[];
export const narrowed: ChildObservation | undefined = isProfiled(resource, '${child}') ? resource : undefined;
export const one: ChildObservation = asProfiled(resource, '${child}');
export const many: ChildObservation[] = pickProfiled(resources, '${child}');
export function recover(err: unknown): readonly ChildObservation[] {
  if (ProfileReadError.is(err, '${child}')) return err.passed;
  // @ts-expect-error passed is typed only once is() narrows the error
  const untyped: readonly ChildObservation[] = (err as ProfileReadError).passed;
  return untyped;
}
// @ts-expect-error only a selected profile can be read
export const unknown = asProfiled(resource, 'http://example.org/other');
`);
  expect(diagnostics).toEqual([]);
});

describe('readProfiled and searchProfiled, against a stub client', () => {
  const parent = `${PLUMB}/parent-observation`;
  const child = `${PLUMB}/child-observation`;
  const conforming = contractTables
    .find((t) => t.profile === child)
    ?.fixtures.find((f) => f.conforms && f.compiles)?.resource as Resource;
  const calls: unknown[][] = [];
  const stub = (results: Resource[]): Reader => ({
    readResource: async (...args) => {
      calls.push(['readResource', ...args]);
      return results[0] as Resource;
    },
    readReference: async (...args) => {
      calls.push(['readReference', ...args]);
      return results[0] as Resource;
    },
    searchResources: async (type, query) => {
      calls.push(['searchResources', type, query.toString()]);
      return results;
    },
  });
  beforeEach(() => {
    calls.length = 0;
  });

  test('reads by id from the profile type, or by reference, then checks', async () => {
    const stamped = stamp({ ...conforming, id: 'obs-1' }, child);
    await expect(generated.readProfiled(stub([stamped]), child, 'obs-1')).resolves.toBe(stamped);
    await expect(
      generated.readProfiled(stub([stamped]), child, { reference: 'Observation/obs-1' }),
    ).resolves.toBe(stamped);
    expect(calls).toEqual([
      ['readResource', 'Observation', 'obs-1'],
      ['readReference', { reference: 'Observation/obs-1' }],
    ]);
    await expect(
      generated.readProfiled(stub([{ ...stamped, meta: {} }]), child, 'obs-1'),
    ).rejects.toMatchObject({ reason: 'unstamped' });
  });

  test("searches for the profile's stamps: one URL alone, or with its children's", async () => {
    const stamped = stamp({ ...conforming, id: 'obs-1' }, child);
    await generatedSearch(child, { status: 'final' });
    await generatedSearch(parent, [
      ['code', 'a'],
      ['code', 'b'],
    ]);
    await generatedSearch(parent, '?subject=Patient/1');
    expect(calls).toEqual([
      ['searchResources', 'Observation', `status=final&_profile=${encodeURIComponent(child)}`],
      [
        'searchResources',
        'Observation',
        `code=a&code=b&_profile=${encodeURIComponent(`${parent},${child}`)}`,
      ],
      [
        'searchResources',
        'Observation',
        `subject=Patient%2F1&_profile=${encodeURIComponent(`${parent},${child}`)}`,
      ],
    ]);
    async function generatedSearch(profile: string, query: unknown) {
      return generated.searchProfiled(stub([stamped]), profile, query);
    }
  });

  test.each(['_elements', '_fields', '_summary', '_include', '_revinclude:iterate'])(
    'refuses %s before any request',
    async (key) => {
      const err = await generated
        .searchProfiled(stub([]), child, { [key]: 'subject' })
        .catch((e: unknown) => e as InstanceType<GeneratedRoutes['ProfileReadError']>);
      expect(err).toBeInstanceOf(generated.ProfileReadError);
      expect(err).toMatchObject({ reason: 'refused', failed: [] });
      expect((err as Error).message).toMatch(
        new RegExp(`^searchProfiled\\(child-observation\\) refuses ${key.split(':')[0]}: `),
      );
      expect(calls).toEqual([]);
    },
  );

  test('one failing result fails the search, with the rest in passed', async () => {
    const good = stamp({ ...conforming, id: 'obs-1' }, child);
    const { subject: _, ...bad } = { ...good, id: 'obs-2' } as Resource & { subject?: unknown };
    const err = await generated
      .searchProfiled(stub([good, bad as Resource]), parent)
      .catch((e: unknown) => e as InstanceType<GeneratedRoutes['ProfileReadError']>);
    expect(err).toMatchObject({
      reason: 'missing',
      failed: [{ reference: 'Observation/obs-2', missing: ['Observation.subject'] }],
    });
    expect((err as { passed: unknown }).passed).toEqual([good]);
  });
});

test('types: a MedplumClient reads, typed with its id', () => {
  const child = `${PLUMB}/child-observation`;
  const diagnostics = generated.typecheck(`
import type { MedplumClient } from '@medplum/core';
import type { ChildObservation } from './generated/ChildObservation.js';
import { type ProfiledReader, readProfiled, searchProfiled } from './generated/index.js';

declare const medplum: MedplumClient;
export const reader: ProfiledReader = medplum;
export async function read(): Promise<string> {
  const one: ChildObservation = await readProfiled(medplum, '${child}', 'obs-1');
  const byReference = await readProfiled(medplum, '${child}', { reference: 'Observation/obs-1' });
  const many: ChildObservation[] = await searchProfiled(medplum, '${child}', { status: 'final' });
  return one.id + byReference.id + many.map((o) => o.id).join();
}
`);
  expect(diagnostics).toEqual([]);
});

// Every US Core example declaring a parseable profile. The examples stamp
// `url|9.0.0`, which a read does not accept, so each is stamped as Plumb writes it.
describe('US Core 9.0.0 examples', () => {
  const claimed = usCoreCases
    .filter((c) => c.profile && !c.unparseable && !c.primitiveExtension)
    .map((c) => ({ ...c, resource: stamp(c.resource, c.profile as string) }));
  let r: GeneratedRoutes;
  beforeAll(async () => {
    r = await generatedRoutes([...new Set(claimed.map((c) => c.profile as string))]);
  }, 60_000);

  test.each(claimed)('$name is the profile it declares, and each of its parents', (c) => {
    const profile = c.profile as string;
    for (const url of [profile, ...r.parentsOf(profile)]) {
      expect(r.isProfiled(c.resource, url), url).toBe(true);
    }
  });

  test('pickProfiled keeps exactly the stamped ones, and throws with the rest passed', () => {
    const patients = claimed.filter((c) => c.profile?.endsWith('/us-core-patient'));
    const mixed = claimed.slice(0, 40).map((c) => c.resource);
    const all = [...mixed, ...patients.map((c) => c.resource)];
    const profile = patients[0]?.profile as string;
    const stamped = all.filter((x) => x.meta?.profile?.includes(profile));
    expect(stamped.length).toBeGreaterThan(0);
    expect(r.pickProfiled(all, profile)).toEqual(stamped);

    const broken = { ...(stamped[0] as Resource), name: undefined } as Resource;
    const err = caught(() => r.pickProfiled([...all, broken], profile));
    expect(err.reason).toBe('missing');
    expect(err.failed).toEqual([{ reference: `Patient/${broken.id}`, missing: ['Patient.name'] }]);
    expect(err.passed).toEqual(stamped);

    // Clinical data stays out of what loggers and error trackers copy.
    const family = (stamped[0] as { name?: { family?: string }[] }).name?.[0]?.family as string;
    for (const text of [JSON.stringify(err), JSON.stringify({ ...err }), err.message]) {
      expect(text).not.toContain(family);
    }
    expect(Object.keys(err)).not.toContain('passed');
    expect({ ...err }).not.toHaveProperty('passed');
  });
});
