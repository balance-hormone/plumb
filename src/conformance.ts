// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ContentType,
  MEDPLUM_VERSION,
  type MedplumClient,
  normalizeErrorString,
} from '@medplum/core';
import type { AsyncJob, Bot, ResourceType } from '@medplum/fhirtypes';
import type { PageResult, Reason } from './checker/handler.js';
import { checkerInput } from './checker/input.js';
import { checkerFilename, deployedVersion, findChecker } from './checker/install.js';
import { type EnvOptions, type EnvResult, loadAndConnect, steps } from './connect.js';
import { type Routing, routingRows } from './emit/routes.js';
import type { LoadProfilesResult } from './loader.js';

type ValidateStepName = 'load' | 'connect' | 'checker' | 'profiles' | 'validate';

/** One resource type's stored resources, as the checker read them. */
export interface TypeReport {
  /** How many the CLI's client counts, to tell "nothing readable" from "nothing stored". */
  exists: number;
  /** How many the checker's AccessPolicy lets it read. */
  read: number;
  /** Resources stamped with at least one selected profile, each counted once. */
  stamped: number;
  /** Of those, the ones failing any of their selected profiles. */
  failing: number;
  /** Resources with no `meta.profile`: routing's job, not validated. */
  unstamped: number;
  /** Stamps that validate against nothing on the server. */
  silent: { unknown: number; versioned: number; empty: number };
  /** Stamps naming a profile the project holds but the config does not select. */
  otherProfiles: Record<string, number>;
  /**
   * Resources stamped, but with no selected profile, when the run read only
   * the selected stamps: `full` sorts them into silent stamps and other profiles.
   */
  stampedOther: number;
}

interface ProfileReport {
  resourceType: string;
  checked: number;
  failing: number;
  reasons: Reason[];
}

/** One type's unstamped resources, as if stamped as `createProfiled` would stamp them. */
interface ForecastType {
  read: number;
  /** Routed to one profile and checked against its stamps; then those failing any. */
  routed: number;
  failing: number;
  /** Routed to no profile, or to several unrelated ones, so not checked. */
  unrouted: { none: number; ambiguous: number };
}

/** What would fail if the unstamped resources were stamped: reported, never failing the run. */
interface Forecast {
  types: Record<string, ForecastType>;
  profiles: Record<string, ProfileReport>;
}

type SavedProfiles = Record<string, Omit<ProfileReport, 'failing'> & { failing: string[] }>;

export interface ValidateEnvResult extends EnvResult<ValidateStepName> {
  checker?: { version: string; core?: string };
  /** Selected URLs the project holds more than one StructureDefinition for. */
  shadowed: { url: string; versions: string[]; picked: string }[];
  types: Record<string, TypeReport>;
  profiles: Record<string, ProfileReport>;
  /** The local file holding the failing ids, written as the run goes. */
  reportPath?: string;
  /** Pages carried over from an interrupted run. */
  resumed: number;
  /** With `unstamped`. */
  forecast?: Forecast;
}

export interface ValidateEnvOptions extends EnvOptions {
  /** The bundled bot, to check the installed one is this Plumb's. */
  checker: { code: string; version: string };
  /** Where failing ids and the cursor are kept: `.plumb/validate-<env>.json`, gitignored. */
  reportPath: string;
  /** Continue an interrupted run from its last cursor. */
  resume?: boolean;
  /**
   * Read every resource of each type, to break down stamps naming no selected
   * profile; otherwise only resources with a selected stamp are read.
   */
  full?: boolean;
  /** Also forecast what would fail if each type's unstamped resources were stamped. */
  unstamped?: boolean;
  /**
   * Called after each page is saved, with the resource type, the pages done
   * so far, and how many of the type's resources to read have been.
   */
  onPage?: (
    resourceType: string,
    pages: number,
    progress: { read: number; of: number },
  ) => void | Promise<void>;
}

