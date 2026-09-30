// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest';
import {
  baseType,
  type CompileCase,
  compileCases,
  generateTypes,
  isExpectedFailure,
} from './compile.js';
import { type UsCoreCase, usCoreCases, usCoreExpectations, validates } from './fixtures.js';

const profileTypes = generateTypes(
  'us-core-examples',
  usCoreCases.flatMap((c) => (c.profile && !c.unparseable ? [c.profile] : [])),
);

// Examples with no parseable US Core profile compile against their base type.
const typeOf = (c: UsCoreCase) =>
  c.profile && !c.unparseable ? profileTypes.get(c.profile) : baseType(c.resource);

const cases = new Map<UsCoreCase, CompileCase>();
for (const c of usCoreCases) {
  const type = typeOf(c);
  if (type) cases.set(c, { type, resource: c.resource, compiles: true });
}
const results = compileCases('us-core-examples', [...cases.values()]);
const diagnostics = new Map([...cases.keys()].map((key, i) => [key, results[i]]));

describe.each(usCoreCases)('$name', (c) => {
  if (c.unparseable && c.profile) {
    const reason = usCoreExpectations.unparseableProfiles.profiles[c.profile];
    test('cannot be validated against its unparseable profile', () => {
      expect(() => validates(c.resource, c.profile)).toThrow(reason);
    });
  } else {
    test(`validates against ${c.profile ?? 'its base type'}`, () => {
      expect(validates(c.resource, c.profile)).toBe(true);
    });
  }

  if (c.primitiveExtension) {
    test('does not compile, for its _field', () => {
      expect(diagnostics.get(c)?.some((d) => d.includes('"_'))).toBe(true);
    });
    return;
  }
  const pending = c.profile !== undefined && isExpectedFailure(c.profile, c.name);
  (pending ? test.fails : test)('compiles', () => {
    expect(typeOf(c), 'no generated type').toBeDefined();
    expect(diagnostics.get(c)).toEqual([]);
  });
});
