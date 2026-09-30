// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { validateProfiled } from '../../src/validate.js';
import { contractTables, usCoreCases, validates } from './fixtures.js';

// A project whose cache is the fixture packages, selecting every profile under test.
const FIXTURES = join(import.meta.dirname, '../fixtures');
const cacheDir = join(FIXTURES, 'packages');
const root = mkdtempSync(join(tmpdir(), 'plumb-harness-validate-'));
const profiles = [
  ...new Set([
    ...contractTables.map((t) => t.profile),
    ...usCoreCases.flatMap((c) => (c.profile && !c.unparseable ? [c.profile] : [])),
  ]),
];
writeFileSync(
  join(root, 'plumb.config.ts'),
  `export default ${JSON.stringify({
    igs: ['hl7.fhir.us.core@9.0.0'],
    profiles,
    local: join(FIXTURES, 'profiles/fsh-generated/resources'),
    out: './generated',
  })};`,
);
writeFileSync(
  join(root, 'plumb.lock'),
  JSON.stringify({
    lockfileVersion: 1,
    igs: ['hl7.fhir.us.core@9.0.0'],
    packages: Object.fromEntries(
      readdirSync(cacheDir).map((folder) => [folder.replace('#', '@'), { integrity: 'fixture' }]),
    ),
  }),
);
const options = { cwd: root, cacheDir };

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
