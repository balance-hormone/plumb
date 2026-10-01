// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest';
import { validateProfiled } from '../../src/validate.js';
import { contractTables, harnessProject, usCoreCases, validates } from './fixtures.js';

const options = harnessProject();

// validateProfiled promises Medplum's validator's verdict, so it must match a direct call.
describe.each(contractTables)('$file', (table) => {
  test.each(table.fixtures)('$name', async (fixture) => {
    const report = await validateProfiled(fixture.resource, table.profile, options);
    expect(report.ok).toBe(validates(fixture.resource, table.profile));
    expect(report.errors.length > 0).toBe(!report.ok);
  });
});

describe('US Core examples', () => {
  test.each(usCoreCases.filter((c) => c.profile && !c.unparseable))('$name', async (c) => {
    const report = await validateProfiled(c.resource, c.profile as string, options);
    expect(report.ok).toBe(validates(c.resource, c.profile));
  });
});
