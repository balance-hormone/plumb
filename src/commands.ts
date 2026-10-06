// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import type * as TS from 'typescript5';
import { type CheckResult, checkProject } from './check.js';
import { bundledChecker, packageVersion } from './checker/install.js';
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
  /** The TypeScript `check` compiles with; the project's own by default. */
  typescript?: typeof TS;
}

const USAGE = `Usage: plumb generate [--check] [--config <path>]
       plumb validate --env <name> [--env-file <path>] [--full] [--unstamped] [--resume] [--config <path>]
       plumb push --env <name> [--env-file <path>] [--dry-run | --check] [--prune] [--adopt] [--config <path>]
       plumb check [--update-baseline [--allow-growth]] [--config <path>]

generate  Generate TypeScript types that narrow @medplum/fhirtypes from the
          FHIR profiles plumb.config.ts selects.
validate  Count the stored resources that would fail each selected profile,
          and why, with Plumb's checker bot inside the project.
push      Install the checker, then load the selected profiles into a Medplum
          project, refusing while stored resources would fail them, then
          converge the project's own configuration.
check     Find MedplumClient reads and writes of profiled types that go
          around readProfiled, searchProfiled, createProfiled and stampProfiled,
          by the types the compiler infers, against a committed baseline.

Options:
  --check          generate: compare with the committed output instead of writing; fail if stale
                   push: plan and fail if push would write anything, writing nothing
  --env <name>     the environment in plumb.config.ts to act on
  --env-file <path>  variables to read credentials and secrets from, as Node's
                   --env-file does; repeatable, later files win, the environment over all
  --resume         continue an interrupted validate from its last page
  --full           validate: read every stored resource, not only those with a selected
                   stamp, to break down silent stamps and other profiles' stamps
  --unstamped      validate: also forecast what would fail if unstamped resources were
                   stamped as createProfiled would; reported, never failing the run
  --dry-run        push: stop after the gate and the project plan, writing nothing
  --prune          push: delete what Plumb manages that the config no longer has
  --adopt          push: tag and converge an untagged resource with a key's name
  --update-baseline  check: rewrite the baseline from what is found; refuses growth
  --allow-growth     check: let --update-baseline accept new findings
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

const time = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/** What a step did, as one line: its name, its counts and its time. */
export function formatStep(step: Step, out: string): string {
  const c = step.counts;
  const summary = {
    sushi: `${c.structureDefinitions} StructureDefinitions, ${c.valueSets} ValueSets`,
    packages: `${c.cached} cached, ${c.fetched} fetched`,
    load: `${c.profiles} profiles${c.skipped ? `, ${c.skipped} skipped` : ''}${c.content ? `, ${c.content} content` : ''}`,
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
    io.stdout(`${packageVersion()}\n`);
    return OK;
  }
  const command = positionals.length === 1 ? positionals[0] : undefined;
  if (command === 'generate') return generateCommand(values, io);
  if (command === 'push' || command === 'validate') return envCommand(command, values, io);
  if (command === 'check') return checkCommand(values, io);
  const got = positionals.length === 0 ? 'no command' : `"${positionals.join(' ')}"`;
  io.stderr(`plumb: expected generate, validate, push or check, got ${got}\n\n${USAGE}`);
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

async function checkCommand(values: Values, io: CliIo): Promise<number> {
  const quiet = values.quiet ?? false;
  const { say, problem } = printer(io, quiet);
  const config = await loadConfig({ cwd: io.cwd, configPath: values.config });
  if (!config.ok) return configErrors(config.errors, values, io);
  say('plumb check');
  const started = Date.now();
  const result = await checkProject({
    config: config.config,
    configPath: config.configPath,
    ...(io.typescript ? { ts: io.typescript } : {}),
    ...(io.cacheDir ? { cacheDir: io.cacheDir } : {}),
    updateBaseline: values['update-baseline'] ?? false,
    allowGrowth: values['allow-growth'] ?? false,
  });
  printCheck(result, Date.now() - started, printer(io, quiet));
  (result.ok ? say : problem)(`${result.ok ? 'Done' : 'Failed'} in ${time(Date.now() - started)}`);
  if (values.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  if (result.ok) return OK;
  const setup = result.errors.some((e) => e.code !== 'baseline-growth');
  return setup ? USAGE_ERROR : PROBLEMS;
}

/** The check step's line, each new finding, and what to run next. */
function printCheck(result: CheckResult, ms: number, p: ReturnType<typeof printer>) {
  const { ok, bad, say, problem } = p;
  for (const e of result.errors) problem(`${bad} check     ${e.message}`);
  const { fresh, accepted, fixed } = result.comparison;
  if (result.files > 0) {
    const summary = `${fresh.length} new, ${accepted} in the baseline${fixed ? `, ${fixed} fixed` : ''}, in ${result.files} files`;
    (fresh.length ? problem : say)(`${fresh.length ? bad : ok} check     ${summary}   ${time(ms)}`);
    for (const f of fresh) {
      problem(
        `    ${f.file}:${f.line}:${f.column}  ${f.method} ${f.resourceTypes.join(' | ')}  → ${f.instead}`,
      );
    }
    if (result.baselineWritten) say('    Baseline written.');
    else if (fixed > 0) say('    Run plumb check --update-baseline to record the fixes.');
  }
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
  const { root, env, ...shared } = options;
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
          env,
        })
      : await validateEnvironment({
          ...shared,
          reportPath,
          resume: values.resume,
          full: values.full,
          unstamped: values.unstamped,
        });
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
  const env = envFiles(values['env-file'] ?? [], io);
  if (typeof env === 'number') return env;
  const config = await loadConfig({ cwd: io.cwd, configPath: values.config });
  if (!config.ok) return configErrors(config.errors, values, io);
  const environment = resolveEnvironment(config.config, values.env, env);
  if (!environment.ok) return configErrors(environment.errors, values, io);
  const root = dirname(config.configPath);
  return {
    root,
    env,
    config: config.config,
    environment: environment.environment,
    lockPath: join(root, 'plumb.lock'),
    checker: bundledChecker(),
    cacheDir: io.cacheDir,
    fetch: io.fetch,
    onStep: (step: EnvStep<string>) => printStep(step, printer(io, quiet), quiet),
    // A type of many pages could otherwise print nothing for minutes.
    onPage: (type: string, _pages: number, { read, of }: { read: number; of: number }) => {
      if (read < of) printer(io, quiet).say(`    ${type}: ${count(read)} of ${count(of)} read`);
    },
  };
}

const count = (n: number) => n.toLocaleString('en-US');

/**
 * The environment with each env file's variables under it. Node refuses
 * --env-file in NODE_OPTIONS and package managers' .bin shims are shell
 * scripts, so the CLI reads them itself.
 */
function envFiles(paths: string[], io: CliIo): CliIo['env'] | number {
  const files: CliIo['env'][] = [];
  for (const path of paths) {
    const file = resolve(io.cwd, path);
    if (!existsSync(file)) {
      io.stderr(`plumb: no env file at ${file}\n`);
      return USAGE_ERROR;
    }
    files.push(parseEnv(readFileSync(file, 'utf8')));
  }
  return Object.assign({}, ...files, io.env);
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

type Found = Pick<Checked, 'types' | 'profiles' | 'forecast'>;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The validate report under its step: each type, then each of its profiles and their reasons. */
export function formatValidation(result: Found): string[] {
  const lines: string[] = [];
  for (const [type, t] of Object.entries(result.types)) {
    const profiles = Object.entries(result.profiles).filter(([, p]) => p.resourceType === type);
    const status = typeStatus(t);
    lines.push(`    ${type}: ${[status, ...typeExtras(t)].join('; ')}`);
    for (const [url, p] of profiles) {
      lines.push(`      ${short(url)}   ${p.checked} checked, ${plural(p.failing, 'failure')}`);
      for (const r of p.reasons) lines.push(`        ${r.path}: ${r.message}   (${r.count})`);
    }
    const forecast = result.forecast?.types[type];
    if (forecast) lines.push(...forecastLines(type, forecast, result.forecast?.profiles ?? {}));
  }
  return lines;
}

const short = (url: string) => url.slice(url.lastIndexOf('/') + 1);

/** What would fail if the type's unstamped resources were stamped: never a failure. */
function forecastLines(
  type: string,
  f: NonNullable<Found['forecast']>['types'][string],
  profiles: NonNullable<Found['forecast']>['profiles'],
): string[] {
  const status =
    f.routed === 0
      ? `none of ${f.read} routed`
      : f.failing === 0
        ? `all ${f.routed} routed would pass`
        : `${f.failing} of ${f.routed} routed would fail`;
  const unrouted = [
    f.unrouted.none > 0 &&
      `${f.unrouted.none} ${f.unrouted.none === 1 ? 'routes' : 'route'} to no profile`,
    f.unrouted.ambiguous > 0 && `${f.unrouted.ambiguous} to several`,
  ].filter((x) => typeof x === 'string');
  const lines = [`      if stamped: ${[status, unrouted.join(', ')].filter(Boolean).join('; ')}`];
  for (const [url, p] of Object.entries(profiles)) {
    if (p.resourceType !== type) continue;
    lines.push(`        ${short(url)}   ${p.checked} checked, ${p.failing} would fail`);
    for (const r of p.reasons) lines.push(`          ${r.path}: ${r.message}   (${r.count})`);
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
    t.stampedOther > 0 &&
      `${t.stampedOther} stamped only with profiles not selected (--full breaks them down)`,
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
      'env-file': { type: 'string', multiple: true },
      resume: { type: 'boolean' },
      full: { type: 'boolean' },
      unstamped: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      prune: { type: 'boolean' },
      adopt: { type: 'boolean' },
      'update-baseline': { type: 'boolean' },
      'allow-growth': { type: 'boolean' },
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
