// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { deepEquals, type MedplumClient } from '@medplum/core';
import type { AccessPolicy, Bot, Project, ProjectMembership, Reference } from '@medplum/fhirtypes';
import type { BotConfig } from './config.js';
import {
  type Blocked,
  claim,
  PLUMB_SYSTEM,
  type ProjectOptions,
  searchAll,
  tagOf,
} from './project.js';

// @medplum/fhirtypes 5.1.0 has no rawBody on Bot.
type BotFields = Bot & { rawBody?: boolean };

/** A bot the project holds, with the membership that carries its access. */
export interface HeldBot {
  bot: BotFields;
  membership?: ProjectMembership;
}

/** The bundle to deploy, and the filename `$deploy` records as `executableCode.title`. */
interface Deploy {
  file: string;
  filename: string;
}

/** One write `push` plans for a bot: `+` create, `~` update, `-` clear a removed bot's schedule. */
export type BotChange =
  | {
      kind: '+';
      key: string;
      /** The Bot's declared fields and identifier. */
      bot: BotFields;
      /** The key of the membership's policy. */
      policy?: string;
      admin: boolean;
      deploy: Deploy;
    }
  | {
      kind: '~';
      key: string;
      id: string;
      membership: string;
      /** The Bot's fields, and the membership's `accessPolicy` and `admin`, that differ. */
      fields: string[];
      /** An untagged bot, given the identifier and taken over with `--adopt`. */
      adopt?: true;
      /** The Bot as the config wants it, keeping what Plumb does not manage. */
      bot: BotFields;
      policy?: string;
      admin: boolean;
      deploy?: Deploy;
      /** The filename deployed now, which `deploy` replaces. */
      deployed?: string;
    }
  | {
      kind: '-';
      key: string;
      id: string;
      /** Listed but not cleared, without `--prune`. */
      kept?: true;
    };

export interface BotPlan {
  changes: BotChange[];
  /** Why nothing in the bots step can be applied. */
  blocked: Blocked[];
  warnings: string[];
  /** Each public webhook's URL, by key, for the bots the project already holds. */
  webhooks: { key: string; url: string }[];
}

/** The Bot fields a key's config writes; any other field is the project's own. */
const MANAGED = [
  'name',
  'runtimeVersion',
  'timeout',
  'cronString',
  'runAsUser',
  'publicWebhook',
  'rawBody',
  'auditEventTrigger',
  'auditEventDestination',
] as const satisfies (keyof BotFields)[];

const identifierOf = (bot: Bot) => bot.identifier?.find((i) => i.system === PLUMB_SYSTEM)?.value;

