// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type BotEvent, type MedplumClient, normalizeErrorString } from '@medplum/core';
import type { Basic, Bot, Resource, ResourceType } from '@medplum/fhirtypes';
import { botFilename } from './bots.js';
import { type CheckerInput, handler as checker } from './checker/handler.js';
import { checkerInput } from './checker/input.js';
import { CHECKER_IDENTIFIER, checkerFilename, findChecker } from './checker/install.js';
import { type ConfigError, importModules, type PlumbConfig } from './config.js';
import {
  notCurrent,
  QUOTA_RETRY,
  QUOTA_TRIES,
  QUOTA_WAIT_MS,
  runPage,
  serverTime,
} from './conformance.js';
import { connect, type EnvOptions, type EnvResult, loadAndConnect, steps } from './connect.js';
import type { LoadProfilesResult } from './loader.js';
import {
  checkMigrations,
  loadMigrations,
  type Migration,
  migrationHash,
  restampHash,
} from './migrations.js';
import { owned, PLUMB_SYSTEM, searchAll } from './project.js';

type MigrateStepName = string;

/** What a run did to a migration's records: counts only, never a record or an id. */
interface Counts {
  read: number;
  changed: number;
  unchanged: number;
  conflict: number;
  failed: number;
  /** Left as they are by the migration's exclusion. */
  skipped: number;
}

type LedgerStatus = 'running' | 'paused' | 'errored' | 'applied';

/** What the ledger holds for one migration in one project. */
interface LedgerState {
  status: LedgerStatus;
  /** The SHA-256 of the module the run applied. */
  hash: string;
  commit?: string;
  /** When the pass started: it reads only records last updated before. */
  start?: string;
  /** Where an interrupted pass resumes; absent once a pass ends. */
  cursor?: string;
  counts: Counts;
  pages: number;
  lastError?: string;
  /** The last time a running pass wrote: older than thirty minutes, another run takes it over. */
  lease?: string;
  /** The run holding the lease: two runs started in the same millisecond share a time, never this. */
  holder?: string;
}

/** The checker's verdict on the changed records, summed over a run. */
interface ForecastReport {
  checked: number;
  failing: number;
  reasons: { path: string; message: string; count: number }[];
}

interface MigrationReport {
  /** Before this run: no ledger entry is pending. */
  status: LedgerStatus | 'pending';
  /** Skipped, as applied, or run in this invocation. */
  ran: boolean;
  /** Carried on from an interrupted pass. */
  resumed: boolean;
  counts: Counts;
  reasons: { message: string; count: number }[];
  /** Why the records skipped were left out, as the exclusion gave each. */
  skips: { message: string; count: number }[];
  forecast?: ForecastReport;
}

export interface MigrateEnvResult extends EnvResult<MigrateStepName> {
  write: boolean;
  migrations: Record<string, MigrationReport>;
}

export interface MigrateEnvOptions extends EnvOptions {
  /** The bundled checker, which forecasts against the selected profiles. */
  checker: { code: string; version: string };
  /** Apply the changes and keep the ledger; otherwise a dry run that writes nothing. */
  write?: boolean;
  /** Only these migrations, by id. */
  ids?: string[];
  /** Applied migrations to run a fresh pass over, by id. */
  rerun?: string[];
  /**
   * Run the generated runner in this process instead of the migration bot,
   * with Plumb's checker in-process for the forecast: only where the
   * environment is synthetic, since the records come to this machine.
   */
  local?: boolean;
  /** Records per page; 100 by default. */
  pageSize?: number;
  /** The git commit the modules are at, for the ledger. */
  commit?: string;
  /** Stops a write after the current page, or during a wait, leaving the migration paused. */
  signal?: AbortSignal;
  /** Called after each page with the migration and its counts so far. */
  onPage?: (id: string, counts: Counts) => void | Promise<void>;
  now?: () => Date;
  wait?: (ms: number) => Promise<void>;
}

// Longer than a page can take: a Lambda's 15 minutes, with the quota's waits.
const LEASE_MS = 30 * 60_000;
const STATE = `${PLUMB_SYSTEM}#migration`;
const CODE = { coding: [{ system: PLUMB_SYSTEM, code: 'migration' }] };
const zero = (): Counts => ({
  read: 0,
  changed: 0,
  unchanged: 0,
  conflict: 0,
  failed: 0,
  skipped: 0,
});

