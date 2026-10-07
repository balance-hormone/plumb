// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import type * as TS from 'typescript5';
import { checkProject } from './check.js';
import { bundledChecker, packageVersion } from './checker/install.js';
import { type ConfigError, loadConfig, resolveEnvironment } from './config.js';
import {
  type Checked,
  type TypeReport,
  type ValidateEnvResult,
  validateEnvironment,
} from './conformance.js';
import type { EnvStep } from './connect.js';
import { type GenerateResult, generate } from './generate.js';
import { type MigrateEnvResult, migrateEnvironment, migrationStatus } from './migrate.js';
import { newMigration } from './migrations.js';
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
       plumb migrate --env <name> [<id>…] [--write] [--rerun <id>] [--local] [--page-size <n>] [--env-file <path>] [--config <path>]
       plumb migrate status --env <name> [--env-file <path>] [--config <path>]
       plumb migrate new <name> [--config <path>]

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
migrate   Run each pending data migration through the project's migration bot,
          a page at a time: a dry run unless --write. status: where each
          migration stands in the environment. new: scaffold a dated
          migration in the first migrations.modules folder.

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
  --write          migrate: apply the changes and keep the ledger; Ctrl-C pauses after a page
  --rerun <id>     migrate: run an applied migration again; repeatable
  --local          migrate: run in this process, without the bot; synthetic environments only
  --page-size <n>  migrate: records per page, 20 to 1,000 (default: 100)
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

/**
 * Each error code's exit, whichever command or step reports it. 2 when the
 * command could not run as asked: usage, config, set-up or connection, fixed
 * before running again. 1 for a problem found, a failed write included: the
 * command ran, and what it met needs fixing. A code not listed, as one a
 * migration throws, is a problem found. docs/errors.md is the catalogue a
 * test holds to this table.
 */
export const exitCodes: Readonly<Record<string, typeof PROBLEMS | typeof USAGE_ERROR>> = {
  // The config, as written: loadConfig's codes, and those found once the profiles load.
  'config-not-found': 2,
  'unsupported-syntax': 2,
  'unresolved-import': 2,
  'no-default-export': 2,
  'unknown-key': 2,
  'missing-out': 2,
  'invalid-type': 2,
  'invalid-ig': 2,
  'unlisted-ig': 2,
  'invalid-profile': 2,
  'invalid-max-codes': 2,
  'invalid-base-url': 2,
  'unknown-environment': 2,
  'missing-variable': 2,
  'invalid-route': 2,
  'unselected-route': 2,
  'invalid-route-element': 2,
  'invalid-default-profile': 2,
  'versioned-url': 2,
  'fsh-and-local': 2,
  'no-sushi-config': 2,
  'invalid-setting': 2,
  'super-admin-field': 2,
  'unknown-access-policy': 2,
  'duplicate-key': 2,
  'invalid-check': 2,
  'invalid-server-version': 2,
  'invalid-bot': 2,
  'invalid-subscription': 2,
  'unknown-bot': 2,
  'invalid-operation': 2,
  'invalid-migration': 2,
  'invalid-content': 2,
  'duplicate-content': 2,
  'unknown-migration': 2,
  'no-migrations': 2,
  'no-check-config': 2,
  // Set-up: tools, deployed bots and features the command needs.
  'sushi-not-installed': 2,
  'sushi-too-old': 2,
  'no-compiler-api': 2,
  'checker-missing': 2,
  'checker-outdated': 2,
  'migrator-missing': 2,
  'migrator-not-current': 2,
  'not-synthetic': 2,
  'bots-disabled': 2,
  'cron-disabled': 2,
  // Connection.
  'connect-failed': 2,
  'registry-error': 2,
  // Packages and the lockfile.
  'download-mismatch': 1,
  'invalid-package': 1,
  'inexact-dependency': 1,
  'integrity-mismatch': 1,
  'lock-missing': 1,
  'lock-disagrees': 1,
  'no-lock': 1,
  // The project's own files: fixed before running again.
  'invalid-lock': 2,
  'local-not-found': 2,
  'invalid-local-json': 2,
  // Profiles that do not load, or do not generate.
  'profile-not-found': 1,
  'no-snapshot': 1,
  'not-r4': 1,
  'unresolved-reference': 1,
  'duplicate-definition': 1,
  unparseable: 1,
  'load-failed': 1,
  'content-refused': 1,
  'sushi-error': 1,
  'sushi-failed': 1,
  'type-name-clash': 1,
  'foreign-file': 1,
  // What check finds.
  'baseline-growth': 1,
  // Writes and runs that failed on the server.
  'checker-failed': 1,
  'apply-failed': 1,
  'content-failed': 1,
  'project-failed': 1,
  'bots-failed': 1,
  'operations-failed': 1,
  'subscriptions-failed': 1,
  'migration-failed': 1,
  // Migrations that must not run as they stand.
  'unmet-dependency': 1,
  'migration-edited': 1,
  'migration-running': 1,
  'migration-paused': 1,
  // A blocked plan's codes: never errors, so push exits 1, but named here as every code is.
  'shadowed-access-policy': 1,
  'untagged-access-policy': 1,
  'shadowed-client-application': 1,
  'untagged-client-application': 1,
  'client-without-membership': 1,
  'missing-secret': 1,
  'unset-variable': 1,
  'shadowed-content': 1,
  'untagged-content': 1,
  'shadowed-bot': 1,
  'untagged-bot': 1,
  'bot-without-membership': 1,
  'shadowed-operation': 1,
  'shadowed-subscription': 1,
  'untagged-subscription': 1,
  'unsendable-header': 1,
};

