// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import type { Observation, Resource } from '@medplum/fhirtypes';
import { beforeAll, describe, expect, test } from 'vitest';
import { type GeneratedRoutes, generatedRoutes } from './routes.js';

const PLUMB = 'http://example.org/fhir/plumb-test/StructureDefinition';
const PARENT = `${PLUMB}/parent-observation`;
const CHILD = `${PLUMB}/child-observation`;
const FIXED = `${PLUMB}/fixed-pattern-observation`;
// A default that is not selected, as a project's own profile would be.
const ORG = `${PLUMB}/required-choice-observation`;
const FOREIGN = 'https://example.org/fhir/StructureDefinition/someone-elses';
const LOINC = 'http://loinc.org';

const observation = (code: string, extra: Partial<Observation> = {}): Observation => ({
  resourceType: 'Observation',
  status: 'final',
  code: { coding: [{ system: LOINC, code }] },
  ...extra,
});

/** A client that records what it is asked to write, and writes nothing. */
function stub() {
  const writes: Resource[] = [];
  const write = async <T extends Resource>(resource: T): Promise<T> => {
    writes.push(resource);
    return resource;
  };
  return { writes, client: { createResource: write, updateResource: write } };
}

/** Frozen all the way down, so a mutation throws. */
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) frozen(v);
    Object.freeze(value);
  }
  return value;
}

describe('createProfiled and updateProfiled, against a stub client', () => {
  let r: GeneratedRoutes;
  beforeAll(async () => {
    r = await generatedRoutes(
      [PARENT, CHILD, FIXED],
      { [PARENT]: { code: [{ system: LOINC, code: '29463-7' }] } },
      { Observation: [PARENT, ORG] },
    );
  }, 60_000);

  test('stamps the defaults, less any the routed profile derives from, then the profile', async () => {
    const { writes, client } = stub();
    await r.createProfiled(client, observation('39156-5'));
    await r.createProfiled(client, observation('8302-2'));
    expect(writes.map((w) => w.meta?.profile)).toEqual([
      [ORG, CHILD],
      [PARENT, ORG, FIXED],
    ]);
  });

  test('leaves the resource passed unchanged', async () => {
    const { writes, client } = stub();
    const input = frozen(observation('39156-5', { meta: { source: 'synthetic' } }));
    await r.createProfiled(client, input);
    expect(input.meta).toEqual({ source: 'synthetic' });
    expect(writes[0]?.meta).toEqual({ source: 'synthetic', profile: [ORG, CHILD] });
  });

  test('{ profile } skips routing and stamps the profile chosen', async () => {
    const { writes, client } = stub();
    await r.createProfiled(client, observation('0000-0'), { profile: CHILD });
    expect(writes[0]?.meta?.profile).toEqual([ORG, CHILD]);
  });

  test('{ profile: false } writes no Plumb stamp, and never an empty meta.profile', async () => {
    const { writes, client } = stub();
    const stamped = observation('39156-5', {
      meta: { source: 'synthetic', profile: [CHILD, ORG] },
    });
    await r.updateProfiled(client, stamped, { profile: false });
    await r.createProfiled(client, observation('0000-0'), { profile: false });
    expect(writes[0]?.meta).toEqual({ source: 'synthetic' });
    expect(writes[1]).not.toHaveProperty('meta');
  });

  test('an update re-routes, replacing the stamps Plumb manages and keeping other URLs', async () => {
    const { writes, client } = stub();
    const before = observation('8302-2', { meta: { profile: [FOREIGN, CHILD, `${ORG}|0.1.0`] } });
    await r.updateProfiled(client, before);
    expect(writes[0]?.meta?.profile).toEqual([FOREIGN, PARENT, ORG, FIXED]);
  });

  test('a type no selected profile constrains keeps its own stamps', async () => {
    const { writes, client } = stub();
    await r.createProfiled(client, { resourceType: 'Patient', meta: { profile: [FOREIGN] } });
    expect(writes[0]?.meta?.profile).toEqual([FOREIGN]);
  });

  test('refuses before writing anything when the content selects no profile', async () => {
    const { writes, client } = stub();
    await expect(r.createProfiled(client, observation('0000-0'))).rejects.toBeInstanceOf(
      r.RoutingError,
    );
    expect(writes).toEqual([]);
  });

  // For writes createProfiled cannot make: conditional creates, upserts, batches.
  test('stampProfiled returns what createProfiled writes, and writes nothing', async () => {
    const { writes, client } = stub();
    const input = frozen(observation('39156-5', { meta: { profile: [FOREIGN] } }));
    await r.createProfiled(client, input);
    expect(r.stampProfiled(input)).toEqual(writes[0]);
    expect(r.stampProfiled(observation('0000-0'), { profile: CHILD }).meta?.profile).toEqual([
      ORG,
      CHILD,
    ]);
    expect(r.stampProfiled(input, { profile: false }).meta?.profile).toEqual([FOREIGN]);
    expect(() => r.stampProfiled(observation('0000-0'))).toThrow(r.RoutingError);
  });

  test('types: a MedplumClient fits, and { profile } narrows the resource and the result', () => {
    const child = JSON.stringify(
      observation('39156-5', {
        subject: { reference: 'Patient/1' },
        effectiveDateTime: '2026-01-01',
        valueQuantity: { value: 1 },
      }),
    );
    const diagnostics = r.typecheck(`
import type { MedplumClient } from '@medplum/core';
import type { Observation } from '@medplum/fhirtypes';
import type { ChildObservation } from './generated/ChildObservation.js';
import { createProfiled, type ProfiledClient, stampProfiled, updateProfiled } from './generated/index.js';

declare const medplum: MedplumClient;
declare const observation: Observation;
export const client: ProfiledClient = medplum;
export const routed: Promise<Observation> = createProfiled(medplum, observation);
export const chosen: Promise<ChildObservation> = createProfiled(medplum, ${child}, { profile: '${CHILD}' });
export const updated: Promise<Observation> = updateProfiled(medplum, observation, { profile: false });
export const stamped: ChildObservation = stampProfiled(${child}, { profile: '${CHILD}' });
// The brand plumb check reads: present on what stampProfiled returns, and nothing a caller must supply.
declare const plain: Observation;
const routedStamp = stampProfiled(plain, { profile: false });
type BrandKeys = Exclude<keyof typeof routedStamp, keyof Observation>;
export const brand: [BrandKeys] extends [never] ? 'missing' : 'present' = 'present';
export const assignable: Observation = routedStamp;
// @ts-expect-error stamping as a profile needs what its type requires
export const unstampable = stampProfiled(observation, { profile: '${CHILD}' });
// @ts-expect-error the chosen profile needs a subject, an effective time and a value
export const incomplete = createProfiled(medplum, observation, { profile: '${CHILD}' });
// @ts-expect-error only a selected profile can be chosen
export const unknown = createProfiled(medplum, observation, { profile: '${FOREIGN}' });
`);
    expect(diagnostics).toEqual([]);
  });
});
