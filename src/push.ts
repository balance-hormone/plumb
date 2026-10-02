// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { createReference, type MedplumClient, normalizeErrorString } from '@medplum/core';
import type {
  AccessPolicy,
  AccessPolicyResource,
  Bot,
  ProjectMembership,
} from '@medplum/fhirtypes';
import type { PlumbConfig, ResolvedEnvironment } from './config.js';
import { connect } from './connect.js';
import { loadProfiles } from './loader.js';
import { fetchPackages } from './packages.js';

/** How `push` finds its checker bot again, whatever it is named. */
export const CHECKER_IDENTIFIER = {
  system: 'https://github.com/balance-hormone/plumb',
  value: 'checker',
};

// The checker reads the types it checks, and the base definitions of contained resources.
const READ: AccessPolicyResource['interaction'] = ['read', 'vread', 'search', 'history'];

interface CheckerInstall {
  status: 'installed' | 'updated' | 'unchanged';
  /** Plumb's version, deployed with the bundle. */
  version: string;
  /** The version replaced, when the bundle was redeployed over an older one. */
  previous?: string;
  botId: string;
}

interface CheckerOptions {
  /** The bundled bot, `dist/checker.cjs`. */
  code: string;
  version: string;
  /** The resource types the selected profiles constrain: all the bot may read, with StructureDefinition. */
  resourceTypes: string[];
}

/**
 * Creates or updates the checker bot and its read-only AccessPolicy, and
 * deploys its bundle unless the deployed one has the same version and hash.
 * Needs an admin membership that can write Bot and AccessPolicy.
 */
async function installChecker(
  medplum: MedplumClient,
  options: CheckerOptions,
): Promise<CheckerInstall> {
  // $deploy records the filename on the Bot, so it names what is deployed.
  const hash = createHash('sha256').update(options.code).digest('hex').slice(0, 16);
  const filename = `plumb-checker-${options.version}-${hash}.cjs`;
  const policy: AccessPolicy = {
    resourceType: 'AccessPolicy',
    name: 'plumb-checker (read-only)',
    resource: [...new Set([...options.resourceTypes, 'StructureDefinition'])]
      .sort()
      .map((resourceType) => ({ resourceType, interaction: READ })),
  };

  const identifier = `${CHECKER_IDENTIFIER.system}|${CHECKER_IDENTIFIER.value}`;
  const found = await medplum.searchOne('Bot', { identifier });
  let bot: Bot;
  let changed = false;
  if (found) {
    bot = found;
    changed = await updatePolicy(medplum, bot, policy);
  } else {
    const created = await medplum.createResource(policy);
    const projectId = medplum.getProject()?.id as string;
    // The admin endpoint creates the bot's membership, with its policy, too.
    const createdBot = await medplum.post<Bot>(`admin/projects/${projectId}/bot`, {
      name: 'plumb-checker',
      description: 'Validates stored resources against profiles for plumb validate; reads only.',
      accessPolicy: createReference(created),
    });
    bot = await medplum.updateResource<Bot>({ ...createdBot, identifier: [CHECKER_IDENTIFIER] });
  }
  const botId = bot.id as string;

  const deployed = bot.executableCode?.title;
  if (deployed !== filename) {
    await medplum.post(medplum.fhirUrl('Bot', botId, '$deploy'), {
      code: options.code,
      filename,
    });
    changed = true;
  }
  const previous = deployed?.match(/^plumb-checker-(.+)-[0-9a-f]{16}\.cjs$/)?.[1];
  return {
    status: deployed === undefined ? 'installed' : changed ? 'updated' : 'unchanged',
    version: options.version,
    ...(previous !== undefined && previous !== options.version ? { previous } : {}),
    botId,
  };
}