/**
 * Runs each pending migration through the project's migration bot, a page
 * at a time, in id order. A dry run writes nothing, the ledger included;
 * with `write`, each migration's `Basic` records its pass as it goes, so an
 * interrupted pass resumes where it stopped and two runs never share one.
 */
export async function migrateEnvironment(options: MigrateEnvOptions): Promise<MigrateEnvResult> {
  const result: MigrateEnvResult = {
    ok: false,
    steps: [],
    totalMs: 0,
    errors: [],
    write: options.write === true,
    migrations: {},
  };
  const step = steps<MigrateStepName, MigrateEnvResult>(result, options.onStep);
  const { migrations: config } = options.config;
  if (!config) {
    return step.fail('migrations', [
      { code: 'no-migrations', message: 'The config has no "migrations" to run.' },
    ]);
  }
  if (options.local && !options.environment.synthetic) {
    const env = options.environment.name;
    return step.fail('migrations', [
      {
        code: 'not-synthetic',
        message: `--local brings records to this machine, so it runs only where the environment is marked synthetic: ${env} is not.`,
      },
    ]);
  }
  const ready = await loadAndConnect(options, result, step);
  if (!ready) return result;
  const { loaded, medplum } = ready;

  const declared = await declaredMigrations(options.config, options);
  if ('errors' in declared) return step.fail('migrations', declared.errors);
  const chosen = inOrder(declared.migrations).filter(
    (m) => !options.ids || options.ids.includes(m.id),
  );
  step.finish('migrations', `${chosen.length} of ${declared.migrations.length} chosen`);

  const page = options.local
    ? await localRunner(medplum, options.config.out, declared.migrations).catch((err: unknown) =>
        step.fail('migrations', [
          { code: 'invalid-migration', message: normalizeErrorString(err) },
        ]),
      )
    : await deployedRunner(medplum, options, config.bot, step);
  if (typeof page !== 'function') return result;
  await runAll({ medplum, loaded, page, options }, chosen, result, step);
  result.ok = result.errors.length === 0 && result.steps.every((s) => !s.failed);
  return step.done();
}

type PageRunner = (input: object) => Promise<PageResult>;

/** The migration bot, once the checker and the bot are found to be this build. */
async function deployedRunner(
  medplum: MedplumClient,
  options: MigrateEnvOptions,
  bot: string,
  step: ReturnType<typeof steps<MigrateStepName, MigrateEnvResult>>,
): Promise<PageRunner | undefined> {
  const checker = await findChecker(medplum);
  if (
    checker?.executableCode?.title !==
    checkerFilename(options.checker.code, options.checker.version)
  ) {
    return void step.fail('checker', [notCurrent(checker, options)]);
  }
  step.finish('checker', `plumb-checker ${options.checker.version} installed`);
  const migrator = await currentMigrator(medplum, options, bot);
  if ('message' in migrator) return void step.fail('migrator', [migrator]);
  step.finish('migrator', `${bot} current (${migrator.executableCode?.title})`);
  const botId = migrator.id as string;
  return (input) => runPage<PageResult>(medplum, botId, input, waitFor(options), 'migrator');
}

/**
 * The project's generated runner in this process, with Plumb's checker
 * handler answering its forecast in place of the checker bot.
 */
async function localRunner(
  medplum: MedplumClient,
  out: string,
  migrations: Migration[],
): Promise<PageRunner> {
  const imported = await importModules([join(out, '_migrations.ts')], 'out', 'invalid-migration');
  const runner = imported.ok
    ? (imported.modules[0]?.module as { handleMigrations?: LocalRunner } | undefined)
    : undefined;
  if (!runner?.handleMigrations) {
    throw new Error(`No generated runner in ${out}: run plumb generate.`);
  }
  const handler = runner.handleMigrations(migrations);
  // What the generated MigrationClient needs, with the forecast answered here.
  const client = {
    search: (type: ResourceType, query: string) => medplum.search(type, query),
    readResource: (type: ResourceType, id: string) => medplum.readResource(type, id),
    updateResource: (resource: Resource, options: object) =>
      medplum.updateResource(resource, options),
    executeBot: (_bot: unknown, input: CheckerInput) =>
      checker(medplum, { input } as BotEvent<CheckerInput>),
  };
  return (input) => handler(client, { input }) as Promise<PageResult>;
}

type LocalRunner = (
  migrations: Migration[],
) => (medplum: object, event: { input: object }) => Promise<unknown>;

/**
 * The migrations on these resource types, Plumb's restamps included, that
 * the project has not applied as they now stand, for push's gate to name
 * when it refuses. Migrations that do not load or check are reported rather
 * than thrown: the gate refuses either way.
 */