/** What the report file holds: the run so far, with failing ids, and where to resume it. */
interface Saved {
  key: string;
  complete: boolean;
  pages: number;
  /** `of`: how many resources the run will read, for progress. */
  types: Record<string, TypeReport & { cursor?: string; done: boolean; of?: number }>;
  profiles: SavedProfiles;
  forecast?: {
    types: Record<string, ForecastType & { cursor?: string; done: boolean }>;
    profiles: SavedProfiles;
  };
}

/**
 * Asks the checker bot, page by page, how many stored resources would fail
 * each selected profile and why, and checks from the CLI for profile
 * shadowing. Patient data stays in the project: counts and reasons come back,
 * and the failing ids go only to `reportPath`.
 */
export async function validateEnvironment(options: ValidateEnvOptions): Promise<ValidateEnvResult> {
  const result: ValidateEnvResult = {
    ok: false,
    steps: [],
    totalMs: 0,
    errors: [],
    shadowed: [],
    types: {},
    profiles: {},
    resumed: 0,
  };
  const step = steps<ValidateStepName, ValidateEnvResult>(result, options.onStep);
  const ready = await loadAndConnect(options, result, step);
  if (!ready) return result;
  const { loaded, medplum } = ready;

  const filename = checkerFilename(options.checker.code, options.checker.version);
  const bot = await findChecker(medplum);
  if (bot?.executableCode?.title !== filename) {
    return step.fail('checker', [notCurrent(bot, options)]);
  }
  step.finish('checker', `plumb-checker ${options.checker.version} installed`);

  const urls = loaded.profiles.map((p) => p.url).sort();
  result.shadowed = await findShadowed(medplum, urls);
  step.finish(
    'profiles',
    result.shadowed.length > 0
      ? `${result.shadowed.length} of ${urls.length} shadowed`
      : `${urls.length} selected, none shadowed`,
    result.shadowed.map(
      (s) =>
        `${s.url}: ${s.versions.length} StructureDefinitions (${s.versions.join(', ')}); Medplum enforces ${s.picked}`,
    ),
    result.shadowed.length > 0,
  );

  let checked: Checked;
  try {
    const forecast = options.unstamped ? routingRows(loaded, options.config) : undefined;
    checked = await checkStored(medplum, loaded, bot.id as string, {
      ...options,
      filename,
      ...(forecast ? { forecast } : {}),
    });
  } catch (err) {
    return step.fail('validate', [{ code: 'checker-failed', message: normalizeErrorString(err) }]);
  }
  Object.assign(result, {
    types: checked.types,
    profiles: checked.profiles,
    resumed: checked.resumed,
    ...(checked.forecast ? { forecast: checked.forecast } : {}),
    reportPath: options.reportPath,
    checker: { version: options.checker.version, ...(checked.core ? { core: checked.core } : {}) },
  });
  const verdict = judge(checked, urls.length);
  step.finish('validate', verdict.summary, checked.warnings, verdict.failed);
  result.ok = !verdict.failed && result.shadowed.length === 0;
  return step.done();
}

/** What the checker found across every page: no ids or cursors, which stay in the local file. */
export interface Checked {
  types: Record<string, TypeReport>;
  profiles: Record<string, ProfileReport>;
  /** The `@medplum/core` version the bot validated with. */
  core?: string;
  resumed: number;
  warnings: string[];
  forecast?: Forecast;
}

/**
 * Drives the checker through every page of each type the profiles
 * constrain, against the profiles as `loaded` holds them, saving each page to
 * `reportPath`. Throws when a page's job fails.
 */
