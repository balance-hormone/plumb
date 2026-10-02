// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import type { StructureDefinition } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { printExpr, printFiles } from './print.js';
import type { ProfileModel, TypeExpr } from './transform.js';

const ref = (name: string, args?: TypeExpr[]): TypeExpr =>
  args ? { kind: 'ref', name, args } : { kind: 'ref', name };

describe('printExpr', () => {
  test('references, primitives, literals and index types', () => {
    expect(
      printExpr(ref('Reference', [{ kind: 'union', of: [ref('Patient'), ref('Group')] }])),
    ).toBe('Reference<Patient | Group>');
    expect(printExpr({ kind: 'literal', value: "it's" })).toBe("'it\\'s'");
    expect(printExpr({ kind: 'literal', value: 3 })).toBe('3');
    expect(printExpr({ kind: 'index', base: 'Patient', key: 'gender' })).toBe(
      "NonNullable<Patient['gender']>",
    );
    expect(printExpr({ kind: 'require', base: ref('Identifier'), keys: ['system', 'value'] })).toBe(
      "Require<Identifier, 'system' | 'value'>",
    );
  });

  test('an open string keeps its suggestions', () => {
    expect(
      printExpr({ kind: 'union', of: [{ kind: 'literal', value: 'g' }, { kind: 'otherString' }] }),
    ).toBe("'g' | (string & {})");
  });

  test('arrays wrap unions and intersections in parentheses', () => {
    expect(printExpr({ kind: 'array', of: ref('HumanName') })).toBe('HumanName[]');
    expect(printExpr({ kind: 'array', of: { kind: 'union', of: [ref('A'), ref('B')] } })).toBe(
      '(A | B)[]',
    );
    expect(
      printExpr({
        kind: 'array',
        of: { kind: 'narrow', base: ref('Coding'), omit: ['code'], fields: [] },
      }),
    ).toBe("(Omit<Coding, 'code'> & {})[]");
  });

  test('a long Omit key list fills lines, one union per line', () => {
    const keys = Array.from({ length: 12 }, (_, i) => `effectiveKey${i}`);
    expect(printExpr({ kind: 'narrow', base: ref('Observation'), omit: keys, fields: [] })).toBe(
      [
        'Omit<',
        '  Observation,',
        "  | 'effectiveKey0' | 'effectiveKey1' | 'effectiveKey2' | 'effectiveKey3' | 'effectiveKey4'",
        "  | 'effectiveKey5' | 'effectiveKey6' | 'effectiveKey7' | 'effectiveKey8' | 'effectiveKey9'",
        "  | 'effectiveKey10' | 'effectiveKey11'",
        '> & {}',
      ].join('\n'),
    );
  });

  test('exact objects and tuples', () => {
    expect(
      printExpr({
        kind: 'object',
        fields: [
          {
            name: 'coding',
            optional: false,
            type: { kind: 'tuple', of: [{ kind: 'literal', value: 'x' }] },
          },
        ],
      }),
    ).toBe("{\n  coding: ['x'];\n}");
  });

  test('a narrowed type: Omit, fields with docs, and exactly-one-of unions', () => {
    const narrowed: TypeExpr = {
      kind: 'narrow',
      base: ref('Observation'),
      omit: ['status', 'valueQuantity', 'valueString'],
      fields: [
        {
          name: 'status',
          optional: false,
          type: { kind: 'literal', value: 'final' },
          doc: 'The status.',
        },
        { name: 'photo', optional: true, type: { kind: 'never' } },
      ],
      oneOf: [
        [
          [
            { name: 'valueQuantity', optional: false, type: ref('Quantity') },
            { name: 'valueString', optional: true, type: { kind: 'never' } },
          ],
          [
            { name: 'valueString', optional: false, type: { kind: 'primitive', name: 'string' } },
            { name: 'valueQuantity', optional: true, type: { kind: 'never' } },
          ],
        ],
      ],
    };
    expect(printExpr(narrowed)).toBe(
      [
        "Omit<Observation, 'status' | 'valueQuantity' | 'valueString'> & {",
        '  /** The status. */',
        "  status: 'final';",
        '  photo?: never;',
        '} & (',
        '  | {',
        '      valueQuantity: Quantity;',
        '      valueString?: never;',
        '    }',
        '  | {',
        '      valueString: string;',
        '      valueQuantity?: never;',
        '    }',
        ')',
      ].join('\n'),
    );
  });
});

