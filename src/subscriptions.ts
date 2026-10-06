// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { deepEquals, type MedplumClient } from '@medplum/core';
import type { Bot, Extension, Subscription } from '@medplum/fhirtypes';
import type { SubscriptionConfig } from './config.js';
import { claim, PLUMB_SYSTEM, type ProjectOptions, tagOf } from './project.js';

// The extensions Medplum reads (`subscriptions/index.ts`, `workers/subscription.ts`).
// The secret's URL has the `www`; the others do not.
const INTERACTION =
  'https://medplum.com/fhir/StructureDefinition/subscription-supported-interaction';
const FHIR_PATH = 'https://medplum.com/fhir/StructureDefinition/fhir-path-criteria-expression';
const SECRET = 'https://www.medplum.com/fhir/StructureDefinition/subscription-secret';
const MAX_ATTEMPTS = 'https://medplum.com/fhir/StructureDefinition/subscription-max-attempts';
const MANAGED_EXTENSIONS = [INTERACTION, FHIR_PATH, SECRET, MAX_ATTEMPTS];

/** The Subscription fields a key's config writes; the server's `meta` and `error` are not drift. */
const MANAGED = ['status', 'reason', 'criteria', 'channel', 'extension'] as const;

/** Where a secret and each header's value come from: read again when written, never kept. */
interface Variables {
  secret?: string;
  headers: [name: string, env: string][];
}

/** One write `push` plans for a Subscription: `+` create, `~` update, `-` turn off. */
export type SubscriptionChange =
  | {
      kind: '+' | '~';
      key: string;
      /** The held Subscription's id, for an update. */
      id?: string;
      /** The fields that differ, for an update. */
      fields: string[];
      adopt?: true;
      /** The Subscription as the config wants it, less its secret and header values. */
      subscription: Subscription;
      /** The bot it delivers to, by key, when its id is not known until the bots step writes. */
      bot?: string;
      variables: Variables;
      /** Why Medplum turned it off, when it did. */
      error?: string;
    }
  | { kind: '-'; key: string; id: string; kept?: true };

export interface SubscriptionPlan {
  changes: SubscriptionChange[];
  /** Why nothing in the subscriptions step can be applied. */
  blocked: string[];
}

/**
 * Plans the Subscriptions against what the target project holds, each found
 * by Plumb's tag with its key. A bot is resolved to its id by its identifier.
 */
export async function planSubscriptions(
  medplum: MedplumClient,
  subscriptions: Record<string, SubscriptionConfig>,
  options: ProjectOptions = {},
): Promise<SubscriptionPlan> {
  const project = medplum.getProject()?.id;
  const ours = <T extends Subscription | Bot>(r: T) => r.meta?.project === project;
  const held = (await medplum.searchResources('Subscription', { _count: '1000' })).filter(ours);
  const bots = (
    await medplum.searchResources('Bot', { identifier: `${PLUMB_SYSTEM}|`, _count: '1000' })
  ).filter(ours);
  const botIds = Object.fromEntries(
    bots.map((b) => [b.identifier?.find((i) => i.system === PLUMB_SYSTEM)?.value, b.id as string]),
  );
  return planHeldSubscriptions(subscriptions, held, botIds, options);
}

/** The plan for the Subscriptions a project holds. A bot this push creates has no id yet. */
export function planHeldSubscriptions(
  subscriptions: Record<string, SubscriptionConfig>,
  held: Subscription[],
  botIds: Record<string, string>,
  options: ProjectOptions = {},
): SubscriptionPlan {
  const plan: SubscriptionPlan = { changes: [], blocked: [] };
  const tagged = Map.groupBy(
    held.filter((s) => tagOf(s) !== undefined),
    (s) => tagOf(s) as string,
  );
  for (const [key, config] of Object.entries(subscriptions)) {
    const desired = declaredSubscription(key, config, botIds, options.env ?? {});
    if (typeof desired === 'string') {
      plan.blocked.push(desired);
      continue;
    }
    const endpoint = desired.subscription.channel.endpoint;
    const untagged = held.filter(
      (s) =>
        tagOf(s) === undefined && s.criteria === config.criteria && s.channel.endpoint === endpoint,
    );
    const name = `${config.criteria} → ${endpoint ?? `Bot ${config.bot}`}`;
    const claimed = claim('Subscription', key, name, tagged.get(key) ?? [], untagged, options);
    if (typeof claimed === 'string') plan.blocked.push(claimed);
    else {
      const change = planOne(key, config, desired, claimed);
      if (change) plan.changes.push(change);
    }
  }
  plan.changes.push(...turnedOff(subscriptions, tagged, options));
  return plan;
}

