// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type ConfigError, loadConfig, resolveEnvironment } from './config.js';
import {
  type Checked,
  type TypeReport,
  type ValidateEnvResult,
  validateEnvironment,
} from './conformance.js';
import type { EnvStep } from './connect.js';
import { type GenerateResult, generate, type Step } from './generate.js';
import { type PushResult, push } from './push.js';

export interface CliIo {
  cwd: string;
  env: Record<string, string | undefined>;
  /** Whether stderr is a terminal, where colour is allowed. */
  isTTY: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cacheDir?: string;
  fetch?: typeof globalThis.fetch;
}

const USAGE = `Usage: plumb generate [--check] [--config <path>]
       plumb validate --env <name> [--resume] [--config <path>]
       plumb push --env <name> [--dry-run | --check] [--prune] [--adopt] [--config <path>]

generate  Generate TypeScript types that narrow @medplum/fhirtypes from the
          FHIR profiles plumb.config.ts selects.
validate  Count the stored resources that would fail each selected profile,
          and why, with Plumb's checker bot inside the project.
push      Install the checker, then load the selected profiles into a Medplum
          project, refusing while stored resources would fail them, then
          converge the project's own configuration.

Options:
  --check          generate: compare with the committed output instead of writing; fail if stale
                   push: plan and fail if push would write anything, writing nothing
  --env <name>     the environment in plumb.config.ts to act on
  --resume         continue an interrupted validate from its last page
  --dry-run        push: stop after the gate and the project plan, writing nothing
  --prune          push: delete what Plumb manages that the config no longer has
  --adopt          push: tag and converge an untagged resource with a key's name
  --config <path>  the config file (default: plumb.config.ts)
  --json           print the report as JSON on stdout
  --quiet          print only problems
  -h, --help       show this help
  -v, --version    show the version
`;

// Exit codes: problems found (stale output, a lock mismatch) differ from misuse.
const OK = 0;
const PROBLEMS = 1;
const USAGE_ERROR = 2;

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

function version(): string {
  return manifest(packageDir())?.version ?? '';
}

const time = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/** What a step did, as one line: its name, its counts and its time. */
export function formatStep(step: Step, out: string): string {
  const c = step.counts;
  const summary = {
    sushi: `${c.structureDefinitions} StructureDefinitions, ${c.valueSets} ValueSets`,
    packages: `${c.cached} cached, ${c.fetched} fetched`,
    load: `${c.profiles} profiles${c.skipped ? `, ${c.skipped} skipped` : ''}`,
    emit: `${c.types} types, ${c.slices} slices, ${c.codeLists} code lists`,
    routes: `${c.rows} rows for ${c.types} types${c.ambiguous ? `, ${c.ambiguous} ambiguous` : ''}`,
    write: `${c.written} written, ${c.removed} removed, ${c.unchanged} unchanged → ${out}`,
    check:
      c.stale || c.missing || c.extra
        ? `${c.stale} stale, ${c.missing} missing, ${c.extra} extra`
        : 'up to date',
  }[step.name];
  return `${step.name.padEnd(8)}  ${summary}   ${time(step.ms)}`;
}

