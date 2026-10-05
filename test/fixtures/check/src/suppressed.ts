// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';

export async function suppressed(medplum: MedplumClient) {
  // plumb-check: the backfill reads unstamped records to stamp them
  await medplum.searchResources('Goal', {});
  // plumb-check:
  await medplum.searchResources('Goal', {});
}
