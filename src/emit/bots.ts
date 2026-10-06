// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotConfig, SubscriptionConfig } from '../config.js';
import { MARKER, quote } from './print.js';

/**
 * What each trigger sends a bot as `event.input`: a Subscription's resource,
 * or `{ deletedResource }` on delete; the Bot itself on a schedule; a
 * webhook's body. An operation's input is typed by `handleOperation`, from
 * its contract, which `generate` does not load.
 */
function inputsOf(
  key: string,
  bot: BotConfig,
  subscriptions: Record<string, SubscriptionConfig>,
): string[] {
  const inputs: string[] = [];
  for (const subscription of Object.values(subscriptions)) {
    if (subscription.bot !== key) continue;
    const type = subscription.criteria.split('?')[0] as string;
    const interactions = subscription.interactions ?? ['create', 'update', 'delete'];
    if (interactions.some((i) => i !== 'delete')) inputs.push(type);
    if (interactions.includes('delete')) inputs.push(`{ deletedResource: ${type} }`);
  }
  if (bot.cron) inputs.push('Bot');
  // A webhook's body is whatever was posted, which takes in every other input.
  if (bot.publicWebhook && !bot.rawBody) return ['unknown'];
  if (bot.publicWebhook) inputs.push('string');
  return inputs.length > 0 ? [...new Set(inputs)] : ['unknown'];
}

/** `_bots.ts`: `defineBot`, typing each declared bot's event by its triggers and secrets. */
export function printBots(
  bots: Record<string, BotConfig>,
  subscriptions: Record<string, SubscriptionConfig> = {},
): string {
  const keys = Object.keys(bots).sort();
  const inputs = new Map(
    keys.map((key) => [key, inputsOf(key, bots[key] as BotConfig, subscriptions)]),
  );
  const resources = new Set(
    [...inputs.values()]
      .flat()
      .map((input) => input.replace(/^\{ deletedResource: (\w+) \}$/, '$1'))
      .filter((input) => /^[A-Z]/.test(input)),
  );
  const imports = [...new Set([...resources, 'ProjectSetting', 'Reference'])].sort();
  return [
    `${MARKER}. Do not edit.`,
    `import type { ${imports.join(', ')} } from '@medplum/fhirtypes';`,
    '',
    "/** The event Medplum passes a bot, as @medplum/core's BotEvent, typed by the bot's triggers. */",
    'export interface PlumbBotEvent<Input, Secret extends string> {',
    '  readonly bot: Reference;',
    '  readonly contentType: string;',
    '  readonly input: Input;',
    "  /** The project's secrets; the bot's declared keys are set wherever `push` converged it. */",
    '  readonly secrets: Record<Secret, ProjectSetting>;',
    '  readonly traceId?: string;',
    '  readonly requester?: Reference;',
    '  readonly headers?: Record<string, string | string[] | undefined>;',
    '}',
    '',
    "/** What each bot's triggers send it: its Subscriptions, its schedule and its webhook. */",
    'export interface BotInputs {',
    ...keys.map((key) => `  ${quote(key)}: ${(inputs.get(key) as string[]).join(' | ')};`),
    '}',
    '',
    '/** The secrets each bot declares. */',
    'export interface BotSecrets {',
    ...keys.map((key) => {
      const secrets = bots[key]?.secrets ?? [];
      return `  ${quote(key)}: ${secrets.length > 0 ? secrets.map(quote).join(' | ') : 'never'};`;
    }),
    '}',
    '',
    "/** A bot's handler, its event typed by the bot's triggers and secrets; returned unchanged. */",
    'export function defineBot<K extends keyof BotInputs, Client, Result>(',
    '  _key: K,',
    '  handler: (medplum: Client, event: PlumbBotEvent<BotInputs[K], BotSecrets[K]>) => Result,',
    '): (medplum: Client, event: PlumbBotEvent<BotInputs[K], BotSecrets[K]>) => Result {',
    '  return handler;',
    '}',
    '',
  ].join('\n');
}
