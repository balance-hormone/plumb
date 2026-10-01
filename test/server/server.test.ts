// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest';
import { connect, server } from './medplum.js';

test.skipIf(!server)('the CI client creates a resource and reads it back', async () => {
  const medplum = await connect();
  const created = await medplum.createResource({
    resourceType: 'Patient',
    name: [{ family: 'Synthetic', given: ['Grace'] }],
  });
  const read = await medplum.readResource('Patient', created.id);
  expect(read.meta?.project).toBe(server?.projectId);
  expect(read.name).toEqual(created.name);
  // The data seeded for this run is there too.
  expect(await medplum.searchResources('Observation')).toHaveLength(1);
});
