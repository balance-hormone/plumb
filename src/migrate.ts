// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type MedplumClient, normalizeErrorString } from '@medplum/core';
import type { Basic, Bot, ResourceType } from '@medplum/fhirtypes';
import { botFilename } from './bots.js';
import { checkerInput } from './checker/input.js';
import { CHECKER_IDENTIFIER, checkerFilename, findChecker } from './checker/install.js';
import { notCurrent, runPage } from './conformance.js';
import { connect, type EnvOptions, type EnvResult, loadAndConnect, steps } from './connect.js';
import type { LoadProfilesResult } from './loader.js';
import { checkMigrations, loadMigrations, type Migration } from './migrations.js';
import { PLUMB_SYSTEM } from './project.js';

type MigrateStepName = string;

/** What a run did to a migration's records: counts only, never a record or an id. */
interface Counts {
  read: number;
  changed: number;
  unchanged: number;
  conflict: number;
  failed: number;
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
  /** The last time a running pass wrote: older than ten minutes, another run takes it over. */
  lease?: string;
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
  /** Records per page; 100 by default. */
  pageSize?: number;
  /** The git commit the modules are at, for the ledger. */
  commit?: string;
  /** Stops a write after the current page, leaving the migration paused. */
  signal?: AbortSignal;
  /** Called after each page with the migration and its counts so far. */
  onPage?: (id: string, counts: Counts) => void | Promise<void>;
  now?: () => Date;
  wait?: (ms: number) => Promise<void>;
}

const LEASE_MS = 10 * 60_000;
const STATE = `${PLUMB_SYSTEM}#migration`;
const CODE = { coding: [{ system: PLUMB_SYSTEM, code: 'migration' }] };
const zero = (): Counts => ({ read: 0, changed: 0, unchanged: 0, conflict: 0, failed: 0 });

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
  const ready = await loadAndConnect(options, result, step);
  if (!ready) return result;
  const { loaded, medplum } = ready;

  const declared = await declaredMigrations(config.modules, options);
  if ('errors' in declared) return step.fail('migrations', declared.errors);
  const chosen = inOrder(declared.migrations).filter(
    (m) => !options.ids || options.ids.includes(m.id),
  );
  step.finish('migrations', `${chosen.length} of ${declared.migrations.length} chosen`);

  const checker = await findChecker(medplum);
  if (
    checker?.executableCode?.title !==
    checkerFilename(options.checker.code, options.checker.version)
  ) {
    return step.fail('checker', [notCurrent(checker, options)]);
  }
  step.finish('checker', `plumb-checker ${options.checker.version} installed`);
  const migrator = await currentMigrator(medplum, options, config.bot);
  if ('message' in migrator) return step.fail('migrator', [migrator]);
  step.finish('migrator', `${config.bot} current (${migrator.executableCode?.title})`);

  const run = { medplum, loaded, botId: migrator.id as string, options };
  await runAll(run, chosen, result, step);
  result.ok = result.errors.length === 0 && result.steps.every((s) => !s.failed);
  return step.done();
}

/**
 * The migrations on these resource types that the project has not applied,
 * for push's gate to name when it refuses. A module that does not load is
 * reported rather than thrown: the gate refuses either way.
 */
