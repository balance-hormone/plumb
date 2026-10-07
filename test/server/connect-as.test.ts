// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Patient } from '@medplum/fhirtypes';
import { beforeAll, describe, expect, test } from 'vitest';
import type { LoadedConfig, PlumbConfig } from '../../src/config.js';
import { fetchPackages } from '../../src/packages.js';
import { connectAs, createTestProject, type TestProject } from '../../src/testing.js';
import { server } from './medplum.js';

const PATIENT = 'http://example.org/fhir/plumb-test/StructureDefinition/cardinality-patient';
const SYNTHETIC = join(import.meta.dirname, '../fixtures/profiles/fsh-generated/resources');

const CONFIG: PlumbConfig = {
  igs: [],
  profiles: [PATIENT],
  local: SYNTHETIC,
  out: '',
  project: {
    accessPolicies: {
      'front-desk': { name: 'Front desk', resource: [{ resourceType: 'Patient', readonly: true }] },
      'one-patient': {
        name: 'One patient',
        resource: [{ resourceType: 'Patient', criteria: 'Patient?_id=%patient.id' }],
      },
    },
    clients: { kiosk: { accessPolicy: 'front-desk' } },
  },
};

const patient = (family: string): Patient => ({ resourceType: 'Patient', name: [{ family }] });

describe.skipIf(!server)('connectAs', { timeout: 120_000 }, () => {
  let project: TestProject;
  let ada: Patient;
  beforeAll(async () => {
    const lockPath = join(mkdtempSync(join(tmpdir(), 'plumb-connect-as-')), 'plumb.lock');
    await fetchPackages({ igs: [], lockPath });
    const created = await createTestProject(CONFIG as LoadedConfig, { lockPath });
    if (!created.ok) throw new Error(created.error.message);
    project = created;
    const admin = await connectAs(project);
    ada = await admin.createResource(patient('Ada'));
    await admin.createResource(patient('Grace'));
    await admin.createResource({
      resourceType: 'Observation',
      status: 'final',
      code: { text: 'Synthetic' },
    });
  }, 120_000);

  test('the admin client, by default, reads everything', async () => {
    const admin = await connectAs(project);
    expect(await admin.searchResources('Observation')).toHaveLength(1);
  });

  test('a policy-scoped client reads what its policy allows and is refused the rest', async () => {
    const frontDesk = await connectAs(project, { accessPolicy: 'front-desk' });
    expect(await frontDesk.searchResources('Patient')).toHaveLength(2);
    await expect(frontDesk.searchResources('Observation')).rejects.toThrow(/forbidden/i);
    await expect(frontDesk.createResource(patient('Hopper'))).rejects.toThrow(/forbidden/i);
  });

  test("a policy's parameters are set on the membership", async () => {
    const one = await connectAs(project, {
      accessPolicy: 'one-patient',
      parameters: { patient: { reference: `Patient/${ada.id}` } },
    });
    const found = await one.searchResources('Patient');
    expect(found.map((p) => p.id)).toEqual([ada.id]);
  });

  test('a declared client logs in with its configured policy', async () => {
    const kiosk = await connectAs(project, { client: 'kiosk' });
    expect(await kiosk.searchResources('Patient')).toHaveLength(2);
    await expect(kiosk.searchResources('Observation')).rejects.toThrow(/forbidden/i);
  });

  test('an unknown key fails by name', async () => {
    await expect(connectAs(project, { client: 'nurse' })).rejects.toMatchObject({
      code: 'unknown-client',
    });
    await expect(connectAs(project, { accessPolicy: 'nurse' })).rejects.toMatchObject({
      code: 'unknown-policy',
    });
  });
});
