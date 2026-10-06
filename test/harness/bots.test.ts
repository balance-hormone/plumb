// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest';
import { printBots } from '../../src/emit/bots.js';
import { printFiles } from '../../src/emit/print.js';
import { typecheck } from './routes.js';

// Design 10's typed bots: each handler's event is what the bot's triggers send.
const files = printFiles(
  [],
  () => 'harness',
  undefined,
  [],
  [],
  printBots(
    {
      'send-reminder': { file: 'a.cjs', cron: '0 14 * * *', secrets: ['SMS_API_KEY'] },
      'intake-webhook': { file: 'b.cjs', publicWebhook: true, rawBody: true, policy: 'p' },
      'lab-watcher': { file: 'c.cjs' },
      'json-webhook': { file: 'd.cjs', publicWebhook: true, policy: 'p', cron: '0 1 * * *' },
      manual: { file: 'e.cjs' },
    },
    {
      'new-appointment': {
        criteria: 'Appointment?status=booked',
        interactions: ['create'],
        bot: 'send-reminder',
      },
      'lab-result': { criteria: 'DiagnosticReport?status=final', bot: 'lab-watcher' },
      'lab-removed': {
        criteria: 'Observation',
        interactions: ['delete'],
        bot: 'lab-watcher',
      },
    },
  ),
);

test("tsc types each handler's event by its bot's triggers and secrets", () => {
  const source = `
import type { Appointment } from '@medplum/fhirtypes';
import { defineBot } from './generated/index.js';

export const reminder = defineBot('send-reminder', async (_medplum: unknown, event) => {
  const key: string | undefined = event.secrets.SMS_API_KEY.valueString;
  // A Subscription's Appointment, or the Bot on its schedule.
  if (event.input.resourceType === 'Appointment') {
    const appointment: Appointment = event.input;
    return [key, appointment.status];
  }
  const bot: 'Bot' = event.input.resourceType;
  // @ts-expect-error a secret the bot does not declare
  event.secrets.OTHER_KEY;
  return [bot];
});

export const watcher = defineBot('lab-watcher', async (_medplum: unknown, event) => {
  // Every interaction for DiagnosticReport, delete only for Observation.
  if ('deletedResource' in event.input) {
    const deleted: 'DiagnosticReport' | 'Observation' = event.input.deletedResource.resourceType;
    return deleted;
  }
  const report: 'DiagnosticReport' = event.input.resourceType;
  return report;
});

// A webhook's raw body is a string; parsed, it is whatever was posted.
export const raw = defineBot('intake-webhook', async (_medplum: unknown, event) => {
  const body: string = event.input;
  return body.length;
});
export const parsed = defineBot('json-webhook', async (_medplum: unknown, event) => {
  // @ts-expect-error the body is unknown until the bot checks it
  return event.input.resourceType;
});
export const manual = defineBot('manual', async (_medplum: unknown, event) => event.input);

// @ts-expect-error a Subscription's Appointment is not a Patient
export const wrong = defineBot('send-reminder', async (_medplum: unknown, event: { input: { resourceType: 'Patient' } }) => event);
// @ts-expect-error a bot the config does not declare
export const unknownBot = defineBot('nobody', async () => undefined);
`;
  expect(typecheck(files, source)).toEqual([]);
});
