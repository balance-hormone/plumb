// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest';
import { connectAs, testProject } from '../../../src/testing.js';

test('the run has a project, pushed from the config', async () => {
  const admin = await connectAs(testProject());
  await admin.createResource({
    resourceType: 'Observation',
    status: 'final',
    code: { text: 'Synthetic' },
  });
  const frontDesk = await connectAs(testProject(), { accessPolicy: 'front-desk' });
  await expect(frontDesk.searchResources('Observation')).rejects.toThrow(/forbidden/i);
});

test('the project is strict, with the configured profile', async () => {
  const admin = await connectAs(testProject());
  await expect(
    admin.createResource({
      resourceType: 'Patient',
      meta: {
        profile: ['http://example.org/fhir/plumb-test/StructureDefinition/cardinality-patient'],
      },
    }),
  ).rejects.toThrow(/name|birthDate/);
});
