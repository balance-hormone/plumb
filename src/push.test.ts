// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';
import type { StructureDefinition } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { loadProfiles } from './loader.js';
import { boundTerminology, planLoad } from './push.js';

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
    sd('http://example.org/fhir/new', '1.0.0'),
    sd('http://example.org/fhir/same', '1.0.0'),
    sd('http://example.org/fhir/bumped', '1.10.0'),
    sd('http://example.org/fhir/edited', '1.0.0', { description: 'changed' }),
    sd('http://example.org/fhir/shadowed', '1.0.0'),
  ];
  const held = new Map([
    // The server's id and meta are not content.
    [
      'http://example.org/fhir/same',
      [sd('http://example.org/fhir/same', '1.0.0', { id: 'a', meta: { versionId: '2' } })],
    ],
    ['http://example.org/fhir/bumped', [sd('http://example.org/fhir/bumped', '1.9.0')]],
    ['http://example.org/fhir/edited', [sd('http://example.org/fhir/edited', '1.0.0')]],
    [
      'http://example.org/fhir/shadowed',
      [
        sd('http://example.org/fhir/shadowed', '0.9.0'),
        sd('http://example.org/fhir/shadowed', '1.0.0'),
      ],
    ],
  ]);
  expect(planLoad(planned, held)).toEqual([
    {
      resourceType: 'StructureDefinition',
      url: 'http://example.org/fhir/new',
      version: '1.0.0',
      action: 'create',
    },
    {
      resourceType: 'StructureDefinition',
      url: 'http://example.org/fhir/same',
      version: '1.0.0',
      held: '1.0.0',
      action: 'unchanged',
    },
    {
      resourceType: 'StructureDefinition',
      url: 'http://example.org/fhir/bumped',
      version: '1.10.0',
      held: '1.9.0',
      action: 'update',
    },
    {
      resourceType: 'StructureDefinition',
      url: 'http://example.org/fhir/edited',
      version: '1.0.0',
      held: '1.0.0',
      action: 'update',
      edited: true,
    },
    {
      resourceType: 'StructureDefinition',
      url: 'http://example.org/fhir/shadowed',
      version: '1.0.0',
      action: 'shadowed',
    },
  ]);
});

test('plans the ValueSets and CodeSystems the selected profiles bind, CodeSystems first', () => {
  const loaded = loadProfiles({
    packages: [],
    igs: [],
    local: join(import.meta.dirname, '../test/fixtures/profiles/fsh-generated/resources'),
    profiles: ['http://example.org/fhir/plumb-test/StructureDefinition/bindings-patient'],
  });
  const { terminology, codeless } = boundTerminology(loaded);
  const urls = terminology.map((t) => `${t.resourceType} ${t.url?.split('/').pop()}`);
  // Base R4's administrative-gender, which gender-subset includes, is the server's own.
  expect(urls).toEqual([
    'CodeSystem plumb-test-colors',
    'ValueSet plumb-test-findings',
    'ValueSet plumb-test-colors-vs',
    'ValueSet plumb-test-gender-subset',
  ]);
  expect(codeless).toEqual([]);
});