export async function pendingMigrations(
  medplum: MedplumClient,
  config: PlumbConfig,
  resourceTypes: string[],
): Promise<{ pending: { id: string; resourceType: string }[]; error?: string }> {
  if (!config.migrations || resourceTypes.length === 0) return { pending: [] };
  const declared = await declaredMigrations(config, {});
  if ('errors' in declared) {
    return { pending: [], error: declared.errors.map((e) => e.message).join(' ') };
  }
  const pending: { id: string; resourceType: string }[] = [];
  for (const migration of inOrder(declared.migrations)) {
    if (!resourceTypes.includes(migration.resourceType)) continue;
    const held = await findLedger(medplum, migration.id);
    if (statusOf(held && stateOf(held), migration) === 'applied') continue;
    pending.push({ id: migration.id, resourceType: migration.resourceType });
  }
  return { pending };
}

/** Where one migration stands in a project, from its ledger entry and its module. */
interface MigrationStatus {
  /** Edited: applied, but its module has changed since. */
  status: LedgerStatus | 'pending' | 'edited';
  /** Whether a module still declares it; an applied one's module may be deleted. */
  module: boolean;
  commit?: string;
  counts?: Counts;
  lastError?: string;
}

export interface MigrationStatusResult extends EnvResult<string> {
  migrations: Record<string, MigrationStatus>;
}

/**
 * Each migration's place in a project: pending, running, paused, errored,
 * applied, or edited since applied, and each ledger entry no module declares.
 * Anything but applied fails the result, so a nightly run catches an
 * environment that missed a migration.
 */
export async function migrationStatus(
  options: Pick<EnvOptions, 'config' | 'environment' | 'onStep'>,
): Promise<MigrationStatusResult> {
  const result: MigrationStatusResult = {
    ok: false,
    steps: [],
    totalMs: 0,
    errors: [],
    migrations: {},
  };
  const step = steps<string, MigrationStatusResult>(result, options.onStep);
  if (!options.config.migrations) {
    return step.fail('migrations', [
      { code: 'no-migrations', message: 'The config has no "migrations" to report on.' },
    ]);
  }
  const declared = await declaredMigrations(options.config, {});
  if ('errors' in declared) return step.fail('migrations', declared.errors);
  step.finish('migrations', `${declared.migrations.length} declared`);
  const connected = await connect(options.environment);
  if (!connected.ok) return step.fail('connect', [connected.error]);
  step.finish('connect', options.environment.baseUrl);

  const entries = await searchAll(
    connected.medplum,
    'Basic',
    owned(connected.medplum, { code: `${PLUMB_SYSTEM}|migration` }),
  );
  const held = new Map(entries.map((basic) => [tagOf(basic), stateOf(basic)]));
  const report = (id: string, state: LedgerState | undefined, migration?: Migration) => {
    result.migrations[id] = {
      status: statusOf(state, migration),
      module: migration !== undefined,
      ...(state?.commit ? { commit: state.commit } : {}),
      ...(state ? { counts: state.counts } : {}),
      ...(state?.lastError ? { lastError: state.lastError } : {}),
    };
  };
  for (const migration of inOrder(declared.migrations)) {
    report(migration.id, held.get(migration.id), migration);
    held.delete(migration.id);
  }
  for (const [id, state] of [...held].sort(([a], [b]) => (a < b ? -1 : 1))) report(id, state);
  // One step, as every command's are: each migration's line under it, the migrations in `migrations`.
  const reported = Object.entries(result.migrations);
  const tally = [...Map.groupBy(reported, ([, m]) => m.status)].map(
    ([status, found]) => `${found.length} ${status}`,
  );
  result.ok = reported.every(([, m]) => m.status === 'applied');
  step.finish(
    'status',
    tally.join(', ') || 'no migrations',
    reported.map(([id, m]) => `${id}: ${describe(id, m)}`),
    !result.ok,
  );
  return step.done();
}

function statusOf(
  state: LedgerState | undefined,
  migration: Migration | undefined,
): MigrationStatus['status'] {
  if (!state) return 'pending';
  if (!migration || !edited(state, hashOf(migration))) return state.status;
  // A restamp runs again when the routing changes; anything else was edited.
  return migration.repeatable ? 'pending' : 'edited';
}

/**
 * Whether the module changed since its pass began, once that pass has
 * written something: resuming, or skipping it as applied, would leave records
 * written by two versions of the transform.
 */
