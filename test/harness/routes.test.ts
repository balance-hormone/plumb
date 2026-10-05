// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import type { Resource } from '@medplum/fhirtypes';
import { beforeAll, describe, expect, test } from 'vitest';
import { routeTo } from '../../src/emit/routes.js';
import { usCoreCases } from './fixtures.js';
import { type GeneratedRoutes, generatedRoutes } from './routes.js';

/** What the generated route returns, or the kind of refusal it throws, as routeTo reports it. */
function generated(r: GeneratedRoutes, resource: Resource) {
  try {
    return { profile: r.route(resource) };
  } catch (e) {
    const many = (e as Error).message.includes('unrelated profiles match');
    return { refused: many ? 'ambiguous' : 'none' };
  }
}
const checker = (r: GeneratedRoutes, resource: Resource) =>
  routeTo(r.routing.routes[resource.resourceType] ?? [], resource);

const PLUMB = 'http://example.org/fhir/plumb-test/StructureDefinition';
const LOINC = 'http://loinc.org';
const observation = (code?: string, extra: object = {}): Resource =>
  ({
    resourceType: 'Observation',
    status: 'final',
    code: { coding: code ? [{ system: LOINC, code }] : [] },
    ...extra,
  }) as Resource;

// A parent and child; siblings that conflict on code; a value-set-keyed
// profile with a config row; one taken out of routing; a type with one profile.
describe('route, on the synthetic profiles', () => {
  let r: GeneratedRoutes;
  beforeAll(async () => {
    r = await generatedRoutes(
      [
        'parent-observation',
        'child-observation',
        'fixed-pattern-observation',
        'bindings-observation',
        'references-observation',
        'cardinality-patient',
      ].map((n) => `${PLUMB}/${n}`),
      {
        [`${PLUMB}/parent-observation`]: {
          code: [
            { system: LOINC, code: '39156-5' },
            { system: LOINC, code: '29463-7' },
          ],
        },
        [`${PLUMB}/bindings-observation`]: { code: [{ system: LOINC, code: '8310-5' }] },
        [`${PLUMB}/references-observation`]: false,
      },
    );
  }, 60_000);

  test.each([
    ['the child over its parent, when both match', observation('39156-5'), 'child-observation'],
    ['the parent, when only it matches', observation('29463-7'), 'parent-observation'],
    ['a pinned code with its fixed status', observation('8302-2'), 'fixed-pattern-observation'],
    ['a value-set-keyed profile by its config row', observation('8310-5'), 'bindings-observation'],
    [
      'the only profile on a type, which has no keys',
      { resourceType: 'Patient' },
      'cardinality-patient',
    ],
  ])('%s', (_, resource, expected) => {
    expect(r.route(resource as Resource)).toBe(`${PLUMB}/${expected}`);
  });

  test('undefined for a type no selected profile constrains', () => {
    expect(
      r.route({ resourceType: 'Encounter', status: 'finished', class: {} } as Resource),
    ).toBeUndefined();
  });

  test("the checker's routeTo agrees with the generated route", () => {
    for (const code of ['39156-5', '29463-7', '8302-2', '8310-5', '0000-0']) {
      expect(checker(r, observation(code))).toEqual(generated(r, observation(code)));
    }
    expect(checker(r, observation('0000-0'))).toEqual({ refused: 'none' });
  });

  test('refuses a resource no profile matches, saying what would select each', () => {
    const err = (() => {
      try {
        r.route(observation('0000-0'));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(r.RoutingError);
    expect((err as Error).message).toBe(
      [
        'no profile matches this Observation.',
        `  bindings-observation        needs code ${LOINC}|8310-5`,
        `  child-observation           needs code ${LOINC}|39156-5`,
        `  fixed-pattern-observation   needs status final, code ${LOINC}|8302-2`,
        `  parent-observation          needs code ${LOINC}|39156-5 or ${LOINC}|29463-7`,
        'Pass { profile } to choose one, or { profile: false } to write it unprofiled.',
      ].join('\n'),
    );
  });

  test('refuses a resource that unrelated profiles both match', () => {
    // Coded both ways, it matches two siblings and neither is the other's parent.
    const both = observation('8302-2', {
      code: {
        coding: [
          { system: LOINC, code: '8302-2' },
          { system: LOINC, code: '8310-5' },
        ],
      },
    });
    expect(checker(r, both)).toEqual({ refused: 'ambiguous' });
    expect(() => r.route(both)).toThrow(
      /^2 unrelated profiles match this Observation\.\n {2}bindings-observation/,
    );
    try {
      r.route(both);
    } catch (e) {
      expect((e as { candidates: string[] }).candidates).toEqual([
        `${PLUMB}/bindings-observation`,
        `${PLUMB}/fixed-pattern-observation`,
      ]);
    }
  });
});

const US_CORE = 'http://hl7.org/fhir/us/core/StructureDefinition';
const SNOMED = 'http://snomed.info/sct';
const OBSERVATION_CATEGORY = 'http://terminology.hl7.org/CodeSystem/observation-category';
const CONDITION_CATEGORY = 'http://terminology.hl7.org/CodeSystem/condition-category';
const loinc = (...codes: string[]) => codes.map((code) => ({ system: LOINC, code }));

/**
 * The routes a project using US Core writes: a row for each profile keyed on a
 * value set (research: US Core 9.0.0 routing). Where the value set can be listed
 * offline, the row lists it; where it cannot, or overlaps other profiles, the row
 * lists the codes the project writes, which the examples stand in for here.
 */
const US_CORE_ROUTES = {
  // us-core-clinical-result-observation-category, less vital-signs and activity,
  // which have profiles of their own; lab results still win as its child.
  [`${US_CORE}/us-core-observation-clinical-result`]: {
    category: ['laboratory', 'exam', 'therapy', 'imaging', 'procedure'].map((code) => ({
      system: OBSERVATION_CATEGORY,
      code,
    })),
  },
  // Its categories overlap nearly every Observation profile, so it keys on the
  // codes written too, and on its categories less survey, which screening
  // assessments pin and share codes with.
  [`${US_CORE}/us-core-simple-observation`]: {
    category: [
      ...['sdoh', 'functional-status', 'disability-status', 'cognitive-status'].map((code) => ({
        system: 'http://hl7.org/fhir/us/core/CodeSystem/us-core-category',
        code,
      })),
      ...['social-history', 'activity'].map((code) => ({ system: OBSERVATION_CATEGORY, code })),
    ],
    code: [
      ...loinc('11331-6', '74013-4', '68516-4', '89555-7', '11332-4', '94023-9', '75276-6'),
      { system: SNOMED, code: '160695008' },
      { system: SNOMED, code: '228366006' },
    ],
  },
  // A VSAC value set, which cannot be listed offline.
  [`${US_CORE}/us-core-smokingstatus`]: {
    code: [...loinc('72166-2', '105045-9'), { system: SNOMED, code: '401201003' }],
  },
  // Its two coding slices, which are extensible, so not generated.
  [`${US_CORE}/us-core-pulse-oximetry`]: { code: loinc('2708-6', '59408-5') },
  // US Core's clinical notes.
  [`${US_CORE}/us-core-documentreference`]: {
    type: loinc(
      '11488-4',
      '18842-5',
      '34117-2',
      '28570-0',
      '11506-3',
      '18748-4',
      '11502-2',
      '34133-9',
    ),
  },
  [`${US_CORE}/us-core-adi-documentreference`]: { category: loinc('42348-3') },
  // us-core-diagnosticreport-category.
  [`${US_CORE}/us-core-diagnosticreport-note`]: {
    category: loinc('LP29684-5', 'LP29708-2', 'LP7839-6'),
  },
  // us-core-problem-or-health-concern.
  [`${US_CORE}/us-core-condition-problems-health-concerns`]: {
    category: [
      { system: CONDITION_CATEGORY, code: 'problem-list-item' },
      {
        system: 'http://hl7.org/fhir/us/core/CodeSystem/condition-category',
        code: 'health-concern',
      },
    ],
  },
};

describe('route, on the US Core 9.0.0 examples', () => {
  const claimed = usCoreCases.filter((c) => c.profile && !c.unparseable);
  let r: GeneratedRoutes;
  beforeAll(async () => {
    r = await generatedRoutes(
      [...new Set(claimed.map((c) => c.profile as string))],
      US_CORE_ROUTES,
    );
  }, 60_000);

  // An example's meta.profile is its expected route: a source independent of the generator.
  test.each(claimed)('$name routes to the profile it claims, or one more specific', (c) => {
    const routed = r.route(c.resource) as string;
    expect([routed, ...r.parentsOf(routed)]).toContain(c.profile);
    expect(checker(r, c.resource)).toEqual(generated(r, c.resource));
  });
});
