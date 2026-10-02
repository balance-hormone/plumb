// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { checkRoutes, type PlumbConfig } from './config.js';
import { printFiles } from './emit/print.js';
import { type ProfileModel, transform } from './emit/transform.js';
import { compareFiles, type Stale, writeFiles } from './emit/write.js';
import { loadProfiles } from './loader.js';
import { fetchPackages } from './packages.js';

type StepName = 'packages' | 'load' | 'emit' | 'write' | 'check';

/** One finished step, with what it did, for the CLI to print as it goes. */
export interface Step {
  name: StepName;
  ms: number;
  counts: Record<string, number>;
  warnings: string[];
}

interface GenerateError {
  code: string;
  message: string;
  step: StepName;
}

export interface GenerateResult {
  ok: boolean;
  steps: Step[];
  totalMs: number;
  /** Files written, and removed because their profile is no longer selected. */
  written: string[];
  removed: string[];
  /** In check mode, every file that differs from what would be generated. */
  stale: Stale[];
  errors: GenerateError[];
}

export interface GenerateOptions {
  /** A loaded config, with `local` and `out` resolved to absolute paths. */
  config: PlumbConfig;
  lockPath: string;
  /** Compare with the committed output instead of writing; nothing is written to the project. */
  check?: boolean;
  cacheDir?: string;
  fetch?: typeof globalThis.fetch;
  onStep?: (step: Step) => void;
}

const ms = (since: number) => Math.round(performance.now() - since);

/**
 * Fetches the IG packages, loads the selected profiles, emits their types,
 * and writes them to `out`, or with `check`, compares them with it byte for
 * byte. Each step is reported as it finishes.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const { config, check = false } = options;
  const start = performance.now();
  const result: GenerateResult = {
    ok: false,
    steps: [],
    totalMs: 0,
    written: [],
    removed: [],
    stale: [],
    errors: [],
  };
  let since = performance.now();
  const finish = (name: StepName, counts: Record<string, number>, warnings: string[] = []) => {
    const step = { name, ms: ms(since), counts, warnings };
    result.steps.push(step);
    options.onStep?.(step);
    since = performance.now();
  };
  const fail = (step: StepName, errors: { code: string; message: string }[]) => {
    result.errors.push(...errors.map((e) => ({ code: e.code, message: e.message, step })));
    result.totalMs = ms(start);
    return result;
  };

  const fetched = await fetchPackages({
    igs: config.igs,
    lockPath: options.lockPath,
    cacheDir: options.cacheDir,
    check,
    fetch: options.fetch,
  });
  if (!fetched.ok) return fail('packages', fetched.errors);
  const downloaded = fetched.packages.filter((p) => p.fetched).length;
  finish('packages', { cached: fetched.packages.length - downloaded, fetched: downloaded });

  const loaded = loadProfiles({
    packages: fetched.packages,
    igs: config.igs,
    local: config.local,
    profiles: config.profiles,
  });
  if (!loaded.ok) return fail('load', loaded.errors);
  // Whether a routing row names a selected profile and its elements is known only now.
  const routeErrors = checkRoutes(config, loaded.profiles);
  if (routeErrors.length > 0) return fail('load', routeErrors);
  const skipped = loaded.warnings.filter((w) => w.code === 'unparseable-skipped').length;
  finish(
    'load',
    { profiles: loaded.profiles.length, skipped, unresolved: loaded.unresolved.length },
    loaded.warnings.map((w) => w.message),
  );

  const { models, errors, warnings } = transform(loaded, { maxCodes: config.bindings?.maxCodes });
  if (errors.length > 0) return fail('emit', errors);
  const integrity = new Map(fetched.packages.map((p) => [`${p.name}@${p.version}`, p.integrity]));
  const files = printFiles(models, (m) => integrity.get(m.source) ?? hashOf(m));
  finish(
    'emit',
    {
      types: models.length,
      slices: models.reduce((n, m) => n + m.slices, 0),
      codeLists: models.reduce((n, m) => n + m.constants.length, 0),
    },
    warnings,
  );

  if (check) {
    const compared = compareFiles(config.out, files);
    if (compared.errors.length > 0) return fail('check', compared.errors);
    result.stale = compared.stale;
    const count = (problem: Stale['problem']) =>
      compared.stale.filter((s) => s.problem === problem).length;
    finish('check', { stale: count('stale'), missing: count('missing'), extra: count('extra') });
  } else {
    const wrote = writeFiles(config.out, files);
    if (!wrote.ok) return fail('write', wrote.errors);
    result.written = wrote.written;
    result.removed = wrote.removed;
    finish('write', {
      written: wrote.written.length,
      removed: wrote.removed.length,
      unchanged: files.size - wrote.written.length,
    });
  }
  result.ok = result.stale.length === 0;
  result.totalMs = ms(start);
  return result;
}

/** A profile outside any package is hashed by its StructureDefinition. */
function hashOf(model: ProfileModel): string {
  return `sha256-${createHash('sha256').update(JSON.stringify(model.sd)).digest('base64')}`;
}