const edited = (state: LedgerState, hash: string) =>
  state.hash !== hash &&
  (state.status === 'applied' || state.status === 'paused' || state.status === 'errored');

function describe(id: string, m: MigrationStatus): string {
  const at = m.commit ? ` at ${m.commit.slice(0, 7)}` : '';
  const changed = m.counts ? `, ${m.counts.changed} changed` : '';
  const text = {
    pending: 'pending',
    applied: `applied${at}${changed}`,
    edited: `ran${at}, then its module was edited: --rerun ${id} runs it again`,
    running: `running${changed}`,
    paused: `paused${changed}: --write resumes it`,
    errored: `errored${m.lastError ? `: ${m.lastError}` : ''}`,
  }[m.status];
  return m.module ? text : `${text} (no module)`;
}

type Declared = { migrations: Migration[] } | { errors: { code: string; message: string }[] };

/**
 * The modules' migrations, checked, then Plumb's restamps when the config
 * asks for them, with every id the options name declared.
 */
async function declaredMigrations(
  config: PlumbConfig,
  options: Pick<MigrateEnvOptions, 'ids' | 'rerun'>,
): Promise<Declared> {
  const declared = await loadMigrations(config.migrations?.modules ?? []);
  if (!declared.ok) return { errors: declared.errors };
  const invalid = checkMigrations(declared.migrations);
  if (invalid.length > 0) return { errors: invalid };
  const restamp = config.migrations?.restamp;
  const restamps = restamp ? await loadRestamps(config.out, restamp) : { migrations: [] };
  if ('errors' in restamps) return restamps;
  const migrations = [...declared.migrations, ...restamps.migrations].map((m) => ({
    ...m,
    hash: m.hash ?? migrationHash(m.from, config.out),
  }));
  const unknown = [...(options.ids ?? []), ...(options.rerun ?? [])].filter(
    (id) => !migrations.some((m) => m.id === id),
  );
  if (unknown.length > 0) {
    const message = `No module declares ${unknown.join(', ')}.`;
    return { errors: [{ code: 'unknown-migration', message }] };
  }
  return { migrations };
}

/**
 * Plumb's restamps, as `generate` wrote them into `_restamp.ts`: hashed by
 * `_routes.ts`, and the exclusion module when there is one, so a change to
 * either makes each pending again. The exclusion is the config's, imported
 * here, so a run in this process leaves out what the config says.
 */
async function loadRestamps(out: string, restamp: true | { exclude: string }): Promise<Declared> {
  const file = join(out, '_restamp.ts');
  const imported = await importModules([file], 'migrations.restamp', 'invalid-migration');
  const restamps = imported.ok
    ? (imported.modules[0]?.module.restamps as Omit<Migration, 'from'>[] | undefined)
    : undefined;
  if (!restamps) {
    const message = `"migrations.restamp" is on, but ${file} has no restamps: run plumb generate.`;
    return { errors: [{ code: 'invalid-migration', message }] };
  }
  const routes = join(out, '_routes.ts');
  if (restamp === true) {
    return { migrations: restamps.map((m) => ({ ...m, from: routes, repeatable: true })) };
  }
  const exclusion = await loadExclusion(restamp.exclude);
  if ('errors' in exclusion) return exclusion;
  const hash = restampHash(readFileSync(routes, 'utf8'), migrationHash(restamp.exclude, out));
  return {
    migrations: restamps.map((m) => ({
      ...m,
      from: routes,
      repeatable: true,
      exclude: exclusion.exclude,
      hash,
    })),
  };
}

/** The exclusion module's default export: a function from a record to the reason to leave it out. */
async function loadExclusion(
  file: string,
): Promise<{ exclude: Migration['exclude'] } | { errors: ConfigError[] }> {
  const path = 'migrations.restamp.exclude';
  const imported = await importModules([file], path, 'invalid-restamp-exclude');
  if (!imported.ok) return imported;
  const exclude = imported.modules[0]?.module.default;
  if (typeof exclude === 'function') return { exclude: exclude as Migration['exclude'] };
  const message = `${file} does not default-export a function from a record to the reason to leave it unstamped.`;
  return { errors: [{ code: 'invalid-restamp-exclude', path, message }] };
}

/** A migration's failure, named: the bot refuses a page for a migration it was not built from. */
function failure(err: unknown): { code: string; message: string } {
  const message = normalizeErrorString(err);
  const stale = message.includes('was built from another version of');
  const code =
    (err as { code?: string }).code ?? (stale ? 'migrator-not-current' : 'migration-failed');
  return { code, message };
}

