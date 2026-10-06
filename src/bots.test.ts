// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, ProjectMembership } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import {
  type BotChange,
  botFilename,
  botsSummary,
  declaredBot,
  describeBot,
  type HeldBot,
  planHeld,
} from './bots.js';
import type { BotConfig } from './config.js';
import { PLUMB_SYSTEM } from './project.js';

const dir = mkdtempSync(join(tmpdir(), 'plumb-bots-'));
const file = join(dir, 'reminder.cjs');
writeFileSync(file, 'exports.handler = async () => {};');
const filename = botFilename('reminder', readFileSync(file), file);

const CONFIG: Record<string, BotConfig> = {
  reminder: { file, policy: 'sender', cron: '0 14 * * *' },
};
const BASE = 'https://api.example.org/';

const held = (
  key: string | undefined,
  fields: Partial<Bot> = {},
  membership: Partial<ProjectMembership> | false = {},
): HeldBot => ({
  bot: {
    ...declaredBot(key ?? 'reminder', CONFIG.reminder as BotConfig),
    id: `bot-${key}`,
    ...(key ? { identifier: [{ system: PLUMB_SYSTEM, value: key }] } : {}),
    executableCode: { title: filename },
    ...fields,
  },
  ...(membership === false
    ? {}
    : {
        membership: {
          resourceType: 'ProjectMembership',
          id: `membership-${key}`,
          project: { reference: 'Project/p' },
          user: { reference: `Bot/bot-${key}` },
          profile: { reference: `Bot/bot-${key}` },
          accessPolicy: { reference: 'AccessPolicy/sender-id' },
          ...membership,
        },
      }),
});

const POLICIES = { sender: 'sender-id' };

describe('planHeld', () => {
  test('creates a missing bot with its identifier, defaults and deploy filename', () => {
    const plan = planHeld(CONFIG, [], POLICIES, BASE);
    expect(plan.changes).toEqual([
      {
        kind: '+',
        key: 'reminder',
        bot: {
          resourceType: 'Bot',
          name: 'reminder',
          runtimeVersion: 'awslambda',
          timeout: 10,
          cronString: '0 14 * * *',
          identifier: [{ system: PLUMB_SYSTEM, value: 'reminder' }],
        },
        policy: 'sender',
        admin: false,
        deploy: { file, filename },
      },
    ]);
    expect(filename).toMatch(/^reminder-[0-9a-f]{16}\.cjs$/);
  });

  test('plans nothing for a bot held as declared, deployed and granted', () => {
    expect(planHeld(CONFIG, [held('reminder')], POLICIES, BASE)).toMatchObject({
      changes: [],
      blocked: [],
    });
  });

  test("updates only the fields Plumb manages, keeping the project's own", () => {
    const current = held('reminder', { description: 'kept', timeout: 30 }, { admin: true });
    const [change] = planHeld(
      { reminder: { file, policy: 'sender' } },
      [current],
      POLICIES,
      BASE,
    ).changes;
    expect(change).toMatchObject({ kind: '~', fields: ['timeout', 'cronString', 'admin'] });
    const bot = (change as Extract<BotChange, { kind: '~' }>).bot;
    expect(bot).toMatchObject({ description: 'kept', timeout: 10 });
    expect(bot).not.toHaveProperty('cronString');
    expect(change).not.toHaveProperty('deploy');
  });

  test('redeploys a changed file, naming the filename it replaces', () => {
    const current = held('reminder', {
      executableCode: { title: 'reminder-0123456789abcdef.cjs' },
    });
    const [change] = planHeld(CONFIG, [current], POLICIES, BASE).changes;
    expect(change).toMatchObject({
      kind: '~',
      fields: [],
      deploy: { file, filename },
      deployed: 'reminder-0123456789abcdef.cjs',
    });
    expect(describeBot(change as BotChange)).toBe(
      `~ Bot  reminder (code changed (0123… → ${filename.slice(9, 13)}…))`,
    );
  });

  test('a policy the project step has not created yet changes the membership', () => {
    const [change] = planHeld(CONFIG, [held('reminder')], {}, BASE).changes;
    expect(change).toMatchObject({ kind: '~', fields: ['accessPolicy'] });
  });

  test('untagged-bot without --adopt; with it, the bot gains the identifier', () => {
    const untagged = held(undefined, { id: 'legacy', name: 'reminder' });
    expect(planHeld(CONFIG, [untagged], POLICIES, BASE).blocked).toMatchObject([
      { code: 'untagged-bot' },
    ]);
    const [change] = planHeld(CONFIG, [untagged], POLICIES, BASE, { adopt: true }).changes;
    expect(change).toMatchObject({ kind: '~', id: 'legacy', adopt: true });
    expect((change as Extract<BotChange, { kind: '~' }>).bot.identifier).toEqual([
      { system: PLUMB_SYSTEM, value: 'reminder' },
    ]);
  });

  test('shadowed-bot and bot-without-membership', () => {
    const twice = [held('reminder'), held('reminder', { id: 'other' })];
    expect(planHeld(CONFIG, twice, POLICIES, BASE).blocked).toMatchObject([
      { code: 'shadowed-bot' },
    ]);
    const orphan = held('reminder', {}, false);
    expect(planHeld(CONFIG, [orphan], POLICIES, BASE).blocked).toMatchObject([
      { code: 'bot-without-membership' },
    ]);
  });

  test("a removed bot's schedule is cleared only with --prune; one without a schedule is reported", () => {
    const removed = [
      held('old', { cronString: '0 1 * * *' }),
      held('quiet', { cronString: undefined }),
    ];
    const plan = planHeld({}, removed, POLICIES, BASE);
    expect(plan.changes).toEqual([{ kind: '-', key: 'old', id: 'bot-old', kept: true }]);
    expect(plan.warnings).toEqual([
      'Bot quiet is no longer declared; it stays, with its membership and webhook URL.',
    ]);
    expect(botsSummary(plan)).toBe('plan: 0 to create, 0 to update, 0 to deploy, 0 to disconnect');
    const pruned = planHeld({}, removed, POLICIES, BASE, { prune: true });
    expect(pruned.changes).toEqual([{ kind: '-', key: 'old', id: 'bot-old' }]);
  });

  test("ignores Plumb's own checker, and reports each held public webhook's URL", () => {
    const checker = held('checker');
    const config = { reminder: { ...(CONFIG.reminder as BotConfig), publicWebhook: true } };
    const plan = planHeld(
      config,
      [checker, held('reminder', { publicWebhook: true })],
      POLICIES,
      BASE,
    );
    expect(plan.changes).toEqual([]);
    expect(plan.webhooks).toEqual([
      { key: 'reminder', url: 'https://api.example.org/webhook/membership-reminder' },
    ]);
  });
});