describe('printFiles', () => {
  const model: ProfileModel = {
    url: 'http://example.org/fhir/StructureDefinition/p',
    version: '1.0.0',
    source: 'example.fhir.ig@1.0.0',
    sd: {} as StructureDefinition,
    typeName: 'ExamplePatient',
    doc: ['Example Patient', '', 'A patient.'],
    helpers: [],
    constants: [],
    slices: 0,
    required: [['identifier'], ['identifier.value'], ['contact.name']],
    decls: [
      {
        name: 'ExamplePatient',
        type: {
          kind: 'narrow',
          base: ref('Patient'),
          omit: ['identifier', 'contact'],
          fields: [
            {
              name: 'identifier',
              optional: false,
              type: {
                kind: 'array',
                of: { kind: 'require', base: ref('Identifier'), keys: ['value'] },
              },
            },
            {
              name: 'contact',
              optional: true,
              type: { kind: 'array', of: ref('ExamplePatientContact') },
            },
          ],
        },
      },
      {
        name: 'ExamplePatientContact',
        type: { kind: 'require', base: ref('PatientContact'), keys: ['name'] },
      },
    ],
  };

  test('one file per profile, with a header, imports, the URL constant and the types', () => {
    const files = printFiles([model], () => 'sha256-abc');
    expect(files.get('ExamplePatient.ts')).toBe(
      [
        '// Generated by Plumb from http://example.org/fhir/StructureDefinition/p|1.0.0. Do not edit.',
        '// Source: example.fhir.ig@1.0.0 sha256-abc',
        "import type { Identifier, Patient, PatientContact } from '@medplum/fhirtypes';",
        "import { type Require } from './_plumb.js';",
        '',
        '/** The canonical URL of ExamplePatient. */',
        "export const ExamplePatientProfileUrl = 'http://example.org/fhir/StructureDefinition/p';",
        '',
        '/**',
        ' * Example Patient',
        ' *',
        ' * A patient.',
        ' */',
        "export type ExamplePatient = Omit<Patient, 'identifier' | 'contact'> & {",
        "  identifier: Require<Identifier, 'value'>[];",
        '  contact?: ExamplePatientContact[];',
        '};',
        '',
        "export type ExamplePatientContact = Require<PatientContact, 'name'>;",
        '',
      ].join('\n'),
    );
  });

  test('exports the codes of a CodeableConcept binding', () => {
    const files = printFiles(
      [
        {
          ...model,
          constants: [
            {
              name: 'ExamplePatientMaritalStatusCodes',
              codes: [{ system: 'http://example.org/cs', code: 'red', display: 'Red' }],
            },
          ],
        },
      ],
      () => 'sha256-abc',
    );
    expect(files.get('ExamplePatient.ts')).toContain(
      [
        '/** The codes of ExamplePatientMaritalStatus. */',
        'export const ExamplePatientMaritalStatusCodes = [',
        "  { system: 'http://example.org/cs', code: 'red', display: 'Red' },",
        '] as const;',
      ].join('\n'),
    );
  });

  test('an index re-exporting every profile, and the shared helpers', () => {
    const files = printFiles([model], () => 'sha256-abc');
    expect(files.get('index.ts')).toBe(
      [
        '// Generated by Plumb. Do not edit.',
        "export type { Require } from './_plumb.js';",
        "export { createProfiled, type ProfiledClient, type ProfileTypes, type ProfileUrl, RoutingError, route, updateProfiled } from './_routes.js';",
        "export * from './ExamplePatient.js';",
        '',
      ].join('\n'),
    );
    expect(files.get('_plumb.ts')).toContain('export type Require<T, K extends keyof T>');
    expect([...files.keys()].sort()).toEqual([
      'ExamplePatient.ts',
      '_plumb.ts',
      '_reads.ts',
      '_routes.ts',
      'index.ts',
    ]);
  });

  test('the required paths of each selected profile, by URL', () => {
    const routing = { profiles: [model.url], stamps: {}, managed: [], routes: {} };
    const unrequired = {
      ...model,
      url: 'http://example.org/fhir/StructureDefinition/o',
      required: [],
    };
    const extension = { ...model, url: 'http://example.org/fhir/StructureDefinition/e' };
    const files = printFiles([model, extension, unrequired], () => 'sha256-abc', {
      ...routing,
      profiles: [model.url, unrequired.url],
    });
    expect(files.get('_reads.ts')).toBe(
      [
        '// Generated by Plumb. Do not edit.',
        "import type { ProfileUrl } from './_routes.js';",
        '',
        '/**',
        " * The paths each selected profile's type requires beyond @medplum/fhirtypes.",
        ' * A row lists alternatives, any one of which meets it (`missing` in _plumb.ts).',
        ' */',
        'export const required: Record<ProfileUrl, readonly (readonly string[])[]> = {',
        "  'http://example.org/fhir/StructureDefinition/o': [],",
        "  'http://example.org/fhir/StructureDefinition/p': [",
        "    ['identifier'],",
        "    ['identifier.value'],",
        "    ['contact.name'],",
        '  ],',
        '};',
      ].join('\n'),
    );
  });

  test('the routing rows, by type then profile URL', () => {
    const files = printFiles([model], () => 'sha256-abc', {
      profiles: [],
      stamps: {},
      managed: [],
      routes: {
        Observation: [
          { profile: 'https://example.org/b', parents: ['https://example.org/a'], keys: [] },
          { profile: 'https://example.org/a', parents: [], keys: [['status', ['final']]] },
        ],
      },
    });
    expect(files.get('_routes.ts')).toContain(
      [
        'export const routes = {',
        '  Observation: [',
        '    {',
        "      profile: 'https://example.org/a',",
        '      parents: [],',
        '      keys: [',
        "        ['status', ['final']],",
        '      ],',
        '    },',
        '    {',
        "      profile: 'https://example.org/b',",
        "      parents: ['https://example.org/a'],",
        '      keys: [],',
        '    },',
        '  ],',
        '} as const;',
      ].join('\n'),
    );
  });
});

