// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import type { StructureDefinition } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { planLoad } from './push.js';

const sd = (url: string, version: string, extra: Partial<StructureDefinition> = {}) =>
  ({
    resourceType: 'StructureDefinition',
    url,
    version,
    name: 'Profile',
    status: 'active',
    kind: 'resource',
    abstract: false,
    type: 'Patient',
    ...extra,
  }) as StructureDefinition;

test('plans each definition against the one the project holds under its URL', () => {
  const planned = [
    sd('http://x/new', '1.0.0'),
    sd('http://x/same', '1.0.0'),
    sd('http://x/bumped', '1.10.0'),
    sd('http://x/edited', '1.0.0', { description: 'changed' }),
    sd('http://x/shadowed', '1.0.0'),
  ];
  const held = new Map([
    // The server's id and meta are not content.
    ['http://x/same', [sd('http://x/same', '1.0.0', { id: 'a', meta: { versionId: '2' } })]],
    ['http://x/bumped', [sd('http://x/bumped', '1.9.0')]],
    ['http://x/edited', [sd('http://x/edited', '1.0.0')]],
    ['http://x/shadowed', [sd('http://x/shadowed', '0.9.0'), sd('http://x/shadowed', '1.0.0')]],
  ]);
  expect(planLoad(planned, held)).toEqual([
    { url: 'http://x/new', version: '1.0.0', action: 'create' },
    { url: 'http://x/same', version: '1.0.0', held: '1.0.0', action: 'unchanged' },
    { url: 'http://x/bumped', version: '1.10.0', held: '1.9.0', action: 'update' },
    { url: 'http://x/edited', version: '1.0.0', held: '1.0.0', action: 'update', edited: true },
    { url: 'http://x/shadowed', version: '1.0.0', action: 'shadowed' },
  ]);
});
