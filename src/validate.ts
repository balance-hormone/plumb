// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { dirname, join, resolve } from 'node:path';
import { OperationOutcomeError, validateResource } from '@medplum/core';
import type { OperationOutcomeIssue, Resource, StructureDefinition } from '@medplum/fhirtypes';
import { loadConfig } from './config.js';
import { loadProfiles } from './loader.js';
import { lockedPackages } from './packages.js';

export interface ValidateReport {
  ok: boolean;
  errors: OperationOutcomeIssue[];
  warnings: OperationOutcomeIssue[];
}

export interface ValidateOptions {
  /** Where to look for plumb.config.ts; the working directory by default. */
  cwd?: string;
  configPath?: string;
  /** The shared FHIR package cache. */
  cacheDir?: string;
}

// Medplum's validator holds one global set of profiles, so they load once per config.
const loaded = new Map<string, Promise<Map<string, StructureDefinition>>>();

/**
 * Validates a resource against one of the profiles the project's
 * plumb.config.ts selects, with `@medplum/core`'s `validateResource`, offline.
 * It promises that validator's verdict at the installed `@medplum/core`
 * version, not a server's: it checks no terminology binding, and inherits
 * the gaps design 01 lists.
 */
export async function validateProfiled(
  resource: Resource,
  profileUrl: string,
  options: ValidateOptions = {},
): Promise<ValidateReport> {
  const cwd = options.cwd ?? process.cwd();
  const key = `${resolve(cwd, options.configPath ?? '')}|${options.cacheDir ?? ''}`;
  let profiles = loaded.get(key);
  if (!profiles) {
    profiles = load(cwd, options);
    loaded.set(key, profiles);
  }
  const url = profileUrl.split('|')[0] as string;
  const profile = (await profiles).get(url);
  if (!profile) {
    throw new Error(`plumb.config.ts does not select ${url}. Add it to profiles.`);
  }
  let issues: OperationOutcomeIssue[];
  try {
    issues = validateResource(resource, { profile });
  } catch (err) {
    // validateResource throws with every issue when any is an error.
    if (!(err instanceof OperationOutcomeError)) throw err;
    issues = err.outcome.issue ?? [];
  }
  const errors = issues.filter((i) => i.severity === 'error' || i.severity === 'fatal');
  const warnings = issues.filter((i) => !errors.includes(i));
  return { ok: errors.length === 0, errors, warnings };
}

async function load(cwd: string, options: ValidateOptions) {
  const config = await loadConfig({ cwd, configPath: options.configPath });
  if (!config.ok) throw new Error(config.errors.map((e) => e.message).join('\n'));
  const packages = lockedPackages(join(dirname(config.configPath), 'plumb.lock'), options.cacheDir);
  const result = loadProfiles({
    packages,
    igs: config.config.igs,
    local: config.config.local,
    profiles: config.config.profiles,
  });
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return new Map(result.profiles.map((p) => [p.url, p.sd]));
}