/** 0 on success; else 2 when any error kept the command from running, or 1. */
export function exitCode(result: { ok: boolean; errors: { code: string }[] }): number {
  if (result.ok) return OK;
  return result.errors.some((e) => exitCodes[e.code] === USAGE_ERROR) ? USAGE_ERROR : PROBLEMS;
}

const time = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

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
  // `migrate new` takes exactly one name; anything else is misuse, below.
  if (positionals[0] === 'migrate' && (positionals[1] !== 'new' || positionals.length === 3)) {
    return migrateCommands(positionals.slice(1), values, io);
  }
  const command = positionals.length === 1 ? positionals[0] : undefined;
  if (command === 'generate') return generateCommand(values, io);
  if (command === 'push' || command === 'validate') return envCommand(command, values, io);
  if (command === 'check') return checkCommand(values, io);
  const got = positionals.length === 0 ? 'no command' : `"${positionals.join(' ')}"`;
  io.stderr(
    `plumb: expected generate, validate, push, check or migrate new, got ${got}\n\n${USAGE}`,
  );
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
  const p = printer(io, quiet);
  const { bad, say, problem } = p;
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
    // Where the output went is the CLI's to say, relative to where it runs.
    onStep: (step) =>
      printStep(
        step.name === 'write' ? { ...step, summary: `${step.summary} → ${out}` } : step,
        p,
        quiet,
      ),
  });
  report(result, out, problem, bad);
  (result.ok ? say : problem)(`${result.ok ? 'Done' : 'Failed'} in ${time(result.totalMs)}`);
  if (values.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return exitCode(result);
}

