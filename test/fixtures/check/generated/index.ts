// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
// The brand as Plumb generates it in _routes.ts; the folder is never checked.
import type { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';

declare const plumbStamped: unique symbol;
type Stamped = { readonly [plumbStamped]?: true };

export function stampProfiled<T extends Resource>(resource: T): T & Stamped {
  return resource;
}

export const raw = (medplum: MedplumClient) => medplum.readResource('Patient', '1');