describe('generated helpers', () => {
  test('build a slice entry with its discriminator filled in, and read it back', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { loadProfiles } = await import('../loader.js');
    const { transform } = await import('./transform.js');
    const { writeFiles } = await import('./write.js');
    const plumb = 'http://example.org/fhir/plumb-test/StructureDefinition';
    const loaded = loadProfiles({
      packages: [],
      igs: [],
      local: join(import.meta.dirname, '../../test/fixtures/profiles/fsh-generated/resources'),
      profiles: [`${plumb}/sliced-observation`, `${plumb}/optional-extensions-patient`],
    });
    const out = join(mkdtempSync(join(tmpdir(), 'plumb-helpers-')), 'generated');
    writeFiles(
      out,
      printFiles(transform(loaded).models, () => 'test'),
    );

    const bp = await import(join(out, 'SlicedObservation.ts'));
    const systolic = bp.SlicedObservation.systolic({ valueQuantity: { value: 120 } });
    expect(systolic).toEqual({
      valueQuantity: { value: 120 },
      code: { coding: [{ code: '8480-6', system: 'http://loinc.org' }] },
    });
    const observation = {
      resourceType: 'Observation',
      component: [{ code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }] } }, systolic],
    };
    expect(bp.SlicedObservation.getSystolic(observation)).toBe(systolic);
    expect(bp.SlicedObservation.getSystolic({ component: [] })).toBeUndefined();

    const { matches, missing } = await import(join(out, '_plumb.ts'));
    // A pattern on a repeating element is met when some entry matches it.
    expect(matches([{ code: 'a' }, { code: 'b' }], { code: 'b' })).toBe(true);
    expect(matches([{ code: 'a' }], { code: 'b' })).toBe(false);

    // A nested path applies to every entry present, and is met when there are none.
    const rows = [['identifier'], ['identifier.system'], ['effectiveDateTime', 'effectivePeriod']];
    expect(missing({ identifier: [{ system: 's' }], effectivePeriod: {} }, rows)).toEqual([]);
    expect(missing({ identifier: [{ system: 's' }, {}] }, rows)).toEqual([
      'identifier.system',
      'effectiveDateTime | effectivePeriod',
    ]);
    expect(missing({ identifier: [] }, [['identifier.system']])).toEqual([]);
    expect(missing({ birthDate: null }, [['birthDate']])).toEqual(['birthDate']);
    // A number is one tuple position; `key*` follows key to any depth.
    expect(missing({ name: [{ family: 'f' }, {}] }, [['name.0.family']])).toEqual([]);
    expect(missing({ name: [{}, { family: 'f' }] }, [['name.0.family']])).toEqual([
      'name.0.family',
    ]);
    const deep = [['item.item*.text']];
    expect(missing({ item: [{ text: 'a', item: [{ text: 'b' }] }] }, deep)).toEqual([]);
    expect(missing({ item: [{ text: 'a', item: [{ item: [{}] }] }] }, deep)).toEqual([
      'item.item*.text',
    ]);

    // A profile file imports the shared extension type it slices in.
    expect(readFileSync(join(out, 'OptionalExtensionsPatient.ts'), 'utf8')).toContain(
      "import type { FavoriteColor } from './FavoriteColor.js';",
    );
    expect(readFileSync(join(out, 'index.ts'), 'utf8')).toContain(
      "export * from './FavoriteColor.js';",
    );
    const patient = await import(join(out, 'OptionalExtensionsPatient.ts'));
    const color = patient.OptionalExtensionsPatient.favoriteColor({ valueCode: 'blue' });
    expect(color).toEqual({ valueCode: 'blue', url: `${plumb}/favorite-color` });
    expect(patient.OptionalExtensionsPatient.getFavoriteColor({ extension: [color] })).toBe(color);
  });
});
