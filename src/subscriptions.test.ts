// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import type { Subscription } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import type { SubscriptionConfig } from './config.js';
import { PLUMB_SYSTEM } from './project.js';
import {
  describeSubscription,
  planHeldSubscriptions,
  type SubscriptionChange,
  subscriptionsSummary,
} from './subscriptions.js';

const CONFIG: Record<string, SubscriptionConfig> = {
  'new-appointment': { criteria: 'Appointment?status=booked', bot: 'send-reminder' },
};

describe('planHeldSubscriptions', () => {
  test('names a bot this push creates by its key, and resolves one it holds to Bot/<id>', () => {
    const [unresolved] = planHeldSubscriptions(CONFIG, [], {}).changes;
    expect(unresolved).toMatchObject({ kind: '+', bot: 'send-reminder' });
    expect(describeSubscription(unresolved as SubscriptionChange)).toBe(
      '+ Subscription  new-appointment  Appointment?status=booked → Bot send-reminder',
    );
    const [resolved] = planHeldSubscriptions(CONFIG, [], { 'send-reminder': 'b1' }).changes;
    expect(resolved).toMatchObject({
      kind: '+',
      subscription: {
        status: 'active',
        reason: 'new-appointment',
        channel: { type: 'rest-hook', endpoint: 'Bot/b1' },
        meta: { tag: [{ system: PLUMB_SYSTEM, code: 'new-appointment' }] },
      },
    });
    expect(resolved).not.toHaveProperty('bot');
  });

  test('refuses a header value Medplum would cut short at its ":"', () => {
    const config = {
      hook: {
        criteria: 'Patient',
        url: 'https://hooks.example.org/a',
        headers: { Authorization: { env: 'TOKEN' } },
      },
    };
    expect(planHeldSubscriptions(config, [], {}, { env: { TOKEN: 'Basic a:b' } }).blocked).toEqual([
      "TOKEN holds a ':', at which Medplum cuts header Authorization short; Subscription hook cannot send it.",
    ]);
  });

  test('an untagged Subscription with the same criteria and endpoint needs --adopt', () => {
    const untagged: Subscription = {
      resourceType: 'Subscription',
      id: 's1',
      status: 'active',
      reason: 'by hand',
      criteria: 'Appointment?status=booked',
      channel: { type: 'rest-hook', endpoint: 'Bot/b1' },
    };
    const bots = { 'send-reminder': 'b1' };
    const plan = planHeldSubscriptions(CONFIG, [untagged], bots);
    expect(plan.blocked).toEqual([
      'Subscription "Appointment?status=booked → Bot/b1" exists untagged; adopt it with --adopt.',
    ]);
    expect(subscriptionsSummary(plan)).toBe('refusing: see below');
    const [adopted] = planHeldSubscriptions(CONFIG, [untagged], bots, { adopt: true }).changes;
    expect(adopted).toMatchObject({
      kind: '~',
      id: 's1',
      adopt: true,
      fields: ['reason', 'channel'],
    });
  });

  test("keeps the server copy's hand-set meta.security on update", () => {
    const security = [{ system: 'http://example.org/security', code: 'restricted' }];
    const held: Subscription = {
      resourceType: 'Subscription',
      id: 's1',
      status: 'active',
      reason: 'new-appointment',
      criteria: 'Appointment?status=proposed',
      channel: { type: 'rest-hook', endpoint: 'Bot/b1', payload: 'application/fhir+json' },
      meta: { security, tag: [{ system: PLUMB_SYSTEM, code: 'new-appointment' }] },
    };
    const [change] = planHeldSubscriptions(CONFIG, [held], { 'send-reminder': 'b1' }).changes;
    expect(change).toMatchObject({
      kind: '~',
      fields: ['criteria'],
      subscription: {
        meta: { security, tag: [{ system: PLUMB_SYSTEM, code: 'new-appointment' }] },
      },
    });
  });
});