/** Runs a command line, printing its report, and returns the exit code. */
export async function run(argv: string[], io: CliIo): Promise<number> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (err) {
    io.stderr(`plumb: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return USAGE_ERROR;
  }
  const { values, positionals } = args;
  if (values.help) {
    io.stdout(USAGE);
    return OK;
  }
  if (values.version) {
    io.stdout(`${version()}\n`);
    return OK;
  }
  const command = positionals.length === 1 ? positionals[0] : undefined;
  if (command === 'generate') return generateCommand(values, io);
  if (command === 'push' || command === 'validate') return envCommand(command, values, io);
  const got = positionals.length === 0 ? 'no command' : `"${positionals.join(' ')}"`;
  io.stderr(`plumb: expected generate, validate or push, got ${got}\n\n${USAGE}`);
  return USAGE_ERROR;
}

type Values = ReturnType<typeof parse>['values'];

/** Progress goes to stderr unless quiet; problems always do. Colour only in a terminal. */
function printer(io: CliIo, quiet: boolean) {
  const color = io.isTTY && !io.env.NO_COLOR;
  const paint = (code: number, text: string) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
  return {
    ok: paint(32, '✔'),
    bad: paint(31, '✖'),
    say: (line: string) => {
      if (!quiet) io.stderr(`${line}\n`);
    },
    problem: (line: string) => io.stderr(`${line}\n`),
  };
}

async function generateCommand(values: Values, io: CliIo): Promise<number> {
  const quiet = values.quiet ?? false;
  const { ok, bad, say, problem } = printer(io, quiet);
  const config = await loadConfig({ cwd: io.cwd, configPath: values.config });
  if (!config.ok) return configErrors(config.errors, values, io);
  const out = relative(io.cwd, config.config.out) || '.';
  say(`plumb generate${values.check ? ' --check' : ''}`);
  const result = await generate({
    config: config.config,
    lockPath: join(dirname(config.configPath), 'plumb.lock'),
    check: values.check,
    cacheDir: io.cacheDir,
    fetch: io.fetch,
    onStep: (step) => {
      const c = step.counts;
      const failed =
        step.name === 'check' && (c.stale ?? 0) + (c.missing ?? 0) + (c.extra ?? 0) > 0;
      (failed ? problem : say)(`${failed ? bad : ok} ${formatStep(step, out)}`);
      for (const w of step.warnings) (quiet ? problem : say)(`    ${w}`);
    },
  });
  report(result, out, problem, bad);
  (result.ok ? say : problem)(`${result.ok ? 'Done' : 'Failed'} in ${time(result.totalMs)}`);
  if (values.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  // SUSHI missing or too old is set-up, like a config error, not a problem in the profiles.
  const setup = result.errors.some(
    (e) => e.code === 'sushi-not-installed' || e.code === 'sushi-too-old',
  );
  return result.ok ? OK : setup ? USAGE_ERROR : PROBLEMS;
}

/** `push` and `validate`: both act on an environment, so both take `--env`. */
async function envCommand(command: 'push' | 'validate', values: Values, io: CliIo) {
  const quiet = values.quiet ?? false;
  const { bad, say, problem } = printer(io, quiet);
  const options = await envOptions(command, values, io);
  if (typeof options === 'number') return options;
  say(
    `plumb ${command} --env ${values.env}${command === 'push' && values.check ? ' --check' : ''}`,
  );
  const { root, ...shared } = options;
  const reportPath = join(root, '.plumb', `validate-${values.env}.json`);
  const result =
    command === 'push'
      ? await push({
          ...shared,
          reportPath,
          dryRun: values['dry-run'],
          check: values.check,
          prune: values.prune,
          adopt: values.adopt,
          env: io.env,
        })
      : await validateEnvironment({ ...shared, reportPath, resume: values.resume });
  printValidation(result, relative(io.cwd, result.reportPath ?? ''), say, problem);
  for (const e of result.errors) problem(`${bad} ${e.step.padEnd(8)}  ${e.message}`);
  (result.ok ? say : problem)(`${result.ok ? 'Done' : 'Failed'} in ${time(result.totalMs)}`);
  if (values.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  if (result.ok) return OK;
  // Profiles that fail, or will not load, are problems found; the rest kept the command from running.
  return result.errors.every((e) => e.step === 'load') ? PROBLEMS : USAGE_ERROR;
}

/** The config, environment and checker a command on an environment needs, or its exit code. */
async function envOptions(command: string, values: Values, io: CliIo) {
  const quiet = values.quiet ?? false;
  if (!values.env) {
    io.stderr(`plumb: ${command} needs --env <name>\n\n${USAGE}`);
    return USAGE_ERROR;
  }
  const config = await loadConfig({ cwd: io.cwd, configPath: values.config });
  if (!config.ok) return configErrors(config.errors, values, io);
  const environment = resolveEnvironment(config.config, values.env, io.env);
  if (!environment.ok) return configErrors(environment.errors, values, io);
  const root = dirname(config.configPath);
  return {
    root,
    config: config.config,
    environment: environment.environment,
    lockPath: join(root, 'plumb.lock'),
    checker: {
      code: readFileSync(join(packageDir(), 'dist/checker.cjs'), 'utf8'),
      version: version(),
    },
    cacheDir: io.cacheDir,
    fetch: io.fetch,
    onStep: (step: EnvStep<string>) => printStep(step, printer(io, quiet), quiet),
  };
}

/** A step's line, then its warnings: a failed step's always print, as problems do. */
function printStep(step: EnvStep<string>, p: ReturnType<typeof printer>, quiet: boolean) {
  const line = `${step.name.padEnd(8)}  ${step.summary}   ${time(step.ms)}`;
  if (step.failed) p.problem(`${p.bad} ${line}`);
  else p.say(`${p.ok} ${line}`);
  for (const w of step.warnings) (quiet || step.failed ? p.problem : p.say)(`    ${w}`);
}

/** The report under the validate step, and where the failing ids are: never the ids themselves. */
function printValidation(
  result: ValidateEnvResult | PushResult,
  reportPath: string,
  say: (line: string) => void,
  problem: (line: string) => void,
) {
  // validate always shows what it found; push only what refused or failed it.
  const found =
    'profiles' in result ? result : result.ok ? undefined : (result.recheck ?? result.gate);
  if (!found) return;
  for (const line of formatValidation(found)) (result.ok ? say : problem)(line);
  if (Object.values(found.profiles).some((p) => p.failing > 0)) {
    problem(`Failing ids: ${reportPath} (gitignored)`);
  }
}

type Found = Pick<Checked, 'types' | 'profiles'>;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The validate report under its step: each type, then each of its profiles and their reasons. */
export function formatValidation(result: Found): string[] {
  const lines: string[] = [];
  for (const [type, t] of Object.entries(result.types)) {
    const profiles = Object.entries(result.profiles).filter(([, p]) => p.resourceType === type);
    const status = typeStatus(t);
    lines.push(`    ${type}: ${[status, ...typeExtras(t)].join('; ')}`);
    for (const [url, p] of profiles) {
      const name = url.slice(url.lastIndexOf('/') + 1);
      lines.push(`      ${name}   ${p.checked} checked, ${plural(p.failing, 'failure')}`);
      for (const r of p.reasons) lines.push(`        ${r.path}: ${r.message}   (${r.count})`);
    }
  }
  return lines;
}

/**
 * The three kinds of empty told apart, then what failed, in records: one
 * stamped with a profile and its parent is checked twice, counted once.
 */
function typeStatus(t: TypeReport): string {
  const read = `${t.read} of ${t.exists} read`;
  if (t.exists === 0) return 'none stored';
  if (t.read === 0) return `0 of ${t.exists} readable: check plumb-checker's AccessPolicy`;
  if (t.stamped === 0) return `${read}, none carries a selected profile`;
  if (t.failing === 0) return `${read}, all ${t.stamped} stamped passed`;
  return `${read}, ${t.failing} of ${t.stamped} stamped fail`;
}

/** What was not validated: unstamped resources, silent stamps, and other profiles' stamps. */
function typeExtras(t: TypeReport): string[] {
  const silent = [
    t.silent.unknown && `${t.silent.unknown} unknown profile URL`,
    t.silent.versioned && `${t.silent.versioned} url|version`,
    t.silent.empty && `${t.silent.empty} empty meta.profile`,
  ].filter((x) => typeof x === 'string');
  const others = Object.values(t.otherProfiles).reduce((n, c) => n + c, 0);
  return [
    t.unstamped > 0 && `${t.unstamped} unstamped`,
    silent.length > 0 && `silent stamps: ${silent.join(', ')}`,
    others > 0 && `${others} stamped with profiles not selected`,
  ].filter((x) => typeof x === 'string');
}

function configErrors(errors: ConfigError[], values: Values, io: CliIo): number {
  const { bad, problem } = printer(io, true);
  for (const e of errors) problem(`${bad} config    ${e.message}`);
  if (values.json) io.stdout(`${JSON.stringify({ ok: false, errors }, null, 2)}\n`);
  return USAGE_ERROR;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      check: { type: 'boolean' },
      config: { type: 'string' },
      env: { type: 'string' },
      resume: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      prune: { type: 'boolean' },
      adopt: { type: 'boolean' },
      json: { type: 'boolean' },
      quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
}

/** Each stale file with its cause, and each error with its step, then the fix. */
function report(result: GenerateResult, out: string, problem: (line: string) => void, bad: string) {
  for (const s of result.stale) problem(`    ${s.file}: ${s.cause}`);
  if (result.stale.length > 0) problem(`Run plumb generate to update ${out}.`);
  for (const e of result.errors) problem(`${bad} ${e.step.padEnd(8)}  ${e.message}`);
}
