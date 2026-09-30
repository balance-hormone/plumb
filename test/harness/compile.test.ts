// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import type { Patient, Resource } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { baseType, compileCases } from './compile.js';

// "No diagnostics" is every passing row's result, so prove the check can fail.
test('reports each case’s diagnostics, honouring @ts-expect-error', () => {
  const valid: Patient = { resourceType: 'Patient', gender: 'unknown' };
  const invalid = JSON.parse('{"resourceType":"Patient","gender":"bogus"}') as Resource;
  const [validOk, invalidOk, invalidExpected, validExpected] = compileCases('compile-self-test', [
    { type: baseType(valid), resource: valid, compiles: true },
    { type: baseType(invalid), resource: invalid, compiles: true },
    { type: baseType(invalid), resource: invalid, compiles: false },
    { type: baseType(valid), resource: valid, compiles: false },
  ]);
  expect(validOk).toEqual([]);
  expect(invalidOk).toEqual([expect.stringContaining('error TS2322')]);
  expect(invalidExpected).toEqual([]);
  expect(validExpected).toEqual([expect.stringContaining('error TS2578')]);
});

test('keeps a multi-line diagnostic with its case', () => {
  // Assigning one type to another is explained over several lines.
  const [diagnostics] = compileCases('compile-self-test-nested', [
    {
      type: { module: '@medplum/fhirtypes', typeName: 'HumanName' },
      source: { module: '@medplum/fhirtypes', typeName: 'ContactPoint' },
      compiles: true,
    },
  ]);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics?.[0]).toContain('\n');
});
