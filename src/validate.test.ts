// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Patient } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { validateProfiled } from './validate.js';

const SYNTHETIC = join(import.meta.dirname, '../test/fixtures/profiles/fsh-generated/resources');
const PLUMB = 'http://example.org/fhir/plumb-test/StructureDefinition';

/** A project selecting two synthetic profiles, with an empty lock as generate writes one. */
function project(lock = true): string {
  const root = mkdtempSync(join(tmpdir(), 'plumb-validate-'));
  writeFileSync(
    join(root, 'plumb.config.ts'),
    `export default {
      igs: [],
      profiles: ['${PLUMB}/cardinality-patient', '${PLUMB}/nesting-patient'],
      local: ${JSON.stringify(SYNTHETIC)},
      out: './generated',
    };`,
  );
  if (lock) {
    writeFileSync(
      join(root, 'plumb.lock'),
      JSON.stringify({ lockfileVersion: 1, igs: [], packages: {} }),
    );
  }
  return root;
}

const patient: Patient = {
  resourceType: 'Patient',
  birthDate: '1970-01-01',
  name: [{ family: 'Tester' }],
};

describe('validateProfiled', () => {
  test('passes a conforming resource, with any warnings', async () => {
    const report = await validateProfiled(patient, `${PLUMB}/cardinality-patient`, {
      cwd: project(),
    });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(Array.isArray(report.warnings)).toBe(true);
  });

  test('reports the errors the validator throws, instead of throwing them', async () => {
    const { birthDate: _, ...noBirthDate } = patient;
    const report = await validateProfiled(noBirthDate, `${PLUMB}/cardinality-patient`, {
      cwd: project(),
    });
    expect(report.ok).toBe(false);
    expect(report.errors.map((i) => i.expression?.[0])).toContain('Patient.birthDate');
    expect(report.errors.every((i) => i.severity === 'error')).toBe(true);
  });

  test('accepts a |version on the profile URL', async () => {
    const report = await validateProfiled(patient, `${PLUMB}/cardinality-patient|0.1.0`, {
      cwd: project(),
    });
    expect(report.ok).toBe(true);
  });

  test('throws when the profile is not one the config selects', async () => {
    await expect(
      validateProfiled(patient, `${PLUMB}/sliced-patient`, { cwd: project() }),
    ).rejects.toThrow(/does not select .*sliced-patient/);
  });

  test('throws what the loader reports, such as a profile no source provides', async () => {
    const root = project();
    const config = join(root, 'plumb.config.ts');
    writeFileSync(
      config,
      readFileSync(config, 'utf8').replace('nesting-patient', 'no-such-profile'),
    );
    await expect(
      validateProfiled(patient, `${PLUMB}/cardinality-patient`, { cwd: root }),
    ).rejects.toThrow(/no-such-profile/);
  });

  test('throws when there is no config, or no lock yet', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'plumb-validate-'));
    await expect(
      validateProfiled(patient, `${PLUMB}/cardinality-patient`, { cwd: empty }),
    ).rejects.toThrow(/No config file/);
    await expect(
      validateProfiled(patient, `${PLUMB}/cardinality-patient`, { cwd: project(false) }),
    ).rejects.toThrow(/plumb generate/);
  });
});