/** Runs each migration in turn, stopping at the first a write must not run, or that fails. */
async function runAll(
  run: Run,
  chosen: Migration[],
  result: MigrateEnvResult,
  step: ReturnType<typeof steps<MigrateStepName, MigrateEnvResult>>,
): Promise<void> {
  const { medplum, options } = run;
  const applied = new Set<string>();
  for (const migration of chosen) {
    const held = await findLedger(medplum, migration.id);
    const hash = hashOf(migration);
    const blocked = await blocker(medplum, migration, held, hash, applied, options);
    if (blocked && options.write) return void step.fail(migration.id, [blocked]);
    let report: MigrationReport;
    try {
      report = await migrate(run, migration, held, hash);
    } catch (err) {
      return void step.fail(migration.id, [failure(err)]);
    }
    result.migrations[migration.id] = report;
    const problems = problemsOf(report);
    if (!report.ran || (options.write && problems === 0)) applied.add(migration.id);
    const notes = warnings(report, blocked?.message);
    step.finish(migration.id, summary(report, options.write === true), notes, problems > 0);
    if (options.signal?.aborted) return void step.fail(migration.id, [paused(migration.id)]);
  }
}

interface Run {
  medplum: MedplumClient;
  loaded: Pick<LoadProfilesResult, 'profiles' | 'definitions'>;
  page: PageRunner;
  options: MigrateEnvOptions;
}

/** The migrations in the order `dependsOn` needs, otherwise by id. */
export function inOrder(migrations: Migration[]): Migration[] {
  const byId = new Map(migrations.map((m) => [m.id, m]));
  const ordered: Migration[] = [];
  // Marked before its dependencies are walked, so a cycle, which
  // checkMigrations reports, ends the walk rather than the stack.
  const seen = new Set<Migration>();
  const visit = (m: Migration) => {
    if (seen.has(m)) return;
    seen.add(m);
    for (const id of m.dependsOn ?? []) {
      const dependency = byId.get(id);
      if (dependency) visit(dependency);
    }
    ordered.push(m);
  };
  for (const m of [...migrations].sort((a, b) => (a.id < b.id ? -1 : 1))) visit(m);
  return ordered;
}

const hashOf = (migration: Migration) => migration.hash ?? migrationHash(migration.from);

/**
 * Why a write must not run the migration: a dependency not applied in this
 * project, or a module edited since it was applied, unless rerun.
 */
async function blocker(
  medplum: MedplumClient,
  migration: Migration,
  held: Basic | undefined,
  hash: string,
  applied: Set<string>,
  options: MigrateEnvOptions,
): Promise<{ code: string; message: string } | undefined> {
  for (const id of migration.dependsOn ?? []) {
    if (applied.has(id)) continue;
    const ledger = await findLedger(medplum, id);
    if (ledger && stateOf(ledger).status === 'applied') continue;
    return {
      code: 'unmet-dependency',
      message: `${migration.id} depends on ${id}, which is not applied in ${options.environment.name}.`,
    };
  }
  const state = held && stateOf(held);
  if (
    state &&
    edited(state, hash) &&
    !migration.repeatable &&
    !options.rerun?.includes(migration.id)
  ) {
    return {
      code: 'migration-edited',
      message: `${migration.id} was edited after it ${state.status === 'applied' ? 'was applied' : 'began writing'}; --rerun ${migration.id} runs it again as a fresh pass.`,
    };
  }
  return undefined;
}

/** One migration's pass: skipped when applied unless rerun, otherwise run page by page. */
async function migrate(
  run: Run,
  migration: Migration,
  held: Basic | undefined,
  hash: string,
): Promise<MigrationReport> {
  const state = held ? stateOf(held) : undefined;
  const status = state?.status ?? 'pending';
  const report: MigrationReport = {
    status,
    ran: false,
    resumed: false,
    counts: zero(),
    reasons: [],
    skips: [],
  };
  const again =
    run.options.rerun?.includes(migration.id) || (migration.repeatable && state?.hash !== hash);
  if (status === 'applied' && !again) return report;
  report.ran = true;
  const pass = await begin(run, migration, held, hash);
  report.resumed = pass.state.cursor !== undefined;
  // A pass a release before skipped existed paused has no count of it.
  if (report.resumed) report.counts = { ...zero(), ...pass.state.counts };
  const finished = await runPages(run, migration, pass, report).catch(async (err: unknown) => {
    // Ctrl-C during a wait: the page it held off runs again on resume.
    if (!stopped(err, run.options)) throw err;
    await savePass(run.medplum, pass, { ...pass.state, status: 'paused' });
    return false;
  });
  if (finished && pass.basic) await close(run.medplum, pass.basic, pass.state, report);
  return report;
}