async function migrateCommand(ids: string[], values: Values, io: CliIo): Promise<number> {
  const quiet = values.quiet ?? false;
  const pageSize = parsePageSize(values['page-size']);
  if (Number.isNaN(pageSize)) {
    io.stderr(`plumb: --page-size must be a whole number from 20 to 1000\n\n${USAGE}`);
    return USAGE_ERROR;
  }
  const options = await envOptions('migrate', values, io);
  if (typeof options === 'number') return options;
  const { bad, say, problem } = printer(io, quiet);
  say(`plumb migrate --env ${values.env}${values.write ? ' --write' : ''}`);
  const controller = new AbortController();
  // Every Ctrl-C, not only the first: a second would otherwise kill the
  // process mid-page and leave the migration running, under its lease.
  const pause = () => {
    if (!controller.signal.aborted) say('Pausing after the current page...');
    controller.abort();
  };
  process.on('SIGINT', pause);
  const { root, env: _env, onPage: _onPage, ...shared } = options;
  let result: MigrateEnvResult;
  try {
    result = await migrateEnvironment({
      ...shared,
      write: values.write,
      ...(ids.length > 0 ? { ids } : {}),
      ...(values.rerun ? { rerun: values.rerun } : {}),
      local: values.local,
      ...(pageSize ? { pageSize } : {}),
      ...gitCommit(root),
      signal: controller.signal,
      onPage: (id, c) => printer(io, quiet).say(`    ${id}: ${count(c.read)} read`),
    });
  } finally {
    process.removeListener('SIGINT', pause);
  }
  for (const e of result.errors) problem(`${bad} ${e.step.padEnd(8)}  ${e.message}`);
  (result.ok ? say : problem)(
    `${result.ok ? 'Done' : 'Failed'} in ${time(result.totalMs)}${result.write ? '' : ' (dry run; --write to apply)'}`,
  );
  if (values.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return exitCode(result);
}

/** A page size within what Medplum pages by cursor, NaN for any other, or undefined. */
function parsePageSize(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 20 && n <= 1000 ? n : Number.NaN;
}

/** `migrate new <name>`, `migrate status`, or `migrate [<id>…]`. */
function migrateCommands(args: string[], values: Values, io: CliIo): Promise<number> {
  if (args[0] === 'new') return migrateNewCommand(args[1] as string, values, io);
  if (args[0] === 'status' && args.length === 1) return migrateStatusCommand(values, io);
  return migrateCommand(args, values, io);
}

async function migrateStatusCommand(values: Values, io: CliIo): Promise<number> {
  const options = await envOptions('migrate status', values, io);
  if (typeof options === 'number') return options;
  const { bad, say, problem } = printer(io, values.quiet ?? false);
  say(`plumb migrate status --env ${values.env}`);
  const result = await migrationStatus(options);
  for (const e of result.errors) problem(`${bad} ${e.step.padEnd(8)}  ${e.message}`);
  (result.ok ? say : problem)(`${result.ok ? 'Done' : 'Failed'} in ${time(result.totalMs)}`);
  if (values.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return exitCode(result);
}

/** The commit the ledger records, when the config is in a git checkout. */
function gitCommit(cwd: string): { commit?: string } {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  return git.status === 0 ? { commit: git.stdout.trim() } : {};
}

async function migrateNewCommand(name: string, values: Values, io: CliIo): Promise<number> {
  const config = await loadConfig({ cwd: io.cwd, configPath: values.config });
  if (!config.ok) return configErrors(config.errors, values, io);
  const result = newMigration(config.config, name);
  if (!result.ok) return configErrors(result.errors, values, io);
  printer(io, values.quiet ?? false).say(`Created ${relative(io.cwd, result.file)}`);
  if (values.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return OK;
}

async function checkCommand(values: Values, io: CliIo): Promise<number> {
  const quiet = values.quiet ?? false;
  const { say, problem } = printer(io, quiet);
  const config = await loadConfig({ cwd: io.cwd, configPath: values.config });
  if (!config.ok) return configErrors(config.errors, values, io);
  say('plumb check');
  const started = Date.now();
  const p = printer(io, quiet);
  const result = await checkProject({
    config: config.config,
    configPath: config.configPath,
    ...(io.typescript ? { ts: io.typescript } : {}),
    ...(io.cacheDir ? { cacheDir: io.cacheDir } : {}),
    updateBaseline: values['update-baseline'] ?? false,
    allowGrowth: values['allow-growth'] ?? false,
  });
  for (const e of result.errors) problem(`${p.bad} check     ${e.message}`);
  for (const step of result.steps) printStep(step, p, quiet);
  (result.ok ? say : problem)(`${result.ok ? 'Done' : 'Failed'} in ${time(Date.now() - started)}`);
  if (values.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return exitCode(result);
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
  return exitCode(result);
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
  return exitCode({ ok: false, errors });
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
      write: { type: 'boolean' },
      rerun: { type: 'string', multiple: true },
      local: { type: 'boolean' },
      'page-size': { type: 'string' },
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