/** A tagged Subscription whose key left the config is listed, and turned off only with --prune. */
function turnedOff(
  subscriptions: Record<string, SubscriptionConfig>,
  tagged: Map<string, Subscription[]>,
  options: ProjectOptions,
): SubscriptionChange[] {
  const kept = options.prune ? {} : { kept: true as const };
  return [...tagged]
    .filter(([key]) => !Object.hasOwn(subscriptions, key))
    .flatMap(([key, found]) =>
      found
        .filter((s) => s.status !== 'off')
        .map((s) => ({ kind: '-' as const, key, id: s.id as string, ...kept })),
    );
}

/**
 * The Subscription as the config declares it, with its secret and header
 * values read from `env` so it compares with what is held, or why it cannot
 * be written.
 */
function declaredSubscription(
  key: string,
  config: SubscriptionConfig,
  botIds: Record<string, string>,
  env: Record<string, string | undefined>,
): { subscription: Subscription; variables: Variables } | string {
  const variables: Variables = {
    ...(config.secret ? { secret: config.secret.env } : {}),
    headers: Object.entries(config.headers ?? {}).map(([name, { env }]) => [name, env]),
  };
  const values = readValues(key, variables, env);
  if (typeof values === 'string') return values;
  const { secret, header } = values;
  const botId = config.bot ? botIds[config.bot] : undefined;
  const extension: Extension[] = [
    ...(config.interactions ?? []).map((valueCode) => ({ url: INTERACTION, valueCode })),
    ...(config.fhirPath ? [{ url: FHIR_PATH, valueString: config.fhirPath }] : []),
    ...(secret ? [{ url: SECRET, valueString: secret }] : []),
    ...(config.maxAttempts ? [{ url: MAX_ATTEMPTS, valueInteger: config.maxAttempts }] : []),
  ];
  const endpoint = config.url ?? (botId ? `Bot/${botId}` : undefined);
  return {
    subscription: {
      resourceType: 'Subscription',
      status: 'active',
      reason: key,
      criteria: config.criteria,
      channel: {
        type: 'rest-hook',
        ...(endpoint ? { endpoint } : {}),
        payload: 'application/fhir+json',
        ...(header.length > 0 ? { header } : {}),
      },
      ...(extension.length > 0 ? { extension } : {}),
      meta: { tag: [{ system: PLUMB_SYSTEM, code: key }] },
    },
    variables,
  };
}

/** The secret and header values from `env`, or why one cannot be sent. */
function readValues(
  key: string,
  variables: Variables,
  env: Record<string, string | undefined>,
): { secret?: string; header: string[] } | string {
  const missing = (variable: string, what: string) =>
    `${variable} is not set: it holds ${what} for Subscription ${key}.`;
  if (variables.secret && !env[variables.secret]) return missing(variables.secret, 'its secret');
  const header: string[] = [];
  for (const [name, variable] of variables.headers) {
    const value = env[variable];
    if (!value) return missing(variable, `header ${name}`);
    // Medplum splits each header on every ':', so a value holding one is cut short.
    if (value.includes(':')) {
      return `${variable} holds a ':', at which Medplum cuts header ${name} short; Subscription ${key} cannot send it.`;
    }
    header.push(`${name}: ${value}`);
  }
  return { ...(variables.secret ? { secret: env[variables.secret] } : {}), header };
}

/** One Subscription's change, or nothing when it is held as declared. */
function planOne(
  key: string,
  config: SubscriptionConfig,
  { subscription, variables }: { subscription: Subscription; variables: Variables },
  { current, adopt }: { current?: Subscription; adopt?: true },
): SubscriptionChange | undefined {
  const bot = config.bot && !subscription.channel.endpoint ? { bot: config.bot } : {};
  if (!current) {
    return {
      kind: '+',
      key,
      fields: [],
      subscription: withoutValues(subscription),
      ...bot,
      variables,
    };
  }
  // Medplum reads extensions by URL, so their order is not drift.
  const managed = (s: Subscription) => ({
    ...s,
    extension: s.extension
      ?.filter((e) => MANAGED_EXTENSIONS.includes(e.url))
      .map((e) => JSON.stringify(e))
      .sort(),
  });
  const fields = MANAGED.filter(
    (f) => !deepEquals(managed(subscription)[f] ?? undefined, managed(current)[f] ?? undefined),
  );
  if (fields.length === 0 && !adopt) return undefined;
  const others = current.extension?.filter((e) => !MANAGED_EXTENSIONS.includes(e.url)) ?? [];
  const otherTags = current.meta?.tag?.filter((t) => t.system !== PLUMB_SYSTEM) ?? [];
  const { error: _, ...kept } = current;
  const next: Subscription = {
    ...kept,
    ...subscription,
    extension: [...others, ...(subscription.extension ?? [])],
    meta: { ...current.meta, tag: [...otherTags, ...(subscription.meta?.tag ?? [])] },
  };
  if (next.extension?.length === 0) delete next.extension;
  return {
    kind: '~',
    key,
    id: current.id as string,
    fields: [...fields],
    ...(adopt ? { adopt } : {}),
    subscription: withoutValues(next),
    ...bot,
    variables,
    ...(current.status === 'off' && current.error ? { error: current.error } : {}),
  };
}

