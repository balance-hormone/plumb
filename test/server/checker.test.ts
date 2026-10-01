// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { ContentType } from '@medplum/core';
import type { AsyncJob, Bot, Parameters, Patient } from '@medplum/fhirtypes';
import { build } from 'esbuild';
import { expect, test } from 'vitest';
import { CHECKER_BUILD } from '../../src/checker/bundle.js';
import type { PageResult } from '../../src/checker/handler.js';
import { checkerInput } from '../../src/checker/input.js';
import { loadProfiles } from '../../src/loader.js';
import { connect, server } from './medplum.js';

const PATIENT = 'http://example.org/fhir/plumb-test/StructureDefinition/cardinality-patient';
const SYNTHETIC = join(import.meta.dirname, '../fixtures/profiles/fsh-generated/resources');

test.skipIf(!server)('the checker runs as an async job through Bot/$execute', async () => {
  const medplum = await connect();
  const bot = await medplum.post<Bot>(`admin/projects/${server?.projectId}/bot`, {
    name: 'plumb-checker',
    runtimeVersion: 'vmcontext',
  });
  const botId = bot.id as string;
  const code = (await build({ ...CHECKER_BUILD, write: false })).outputFiles[0]?.text;
  await medplum.post(medplum.fhirUrl('Bot', botId, '$deploy'), { code, filename: 'checker.cjs' });

  // The contained Organization's definition is not in the input: the bot reads it from the server.
  const valid = await medplum.createResource<Patient>({
    resourceType: 'Patient',
    meta: { profile: [PATIENT] },
    birthDate: '1970-01-01',
    name: [{ family: 'Synthetic' }],
    contained: [{ resourceType: 'Organization', id: 'o1', name: 'Synthetic Clinic' }],
    managingOrganization: { reference: '#o1' },
  });
  const failing = await medplum.createResource<Patient>({
    resourceType: 'Patient',
    meta: { profile: [PATIENT] },
    name: [{ family: 'Synthetic' }],
  });

  const loaded = loadProfiles({ packages: [], igs: [], local: SYNTHETIC, profiles: [PATIENT] });
  const job = await medplum.post<AsyncJob>(
    medplum.fhirUrl('Bot', botId, '$execute'),
    checkerInput(loaded, 'Patient'),
    ContentType.JSON,
    { headers: { Prefer: 'respond-async' }, pollStatusOnAccepted: true },
  );
  expect(job.resourceType).toBe('AsyncJob');
  expect(job.status).toBe('completed');
  const output = job.output as Parameters;
  const body = output.parameter?.find((p) => p.name === 'responseBody')?.valueString ?? '{}';
  const result = JSON.parse(body) as PageResult;
  expect(result.profiles[PATIENT]).toMatchObject({ checked: 2, failing: [failing.id] });
  expect(result.profiles[PATIENT]?.failing).not.toContain(valid.id);
  expect(result.profiles[PATIENT]?.reasons.map((r) => r.path)).toEqual(['Patient.birthDate']);
});