interface Pass {
  state: LedgerState;
  /** The ledger entry, written as the pass goes; none in a dry run. */
  basic?: Basic;
}

/** A dry run's pass, or a write's, with the lease taken and any interrupted pass resumed. */
async function begin(
  run: Run,
  migration: Migration,
  held: Basic | undefined,
  hash: string,
): Promise<Pass> {
  const { options } = run;
  const now = (options.now ?? (() => new Date()))();
  const pass: Pass = options.write
    ? await takeLease(run.medplum, migration, held, hash, now, options)
    : { state: { status: 'running', hash, counts: zero(), pages: 0 } };
  // The pass reads what the server last updated before it began, so the
  // cutoff is the server's time, never this machine's: a slow clock would
  // skip records, a fast one read the pass's own writes again. A write's is
  // when its ledger entry was saved, before any record is written.
  pass.state.start ??= pass.basic?.meta?.lastUpdated ?? (await serverTime(run.medplum));
  return pass;
}

/** Runs the pass's pages, saving the ledger after each; false when stopped by the signal. */
async function runPages(
  run: Run,
  migration: Migration,
  pass: Pass,
  report: MigrationReport,
): Promise<boolean> {
  const { medplum, options } = run;
  const { state } = pass;
  const forecast = forecastInput(run.loaded, migration.resourceType as ResourceType);
  const input = {
    id: migration.id,
    hash: state.hash,
    start: state.start,
    write: options.write === true,
    count: options.pageSize ?? 100,
    ...(forecast ? { forecast } : {}),
    ...(migration.exclude ? { exclude: true } : {}),
  };
  let limited = 0;
  for (;;) {
    const cursor = state.cursor ? { cursor: state.cursor } : {};
    const page = await pageOf(run, pass, { ...input, ...cursor });
    add(report, page);
    state.counts = { ...report.counts };
    state.pages++;
    if (page.limited) {
      limited = await holdOff(run, pass, limited + 1);
      continue;
    }
    limited = 0;
    state.cursor = page.next;
    state.lease = (options.now ?? (() => new Date()))().toISOString();
    await savePass(medplum, pass, state);
    await options.onPage?.(migration.id, report.counts);
    if (!state.cursor) return true;
    if (options.signal?.aborted) {
      await savePass(medplum, pass, { ...state, status: 'paused' });
      return false;
    }
  }
}

/** Waits out the quota or a bot not ready, unless Ctrl-C ends the wait. */
const waitFor =
  ({ wait, signal }: MigrateEnvOptions) =>
  async (ms: number) => {
    await (wait ? wait(ms) : sleep(ms, undefined, { signal }));
    signal?.throwIfAborted();
  };

/** Whether the run stopped for Ctrl-C, rather than failed. */
const stopped = (err: unknown, { signal }: MigrateEnvOptions) =>
  signal?.aborted === true && (err as Error).name === 'AbortError';

/** One page; a failure leaves the pass errored, to resume from its cursor. */
async function pageOf(run: Run, pass: Pass, input: object): Promise<PageResult> {
  try {
    return await run.page(input);
  } catch (err) {
    if (stopped(err, run.options)) throw err;
    await savePass(run.medplum, pass, {
      ...pass.state,
      status: 'errored',
      lastError: normalizeErrorString(err),
    });
    throw err;
  }
}

/**
 * Over the project's rate limit: saves what the page wrote, with the lease,
 * and waits for the limit to reset before the same page runs again.
 */
async function holdOff(run: Run, pass: Pass, tries: number): Promise<number> {
  const { medplum, options } = run;
  pass.state.lease = (options.now ?? (() => new Date()))().toISOString();
  if (tries >= QUOTA_TRIES) {
    const lastError = `Still over the project's rate limit after ${QUOTA_TRIES} tries.`;
    await savePass(medplum, pass, { ...pass.state, status: 'errored', lastError });
    throw new Error(lastError);
  }
  await savePass(medplum, pass, pass.state);
  await waitFor(options)(QUOTA_WAIT_MS);
  return tries;
}