export async function checkStored(
  medplum: MedplumClient,
  loaded: Pick<LoadProfilesResult, 'profiles' | 'definitions'>,
  botId: string,
  options: Pick<ValidateEnvOptions, 'reportPath' | 'resume' | 'full' | 'onPage'> & {
    filename: string;
    /** The routing `forecast` checks unstamped resources with. */
    forecast?: Pick<Routing, 'routes' | 'stamps'>;
  },
): Promise<Checked> {
  const profiles = loaded.profiles.map((p) => [p.url, p.sd.version]).sort();
  const modes = [options.full ?? false, options.forecast !== undefined];
  const key = createHash('sha256')
    .update(JSON.stringify([options.filename, profiles, ...modes]))
    .digest('hex');
  const { saved, warnings } = start(options, key);
  const resumed = saved.pages;
  let core: string | undefined;
  const resourceTypes = [...new Set(loaded.profiles.map((p) => p.sd.type))].sort();
  for (const resourceType of resourceTypes) {
    const input = {
      ...checkerInput(loaded, resourceType as ResourceType),
      ...(options.full ? { full: true } : {}),
    };
    await checkType(medplum, saved, options, botId, input, (c) => {
      core = c;
    });
    if (options.forecast) {
      const base = checkerInput(loaded, resourceType as ResourceType);
      await forecastType(medplum, saved, options, botId, base, options.forecast);
    }
  }
  await classifyOtherStamps(medplum, saved);
  saved.complete = true;
  write(options.reportPath, saved);

  if (core && core !== MEDPLUM_VERSION) {
    warnings.push(
      `plumb-checker validates with @medplum/core ${core}; this project has ${MEDPLUM_VERSION}.`,
    );
  }
  const checked: Checked = {
    types: {},
    profiles: {},
    resumed,
    warnings,
    ...(core ? { core } : {}),
  };
  for (const [type, { cursor: _c, done: _d, of: _o, ...report }] of Object.entries(saved.types)) {
    checked.types[type] = report;
  }
  checked.profiles = counted(saved.profiles);
  if (saved.forecast) {
    const types = Object.entries(saved.forecast.types).map(
      ([type, { cursor: _c, done: _d, ...report }]) => [type, report],
    );
    checked.forecast = {
      types: Object.fromEntries(types),
      profiles: counted(saved.forecast.profiles),
    };
  }
  return checked;
}

/** Failing ids stay in the saved file; the report has their count. */
function counted(profiles: SavedProfiles): Record<string, ProfileReport> {
  return Object.fromEntries(
    Object.entries(profiles).map(([url, p]) => [url, { ...p, failing: p.failing.length }]),
  );
}

/**
 * Drives the checker through one type's unstamped resources, each routed and
 * checked as `createProfiled` would stamp it, saving after each page.
 */
async function forecastType(
  medplum: MedplumClient,
  saved: Saved,
  options: Pick<ValidateEnvOptions, 'reportPath' | 'onPage'>,
  botId: string,
  input: ReturnType<typeof checkerInput>,
  routing: Pick<Routing, 'routes' | 'stamps'>,
): Promise<void> {
  const { resourceType } = input;
  saved.forecast ??= { types: {}, profiles: {} };
  const { types, profiles } = saved.forecast;
  types[resourceType] ??= {
    read: 0,
    routed: 0,
    failing: 0,
    unrouted: { none: 0, ambiguous: 0 },
    done: false,
  };
  const type = types[resourceType];
  if (type.done) return;
  const routes = routing.routes[resourceType] ?? [];
  const stamps = Object.fromEntries(
    routes.map((r) => [r.profile, routing.stamps[r.profile] ?? []]),
  );
  const forecast = { routes, stamps };
  do {
    const page = await runPage(medplum, botId, { ...input, forecast, cursor: type.cursor });
    type.read += page.read;
    type.routed += page.stamped;
    type.failing += page.failing;
    type.unrouted.none += page.unrouted?.none ?? 0;
    type.unrouted.ambiguous += page.unrouted?.ambiguous ?? 0;
    addProfiles(profiles, page, resourceType);
    type.cursor = page.next;
    type.done = !page.next;
    saved.pages++;
    write(options.reportPath, saved);
    const of = saved.types[resourceType]?.unstamped ?? 0;
    await options.onPage?.(resourceType, saved.pages, { read: type.read, of });
  } while (!type.done);
}

/** A fresh run, or with `resume` the interrupted one for the same checker and profiles. */
function start(options: Pick<ValidateEnvOptions, 'reportPath' | 'resume'>, key: string) {
  const previous = options.resume ? read(options.reportPath) : undefined;
  const resumable = previous?.key === key && !previous.complete;
  const saved: Saved = resumable
    ? previous
    : { key, complete: false, pages: 0, types: {}, profiles: {} };
  const warnings =
    options.resume && !resumable ? ['Nothing to resume: checked from the start.'] : [];
  return { saved, warnings };
}