/** Points the bot's membership at a policy with exactly the planned entries. */
async function updatePolicy(medplum: MedplumClient, bot: Bot, policy: AccessPolicy) {
  const membership = await medplum.searchOne('ProjectMembership', {
    profile: `Bot/${bot.id}`,
  });
  if (!membership) throw new Error(`plumb-checker (Bot/${bot.id}) has no ProjectMembership.`);
  const current = membership.accessPolicy
    ? await medplum.readReference(membership.accessPolicy)
    : undefined;
  if (!current) {
    const created = await medplum.createResource(policy);
    await medplum.updateResource<ProjectMembership>({
      ...membership,
      accessPolicy: createReference(created),
    });
    return true;
  }
  if (JSON.stringify(current.resource) === JSON.stringify(policy.resource)) return false;
  await medplum.updateResource({ ...current, resource: policy.resource });
  return true;
}

type PushStepName = 'load' | 'connect' | 'checker';

interface PushStep {
  name: PushStepName;
  ms: number;
  /** What the step did, for the CLI's line. */
  summary: string;
  warnings: string[];
}

export interface PushResult {
  ok: boolean;
  steps: PushStep[];
  totalMs: number;
  strictMode?: boolean;
  checker?: CheckerInstall;
  errors: { code: string; message: string; step: PushStepName }[];
}

export interface PushOptions {
  /** A loaded config, with `local` resolved to an absolute path. */
  config: PlumbConfig;
  environment: ResolvedEnvironment;
  lockPath: string;
  checker: Pick<CheckerOptions, 'code' | 'version'>;
  cacheDir?: string;
  fetch?: typeof globalThis.fetch;
  onStep?: (step: PushStep) => void;
}

const ms = (since: number) => Math.round(performance.now() - since);

/**
 * Loads the selected profiles, connects to the environment and installs or
 * updates the checker bot: step 1 of design 02's push.
 */
export async function push(options: PushOptions): Promise<PushResult> {
  const { config } = options;
  const start = performance.now();
  const result: PushResult = { ok: false, steps: [], totalMs: 0, errors: [] };
  let since = performance.now();
  const finish = (name: PushStepName, summary: string, warnings: string[] = []) => {
    const step = { name, ms: ms(since), summary, warnings };
    result.steps.push(step);
    options.onStep?.(step);
    since = performance.now();
  };
  const fail = (step: PushStepName, errors: { code: string; message: string }[]) => {
    result.errors.push(...errors.map((e) => ({ code: e.code, message: e.message, step })));
    result.totalMs = ms(start);
    return result;
  };

  // As generate --check: packages are verified against plumb.lock, which push never writes.
  const fetched = await fetchPackages({
    igs: config.igs,
    lockPath: options.lockPath,
    cacheDir: options.cacheDir,
    check: true,
    fetch: options.fetch,
  });
  if (!fetched.ok) return fail('load', fetched.errors);
  const loaded = loadProfiles({
    packages: fetched.packages,
    igs: config.igs,
    local: config.local,
    profiles: config.profiles,
  });
  if (!loaded.ok) return fail('load', loaded.errors);
  const resourceTypes = [...new Set(loaded.profiles.map((p) => p.sd.type))].sort();
  finish(
    'load',
    `${loaded.profiles.length} profiles of ${resourceTypes.join(', ')}`,
    loaded.warnings.map((w) => w.message),
  );

  const connected = await connect(options.environment);
  if (!connected.ok) return fail('connect', [connected.error]);
  result.strictMode = connected.strictMode;
  finish(
    'connect',
    `${options.environment.baseUrl} (strict mode ${connected.strictMode ? 'on' : 'off'})`,
  );

  try {
    result.checker = await installChecker(connected.medplum, { ...options.checker, resourceTypes });
  } catch (err) {
    return fail('checker', [{ code: 'checker-failed', message: normalizeErrorString(err) }]);
  }
  const { status, version, previous } = result.checker;
  finish('checker', `plumb-checker ${previous ? `${previous} → ` : ''}${version} ${status}`);

  result.ok = true;
  result.totalMs = ms(start);
  return result;
}
