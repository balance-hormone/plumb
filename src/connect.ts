// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { MedplumClient, normalizeErrorString } from '@medplum/core';
import type { PlumbConfig, ResolvedEnvironment } from './config.js';
import { type LoadProfilesResult, loadProfiles } from './loader.js';
import { fetchPackages } from './packages.js';

export type ConnectResult =
  | { ok: true; medplum: MedplumClient; strictMode: boolean; ms: number }
  | { ok: false; error: { code: 'connect-failed'; message: string } };

/**
 * Logs in to an environment with its client credentials. Strict mode is
 * reported, never set: only a super admin can change it.
 */
export async function connect(environment: ResolvedEnvironment): Promise<ConnectResult> {
  const start = performance.now();
  const medplum = new MedplumClient({ baseUrl: environment.baseUrl });
  try {
    // The login reads GET /auth/me, which returns the project to any member.
    await medplum.startClientLogin(environment.clientId, environment.clientSecret);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'connect-failed',
        message: `Could not log in to ${environment.baseUrl} (${environment.name}): ${normalizeErrorString(err)}`,
      },
    };
  }
  return {
    ok: true,
    medplum,
    strictMode: medplum.getProject()?.strictMode === true,
    ms: Math.round(performance.now() - start),
  };
}

/** One finished step of a command that acts on an environment, for the CLI to print as it goes. */
export interface EnvStep<Name extends string> {
  name: Name;
  ms: number;
  /** What the step did, for the CLI's line. */
  summary: string;
  warnings: string[];
  /** The step found problems, so the CLI marks it failed. */
  failed?: boolean;
}

export interface EnvResult<Name extends string> {
  ok: boolean;
  steps: EnvStep<Name>[];
  totalMs: number;
  strictMode?: boolean;
  errors: { code: string; message: string; step: Name }[];
}

export interface EnvOptions {
  /** A loaded config, with `local` resolved to an absolute path. */
  config: PlumbConfig;
  environment: ResolvedEnvironment;
  lockPath: string;
  cacheDir?: string;
  fetch?: typeof globalThis.fetch;
  // Any step name, so one printer serves every command.
  onStep?: (step: EnvStep<string>) => void;
}

const ms = (since: number) => Math.round(performance.now() - since);

/** Records each step as it finishes, and each error with its step. */
export function steps<Name extends string, Result extends EnvResult<Name>>(
  result: Result,
  onStep?: (step: EnvStep<string>) => void,
) {
  const start = performance.now();
  let since = start;
  return {
    finish(name: Name, summary: string, warnings: string[] = [], failed = false) {
      const step = { name, ms: ms(since), summary, warnings, ...(failed ? { failed } : {}) };
      result.steps.push(step);
      onStep?.(step);
      since = performance.now();
    },
    fail(step: Name, errors: { code: string; message: string }[]) {
      result.errors.push(...errors.map((e) => ({ code: e.code, message: e.message, step })));
      result.totalMs = ms(start);
      return result;
    },
    done() {
      result.totalMs = ms(start);
      return result;
    },
  };
}

/**
 * The first two steps of `push` and `validate`: load the selected profiles,
 * with packages verified against plumb.lock (never written, as in
 * `generate --check`), then log in to the environment.
 */
export async function loadAndConnect<Name extends string>(
  options: EnvOptions,
  result: EnvResult<Name | 'load' | 'connect'>,
  step: Pick<
    ReturnType<typeof steps<Name | 'load' | 'connect', EnvResult<Name | 'load' | 'connect'>>>,
    'finish' | 'fail'
  >,
): Promise<
  { loaded: LoadProfilesResult; resourceTypes: string[]; medplum: MedplumClient } | undefined
> {
  const { config } = options;
  const fetched = await fetchPackages({
    igs: config.igs,
    lockPath: options.lockPath,
    cacheDir: options.cacheDir,
    check: true,
    fetch: options.fetch,
  });
  if (!fetched.ok) return void step.fail('load', fetched.errors);
  const loaded = loadProfiles({
    packages: fetched.packages,
    igs: config.igs,
    local: config.local,
    profiles: config.profiles,
  });
  if (!loaded.ok) return void step.fail('load', loaded.errors);
  const resourceTypes = [...new Set(loaded.profiles.map((p) => p.sd.type))].sort();
  step.finish(
    'load',
    `${loaded.profiles.length} profiles of ${resourceTypes.join(', ')}`,
    loaded.warnings.map((w) => w.message),
  );

  const connected = await connect(options.environment);
  if (!connected.ok) return void step.fail('connect', [connected.error]);
  result.strictMode = connected.strictMode;
  step.finish(
    'connect',
    `${options.environment.baseUrl} (strict mode ${connected.strictMode ? 'on' : 'off'})`,
  );
  return { loaded, resourceTypes, medplum: connected.medplum };
}
