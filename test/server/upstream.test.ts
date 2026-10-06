// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent, OperationDefinition, Subscription } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { applyBots, planBots } from '../../src/bots.js';
import type { BotConfig } from '../../src/config.js';
import { PLUMB_SYSTEM } from '../../src/project.js';
import { applySubscriptions, planSubscriptions } from '../../src/subscriptions.js';
import { connect, server } from './medplum.js';
import { newProject } from './setup.js';

// Medplum behaviour design 10 works around, reproduced for the issues drafted
// in the research notes ("Upstream issues"). Each test pins today's behaviour,
// so a fix upstream turns it red and the workaround can go.

const bot = (code: string) => {
  const file = join(mkdtempSync(join(tmpdir(), 'plumb-upstream-')), 'bot.cjs');
  writeFileSync(file, code);
  return { file, runtime: 'vmcontext' } as BotConfig;
};

describe.skipIf(!server)('Medplum behaviour reported upstream', { timeout: 120_000 }, () => {
  test("a Subscription's failing bot counts as delivered: never retried, never turned off", async () => {
    const project = await newProject();
    const medplum = await connect(project);
    await applyBots(
      await planBots(medplum, {
        failing: bot('exports.handler = async () => { throw new Error("boom"); };'),
      }),
      medplum,
    );
    const subscriptions = {
      'new-patient': { criteria: 'Patient', bot: 'failing', interactions: ['create' as const] },
    };
    await applySubscriptions(await planSubscriptions(medplum, subscriptions), medplum);
    const failing = await medplum.searchOne('Bot', { identifier: `${PLUMB_SYSTEM}|failing` });
    // Allow retries, so a delivery that counted as failed would run again.
    const subscription = (await medplum.searchOne('Subscription', {
      _tag: `${PLUMB_SYSTEM}|new-patient`,
    })) as Subscription;
    await medplum.updateResource({
      ...subscription,
      extension: [
        ...(subscription.extension ?? []),
        {
          url: 'https://medplum.com/fhir/StructureDefinition/subscription-max-attempts',
          valueInteger: 3,
        },
      ],
    });

    await medplum.createResource({ resourceType: 'Patient', name: [{ family: 'Synthetic' }] });
    const runs = () =>
      medplum.searchResources('AuditEvent', { entity: `Bot/${failing?.id}`, _count: '20' });
    let events: AuditEvent[] = [];
    for (let i = 0; i < 60 && events.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 500));
      events = await runs();
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.outcomeDesc).toMatch(/boom/);
    // Medplum's retries back off for seconds; none comes.
    await new Promise((r) => setTimeout(r, 15_000));
    expect(await runs()).toHaveLength(1);
    expect((await medplum.readResource('Subscription', subscription.id as string)).status).toBe(
      'active',
    );
  });

  test('a custom operation called by GET with a query string is not found', async () => {
    const project = await newProject();
    const medplum = await connect(project);
    await applyBots(
      await planBots(medplum, {
        echo: bot('exports.handler = async (medplum, event) => event.input;'),
      }),
      medplum,
    );
    const echo = await medplum.searchOne('Bot', { identifier: `${PLUMB_SYSTEM}|echo` });
    await medplum.createResource<OperationDefinition>({
      resourceType: 'OperationDefinition',
      name: 'echo',
      status: 'active',
      kind: 'operation',
      code: 'plumb-echo',
      resource: ['Patient'],
      system: false,
      type: true,
      instance: false,
      extension: [
        {
          url: 'https://medplum.com/fhir/StructureDefinition/operationDefinition-implementation',
          valueReference: { reference: `Bot/${echo?.id}` },
        },
      ],
    });

    await expect(medplum.get(medplum.fhirUrl('Patient', '$plumb-echo'))).resolves.toBeDefined();
    const withQuery = medplum.fhirUrl('Patient', '$plumb-echo');
    withQuery.searchParams.set('name', 'Synthetic');
    // The query string is read as part of the code, `plumb-echo?name=Synthetic`.
    await expect(medplum.get(withQuery)).rejects.toThrow(/^Not found$/);
  });
});
