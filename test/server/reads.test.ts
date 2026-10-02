// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MedplumClient } from '@medplum/core';
import type {
  AccessPolicy,
  ClientApplication,
  Observation,
  Project,
  StructureDefinition,
} from '@medplum/fhirtypes';
import { beforeAll, describe, expect, test } from 'vitest';
import { type GeneratedRoutes, generatedRoutes, type Reader } from '../harness/routes.js';
import { connect, server } from './medplum.js';
import { newProject, type TestServer } from './setup.js';

const PLUMB = 'http://example.org/fhir/plumb-test/StructureDefinition';
const PARENT = `${PLUMB}/parent-observation`;
const CHILD = `${PLUMB}/child-observation`;
const LOINC = 'http://loinc.org';
const SYNTHETIC = join(import.meta.dirname, '../fixtures/profiles/fsh-generated/resources');

type ReadError = InstanceType<GeneratedRoutes['ProfileReadError']>;
async function rejection(promise: Promise<unknown>): Promise<ReadError> {
  try {
    await promise;
  } catch (err) {
    return err as ReadError;
  }
  throw new Error('did not reject');
}

// Design 04, "Why the stamp is not enough": each way a stamped record can lack
// what its profile requires, on Medplum itself. A loose project, so a stamped
// record can be stored without what its profile requires.
describe.skipIf(!server)('typed reads on a real server', { timeout: 60_000 }, () => {
  let project: TestServer;
  let medplum: MedplumClient;
  let r: GeneratedRoutes;
  let subject: { reference: string };
  const observation = (profile: string[] | undefined, extra: Partial<Observation> = {}) =>
    medplum.createResource<Observation>({
      resourceType: 'Observation',
      ...(profile ? { meta: { profile } } : {}),
      status: 'final',
      code: { coding: [{ system: LOINC, code: '39156-5' }] },
      subject,
      effectiveDateTime: '2026-01-01T09:00:00Z',
      valueQuantity: { value: 1 },
      ...extra,
    });

  beforeAll(async () => {
    project = await newProject(undefined, { strictMode: false });
    medplum = await connect(project);
    for (const name of ['parent-observation', 'child-observation']) {
      const { id: _, ...sd } = JSON.parse(
        readFileSync(join(SYNTHETIC, `StructureDefinition-${name}.json`), 'utf8'),
      ) as StructureDefinition;
      await medplum.createResource(sd);
    }
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    subject = { reference: `Patient/${patient.id}` };
    r = await generatedRoutes([PARENT, CHILD]);
  }, 60_000);

  test('a record stored while the project is loose, stamped but missing a required element', async () => {
    const stored = await observation([CHILD], { subject: undefined });
    expect(stored.meta?.profile).toEqual([CHILD]);
    const err = await rejection(r.readProfiled(medplum, CHILD, stored.id as string));
    expect(err).toBeInstanceOf(r.ProfileReadError);
    expect(err).toMatchObject({
      reason: 'missing',
      failed: [{ reference: `Observation/${stored.id}`, missing: ['Observation.subject'] }],
    });
  });

  test('an AccessPolicy hiding a required element fails the read for its reader only', async () => {
    const stored = await observation([CHILD]);
    const policy = await medplum.createResource<AccessPolicy>({
      resourceType: 'AccessPolicy',
      name: 'Hides subject',
      resource: [{ resourceType: 'Observation', hiddenFields: ['subject'] }],
    });
    const client = await medplum.post<ClientApplication & { secret: string }>(
      `admin/projects/${project.projectId}/client`,
      { name: 'Hidden subject' },
    );
    const membership = await medplum.searchOne('ProjectMembership', {
      profile: `ClientApplication/${client.id}`,
    });
    if (!membership) throw new Error('The client has no membership.');
    await medplum.updateResource({
      ...membership,
      accessPolicy: { reference: `AccessPolicy/${policy.id}` },
    });
    const reader = new MedplumClient({ baseUrl: project.baseUrl });
    await reader.startClientLogin(client.id as string, client.secret);

    const err = await rejection(r.readProfiled(reader, CHILD, stored.id as string));
    expect(err).toMatchObject({
      reason: 'missing',
      failed: [{ missing: ['Observation.subject'] }],
    });
    await expect(r.readProfiled(medplum, CHILD, stored.id as string)).resolves.toMatchObject({
      id: stored.id,
      subject,
    });
  });

  test('_profile finds parent- and child-stamped records, and no unstamped ones', async () => {
    const parent = await observation([PARENT], {
      code: { coding: [{ system: LOINC, code: '29463-7' }] },
    });
    const child = await observation([CHILD]);
    const unstamped = await observation(undefined);
    const ids = (resources: { id?: string }[]) => resources.map((x) => x.id).sort();
    const query = { _id: [parent.id, child.id, unstamped.id].join(',') };
    // Several URLs: the parent and its selected child.
    expect(ids(await r.searchProfiled(medplum, PARENT, query))).toEqual(ids([parent, child]));
    // One URL.
    expect(ids(await r.searchProfiled(medplum, CHILD, query))).toEqual(ids([child]));
  });

  test('a search with one failing record throws, with the rest in passed', async () => {
    const good = await observation([CHILD]);
    const bad = await observation([CHILD], { valueQuantity: undefined });
    const err = await rejection(r.searchProfiled(medplum, CHILD, { _id: `${good.id},${bad.id}` }));
    expect(err).toMatchObject({
      reason: 'missing',
      failed: [
        {
          reference: `Observation/${bad.id}`,
          missing: ['Observation.valueQuantity'],
        },
      ],
    });
    expect(err.passed.map((x: { id?: string }) => x.id)).toEqual([good.id]);
  });

  test('a refused query makes no request', async () => {
    let requests = 0;
    const counted: Reader = {
      readResource: (type, id) => {
        requests++;
        return medplum.readResource(type as 'Observation', id);
      },
      readReference: (reference) => {
        requests++;
        return medplum.readReference(reference);
      },
      searchResources: (type, query) => {
        requests++;
        return medplum.searchResources(type as 'Observation', query);
      },
    };
    for (const query of [
      { _elements: 'status' },
      { _summary: 'count' },
      { _include: 'Observation:subject' },
    ]) {
      const err = await rejection(r.searchProfiled(counted, CHILD, query));
      expect(err.reason).toBe('refused');
    }
    expect(requests).toBe(0);
  });

  // Last: it sets the project's default for every later write.
  test('a record written under defaultProfile carries the stamp and reads typed', async () => {
    const stored = await medplum.readResource('Project', project.projectId);
    await medplum.updateResource<Project>({
      ...stored,
      defaultProfile: [{ resourceType: 'Observation', profile: [CHILD] }],
    });
    const fresh = await connect(project);
    const written = await fresh.createResource<Observation>({
      resourceType: 'Observation',
      status: 'final',
      code: { coding: [{ system: LOINC, code: '39156-5' }] },
      subject,
      effectiveDateTime: '2026-01-01T09:00:00Z',
      valueQuantity: { value: 1 },
    });
    expect(written.meta?.profile).toEqual([CHILD]);
    await expect(r.readProfiled(fresh, CHILD, written.id as string)).resolves.toMatchObject({
      id: written.id,
    });
  });
});
