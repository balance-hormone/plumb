// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SliceDefinition, SlicingRules } from '@medplum/core';
import { describe, expect, test } from 'vitest';
import { loadProfiles } from '../loader.js';
import {
  discriminatorValues,
  type Field,
  type ProfileModel,
  type TypeExpr,
  transform,
} from './transform.js';

const LOCAL = join(import.meta.dirname, '../../test/fixtures/profiles/fsh-generated/resources');
const PLUMB = 'http://example.org/fhir/plumb-test/StructureDefinition';

function models(...names: string[]): ProfileModel[] {
  const loaded = loadProfiles({
    packages: [],
    igs: [],
    local: LOCAL,
    profiles: names.map((n) => `${PLUMB}/${n}`),
  });
  expect(loaded.errors).toEqual([]);
  const result = transform(loaded);
  expect(result.errors).toEqual([]);
  return result.models;
}

function bloodPressure(): ProfileModel {
  const dir = join(import.meta.dirname, '../../test/fixtures/packages');
  const loaded = loadProfiles({
    packages: readdirSync(dir).map((folder) => {
      const [name, version] = folder.split('#') as [string, string];
      return { name, version, dir: join(dir, folder) };
    }),
    igs: ['hl7.fhir.us.core@9.0.0'],
    profiles: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-blood-pressure'],
  });
  return transform(loaded).models[0] as ProfileModel;
}

function model(name: string): ProfileModel {
  return models(name)[0] as ProfileModel;
}

/** The declared type with this name. */
function decl(m: ProfileModel, name = m.typeName): TypeExpr {
  const found = m.decls.find((d) => d.name === name);
  if (!found) throw new Error(`no declaration ${name} in ${m.decls.map((d) => d.name)}`);
  return found.type;
}

function field(type: TypeExpr, name: string): Field {
  const fields =
    type.kind === 'narrow' ? [...type.fields, ...((type.oneOf ?? []).flat(2) as Field[])] : [];
  const found = fields.find((f) => f.name === name);
  if (!found) throw new Error(`no field ${name}`);
  return found;
}

