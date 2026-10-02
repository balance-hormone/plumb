// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type ConfigError, loadConfig, resolveEnvironment } from './config.js';
import { type GenerateResult, generate, type Step } from './generate.js';
import { push } from './push.js';

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
       plumb push --env <name> [--config <path>]

generate  Generate TypeScript types that narrow @medplum/fhirtypes from the
          FHIR profiles plumb.config.ts selects.
push      Install or update Plumb's checker bot in a Medplum project.

Options:
  --check          compare with the committed output instead of writing; fail if stale
  --env <name>     the environment in plumb.config.ts to push to
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
function packageDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) dir = dirname(dir);
  return dir;
}

function version(): string {
  const file = join(packageDir(), 'package.json');
  return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
}

const time = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/** What a step did, as one line: its name, its counts and its time. */
export function formatStep(step: Step, out: string): string {
  const c = step.counts;
  const summary = {
    packages: `${c.cached} cached, ${c.fetched} fetched`,
    load: `${c.profiles} profiles${c.skipped ? `, ${c.skipped} skipped` : ''}`,
    emit: `${c.types} types, ${c.slices} slices, ${c.codeLists} code lists`,
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
  if (command === 'push') return pushCommand(values, io);
  const got = positionals.length === 0 ? 'no command' : `"${positionals.join(' ')}"`;
  io.stderr(`plumb: expected the generate or push command, got ${got}\n\n${USAGE}`);
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
  return result.ok ? OK : PROBLEMS;
}

async function pushCommand(values: Values, io: CliIo): Promise<number> {
  const quiet = values.quiet ?? false;
  const { ok, bad, say, problem } = printer(io, quiet);
  if (!values.env) {
    io.stderr(`plumb: push needs --env <name>\n\n${USAGE}`);
    return USAGE_ERROR;
  }
  const config = await loadConfig({ cwd: io.cwd, configPath: values.config });
  if (!config.ok) return configErrors(config.errors, values, io);
  const environment = resolveEnvironment(config.config, values.env, io.env);
  if (!environment.ok) return configErrors(environment.errors, values, io);
  say(`plumb push --env ${values.env}`);
  const result = await push({
    config: config.config,
    environment: environment.environment,
    lockPath: join(dirname(config.configPath), 'plumb.lock'),
    checker: {
      code: readFileSync(join(packageDir(), 'dist/checker.cjs'), 'utf8'),
      version: version(),
    },
    cacheDir: io.cacheDir,
    fetch: io.fetch,
    onStep: (step) => {
      say(`${ok} ${step.name.padEnd(8)}  ${step.summary}   ${time(step.ms)}`);
      for (const w of step.warnings) (quiet ? problem : say)(`    ${w}`);
    },
  });
  for (const e of result.errors) problem(`${bad} ${e.step.padEnd(8)}  ${e.message}`);
  (result.ok ? say : problem)(`${result.ok ? 'Done' : 'Failed'} in ${time(result.totalMs)}`);
  if (values.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  if (result.ok) return OK;
  return result.errors.some((e) => e.step === 'connect') ? USAGE_ERROR : PROBLEMS;
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