/** The Subscription with its secret and header values taken out, so no plan or `--json` holds them. */
function withoutValues(subscription: Subscription): Subscription {
  const { header: _, ...channel } = subscription.channel;
  const extension = subscription.extension?.filter((e) => e.url !== SECRET);
  const stripped: Subscription = { ...subscription, channel };
  if (extension?.length) stripped.extension = extension;
  else delete stripped.extension;
  return stripped;
}

/**
 * Writes the plan in order, reading each secret and header value from `env`
 * as it writes. A bot created by this push is resolved by its identifier.
 */
export async function applySubscriptions(
  plan: SubscriptionPlan,
  medplum: MedplumClient,
  env: Record<string, string | undefined> = {},
): Promise<number> {
  let written = 0;
  for (const change of plan.changes) {
    if (change.kind === '-') {
      if (change.kept) continue;
      const current = await medplum.readResource('Subscription', change.id);
      await medplum.updateResource({ ...current, status: 'off' });
    } else {
      const subscription = await withValues(medplum, change, env);
      if (change.kind === '+') await medplum.createResource(subscription);
      else await medplum.updateResource({ ...subscription, id: change.id });
    }
    written++;
  }
  return written;
}

async function withValues(
  medplum: MedplumClient,
  change: Extract<SubscriptionChange, { kind: '+' | '~' }>,
  env: Record<string, string | undefined>,
): Promise<Subscription> {
  const value = (variable: string) => {
    const read = env[variable];
    if (!read)
      throw new Error(`${variable} is not set: it holds a value for Subscription ${change.key}.`);
    return read;
  };
  const { subscription, variables } = change;
  let endpoint = subscription.channel.endpoint;
  if (change.bot) {
    const bot = await medplum.searchOne('Bot', { identifier: `${PLUMB_SYSTEM}|${change.bot}` });
    if (!bot) throw new Error(`Bot ${change.bot} is not in the project.`);
    endpoint = `Bot/${bot.id}`;
  }
  const header = variables.headers.map(([name, variable]) => `${name}: ${value(variable)}`);
  const secret = variables.secret ? [{ url: SECRET, valueString: value(variables.secret) }] : [];
  const extension = [...(subscription.extension ?? []), ...secret];
  return {
    ...subscription,
    channel: {
      ...subscription.channel,
      ...(endpoint ? { endpoint } : {}),
      ...(header.length > 0 ? { header } : {}),
    },
    ...(extension.length > 0 ? { extension } : {}),
  };
}

/** One change as the plan prints it. */
export function describeSubscription(change: SubscriptionChange): string {
  const line = `${change.kind} Subscription  ${change.key}`;
  if (change.kind === '-')
    return change.kept ? `${line} (kept: pass --prune to turn off)` : `${line} (turn off)`;
  const target = change.subscription.channel.endpoint ?? `Bot ${change.bot}`;
  if (change.kind === '+') return `${line}  ${change.subscription.criteria} → ${target}`;
  const notes = [
    change.adopt && 'adopted',
    change.fields.length > 0 && `${change.fields.join(', ')} changed`,
    change.error && `turned off by Medplum: ${change.error}`,
  ].filter(Boolean);
  return `${line} (${notes.join('; ')})`;
}

/** The step's line: what it will write. */
export function subscriptionsSummary(plan: SubscriptionPlan): string {
  if (plan.blocked.length > 0) return 'refusing: see below';
  const count = (kind: SubscriptionChange['kind']) =>
    plan.changes.filter((c) => c.kind === kind && !('kept' in c && c.kept)).length;
  return `plan: ${count('+')} to create, ${count('~')} to update, ${count('-')} to turn off`;
}