export async function pendingMigrations(
  medplum: MedplumClient,
  modules: string[] | undefined,
  resourceTypes: string[],
): Promise<{ pending: { id: string; resourceType: string }[]; error?: string }> {
  if (!modules || resourceTypes.length === 0) return { pending: [] };
  const declared = await loadMigrations(modules);
  if (!declared.ok) return { pending: [], error: declared.errors.map((e) => e.message).join(' ') };
  const pending: { id: string; resourceType: string }[] = [];
  for (const migration of inOrder(declared.migrations)) {
    if (!resourceTypes.includes(migration.resourceType)) continue;
    const held = await findLedger(medplum, migration.id);
    if (held && stateOf(held).status === 'applied') continue;
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
  const modules = options.config.migrations?.modules;
  if (!modules) {
    return step.fail('migrations', [
      { code: 'no-migrations', message: 'The config has no "migrations" to report on.' },
    ]);
  }
  const declared = await declaredMigrations(modules, {});
  if ('errors' in declared) return step.fail('migrations', declared.errors);
  step.finish('migrations', `${declared.migrations.length} declared`);
  const connected = await connect(options.environment);
  if (!connected.ok) return step.fail('connect', [connected.error]);
  step.finish('connect', options.environment.baseUrl);

  const entries = await connected.medplum.searchResources('Basic', {
    code: `${PLUMB_SYSTEM}|migration`,
    _count: '1000',
  });
  const held = new Map(entries.map((basic) => [tagOf(basic), stateOf(basic)]));
  const report = (id: string, state: LedgerState | undefined, hash?: string) => {
    const status: MigrationStatus['status'] = !state
      ? 'pending'
      : hash && state.status === 'applied' && state.hash !== hash
        ? 'edited'
        : state.status;
    const found: MigrationStatus = {
      status,
      module: hash !== undefined,
      ...(state?.commit ? { commit: state.commit } : {}),
      ...(state ? { counts: state.counts } : {}),
      ...(state?.lastError ? { lastError: state.lastError } : {}),
    };
    result.migrations[id] = found;
    step.finish(id, describe(id, found), [], status !== 'applied');
  };
  for (const migration of inOrder(declared.migrations)) {
    report(migration.id, held.get(migration.id), hashOf(migration));
    held.delete(migration.id);
  }
  for (const [id, state] of [...held].sort(([a], [b]) => a.localeCompare(b))) report(id, state);
  result.ok = result.steps.every((s) => !s.failed);
  return step.done();
}

function describe(id: string, m: MigrationStatus): string {
  const at = m.commit ? ` at ${m.commit.slice(0, 7)}` : '';
  const changed = m.counts ? `, ${m.counts.changed} changed` : '';
  const text = {
    pending: 'pending',
    applied: `applied${at}${changed}`,
    edited: `applied${at}, then its module was edited: --rerun ${id} runs it again`,
    running: `running${changed}`,
    paused: `paused${changed}: --write resumes it`,
    errored: `errored${m.lastError ? `: ${m.lastError}` : ''}`,
  }[m.status];
  return m.module ? text : `${text} (no module)`;
}

/** The modules' migrations, checked, with every id the options name declared. */
async function declaredMigrations(
  modules: string[],
  options: Pick<MigrateEnvOptions, 'ids' | 'rerun'>,
): Promise<{ migrations: Migration[] } | { errors: { code: string; message: string }[] }> {
  const declared = await loadMigrations(modules);
  if (!declared.ok) return { errors: declared.errors };
  const invalid = checkMigrations(declared.migrations);
  if (invalid.length > 0) return { errors: invalid };
  const unknown = [...(options.ids ?? []), ...(options.rerun ?? [])].filter(
    (id) => !declared.migrations.some((m) => m.id === id),
  );
  if (unknown.length > 0) {
    const message = `No module declares ${unknown.join(', ')}.`;
    return { errors: [{ code: 'unknown-migration', message }] };
  }
  return { migrations: declared.migrations };
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
      const code = (err as { code?: string }).code ?? 'migration-failed';
      return void step.fail(migration.id, [{ code, message: normalizeErrorString(err) }]);
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
  botId: string;
  options: MigrateEnvOptions;
}

/** The migrations in the order `dependsOn` needs, otherwise by id. */
export function inOrder(migrations: Migration[]): Migration[] {
  const byId = new Map(migrations.map((m) => [m.id, m]));
  const ordered: Migration[] = [];
  const visit = (m: Migration) => {
    if (ordered.includes(m)) return;
    for (const id of m.dependsOn ?? []) {
      const dependency = byId.get(id);
      // checkMigrations refuses cycles, so the walk ends.
      if (dependency) visit(dependency);
    }
    ordered.push(m);
  };
  for (const m of [...migrations].sort((a, b) => a.id.localeCompare(b.id))) visit(m);
  return ordered;
}

const hashOf = (migration: Migration) =>
  createHash('sha256').update(readFileSync(migration.from)).digest('hex');

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
    state?.status === 'applied' &&
    state.hash !== hash &&
    !options.rerun?.includes(migration.id)
  ) {
    return {
      code: 'migration-edited',
      message: `${migration.id} was edited after it was applied; --rerun ${migration.id} runs it again.`,
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
  const status = held ? stateOf(held).status : 'pending';
  const report: MigrationReport = {
    status,
    ran: false,
    resumed: false,
    counts: zero(),
    reasons: [],
  };
  if (status === 'applied' && !run.options.rerun?.includes(migration.id)) return report;
  report.ran = true;
  const pass = await begin(run, migration, held, hash);
  report.resumed = pass.state.cursor !== undefined;
  if (report.resumed) report.counts = { ...pass.state.counts };
  const finished = await runPages(run, migration, pass, report);
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
  pass.state.start ??= now.toISOString();
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
    start: state.start,
    write: options.write === true,
    count: options.pageSize ?? 100,
    ...(forecast ? { forecast } : {}),
  };
  do {
    let page: PageResult;
    try {
      const cursor = state.cursor ? { cursor: state.cursor } : {};
      page = await runPage<PageResult>(
        medplum,
        run.botId,
        { ...input, ...cursor },
        options.wait,
        'migrator',
      );
    } catch (err) {
      await savePass(medplum, pass, {
        ...state,
        status: 'errored',
        lastError: normalizeErrorString(err),
      });
      throw err;
    }
    add(report, page);
    state.counts = { ...report.counts };
    state.cursor = page.next;
    state.pages++;
    state.lease = (options.now ?? (() => new Date()))().toISOString();
    await savePass(medplum, pass, state);
    await options.onPage?.(migration.id, report.counts);
    if (state.cursor && options.signal?.aborted) {
      await savePass(medplum, pass, { ...state, status: 'paused' });
      return false;
    }
  } while (state.cursor);
  return true;
}