describe('transform', () => {
  test('names a type from the profile name, and a URL constant', () => {
    const m = model('cardinality-patient');
    expect(m.typeName).toBe('CardinalityPatient');
    expect(m.url).toBe(`${PLUMB}/cardinality-patient`);
  });

  test('narrows the base: required fields, prohibited fields, unchanged fields untouched', () => {
    const t = decl(model('cardinality-patient'));
    expect(t.kind).toBe('narrow');
    if (t.kind !== 'narrow') return;
    expect(t.base).toEqual({ kind: 'ref', name: 'Patient' });
    expect(field(t, 'birthDate')).toMatchObject({ optional: false });
    expect(field(t, 'name')).toMatchObject({
      optional: false,
      type: { kind: 'array', of: { kind: 'ref', name: 'HumanName' } },
    });
    expect(field(t, 'photo')).toMatchObject({ optional: true, type: { kind: 'never' } });
    expect(t.omit).not.toContain('gender');
  });

  test('narrows required paths at every depth, with Require for datatypes', () => {
    const m = model('nesting-patient');
    const t = decl(m);
    expect(field(t, 'identifier').type).toEqual({
      kind: 'array',
      of: { kind: 'require', base: { kind: 'ref', name: 'Identifier' }, keys: ['system', 'value'] },
    });
    // A backbone element the profile narrows becomes a named type in the same file.
    expect(field(t, 'contact').type).toEqual({
      kind: 'array',
      of: { kind: 'ref', name: 'NestingPatientContact' },
    });
    const contact = decl(m, 'NestingPatientContact');
    if (contact.kind !== 'narrow') throw new Error('contact is not narrowed');
    expect(contact.base).toEqual({ kind: 'ref', name: 'PatientContact' });
    expect(field(contact, 'name').type).toEqual({
      kind: 'require',
      base: { kind: 'ref', name: 'HumanName' },
      keys: ['family'],
    });
  });

  test('a narrowed backbone element refers to itself where it recurses', () => {
    const m = model('recursive-questionnaire');
    const item = decl(m, 'RecursiveQuestionnaireItem');
    expect(field(item, 'text')).toMatchObject({ optional: false });
    expect(field(item, 'item').type).toEqual({
      kind: 'array',
      of: { kind: 'ref', name: 'RecursiveQuestionnaireItem' },
    });
  });

  test('a choice narrowed to fewer types omits the others', () => {
    const t = decl(model('choice-observation'));
    if (t.kind !== 'narrow') throw new Error('not narrowed');
    expect(t.omit).toEqual(
      expect.arrayContaining(['valueString', 'valueBoolean', 'effectiveInstant']),
    );
    expect(t.omit).not.toContain('valueQuantity');
    expect(t.omit).not.toContain('effectiveDateTime');
  });

  test('a required choice with several types is exactly one of them', () => {
    const t = decl(model('required-choice-observation'));
    if (t.kind !== 'narrow') throw new Error('not narrowed');
    expect(
      t.oneOf?.[0]?.map((branch) => branch.map((f) => [f.name, f.optional, f.type.kind])),
    ).toEqual([
      [
        ['valueQuantity', false, 'ref'],
        ['valueString', true, 'never'],
      ],
      [
        ['valueString', false, 'primitive'],
        ['valueQuantity', true, 'never'],
      ],
    ]);
  });

  test('fixed values are exact; patterns on a Coding stay open', () => {
    const m = model('fixed-pattern-encounter');
    const t = decl(m);
    expect(field(t, 'status').type).toEqual({ kind: 'literal', value: 'finished' });
    expect(field(t, 'class').type).toEqual({
      kind: 'object',
      fields: [
        { name: 'code', optional: false, type: { kind: 'literal', value: 'AMB' } },
        {
          name: 'system',
          optional: false,
          type: { kind: 'literal', value: 'http://terminology.hl7.org/CodeSystem/v3-ActCode' },
        },
      ],
    });
    expect(field(t, 'priority')).toMatchObject({
      optional: true,
      type: { kind: 'object', fields: [{ name: 'coding', type: { kind: 'tuple' } }] },
    });
    const history = decl(m, 'FixedPatternEncounterClassHistory');
    expect(field(history, 'class').type).toMatchObject({
      kind: 'narrow',
      base: { kind: 'ref', name: 'Coding' },
      omit: ['code', 'system'],
    });
  });

  test('a pattern CodeableConcept is documented, not typed', () => {
    const t = decl(model('fixed-pattern-observation'));
    expect(field(t, 'status').type).toEqual({ kind: 'literal', value: 'final' });
    if (t.kind !== 'narrow') throw new Error('not narrowed');
    expect(t.fields.some((f) => f.name === 'code')).toBe(false);
    expect(model('fixed-pattern-observation').doc.join('\n')).toContain('8302-2');
  });

  test('narrows reference targets', () => {
    const t = decl(model('references-observation'));
    expect(field(t, 'performer').type).toEqual({
      kind: 'array',
      of: { kind: 'ref', name: 'Reference', args: [{ kind: 'ref', name: 'Patient' }] },
    });
  });

  test('profiles sharing a name are named from their URLs', () => {
    expect(models('naming-patient-a', 'naming-patient-b').map((m) => m.typeName)).toEqual([
      'NamingPatientA',
      'NamingPatientB',
    ]);
    expect(model('naming-patient-a').typeName).toBe('NamingPatient');
  });

  describe('slices', () => {
    test('each slice gets a typed shape; an open slicing keeps the plain array', () => {
      const m = model('sliced-observation');
      const systolic = decl(m, 'SlicedObservationSystolic');
      if (systolic.kind !== 'narrow') throw new Error('systolic is not narrowed');
      expect(systolic.base).toEqual({ kind: 'ref', name: 'ObservationComponent' });
      expect(field(systolic, 'valueQuantity').type).toMatchObject({
        kind: 'require',
        keys: ['value'],
      });
      // Open and unordered, so component keeps its plain base array: only required.
      expect(decl(m)).toEqual({
        kind: 'require',
        base: { kind: 'ref', name: 'Observation' },
        keys: expect.arrayContaining(['component']),
      });
    });

    test('closed slicing is a union of the slice shapes; ordered slicing is a tuple', () => {
      const t = decl(model('sliced-patient'));
      expect(field(t, 'identifier').type).toEqual({
        kind: 'array',
        of: {
          kind: 'union',
          of: [
            { kind: 'ref', name: 'SlicedPatientMrn' },
            { kind: 'ref', name: 'SlicedPatientMember' },
          ],
        },
      });
      expect(field(t, 'name').type).toMatchObject({
        kind: 'tuple',
        of: [
          { kind: 'ref', name: 'SlicedPatientOfficial' },
          { kind: 'optional' },
          { kind: 'rest' },
        ],
      });
    });

    test('an extension slice is typed from its extension profile, recursing into complex ones', () => {
      const m = model('optional-extensions-patient');
      expect(field(decl(m, 'OptionalExtensionsPatientFavoriteColor'), 'url').type).toEqual({
        kind: 'literal',
        value: `${PLUMB}/favorite-color`,
      });
      expect(field(decl(m, 'OptionalExtensionsPatientCareNote'), 'valueString').type).toEqual({
        kind: 'never',
      });
      expect(field(decl(m, 'OptionalExtensionsPatientCareNoteInstruction'), 'url').type).toEqual({
        kind: 'literal',
        value: 'instruction',
      });
    });

    test('each slice with discriminator values gets a builder and a getter', () => {
      const m = model('sliced-observation');
      expect(m.helpers.map((h) => [h.kind, h.name, h.shape, h.element])).toEqual(
        expect.arrayContaining([
          ['build', 'systolic', 'SlicedObservationSystolic', 'component'],
          ['get', 'getSystolic', 'SlicedObservationSystolic', 'component'],
        ]),
      );
      expect(m.helpers.find((h) => h.name === 'systolic')?.values).toEqual({
        code: { coding: [{ code: '8480-6', system: 'http://loinc.org' }] },
      });
    });

    test('a discriminator through a repeating element builds an array entry', () => {
      // A leading run of capitals lowercases as a run: VSCat becomes vsCat.
      const builder = bloodPressure().helpers.find((h) => h.name === 'vsCat');
      expect(builder?.values).toEqual({
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/observation-category',
            code: 'vital-signs',
          },
        ],
      });
    });

    test('the doc comment says a missing required slice is caught at run time', () => {
      expect(model('sliced-observation').doc.join('\n')).toContain('component:systolic: 1..1');
    });
  });

  describe('bindings', () => {
    const colors = 'http://example.org/fhir/plumb-test/CodeSystem/plumb-test-colors';
    const literals = (...values: string[]) => ({
      kind: 'union',
      of: values.map((value) => ({ kind: 'literal', value })),
    });

    test('a required binding on a code, listable, is a literal union', () => {
      expect(field(decl(model('bindings-patient')), 'gender').type).toEqual(
        literals('female', 'male'),
      );
    });

    test('a required binding on a Coding is a union per system', () => {
      const meta = field(decl(model('bindings-patient')), 'meta').type;
      if (meta.kind !== 'narrow') throw new Error('meta is not narrowed');
      expect(field(meta, 'tag').type).toEqual({
        kind: 'array',
        of: {
          kind: 'narrow',
          base: { kind: 'ref', name: 'Coding' },
          omit: ['system', 'code'],
          fields: [],
          oneOf: [
            [
              [
                { name: 'system', optional: false, type: { kind: 'literal', value: colors } },
                { name: 'code', optional: false, type: literals('red', 'green', 'blue') },
              ],
            ],
          ],
        },
      });
    });

    test('a required binding on a CodeableConcept keeps the type and exports the codes', () => {
      const m = model('bindings-patient');
      const t = decl(m);
      if (t.kind !== 'narrow') throw new Error('not narrowed');
      expect(t.fields.some((f) => f.name === 'maritalStatus')).toBe(false);
      expect(m.constants).toContainEqual({
        name: 'BindingsPatientMaritalStatusCodes',
        codes: [
          { system: colors, code: 'red', display: 'Red' },
          { system: colors, code: 'green', display: 'Green' },
          { system: colors, code: 'blue', display: 'Blue' },
        ],
      });
    });

    test('a value set that cannot be listed, or is too large, keeps the base type and is documented', () => {
      const patient = model('bindings-patient');
      const meta = field(decl(patient), 'meta').type;
      if (meta.kind !== 'narrow') throw new Error('meta is not narrowed');
      expect(meta.fields.some((f) => f.name === 'security')).toBe(false);
      expect(patient.doc.join('\n')).toContain('plumb-test-findings');
      const observation = model('bindings-observation');
      expect(JSON.stringify(decl(observation))).not.toContain('c001');
      expect(observation.doc.join('\n')).toContain('plumb-test-large-vs');
    });

    test('an extensible binding on a code suggests its codes without rejecting others', () => {
      const component = decl(model('bindings-observation'), 'BindingsObservationComponent');
      if (component.kind !== 'narrow') throw new Error('component is not narrowed');
      const quantity = field(component, 'valueQuantity').type;
      if (quantity.kind !== 'narrow') throw new Error('valueQuantity is not narrowed');
      expect(field(quantity, 'code').type).toEqual({
        kind: 'union',
        of: [
          { kind: 'literal', value: 'g' },
          { kind: 'literal', value: 'kg' },
          { kind: 'otherString' },
        ],
      });
    });
  });

  test('lists invariants the type cannot check in the doc comment', () => {
    expect(model('nesting-patient').doc.join('\n')).toContain('plumb-name-part');
  });
});

