// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest';
import { baseType, compileCases, generateTypes, type ProfileType } from './compile.js';
import { contractTables } from './fixtures.js';
import { generatedRoutes } from './routes.js';

// Design 04: the presence check follows the type. A fixture that compiles
// passes it; one that fails it does not compile; and one that tsc reports
// missing an element the base type does not require fails it.
const profiles = contractTables.map((table) => table.profile);
const generated = await generatedRoutes(profiles);
const types = generateTypes('reads', profiles);
const failing = contractTables.flatMap((table) =>
  table.fixtures.filter((f) => !f.compiles).map((fixture) => ({ table, fixture })),
);
// Compiled as if they should, so each one's diagnostics say why it does not.
const diagnostics = compileCases(
  'reads',
  failing.flatMap(({ table, fixture }) => [
    { type: types.get(table.profile) as ProfileType, resource: fixture.resource, compiles: true },
    { type: baseType(fixture.resource), resource: fixture.resource, compiles: true },
  ]),
);
const forMissing = new Set(
  failing
    .filter((_, i) => {
      const profiled = diagnostics[2 * i] ?? [];
      const base = diagnostics[2 * i + 1] ?? [];
      return base.length === 0 && profiled.some((d) => /is missing in type/.test(d));
    })
    .map(({ fixture }) => fixture),
);

describe.each(contractTables)('$file', (table) => {
  test.each(table.fixtures)('$name', (fixture) => {
    const missing = generated.missing(fixture.resource, table.profile);
    if (fixture.compiles) expect(missing).toEqual([]);
    if (forMissing.has(fixture)) expect(missing).not.toEqual([]);
  });
});

test('fixtures fail to compile for a missing element', () => {
  expect(forMissing.size).toBeGreaterThan(10);
});