/** Failing resources fail the run, and so does a type the checker could read none of. */
export function judge(result: Pick<Checked, 'types' | 'profiles'>, selected: number) {
  const failing = Object.values(result.profiles).filter((p) => p.failing > 0).length;
  const unreadable = Object.values(result.types).some((t) => t.read === 0 && t.exists > 0);
  if (failing > 0)
    return { summary: `${failing} of ${selected} profiles would fail`, failed: true };
  if (unreadable) return { summary: 'nothing fails, but a type was not readable', failed: true };
  return { summary: `${selected} profiles, nothing fails`, failed: false };
}

/** `validate` never installs anything, so a missing or different checker is push's to fix. */
export function notCurrent(
  bot: Bot | undefined,
  options: Pick<ValidateEnvOptions, 'environment' | 'checker'>,
) {
  const env = options.environment.name;
  const fix = `Run plumb push --env ${env}.`;
  if (!bot) {
    return {
      code: 'checker-missing',
      message: `plumb-checker is not installed in ${env}. ${fix}`,
    };
  }
  const installed = deployedVersion(bot);
  const which =
    installed === options.checker.version
      ? `a different build of ${installed}`
      : (installed ?? 'an unknown version');
  return {
    code: 'checker-outdated',
    message: `plumb-checker in ${env} is ${which}, not this plumb's ${options.checker.version}. ${fix}`,
  };
}

/** Selected URLs with more than one StructureDefinition in the project or a linked one. */
async function findShadowed(medplum: MedplumClient, urls: string[]) {
  const shadowed: ValidateEnvResult['shadowed'] = [];
  for (const url of urls) {
    const sds = await medplum.searchResources('StructureDefinition', { url, _count: '100' });
    if (sds.length < 2) continue;
    const versions = sds.map((sd) => sd.version ?? '').sort();
    // Medplum picks the "newest" by sorting version as text, so 1.9.0 beats 1.10.0.
    shadowed.push({ url, versions, picked: versions.at(-1) ?? '' });
  }
  return shadowed;
}

/** Drives the checker through one resource type's pages, saving after each. */
async function checkType(
  medplum: MedplumClient,
  saved: Saved,
  options: Pick<ValidateEnvOptions, 'reportPath' | 'onPage'>,
  botId: string,
  input: ReturnType<typeof checkerInput>,
  onCore: (core: string) => void,
): Promise<void> {
  const { resourceType } = input;
  let type = saved.types[resourceType];
  if (type?.done) return;
  if (!type) {
    // Counted by the CLI's own client, which may read what the checker's policy cannot.
    const count = await medplum.search(resourceType as ResourceType, {
      _summary: 'count',
      _total: 'accurate',
    });
    type = {
      exists: count.total ?? 0,
      read: 0,
      stamped: 0,
      failing: 0,
      unstamped: 0,
      silent: { unknown: 0, versioned: 0, empty: 0 },
      otherProfiles: {},
      stampedOther: 0,
      done: false,
    };
    saved.types[resourceType] = type;
  }
  for (const url of input.profiles) {
    saved.profiles[url] ??= { resourceType, checked: 0, failing: [], reasons: [] };
  }
  do {
    const page = await runPage(medplum, botId, { ...input, cursor: type.cursor });
    onCore(page.core);
    merge(saved, type, page, resourceType);
    type.cursor = page.next;
    type.done = !page.next;
    saved.pages++;
    write(options.reportPath, saved);
    // Without full, every resource read carries a selected stamp.
    const progress = input.full
      ? { read: type.read, of: type.exists }
      : { read: type.stamped, of: type.of ?? 0 };
    await options.onPage?.(resourceType, saved.pages, progress);
  } while (!type.done);
}

// On Medplum's awslambda runtime, AWS holds a function just deployed or
// redeployed in a state that refuses invocations for a few seconds.
const NOT_READY = /currently in the following state: Pending|An update is in progress for resource/;
const READY_WAIT_MS = 2_000;
const READY_TIMEOUT_MS = 60_000;
// Over the project's FHIR quota, which Medplum counts per minute.
const QUOTA = /too many requests|too-many-requests/i;
export const QUOTA_WAIT_MS = 60_000;
export const QUOTA_TRIES = 10;

