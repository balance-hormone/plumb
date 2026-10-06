// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Patient } from '@medplum/fhirtypes';
import { beforeAll, describe, expect, test } from 'vitest';
import { fetchPackages } from '../../src/packages.js';
import { superAdmin } from '../../src/server.js';
import { connectAs, createTestProject, type TestProject } from '../../src/testing.js';
import { server } from './medplum.js';

const PROFILE = 'http://example.org/fhir/plumb-test/StructureDefinition/bindings-patient';
const COLORS = 'http://example.org/fhir/plumb-test/CodeSystem/plumb-test-colors';
const SYNTHETIC = join(import.meta.dirname, '../fixtures/profiles/fsh-generated/resources');

// maritalStatus is bound (required) to a local ValueSet of colours: a binding
// only the pushed terminology can satisfy.
const patient = (code: string): Patient => ({
  resourceType: 'Patient',
  meta: { profile: [PROFILE] },
  maritalStatus: { coding: [{ system: COLORS, code }] },
});

describe.skipIf(!server)(
  'push loads the terminology its profiles bind',
  { timeout: 120_000 },
  () => {
    let project: TestProject;
    beforeAll(async () => {
      const lockPath = join(mkdtempSync(join(tmpdir(), 'plumb-terminology-')), 'plumb.lock');
      await fetchPackages({ igs: [], lockPath });
      const created = await createTestProject(
        { igs: [], profiles: [PROFILE], local: SYNTHETIC, out: '' },
        { lockPath },
      );
      if (!created.ok) throw new Error(created.error.message);
      project = created;
      // Turned on after the push: Medplum's own bot creation writes a Binary
      // its mimetypes binding refuses under validate-terminology, so no bot,
      // the checker included, can be created in such a project.
      const admin = await superAdmin();
      const stored = await admin.readResource('Project', project.projectId);
      await admin.updateResource({ ...stored, features: ['bots', 'validate-terminology'] });
    }, 120_000);

    test('the bound ValueSet expands to its CodeSystem codes', async () => {
      const medplum = await connectAs(project);
      const expansion = await medplum.valueSetExpand({
        url: 'http://example.org/fhir/plumb-test/ValueSet/plumb-test-colors-vs',
      });
      expect(expansion.expansion?.contains?.map((c) => c.code).sort()).toEqual([
        'blue',
        'green',
        'red',
      ]);
    });

    test('with validate-terminology, a code inside the binding is accepted and one outside refused', async () => {
      const medplum = await connectAs(project);
      await expect(medplum.createResource(patient('red'))).resolves.toMatchObject({
        resourceType: 'Patient',
      });
      await expect(medplum.createResource(patient('purple'))).rejects.toThrow(
        /terminology binding/,
      );
    });
  },
);
