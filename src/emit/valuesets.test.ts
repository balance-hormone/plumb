// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import type { CodeSystem, ValueSet } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { expandValueSet } from './valuesets.js';

const CS = 'http://example.org/fhir/plumb-test/CodeSystem';
const VS = 'http://example.org/fhir/plumb-test/ValueSet';

const codeSystem = (
  name: string,
  concept: CodeSystem['concept'],
  content = 'complete',
): CodeSystem => ({
  resourceType: 'CodeSystem',
  url: `${CS}/${name}`,
  status: 'active',
  content: content as CodeSystem['content'],
  concept,
});
const valueSet = (name: string, compose: ValueSet['compose']): ValueSet => ({
  resourceType: 'ValueSet',
  url: `${VS}/${name}`,
  status: 'active',
  compose,
});

const resources = [
  codeSystem('colors', [{ code: 'red' }, { code: 'green', concept: [{ code: 'lime' }] }]),
  codeSystem('stub', [], 'not-present'),
  valueSet('all-colors', { include: [{ system: `${CS}/colors` }] }),
  valueSet('two', {
    include: [{ system: `${CS}/colors`, concept: [{ code: 'red' }, { code: 'blue' }] }],
  }),
  valueSet('no-lime', {
    include: [{ system: `${CS}/colors` }],
    exclude: [{ system: `${CS}/colors`, concept: [{ code: 'lime' }] }],
  }),
  valueSet('nested', { include: [{ valueSet: [`${VS}/two`] }] }),
  valueSet('rules', {
    include: [
      { system: `${CS}/colors`, filter: [{ property: 'concept', op: 'is-a', value: 'green' }] },
    ],
  }),
  valueSet('stubbed', { include: [{ system: `${CS}/stub` }] }),
  valueSet('elsewhere', { include: [{ system: 'http://snomed.info/sct' }] }),
  {
    ...valueSet('expanded', undefined),
    expansion: { timestamp: '2026-01-01', contains: [{ system: `${CS}/colors`, code: 'red' }] },
  } as ValueSet,
];
const lookup = (url: string) => resources.find((r) => r.url === url.split('|')[0]);
const codes = (url: string) =>
  expandValueSet(url, lookup)?.map((c) => `${c.system.slice(CS.length + 1)}#${c.code}`);

describe('expandValueSet', () => {
  test('every code of an included code system, walking nested concepts', () => {
    expect(codes(`${VS}/all-colors`)).toEqual(['colors#red', 'colors#green', 'colors#lime']);
  });

  test('an explicit concept list, and value sets included by another', () => {
    expect(codes(`${VS}/two`)).toEqual(['colors#red', 'colors#blue']);
    expect(codes(`${VS}/nested`)).toEqual(['colors#red', 'colors#blue']);
  });

  test('excludes, and a version pin on the value set URL', () => {
    expect(codes(`${VS}/no-lime|1.0.0`)).toEqual(['colors#red', 'colors#green']);
  });

  test('a pre-built expansion', () => {
    expect(codes(`${VS}/expanded`)).toEqual(['colors#red']);
  });

  test('cannot list rules, code systems without their concepts, or what is not loaded', () => {
    expect(expandValueSet(`${VS}/rules`, lookup)).toBeUndefined();
    expect(expandValueSet(`${VS}/stubbed`, lookup)).toBeUndefined();
    expect(expandValueSet(`${VS}/elsewhere`, lookup)).toBeUndefined();
    expect(expandValueSet(`${VS}/missing`, lookup)).toBeUndefined();
  });
});
