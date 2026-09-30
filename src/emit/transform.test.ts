// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadProfiles } from '../loader.js';
import { type Field, type ProfileModel, type TypeExpr, transform } from './transform.js';

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

  test('lists invariants the type cannot check in the doc comment', () => {
    expect(model('nesting-patient').doc.join('\n')).toContain('plumb-name-part');
  });
});