/** A finished pass is applied, or errored and run again from the start when it left records behind. */
async function close(
  medplum: MedplumClient,
  basic: Basic,
  state: LedgerState,
  report: MigrationReport,
) {
  const left = report.counts.failed + report.counts.conflict;
  const { start, lease, lastError, ...rest } = state;
  await saveLedger(
    medplum,
    basic,
    left > 0
      ? { ...rest, status: 'errored', lastError: `${left} records not migrated` }
      : { ...rest, start: start as string, status: 'applied' },
  );
}

/** What one page of the bot returns, as the generated MigrationPageResult. */
interface PageResult extends Counts {
  reasons: { message: string; count: number }[];
  forecast?: {
    profiles: Record<
      string,
      { checked: number; failing: string[]; reasons: ForecastReport['reasons'] }
    >;
  };
  next?: string;
}

function add(report: MigrationReport, page: PageResult): void {
  for (const key of Object.keys(report.counts) as (keyof Counts)[]) report.counts[key] += page[key];
  for (const reason of page.reasons) {
    const same = report.reasons.find((r) => r.message === reason.message);
    if (same) same.count += reason.count;
    else report.reasons.push({ ...reason });
  }
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
  const bot = await medplum.searchOne('Bot', { identifier: `${PLUMB_SYSTEM}|${key}` });
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
  medplum.searchOne('Basic', { _tag: `${PLUMB_SYSTEM}|${id}`, code: `${PLUMB_SYSTEM}|migration` });

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
  if (
    previous?.status === 'running' &&
    previous.lease &&
    now.getTime() - Date.parse(previous.lease) < LEASE_MS
  ) {
    throw running(migration.id);
  }
  const resume = previous?.cursor !== undefined && previous.status !== 'applied';
  const state: LedgerState = {
    status: 'running',
    hash,
    ...(options.commit ? { commit: options.commit } : {}),
    ...(resume ? { start: previous.start, cursor: previous.cursor } : {}),
    counts: resume ? previous.counts : zero(),
    pages: resume ? previous.pages : 0,
    lease: now.toISOString(),
  };
  if (!held) {
    const created = await medplum.createResource<Basic>(ledgerResource(migration.id, state), {
      headers: { 'If-None-Exist': `_tag=${PLUMB_SYSTEM}|${migration.id}` },
    });
    // A conditional create that found one returns it: another run made it first.
    if (stateOf(created).lease !== state.lease) throw running(migration.id);
    return { basic: created, state };
  }
  return { basic: await saveLedger(medplum, held, state), state };
}

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
      { headers: { 'If-Match': `W/"${basic.meta?.versionId}"` } },
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
      `${id} is being run by another plumb migrate; it is taken over once idle for ten minutes.`,
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
  return `${write ? '' : 'dry run: '}${parts.join(', ')}${report.resumed ? ' (resumed)' : ''}`;
}

const problemsOf = (report: MigrationReport) =>
  report.counts.failed + report.counts.conflict + (report.forecast?.failing ?? 0);

function warnings(report: MigrationReport, blocked?: string): string[] {
  const lines = [
    ...(blocked ? [blocked] : []),
    ...report.reasons.map((r) => `${r.count} failed: ${r.message}`),
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
