// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest';
import { type CompileCase, compileCases, expectedFailures, profileTypes } from './compile.js';
import {
  type ContractFixture,
  contractTables,
  TYPE_GAPS,
  usCoreCases,
  VALIDATOR_GAPS,
  validates,
} from './fixtures.js';

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

// A profile on the list runs its compile rows as expected failures, so CI stays
// green while they stay visible; one that starts passing fails until it is removed.
const compileTest = (profile: string) => (expectedFailures.has(profile) ? test.fails : test);

describe.each(contractTables)('$file', (table) => {
  describe.each(table.fixtures)('$name', (fixture) => {
    test('validates as recorded', () => {
      expect(validates(fixture.resource, table.profile)).toBe(fixture.validates);
    });

    compileTest(table.profile)(`compiles: ${fixture.compiles}`, () => {
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
    compileTest(table.profile)(`is assignable to ${parent}`, () => {
      expect(profileTypes.has(table.profile) && profileTypes.has(parent), 'no generated type').toBe(
        true,
      );
      expect(diagnostics.get(`${table.profile} > ${parent}`)).toEqual([]);
    });
  }
});

test('expected-failures.json lists only profiles under test', () => {
  const underTest = new Set([
    ...contractTables.map((table) => table.profile),
    ...usCoreCases.flatMap((c) => (c.profile && !c.unparseable ? [c.profile] : [])),
  ]);
  expect([...expectedFailures].filter((url) => !underTest.has(url))).toEqual([]);
});
