// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReference, type MedplumClient } from '@medplum/core';
import type {
  AccessPolicy,
  AccessPolicyResource,
  Bot,
  ProjectMembership,
} from '@medplum/fhirtypes';
import { PLUMB_SYSTEM } from '../project.js';

/** How `push` finds its checker bot again, whatever it is named. */
export const CHECKER_IDENTIFIER = { system: PLUMB_SYSTEM, value: 'checker' };

export const findChecker = async (medplum: MedplumClient) => {
  const found = await medplum.searchResources('Bot', {
    identifier: `${CHECKER_IDENTIFIER.system}|${CHECKER_IDENTIFIER.value}`,
  });
  // A linked project's checker is found too, and is not this project's.
  return found.find((bot) => bot.meta?.project === medplum.getProject()?.id);
};

/** `$deploy` records the filename on the Bot, so it names the version and bundle deployed. */
export function checkerFilename(code: string, version: string): string {
  const hash = createHash('sha256').update(code).digest('hex').slice(0, 16);
  return `plumb-checker-${version}-${hash}.cjs`;
}

export const deployedVersion = (bot: Bot) =>
  bot.executableCode?.title?.match(/^plumb-checker-(.+)-[0-9a-f]{16}\.cjs$/)?.[1];

// The checker reads the types it checks, and the base definitions of contained resources.
const READ: AccessPolicyResource['interaction'] = ['read', 'vread', 'search', 'history'];

export interface CheckerInstall {
  status: 'installed' | 'updated' | 'unchanged';
  /** Plumb's version, deployed with the bundle. */
  version: string;
  /** The version replaced, when the bundle was redeployed over an older one. */
  previous?: string;
  botId: string;
}

export interface CheckerOptions {
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
export async function installChecker(
  medplum: MedplumClient,
  options: CheckerOptions,
): Promise<CheckerInstall> {
  const filename = checkerFilename(options.code, options.version);
  const policy: AccessPolicy = {
    resourceType: 'AccessPolicy',
    name: 'plumb-checker (read-only)',
    resource: [...new Set([...options.resourceTypes, 'StructureDefinition'])]
      .sort()
      .map((resourceType) => ({ resourceType, interaction: READ })),
  };

  const found = await findChecker(medplum);
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
  const previous = deployedVersion(bot);
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

/** Plumb's package directory, the one above this module in source or in dist. */
// Built, dist/esm and dist/cjs each hold a package.json naming only their
// module type, so the walk stops at the one naming Plumb.
function packageDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (manifest(dir)?.name !== 'plumb-fhir') {
    if (dir === dirname(dir)) throw new Error('plumb: cannot find the plumb-fhir package.json.');
    dir = dirname(dir);
  }
  return dir;
}

function manifest(dir: string): { name?: string; version?: string } | undefined {
  const file = join(dir, 'package.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}

export function packageVersion(): string {
  return manifest(packageDir())?.version ?? '';
}

/** The checker as this Plumb ships it, `dist/checker.cjs`, for push to deploy. */
export function bundledChecker(): Pick<CheckerOptions, 'code' | 'version'> {
  return {
    code: readFileSync(join(packageDir(), 'dist/checker.cjs'), 'utf8'),
    version: packageVersion(),
  };
}