/** A finished pass is applied, or errored and run again from the start when it left records behind. */
async function close(
  medplum: MedplumClient,
  basic: Basic,
  state: LedgerState,
  report: MigrationReport,
) {
  const left = report.counts.failed + report.counts.conflict;
  const { start, lease, holder, lastError, ...rest } = state;
  await saveLedger(
    medplum,
    basic,
    left > 0
      ? { ...rest, status: 'errored', lastError: `${left} records not migrated` }
      : { ...rest, start: start as string, status: 'applied' },
  );
}

/** What one page of the bot returns, as the generated MigrationPageResult. */
interface PageResult extends Omit<Counts, 'skipped'> {
  skipped?: number;
  reasons: { message: string; count: number }[];
  skips?: { message: string; count: number }[];
  forecast?: {
    profiles: Record<
      string,
      { checked: number; failing: string[]; reasons: ForecastReport['reasons'] }
    >;
  };
  next?: string;
  /** Stopped by the project's rate limit: what it wrote is counted, and the page runs again. */
  limited?: true;
}

function add(report: MigrationReport, page: PageResult): void {
  // A bot built by a release before skipped existed returns no skips.
  for (const key of Object.keys(report.counts) as (keyof Counts)[]) {
    report.counts[key] += page[key] ?? 0;
  }
  tally(report.reasons, page.reasons);
  tally(report.skips, page.skips ?? []);
  for (const profile of Object.values(page.forecast?.profiles ?? {})) {
    report.forecast ??= { checked: 0, failing: 0, reasons: [] };
    report.forecast.checked += profile.checked;
    report.forecast.failing += profile.failing.length;
    for (const reason of profile.reasons) {
      const same = report.forecast.reasons.find(
        (r) => r.path === reason.path && r.message === reason.message,
      );
      if (same) same.count += reason.count;
      else report.forecast.reasons.push({ ...reason });
    }
  }
}

/** Adds a page's reasons to the run's, one entry per message. */
function tally(
  into: { message: string; count: number }[],
  from: { message: string; count: number }[],
): void {
  for (const reason of from) {
    const same = into.find((r) => r.message === reason.message);
    if (same) same.count += reason.count;
    else into.push({ ...reason });
  }
}

/** What the checker needs for the type, when a selected profile constrains it. */
function forecastInput(loaded: Run['loaded'], resourceType: ResourceType) {
  const { profiles, definitions } = checkerInput(loaded, resourceType);
  return profiles.length > 0 ? { checker: CHECKER_IDENTIFIER, profiles, definitions } : undefined;
}

/** The project's migration bot, deployed from this build of its file, or why not. */
async function currentMigrator(
  medplum: MedplumClient,
  options: MigrateEnvOptions,
  key: string,
): Promise<Bot | { code: string; message: string }> {
  const fix = `Run plumb push --env ${options.environment.name}.`;
  const bot = await medplum.searchOne(
    'Bot',
    owned(medplum, { identifier: `${PLUMB_SYSTEM}|${key}` }),
  );
  const file = options.config.bots?.[key]?.file;
  if (!bot || !file) {
    return {
      code: 'migrator-missing',
      message: `The migration bot "${key}" is not deployed. ${fix}`,
    };
  }
  if (bot.executableCode?.title !== botFilename(key, readFileSync(file), file)) {
    return {
      code: 'migrator-not-current',
      message: `The migration bot "${key}" is not this build of ${file}. ${fix}`,
    };
  }
  return bot;
}

const findLedger = (medplum: MedplumClient, id: string) =>
  medplum.searchOne(
    'Basic',
    owned(medplum, { _tag: `${PLUMB_SYSTEM}|${id}`, code: `${PLUMB_SYSTEM}|migration` }),
  );

const stateOf = (basic: Basic): LedgerState =>
  JSON.parse(basic.extension?.find((e) => e.url === STATE)?.valueString ?? '{}') as LedgerState;

