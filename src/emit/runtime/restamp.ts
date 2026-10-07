// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

// _restamp.ts after its imports, which name generated siblings; these name their sources.
// printRestamp fills in TYPES.
import type { Resource, ResourceType } from '@medplum/fhirtypes';
import type { JsonPatchOperation, MigrationDefinition } from './migrations.js';
import { RoutingError } from './route.js';
import { stampProfiled } from './write.js';

declare const TYPES: string[];

// Generated files hold what follows this line.
/** One per type with routing rows; each runs again whenever _routes.ts changes. */
export const restamps: MigrationDefinition[] = (TYPES as ResourceType[]).map((resourceType) => ({
  id: 'plumb-restamp-' + resourceType,
  resourceType,
  transform: restamp,
}));

function restamp(resource: Resource): JsonPatchOperation[] | undefined {
  let next: Resource;
  try {
    next = stampProfiled(resource);
  } catch (err) {
    if (err instanceof RoutingError) return undefined;
    throw err;
  }
  const before = resource.meta?.profile ?? [];
  const after = next.meta?.profile ?? [];
  if (before.length === after.length && before.every((url, i) => url === after[i])) return undefined;
  if (!resource.meta) return [{ op: 'add', path: '/meta', value: { profile: after } }];
  return after.length > 0
    ? [{ op: 'add', path: '/meta/profile', value: after }]
    : [{ op: 'remove', path: '/meta/profile' }];
}
