// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { ResourceType } from '@medplum/fhirtypes';

export async function reads(medplum: MedplumClient, type: ResourceType) {
  await medplum.readResource('Patient', '1');
  await medplum.readResource('Practitioner', '1');
  await medplum.searchResources('Goal', { status: 'active' });
  await medplum.searchOne(type);
  const either: 'Patient' | 'Practitioner' = Math.random() > 0.5 ? 'Patient' : 'Practitioner';
  await medplum.searchOne(either);
}