/** The ledger entry with this run's lease, or `migration-running` when another run holds it. */
async function takeLease(
  medplum: MedplumClient,
  migration: Migration,
  held: Basic | undefined,
  hash: string,
  now: Date,
  options: MigrateEnvOptions,
): Promise<Required<Pass>> {
  const previous = held ? stateOf(held) : undefined;
  if (leased(previous, now)) throw running(migration.id);
  // A pass resumes only with the module it began with; otherwise a fresh pass.
  const resume =
    previous?.cursor !== undefined && previous.status !== 'applied' && previous.hash === hash;
  const state: LedgerState = {
    status: 'running',
    hash,
    ...(options.commit ? { commit: options.commit } : {}),
    ...(resume ? { start: previous.start, cursor: previous.cursor } : {}),
    counts: resume ? previous.counts : zero(),
    pages: resume ? previous.pages : 0,
    lease: now.toISOString(),
    holder: randomUUID(),
  };
  if (!held) {
    const created = await medplum
      .createResource<Basic>(ledgerResource(migration.id, state), {
        ...QUOTA_RETRY,
        headers: {
          'If-None-Exist': Object.entries(
            owned(medplum, { _tag: `${PLUMB_SYSTEM}|${migration.id}` }),
          )
            .map(([k, v]) => `${k}=${v}`)
            .join('&'),
        },
      })
      .catch(async (err: unknown) => {
        // Postgres can abort one of two creates racing for the tag, with a
        // serialization failure rather than handing back the other's entry.
        const other = await findLedger(medplum, migration.id);
        if (leased(other && stateOf(other), now)) throw running(migration.id);
        throw err;
      });
    // A conditional create that found one returns it: another run made it first.
    if (stateOf(created).holder !== state.holder) throw running(migration.id);
    return { basic: created, state };
  }
  return { basic: await saveLedger(medplum, held, state), state };
}

/** Whether a run holds the entry: running, and written to within the lease. */
const leased = (state: LedgerState | undefined, now: Date) =>
  state?.status === 'running' &&
  state.lease !== undefined &&
  now.getTime() - Date.parse(state.lease) < LEASE_MS;

const ledgerResource = (id: string, state: LedgerState): Basic => ({
  resourceType: 'Basic',
  meta: { tag: [{ system: PLUMB_SYSTEM, code: id }] },
  code: CODE,
  extension: [{ url: STATE, valueString: JSON.stringify(state) }],
});

/** Saves the pass's state to its ledger entry, when it has one: a dry run writes nothing. */
async function savePass(medplum: MedplumClient, pass: Pass, state: LedgerState): Promise<void> {
  if (pass.basic) pass.basic = await saveLedger(medplum, pass.basic, state);
}

/** Writes the state against the version last read, so a run that lost its lease stops. */
async function saveLedger(
  medplum: MedplumClient,
  basic: Basic,
  state: LedgerState,
): Promise<Basic> {
  const id = tagOf(basic);
  try {
    return await medplum.updateResource<Basic>(
      { ...ledgerResource(id, state), id: basic.id as string },
      { headers: { 'If-Match': `W/"${basic.meta?.versionId}"` }, ...QUOTA_RETRY },
    );
  } catch (err) {
    if ((err as { outcome?: { id?: string } }).outcome?.id === 'precondition-failed')
      throw running(id);
    throw err;
  }
}

const tagOf = (basic: Basic) => basic.meta?.tag?.find((t) => t.system === PLUMB_SYSTEM)?.code ?? '';

const running = (id: string) =>
  Object.assign(
    new Error(
      `${id} is being run by another plumb migrate; it is taken over once idle for thirty minutes.`,
    ),
    {
      code: 'migration-running',
    },
  );

const paused = (id: string) => ({
  code: 'migration-paused',
  message: `Stopped after a page: ${id} is paused, and plumb migrate --write resumes it.`,
});

function summary(report: MigrationReport, write: boolean): string {
  if (!report.ran) return 'applied';
  const c = report.counts;
  const verb = write ? 'changed' : 'to change';
  const parts = [`${c.read} read`, `${c.changed} ${verb}`, `${c.unchanged} unchanged`];
  if (c.conflict) parts.push(`${c.conflict} conflicted`);
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  return `${write ? '' : 'dry run: '}${parts.join(', ')}${report.resumed ? ' (resumed)' : ''}`;
}

const problemsOf = (report: MigrationReport) =>
  report.counts.failed + report.counts.conflict + (report.forecast?.failing ?? 0);

function warnings(report: MigrationReport, blocked?: string): string[] {
  const lines = [
    ...(blocked ? [blocked] : []),
    ...report.reasons.map((r) => `${r.count} failed: ${r.message}`),
    ...report.skips.map((r) => `${r.count} skipped: ${r.message}`),
  ];
  const f = report.forecast;
  if (f) {
    lines.push(
      `forecast: ${f.checked - f.failing} would pass the selected profiles, ${f.failing} would still fail`,
    );
    for (const r of f.reasons) lines.push(`  ${r.count} × ${r.path}: ${r.message}`);
  }
  return lines;
}
