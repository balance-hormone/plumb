// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';
import type { StructureDefinition } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { loadProfiles } from './loader.js';
import { boundTerminology, gatedProfiles, type PlannedDefinition, planLoad } from './push.js';

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

test("refuses a URL only a linked project holds, rather than updating that project's copy", () => {
  const url = 'http://example.org/fhir/theirs';
  const theirs = sd(url, '1.0.0', { meta: { project: 'linked' } });
  const plan = planLoad(
    [sd(url, '1.0.0')],
    new Map([[url, [theirs]]]),
    (d) => d.meta?.project === 'ours',
  );
  expect(plan).toEqual([
    { resourceType: 'StructureDefinition', url, version: '1.0.0', action: 'linked' },
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

describe('the gate reads only what is stamped with a changed profile', () => {
  const PLUMB = 'http://example.org/fhir/plumb-test/StructureDefinition';
  const loaded = loadProfiles({
    packages: [],
    igs: [],
    local: join(import.meta.dirname, '../test/fixtures/profiles/fsh-generated/resources'),
    profiles: [
      `${PLUMB}/cardinality-patient`,
      `${PLUMB}/extensions-patient`,
      `${PLUMB}/fixed-pattern-encounter`,
      `${PLUMB}/child-observation`,
    ],
  });
  const updated = (...names: string[]): PlannedDefinition[] =>
    names.map((name) => ({
      resourceType: 'StructureDefinition',
      url: `${PLUMB}/${name}`,
      version: '0.2.0',
      held: '0.1.0',
      action: 'update',
    }));
  const gated = (changes: PlannedDefinition[], strictMode = true) => {
    const { profiles, skipped } = gatedProfiles(loaded, changes, strictMode);
    return { profiles: profiles.map((p) => p.url.slice(PLUMB.length + 1)).sort(), skipped };
  };

  test('a changed profile gates its own records, and no other profile', () => {
    expect(gated(updated('fixed-pattern-encounter'))).toEqual({
      profiles: ['fixed-pattern-encounter'],
      skipped: 3,
    });
  });

  test('a changed extension or parent gates the profiles that depend on it', () => {
    expect(gated(updated('favorite-color'))).toEqual({
      profiles: ['extensions-patient'],
      skipped: 3,
    });
    // A parent push loads is checked too: strict mode enforces it on what it stamps.
    expect(gated(updated('parent-observation'))).toEqual({
      profiles: ['child-observation', 'parent-observation'],
      skipped: 3,
    });
  });

  test('no changed profile gates nothing, and terminology alone changes none', () => {
    expect(gated([])).toEqual({ profiles: [], skipped: 4 });
    const terminology: PlannedDefinition = {
      resourceType: 'ValueSet',
      url: 'http://example.org/fhir/plumb-test/ValueSet/plumb-test-colors-vs',
      action: 'update',
    };
    expect(gated([terminology])).toEqual({ profiles: [], skipped: 4 });
  });

  test('with strict mode off, every profile is gated', () => {
    expect(gated(updated('fixed-pattern-encounter'), false)).toEqual({
      profiles: [
        'cardinality-patient',
        'child-observation',
        'extensions-patient',
        'fixed-pattern-encounter',
      ],
      skipped: 0,
    });
  });
});
