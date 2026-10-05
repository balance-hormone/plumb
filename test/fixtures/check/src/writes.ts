// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { MedplumClient } from '@medplum/core';
import type { Coverage, Goal, Practitioner } from '@medplum/fhirtypes';
import { stampProfiled } from '../generated/index.js';

const buildGoal = (): Goal => ({
  resourceType: 'Goal',
  lifecycleStatus: 'active',
  description: { text: 'x' },
  subject: { reference: 'Patient/1' },
});

class LocalClient extends MedplumClient {}

export async function writes(
  medplum: MedplumClient,
  local: LocalClient,
  coverage: Coverage,
  either: (Goal & { tag: 'a' }) | (Goal & { tag: 'b' }),
) {
  await medplum.createResource(buildGoal());
  await medplum.createResource(stampProfiled(buildGoal()));
  const stamped = stampProfiled(coverage);
  await medplum.upsertResource(stamped, { beneficiary: 'Patient/1' });
  const practitioner: Practitioner = { resourceType: 'Practitioner' };
  await medplum.updateResource(practitioner);
  await local.createResource(coverage);
  await medplum.createResource(either);
}