describe('discriminatorValues', () => {
  const slice = (elements: SliceDefinition['elements']): SliceDefinition =>
    ({
      name: 's',
      path: 'X.x',
      min: 0,
      max: 1,
      type: [],
      description: '',
      elements,
    }) as SliceDefinition;
  const slicing = (type: string, path: string): SlicingRules => ({
    discriminator: [{ type, path }],
    ordered: false,
    slices: [],
  });
  const coding = { system: 'http://loinc.org', code: '1' };

  test('a value for a repeating element is one entry of it', () => {
    const s = slice({
      coding: {
        path: 'X.coding',
        min: 0,
        max: 5,
        isArray: true,
        type: [],
        description: '',
        pattern: { type: 'Coding', value: coding },
      },
    });
    expect(discriminatorValues(slicing('pattern', 'coding'), s)).toEqual({ coding: [coding] });
  });

  test('only value and pattern discriminators have values', () => {
    const s = slice({
      'value[x]': {
        path: 'X.value[x]',
        min: 0,
        max: 1,
        type: [],
        description: '',
        fixed: { type: 'string', value: 'a' },
      },
    });
    expect(discriminatorValues(slicing('type', 'value[x]'), s)).toBeUndefined();
    expect(discriminatorValues(slicing('value', 'value[x]'), s)).toEqual({ 'value[x]': 'a' });
  });
});
