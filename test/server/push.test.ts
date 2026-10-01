// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContentType, type MedplumRequestOptions } from '@medplum/core';
import type { AsyncJob, Parameters } from '@medplum/fhirtypes';
import { build } from 'esbuild';
import { beforeAll, describe, expect, test } from 'vitest';
import { CHECKER_BUILD } from '../../src/checker/bundle.js';
import type { PageResult } from '../../src/checker/handler.js';
import { checkerInput } from '../../src/checker/input.js';
import { loadProfiles } from '../../src/loader.js';
import { fetchPackages } from '../../src/packages.js';
import { CHECKER_IDENTIFIER, type PushOptions, push } from '../../src/push.js';
import { connect, server } from './medplum.js';

const PATIENT = 'http://example.org/fhir/plumb-test/StructureDefinition/cardinality-patient';
const SYNTHETIC = join(import.meta.dirname, '../fixtures/profiles/fsh-generated/resources');
const READ = ['read', 'vread', 'search', 'history'];

// The tests share one checker bot in this run's project, so they run in order.
describe.skipIf(!server)('push installs the checker bot', () => {
  let options: PushOptions;
  beforeAll(async () => {
    const lockPath = join(mkdtempSync(join(tmpdir(), 'plumb-push-')), 'plumb.lock');
    await fetchPackages({ igs: [], lockPath });
    const code = (await build({ ...CHECKER_BUILD, write: false })).outputFiles[0]?.text ?? '';
    options = {
      config: { igs: [], profiles: [PATIENT], local: SYNTHETIC, out: '' },
      environment: {
        name: 'test',
        baseUrl: server?.baseUrl ?? '',
        clientId: server?.clientId ?? '',
        clientSecret: server?.clientSecret ?? '',
      },
      lockPath,
      checker: { code, version: '0.2.0' },
    };
  });

  /** The checker bot, its membership and its AccessPolicy, as stored. */
  async function installed() {
    const medplum = await connect();
    const bot = await medplum.searchOne('Bot', {
      identifier: `${CHECKER_IDENTIFIER.system}|${CHECKER_IDENTIFIER.value}`,
    });
    const membership = await medplum.searchOne('ProjectMembership', { profile: `Bot/${bot?.id}` });
    if (!bot || !membership?.accessPolicy) throw new Error('The checker bot is not installed.');
    const policy = await medplum.readReference(membership.accessPolicy);
    return { medplum, bot, membership, policy };
  }

  test('a first push installs the bot, deploys its bundle and gives it a read-only policy', async () => {
    const result = await push(options);
    expect(result.errors).toEqual([]);
    expect(result.checker).toMatchObject({ status: 'installed', version: '0.2.0' });
    expect(result.steps.map((s) => s.summary)).toEqual([
      '1 profiles of Patient',
      expect.stringMatching(/\(strict mode on\)$/),
      'plumb-checker 0.2.0 installed',
    ]);
    const { bot, policy } = await installed();
    expect(bot.id).toBe(result.checker?.botId);
    expect(bot.executableCode?.title).toMatch(/^plumb-checker-0\.2\.0-[0-9a-f]{16}\.cjs$/);
    expect(policy.resource).toEqual([
      { resourceType: 'Patient', interaction: READ },
      { resourceType: 'StructureDefinition', interaction: READ },
    ]);
  });

  test('a second push changes nothing', async () => {
    const before = await installed();
    const result = await push(options);
    expect(result.checker?.status).toBe('unchanged');
    const after = await installed();
    expect(after.bot.meta?.versionId).toBe(before.bot.meta?.versionId);
    expect(after.policy.meta?.versionId).toBe(before.policy.meta?.versionId);
  });

  test("the bot's membership can read the checked types but write nothing", async () => {
    const { medplum, membership } = await installed();
    const asBot: MedplumRequestOptions = {
      headers: { 'X-Medplum-On-Behalf-Of': `ProjectMembership/${membership.id}` },
    };
    await expect(medplum.searchResources('Patient', {}, asBot)).resolves.toBeDefined();
    const patient = { resourceType: 'Patient' as const, name: [{ family: 'Synthetic' }] };
    await expect(medplum.createResource(patient, asBot)).rejects.toThrow(/Forbidden/);
    await expect(medplum.searchResources('Observation', {}, asBot)).rejects.toThrow(/Forbidden/);
  });

  test('the installed bot checks a page under its policy', async () => {
    const { medplum, bot } = await installed();
    // The contained Organization's definition comes from the server, through the policy.
    await medplum.createResource({
      resourceType: 'Patient',
      meta: { profile: [PATIENT] },
      birthDate: '1970-01-01',
      name: [{ family: 'Synthetic' }],
      contained: [{ resourceType: 'Organization', id: 'o1', name: 'Synthetic Clinic' }],
      managingOrganization: { reference: '#o1' },
    });
    const loaded = loadProfiles({ packages: [], igs: [], local: SYNTHETIC, profiles: [PATIENT] });
    const job = await medplum.post<AsyncJob>(
      medplum.fhirUrl('Bot', bot.id as string, '$execute'),
      checkerInput(loaded, 'Patient'),
      ContentType.JSON,
      { headers: { Prefer: 'respond-async' }, pollStatusOnAccepted: true },
    );
    expect(job.status).toBe('completed');
    const output = job.output as Parameters;
    const body = output.parameter?.find((p) => p.name === 'responseBody')?.valueString ?? '{}';
    expect((JSON.parse(body) as PageResult).profiles[PATIENT]?.checked).toBeGreaterThan(0);
  });

  test('a new bundle or version is redeployed, and a changed profile set updates the policy', async () => {
    const changed = { ...options.checker, code: `${options.checker.code}\n// changed\n` };
    const redeployed = await push({ ...options, checker: changed });
    expect(redeployed.checker).toMatchObject({ status: 'updated', version: '0.2.0' });
    expect(redeployed.checker).not.toHaveProperty('previous');

    const newer = await push({ ...options, checker: { ...changed, version: '0.3.0' } });
    expect(newer.steps.at(-1)?.summary).toBe('plumb-checker 0.2.0 → 0.3.0 updated');

    const observation = 'http://example.org/fhir/plumb-test/StructureDefinition/sliced-observation';
    const config = { ...options.config, profiles: [PATIENT, observation] };
    const widened = await push({ ...options, config, checker: { ...changed, version: '0.3.0' } });
    expect(widened.checker?.status).toBe('updated');
    expect((await installed()).policy.resource?.map((r) => r.resourceType)).toEqual([
      'Observation',
      'Patient',
      'StructureDefinition',
    ]);
  });
});
