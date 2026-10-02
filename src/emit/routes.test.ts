// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadProfiles } from '../loader.js';
import { routingRows } from './routes.js';

const PLUMB = 'http://example.org/fhir/plumb-test/StructureDefinition';
const SYNTHETIC = join(import.meta.dirname, '../../test/fixtures/profiles/fsh-generated/resources');
const LOINC = 'http://loinc.org';

const load = (names: string[]) =>
  loadProfiles({
    packages: [],
    igs: [],
    local: SYNTHETIC,
    profiles: names.map((n) => `${PLUMB}/${n}`),
  });

describe('routingRows', () => {
  // A parent and its child, two siblings whose codes conflict, keyless siblings
  // (ambiguous), a value-set-keyed profile given a config row, and one taken out.
  const loaded = load([
    'parent-observation',
    'child-observation',
    'fixed-pattern-observation',
    'bindings-observation',
    'choice-observation',
    'references-observation',
  ]);
  const { routes, warnings } = routingRows(loaded, {
    routes: {
      [`${PLUMB}/bindings-observation`]: { code: [{ system: LOINC, code: '29463-7' }] },
      [`${PLUMB}/references-observation`]: false,
    },
  });
  const row = (name: string) => routes.Observation?.find((r) => r.profile === `${PLUMB}/${name}`);

  test('keys on required fixed and pattern values, and names the selected parents', () => {
    expect(row('parent-observation')).toEqual({
      profile: `${PLUMB}/parent-observation`,
      parents: [],
      keys: [],
    });
    expect(row('child-observation')).toEqual({
      profile: `${PLUMB}/child-observation`,
      parents: [`${PLUMB}/parent-observation`],
      keys: [['code', [{ coding: [{ code: '39156-5', system: LOINC }] }]]],
    });
    expect(row('fixed-pattern-observation')?.keys).toEqual([
      ['status', ['final']],
      ['code', [{ coding: [{ code: '8302-2', system: LOINC }] }]],
    ]);
  });

  test('a config row adds keys, a coding inside a CodeableConcept, and false removes the profile', () => {
    expect(row('bindings-observation')?.keys).toEqual([
      ['code', [{ coding: [{ system: LOINC, code: '29463-7' }] }]],
    ]);
    expect(row('references-observation')).toBeUndefined();
  });

  test('warns for each unrelated pair whose keys conflict on no element', () => {
    const pairs = warnings.map((w) => w.split(' can both')[0]);
    // Parent and child are related; the coded profiles conflict with each other.
    expect(pairs).not.toContain('parent-observation and child-observation');
    expect(pairs).not.toContain('child-observation and fixed-pattern-observation');
    expect(pairs).not.toContain('fixed-pattern-observation and bindings-observation');
    // A keyless profile can match anything its siblings match.
    expect(pairs).toEqual(
      expect.arrayContaining([
        'parent-observation and fixed-pattern-observation',
        'bindings-observation and choice-observation',
      ]),
    );
    expect(warnings[0]).toMatch(
      /can both match an Observation; add a routes row to tell them apart\.$/,
    );
  });

  test("required slices key on their discriminator values; an optional element's value does not", () => {
    const { routes } = routingRows(load(['sliced-observation', 'fixed-pattern-encounter']));
    expect(routes.Observation?.[0]?.keys).toEqual([
      ['component', [{ code: { coding: [{ code: '8480-6', system: LOINC }] } }]],
      ['component', [{ code: { coding: [{ code: '8462-4', system: LOINC }] } }]],
    ]);
    // priority is 0..1, so its fixed value applies only when present.
    expect(routes.Encounter?.[0]?.keys.map(([element]) => element)).toEqual(['status', 'class']);
  });
});