/** The Bot fields as the config declares them, with Medplum's defaults written out. */
export function declaredBot(key: string, config: BotConfig): BotFields {
  const fields: BotFields = {
    resourceType: 'Bot',
    name: config.name ?? key,
    runtimeVersion: config.runtime ?? 'awslambda',
    // $deploy writes a timeout when there is none, which would then read as drift.
    timeout: config.timeout ?? 10,
    cronString: config.cron,
    runAsUser: config.runAsUser,
    publicWebhook: config.publicWebhook,
    rawBody: config.rawBody,
    auditEventTrigger: config.audit?.trigger,
    auditEventDestination: config.audit?.destination,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as BotFields;
}

/** The filename a bundle deploys as: the key and the file's hash, keeping its extension. */
export function botFilename(key: string, code: string | Buffer, file: string): string {
  const hash = createHash('sha256').update(code).digest('hex').slice(0, 16);
  return `${key}-${hash}${extname(file)}`;
}

/**
 * The features a project needs for its bots, which only a super admin can
 * turn on: `bots` for any, `cron` for a schedule. Read from the Project
 * itself, since the login's copy leaves out `features`.
 */
export async function missingFeatures(
  medplum: MedplumClient,
  bots: Record<string, BotConfig>,
): Promise<{ code: string; message: string }[]> {
  const project = await medplum.readResource('Project', medplum.getProject()?.id as string);
  const features = new Set<string>((project as Project).features ?? []);
  const scheduled = Object.keys(bots).filter((key) => bots[key]?.cron);
  return [
    !features.has('bots') && {
      code: 'bots-disabled',
      message: `The project does not have the bots feature, which only a super admin can turn on.`,
    },
    scheduled.length > 0 &&
      !features.has('cron') && {
        code: 'cron-disabled',
        message: `${scheduled.join(', ')} ${scheduled.length === 1 ? 'has a' : 'have'} schedule, and the project does not have the cron feature, which only a super admin can turn on: Medplum would never run it.`,
      },
  ].filter((e) => e !== false);
}

/**
 * Plans the bots against what the target project holds: each found by its
 * identifier, Plumb's system and the key, in this project only.
 */
export async function planBots(
  medplum: MedplumClient,
  bots: Record<string, BotConfig>,
  options: ProjectOptions = {},
): Promise<BotPlan> {
  const project = medplum.getProject()?.id;
  const ours = <T extends Bot | AccessPolicy>(r: T) => r.meta?.project === project;
  const tagged = (await searchAll(medplum, 'Bot', { identifier: `${PLUMB_SYSTEM}|` })).filter(ours);
  const names = Object.entries(bots).map(([key, c]) => c.name ?? key);
  const untagged = (await searchAll(medplum, 'Bot', {})).filter(
    (b) => ours(b) && identifierOf(b) === undefined && names.includes(b.name as string),
  );
  const policies = (await searchAll(medplum, 'AccessPolicy', { _tag: `${PLUMB_SYSTEM}|` })).filter(
    ours,
  );
  const policyIds = Object.fromEntries(policies.map((p) => [tagOf(p), p.id as string]));
  const held = await withMemberships(medplum, [...tagged, ...untagged]);
  return planHeld(bots, held, policyIds, medplum.getBaseUrl(), options);
}

async function withMemberships(medplum: MedplumClient, bots: Bot[]): Promise<HeldBot[]> {
  const held: HeldBot[] = [];
  for (const bot of bots) {
    const membership = await medplum.searchOne('ProjectMembership', { profile: `Bot/${bot.id}` });
    held.push({ bot, ...(membership ? { membership } : {}) });
  }
  return held;
}

/**
 * The plan for the bots a project holds. A policy the project step creates in
 * a dry run has no id yet, so a bot that names one is always updated.
 */
export function planHeld(
  bots: Record<string, BotConfig>,
  held: HeldBot[],
  policyIds: Record<string, string>,
  baseUrl: string,
  options: ProjectOptions = {},
): BotPlan {
  const plan: BotPlan = { changes: [], blocked: [], warnings: [], webhooks: [] };
  // The checker is Plumb's own, found by its own identifier.
  const byKey = Map.groupBy(
    held.filter((h) => identifierOf(h.bot) !== undefined && identifierOf(h.bot) !== 'checker'),
    (h) => identifierOf(h.bot) as string,
  );
  for (const [key, config] of Object.entries(bots)) {
    const name = config.name ?? key;
    const untagged = held.filter((h) => identifierOf(h.bot) === undefined && h.bot.name === name);
    const found = byKey.get(key) ?? [];
    const claimed = claim('Bot', key, name, found, untagged, options);
    if ('code' in claimed) {
      plan.blocked.push(claimed);
      continue;
    }
    const planned = planBot(key, config, claimed, policyIds);
    if ('code' in planned) plan.blocked.push(planned);
    else if (planned.change) plan.changes.push(planned.change);
    const membership = claimed.current?.membership?.id;
    if (config.publicWebhook && membership) {
      plan.webhooks.push({ key, url: webhookUrl(baseUrl, membership) });
    }
  }
  removed(plan, bots, byKey, options);
  return plan;
}

/**
 * A held bot whose key left the config keeps its Bot, membership and webhook
 * URL; only its schedule is cleared, with `--prune`.
 */
function removed(
  plan: BotPlan,
  bots: Record<string, BotConfig>,
  byKey: Map<string, HeldBot[]>,
  options: ProjectOptions,
): void {
  const kept = options.prune ? {} : { kept: true as const };
  for (const [key, found] of byKey) {
    if (Object.hasOwn(bots, key)) continue;
    for (const { bot } of found) {
      if (bot.cronString) plan.changes.push({ kind: '-', key, id: bot.id as string, ...kept });
      else {
        plan.warnings.push(
          `Bot ${key} is no longer declared; it stays, with its membership and webhook URL.`,
        );
      }
    }
  }
}

const webhookUrl = (baseUrl: string, membership: string) =>
  new URL(`webhook/${membership}`, baseUrl).href;

/** One bot's change, nothing when it is up to date, or why it is blocked. */
function planBot(
  key: string,
  config: BotConfig,
  { current, adopt }: { current?: HeldBot; adopt?: true },
  policyIds: Record<string, string>,
): { change?: BotChange } | Blocked {
  const code = readFileSync(config.file);
  const deploy = { file: config.file, filename: botFilename(key, code, config.file) };
  const declared = declaredBot(key, config);
  const identity = { system: PLUMB_SYSTEM, value: key };
  const access = {
    ...(config.policy ? { policy: config.policy } : {}),
    admin: config.admin === true,
  };
  if (!current) {
    return {
      change: { kind: '+', key, bot: { ...declared, identifier: [identity] }, ...access, deploy },
    };
  }
  const { bot, membership } = current;
  if (!membership) {
    return {
      code: 'bot-without-membership',
      message: `Bot ${key} (Bot/${bot.id}) has no ProjectMembership, so it cannot run on a schedule, a Subscription or a webhook, and only a super admin can add one.`,
    };
  }
  const fields = [
    ...MANAGED.filter((f) => !deepEquals(declared[f], bot[f])),
    ...accessFields(membership, config, policyIds),
  ];
  const deployed = bot.executableCode?.title;
  const redeploy = deployed !== deploy.filename;
  if (fields.length === 0 && !adopt && !redeploy) return {};
  const next: BotFields = { ...bot, identifier: [...(bot.identifier ?? []), identity] };
  for (const field of MANAGED) {
    if (declared[field] === undefined) delete next[field];
    else Object.assign(next, { [field]: declared[field] });
  }
  if (identifierOf(bot) !== undefined) next.identifier = bot.identifier;
  return {
    change: {
      kind: '~',
      key,
      id: bot.id as string,
      membership: membership.id as string,
      fields,
      ...(adopt ? { adopt } : {}),
      bot: next,
      ...access,
      ...(redeploy ? { deploy, ...(deployed ? { deployed } : {}) } : {}),
    },
  };
}

/** The membership's policy and `admin`, where they differ from the config. */
function accessFields(
  membership: ProjectMembership,
  config: BotConfig,
  policyIds: Record<string, string>,
): string[] {
  const policy = config.policy && policyIds[config.policy];
  const policyChanged = config.policy
    ? !policy || membership.accessPolicy?.reference !== `AccessPolicy/${policy}`
    : membership.accessPolicy !== undefined;
  return [
    policyChanged && 'accessPolicy',
    (membership.admin === true) !== (config.admin === true) && 'admin',
  ].filter((f) => typeof f === 'string');
}

/** What `applyBots` wrote, and each public webhook's URL for a bot it created. */
export interface BotsApplied {
  written: number;
  webhooks: { key: string; url: string }[];
}

/**
 * Writes the plan in order. A new bot is created through the admin endpoint,
 * which makes its membership, then given its identifier and fields, then
 * deployed. A removed bot only loses its schedule: deleting it would break
 * every webhook pointing at its membership, for good.
 */
export async function applyBots(plan: BotPlan, medplum: MedplumClient): Promise<BotsApplied> {
  const applied: BotsApplied = { written: 0, webhooks: [] };
  const policies = (await searchAll(medplum, 'AccessPolicy', { _tag: `${PLUMB_SYSTEM}|` })).filter(
    (p) => p.meta?.project === medplum.getProject()?.id,
  );
  const policy = (key?: string): Reference<AccessPolicy> | undefined => {
    const found = key ? policies.find((p) => tagOf(p) === key) : undefined;
    return found ? { reference: `AccessPolicy/${found.id}` } : undefined;
  };
  for (const change of plan.changes) {
    if (change.kind === '-') {
      if (change.kept) continue;
      const { cronString: _, ...bot } = await medplum.readResource('Bot', change.id);
      await medplum.updateResource(bot);
    } else if (change.kind === '+') {
      const membership = await createBot(medplum, change, policy(change.policy));
      if (change.bot.publicWebhook) {
        applied.webhooks.push({
          key: change.key,
          url: webhookUrl(medplum.getBaseUrl(), membership),
        });
      }
    } else {
      await updateBot(medplum, change, policy(change.policy));
    }
    applied.written++;
  }
  return applied;
}

/** Creates a bot with its membership, then converges and deploys it; returns the membership's id. */
async function createBot(
  medplum: MedplumClient,
  change: Extract<BotChange, { kind: '+' }>,
  accessPolicy: Reference<AccessPolicy> | undefined,
): Promise<string> {
  const created = await medplum.post<Bot>(`admin/projects/${medplum.getProject()?.id}/bot`, {
    name: change.bot.name,
    runtimeVersion: change.bot.runtimeVersion,
    ...(accessPolicy ? { accessPolicy } : {}),
  });
  const membership = await medplum.searchOne('ProjectMembership', {
    profile: `Bot/${created.id}`,
  });
  if (!membership) throw new Error(`Bot ${change.key} (${created.id}) has no ProjectMembership.`);
  await updateBot(
    medplum,
    {
      ...change,
      kind: '~',
      id: created.id as string,
      membership: membership.id as string,
      fields: change.admin ? ['admin'] : [],
      adopt: true,
      bot: { ...created, ...change.bot },
    },
    accessPolicy,
  );
  return membership.id as string;
}

/** Writes a bot's fields, then its membership's policy and `admin`, then deploys its bundle. */
async function updateBot(
  medplum: MedplumClient,
  change: Extract<BotChange, { kind: '~' }>,
  accessPolicy: Reference<AccessPolicy> | undefined,
): Promise<void> {
  if (change.adopt || change.fields.some((f) => (MANAGED as readonly string[]).includes(f))) {
    await medplum.updateResource(change.bot);
  }
  if (change.fields.some((f) => f === 'accessPolicy' || f === 'admin')) {
    const { accessPolicy: _, ...membership } = await medplum.readResource(
      'ProjectMembership',
      change.membership,
    );
    await medplum.updateResource({
      ...membership,
      ...(accessPolicy ? { accessPolicy } : {}),
      admin: change.admin,
    });
  }
  if (change.deploy) {
    await medplum.post(medplum.fhirUrl('Bot', change.id, '$deploy'), {
      code: readFileSync(change.deploy.file, 'utf8'),
      filename: change.deploy.filename,
    });
  }
}

/** One change as the plan prints it. */
export function describeBot(change: BotChange): string {
  const line = `${change.kind} Bot  ${change.key}`;
  if (change.kind === '-') {
    return change.kept
      ? `${line} (kept: pass --prune to clear its schedule)`
      : `${line} (clear its schedule)`;
  }
  if (change.kind === '+')
    return `${line}  ${change.bot.runtimeVersion}${change.policy ? `, policy ${change.policy}` : ''}`;
  const hash = (filename?: string) => filename?.match(/-([0-9a-f]{16})\.\w+$/)?.[1]?.slice(0, 4);
  const notes = [
    change.adopt && 'adopted',
    change.fields.length > 0 && change.fields.join(', '),
    change.deploy &&
      (change.deployed
        ? `code changed (${hash(change.deployed) ?? '?'}… → ${hash(change.deploy.filename)}…)`
        : 'code deployed'),
  ].filter(Boolean);
  return `${line} (${notes.join('; ')})`;
}

/** The step's line: what it will write. */
export function botsSummary(plan: BotPlan): string {
  if (plan.blocked.length > 0) return 'refusing: see below';
  const count = (match: (c: BotChange) => boolean) => plan.changes.filter(match).length;
  const created = count((c) => c.kind === '+');
  const deployed = count((c) => c.kind === '+' || (c.kind === '~' && c.deploy !== undefined));
  const updated = count((c) => c.kind === '~' && c.deploy === undefined);
  const cleared = count((c) => c.kind === '-' && !c.kept);
  return `plan: ${created} to create, ${updated} to update, ${deployed} to deploy, ${cleared} to disconnect`;
}
