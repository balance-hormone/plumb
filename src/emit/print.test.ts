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

  test('a long Omit key list goes one key per line', () => {
    const keys = [
      'subject',
      'effectiveDateTime',
      'effectivePeriod',
      'effectiveTiming',
      'effectiveInstant',
    ];
    expect(printExpr({ kind: 'narrow', base: ref('Observation'), omit: keys, fields: [] })).toBe(
      [
        'Omit<',
        '  Observation,',
        "  | 'subject'",
        "  | 'effectiveDateTime'",
        "  | 'effectivePeriod'",
        "  | 'effectiveTiming'",
        "  | 'effectiveInstant'",
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
        "import type { Require } from './_plumb.js';",
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

  test('an index re-exporting every profile, and the shared helpers', () => {
    const files = printFiles([model], () => 'sha256-abc');
    expect(files.get('index.ts')).toBe(
      [
        '// Generated by Plumb. Do not edit.',
        "export type { Require } from './_plumb.js';",
        "export * from './ExamplePatient.js';",
        '',
      ].join('\n'),
    );
    expect(files.get('_plumb.ts')).toContain('export type Require<T, K extends keyof T>');
    expect([...files.keys()].sort()).toEqual(['ExamplePatient.ts', '_plumb.ts', 'index.ts']);
  });
});