/**
 * One page, as an async job: a page can outlast an HTTP request, not the
 * bot's timeout. A page over the quota is run again a minute later, so pages
 * must be safe to repeat.
 */
export async function runPage<Result = PageResult>(
  medplum: MedplumClient,
  botId: string,
  input: object,
  wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  bot = 'checker',
): Promise<Result> {
  let limited = 0;
  for (let waited = 0; ; waited += READY_WAIT_MS) {
    const job = await medplum.post<AsyncJob>(
      medplum.fhirUrl('Bot', botId, '$execute'),
      input,
      ContentType.JSON,
      { headers: { Prefer: 'respond-async' }, pollStatusOnAccepted: true },
    );
    const output = job.output?.parameter ?? [];
    const body = output.find((p) => p.name === 'responseBody')?.valueString;
    if (job.status === 'completed' && body !== undefined) return JSON.parse(body) as Result;
    const reason = normalizeErrorString(output.find((p) => p.resource)?.resource);
    if (QUOTA.test(reason) && ++limited < QUOTA_TRIES) {
      await wait(QUOTA_WAIT_MS);
      continue;
    }
    if (!NOT_READY.test(reason)) {
      throw new Error(`The ${bot}'s job ended ${job.status}: ${reason}`);
    }
    if (waited >= READY_TIMEOUT_MS) {
      throw new Error(
        `The ${bot} bot is still not ready after ${READY_TIMEOUT_MS / 1000}s: ${reason}`,
      );
    }
    await wait(READY_WAIT_MS);
  }
}

function merge(
  saved: Saved,
  type: Saved['types'][string],
  page: PageResult,
  resourceType: string,
): void {
  if (page.totals) {
    type.read = page.totals.readable;
    type.unstamped = page.totals.unstamped;
    type.of = page.totals.stamped;
  } else if (type.of === undefined) {
    type.read += page.read;
    type.unstamped += page.unstamped;
  }
  type.stamped += page.stamped;
  type.failing += page.failing;
  // The query counts; the pages read may see a write made in between.
  if (type.of !== undefined && !page.next) {
    type.stampedOther = Math.max(0, type.read - type.unstamped - type.stamped);
  }
  type.silent.versioned += page.silent.versioned;
  type.silent.empty += page.silent.empty;
  for (const [url, n] of Object.entries(page.otherStamps)) {
    type.otherProfiles[url] = (type.otherProfiles[url] ?? 0) + n;
  }
  addProfiles(saved.profiles, page, resourceType);
}

function addProfiles(target: SavedProfiles, page: PageResult, resourceType: string): void {
  for (const [url, p] of Object.entries(page.profiles)) {
    target[url] ??= { resourceType, checked: 0, failing: [], reasons: [] };
    const profile = target[url];
    profile.checked += p.checked;
    profile.failing.push(...p.failing);
    for (const reason of p.reasons) {
      const same = profile.reasons.find(
        (r) => r.path === reason.path && r.message === reason.message,
      );
      if (same) same.count += reason.count;
      else profile.reasons.push({ ...reason });
    }
    profile.reasons.sort((a, b) => b.count - a.count);
  }
}

/** A stamp naming a profile the project does not hold validates against nothing. */
async function classifyOtherStamps(medplum: MedplumClient, saved: Saved): Promise<void> {
  for (const type of Object.values(saved.types)) {
    for (const [url, n] of Object.entries(type.otherProfiles)) {
      const held = await medplum.searchOne('StructureDefinition', { url });
      if (held) continue;
      type.silent.unknown += n;
      delete type.otherProfiles[url];
    }
  }
}

function read(path: string): Saved | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Saved) : undefined;
}

/** Ids name specific records, so their directory ignores itself in git. */
function write(path: string, saved: Saved): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '*\n');
  writeFileSync(path, `${JSON.stringify(saved, null, 2)}\n`);
}
