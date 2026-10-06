// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Observation, Project, StructureDefinition } from '@medplum/fhirtypes';
import { beforeAll, describe, expect, test } from 'vitest';
import { type GeneratedRoutes, generatedRoutes } from '../harness/routes.js';
import { connect, server } from './medplum.js';
import { newProject, type TestProject } from './setup.js';

const PLUMB = 'http://example.org/fhir/plumb-test/StructureDefinition';
const PARENT = `${PLUMB}/parent-observation`;
const CHILD = `${PLUMB}/child-observation`;
const FIXED = `${PLUMB}/fixed-pattern-observation`;
// A default the config does not select, as a project's own profile would be.
const ORG = `${PLUMB}/required-choice-observation`;
const FOREIGN = 'https://example.org/fhir/StructureDefinition/someone-elses';
const LOINC = 'http://loinc.org';
const SYNTHETIC = join(import.meta.dirname, '../fixtures/profiles/fsh-generated/resources');

// Writes profiles and changes the project's defaultProfile, so it has a project of its own.
describe.skipIf(!server)(
  'createProfiled and updateProfiled on a real server',
  { timeout: 60_000 },
  () => {
    let project: TestProject;
    let medplum: MedplumClient;
    let r: GeneratedRoutes;
    let subject: { reference: string };
    const observation = (code: string, extra: Partial<Observation> = {}): Observation => ({
      resourceType: 'Observation',
      status: 'final',
      code: { coding: [{ system: LOINC, code }] },
      subject,
      effectiveDateTime: '2026-01-01T09:00:00Z',
      valueQuantity: { value: 1 },
      ...extra,
    });

    beforeAll(async () => {
      project = await newProject();
      medplum = await connect(project);
      for (const name of [
        'parent-observation',
        'child-observation',
        'fixed-pattern-observation',
        'required-choice-observation',
      ]) {
        const { id: _, ...sd } = JSON.parse(
          readFileSync(join(SYNTHETIC, `StructureDefinition-${name}.json`), 'utf8'),
        ) as StructureDefinition;
        await medplum.createResource(sd);
      }
      const patient = await medplum.createResource({ resourceType: 'Patient' });
      subject = { reference: `Patient/${patient.id}` };
      r = await generatedRoutes(
        [PARENT, CHILD, FIXED],
        { [PARENT]: { code: [{ system: LOINC, code: '29463-7' }] } },
        { Observation: [PARENT, ORG] },
      );
    }, 60_000);

    test('stores the defaults plus the routed profile', async () => {
      const created = await r.createProfiled(medplum, observation('39156-5'));
      const stored = await medplum.readResource('Observation', created.id as string);
      expect(stored.meta?.profile).toEqual([ORG, CHILD]);
    });

    test('the server validates against the defaults as well as the routed profile', async () => {
      // Fixed-pattern needs no subject or effective time; the parent default does.
      const bare = observation('8302-2', { subject: undefined, effectiveDateTime: undefined });
      await expect(r.createProfiled(medplum, bare)).rejects.toThrow(/subject|effective/);
      // And the org default needs a value.
      await expect(
        r.createProfiled(medplum, observation('8302-2', { valueQuantity: undefined })),
      ).rejects.toThrow(/value/);
      const ok = await r.createProfiled(medplum, observation('8302-2'));
      expect(ok.meta?.profile).toEqual([PARENT, ORG, FIXED]);
    });

    test('a resource routing refuses never reaches the server', async () => {
      await expect(r.createProfiled(medplum, observation('0000-0'))).rejects.toBeInstanceOf(
        r.RoutingError,
      );
      expect(
        await medplum.searchResources('Observation', { code: `${LOINC}|0000-0` }),
      ).toHaveLength(0);
    });

    test('updateProfiled re-routes, restamps, and keeps URLs Plumb does not manage', async () => {
      const created = await r.createProfiled(medplum, observation('39156-5'));
      const recoded = {
        ...created,
        code: { coding: [{ system: LOINC, code: '8302-2' }] },
        meta: { ...created.meta, profile: [FOREIGN, ...(created.meta?.profile ?? [])] },
      };
      await r.updateProfiled(medplum, recoded);
      const stored = await medplum.readResource('Observation', created.id as string);
      expect(stored.meta?.profile).toEqual([FOREIGN, PARENT, ORG, FIXED]);
    });

    // Last: it sets the project's own default for every later write.
    test('{ profile: false } writes no stamp, so the server applies its own default', async () => {
      const stored = await medplum.readResource('Project', project.projectId);
      await medplum.updateResource<Project>({
        ...stored,
        defaultProfile: [{ resourceType: 'Observation', profile: [ORG] }],
      });
      const fresh = await connect(project);
      // The server's default (the org profile) needs a value.
      await expect(
        r.createProfiled(fresh, observation('0000-0', { valueQuantity: undefined }), {
          profile: false,
        }),
      ).rejects.toThrow(/value/);
      // The server applies its default, and stores it as the stamp.
      const ok = await r.createProfiled(fresh, observation('0000-0'), { profile: false });
      expect(ok.meta?.profile).toEqual([ORG]);
    });
  },
);
