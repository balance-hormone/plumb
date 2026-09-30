// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest';
import {
  type CompileCase,
  compileCases,
  expectedFailureEntries,
  generateTypes,
  isExpectedFailure,
} from './compile.js';
import {
  type ContractFixture,
  contractTables,
  TYPE_GAPS,
  usCoreCases,
  VALIDATOR_GAPS,
  validates,
} from './fixtures.js';

const profileTypes = generateTypes(
  'contracts',
  contractTables.flatMap((table) => [table.profile, ...(table.assignableTo ?? [])]),
);
const cases = new Map<ContractFixture | string, CompileCase>();
for (const table of contractTables) {
  const type = profileTypes.get(table.profile);
  if (!type) continue;
  for (const fixture of table.fixtures) {
    cases.set(fixture, { type, resource: fixture.resource, compiles: fixture.compiles });
  }
  for (const parent of table.assignableTo ?? []) {
    const parentType = profileTypes.get(parent);
    if (parentType) {
      cases.set(`${table.profile} > ${parent}`, { type: parentType, source: type, compiles: true });
    }
  }
}
const results = compileCases('contracts', [...cases.values()]);
const diagnostics = new Map([...cases.keys()].map((key, i) => [key, results[i]]));

// A row on the list runs as an expected failure, so CI stays green while it
// stays visible; one that starts passing fails until it is removed.
const compileTest = (profile: string, row: string) =>
  isExpectedFailure(profile, row) ? test.fails : test;

describe.each(contractTables)('$file', (table) => {
  describe.each(table.fixtures)('$name', (fixture) => {
    test('validates as recorded', () => {
      expect(validates(fixture.resource, table.profile)).toBe(fixture.validates);
    });

    compileTest(table.profile, fixture.name)(`compiles: ${fixture.compiles}`, () => {
      expect(profileTypes.has(table.profile), 'no generated type').toBe(true);
      expect(diagnostics.get(fixture)).toEqual([]);
    });

    // A row may disagree with conforms only through a gap listed in design 01.
    test('names a gap exactly when it disagrees with conforms', () => {
      if (fixture.compiles === fixture.conforms) expect(fixture.typeGap).toBeUndefined();
      else expect(TYPE_GAPS).toContain(fixture.typeGap);
      if (fixture.validates === fixture.conforms) expect(fixture.validatorGap).toBeUndefined();
      else expect(VALIDATOR_GAPS).toContain(fixture.validatorGap);
    });
  });

  for (const parent of table.assignableTo ?? []) {
    compileTest(table.profile, `assignable to ${parent}`)(`is assignable to ${parent}`, () => {
      expect(profileTypes.has(table.profile) && profileTypes.has(parent), 'no generated type').toBe(
        true,
      );
      expect(diagnostics.get(`${table.profile} > ${parent}`)).toEqual([]);
    });
  }
});

test('expected-failures.json lists only rows under test', () => {
  const rows = new Set([
    ...contractTables.flatMap((table) => [
      table.profile,
      ...table.fixtures.map((f) => `${table.profile}#${f.name}`),
      ...(table.assignableTo ?? []).map((p) => `${table.profile}#assignable to ${p}`),
    ]),
    ...usCoreCases.flatMap((c) => (c.profile ? [c.profile, `${c.profile}#${c.name}`] : [])),
  ]);
  expect(expectedFailureEntries.filter((entry) => !rows.has(entry))).toEqual([]);
});
