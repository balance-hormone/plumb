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
import type { AsyncJob, Basic, Bot, ResourceType } from '@medplum/fhirtypes';
import { type CheckerInput, type PageResult, type Reason, readQuery } from './checker/handler.js';
import { checkerInput, closure, type Gated } from './checker/input.js';
import { checkerFilename, deployedVersion, findChecker } from './checker/install.js';
import { type EnvOptions, type EnvResult, loadAndConnect, steps } from './connect.js';
import { type Routing, routingRows } from './emit/routes.js';
import { owned, PLUMB_SYSTEM } from './project.js';

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
  /** The receipt a passing run records, which lets `push` gate only what changes after. */
  receipt?: { id: string; began: string };
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
   * Pages to run at once, each type split by `_lastUpdated` into slices
   * paged side by side: 1, the default, reads each type in one pass.
   */
  concurrency?: number;
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
  /** When the run began, by the server's clock: it reads only what was updated before. */
  before: string;
  pages: number;
  /** `of`: how many resources the run will read, for progress. */
  types: Record<string, TypeReport & Sliced & { of?: number }>;
  profiles: SavedProfiles;
  forecast?: {
    types: Record<string, ForecastType & Sliced>;
    profiles: SavedProfiles;
  };
}

/** A type's reads, as slices that together cover everything updated before the run. */
interface Sliced {
  slices: Slice[];
  done: boolean;
}

/**
 * Resources last updated in `[from, to)`, read on a cursor of their own: the
 * first slice has no `from` unless the run reads from `since`, and one slice
 * alone has no `to`.
 */
interface Slice {
  from?: string;
  to?: string;
  cursor?: string;
  done: boolean;
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
  result.ok = !verdict.failed && result.shadowed.length === 0;
  const notes = [...checked.warnings];
  if (result.ok) {
    try {
      const receipt = { began: checked.began, checker: filename, profiles: covered(loaded) };
      result.receipt = { id: await recordReceipt(medplum, receipt), began: checked.began };
      notes.push(
        `Receipt Basic/${result.receipt.id}: push checks only what is updated from ${checked.began}.`,
      );
    } catch (err) {
      notes.push(`No receipt recorded, so push checks everything: ${normalizeErrorString(err)}`);
    }
  }
  step.finish('validate', verdict.summary, notes, verdict.failed);
  return step.done();
}

/**
 * What a passing `validate` found: every stored resource stamped with these
 * profiles, as hashed, and last updated before `began`, passed them under
 * this checker. One per project, the last pass's; its history keeps the rest.
 */
interface Receipt {
  /** The second the run began, by the server's clock. */
  began: string;
  /** The checker's filename, which names its build. */
  checker: string;
  profiles: { url: string; version?: string; hash: string }[];
}

const RECEIPT = `${PLUMB_SYSTEM}#validation`;
const RECEIPT_CODE = { coding: [{ system: PLUMB_SYSTEM, code: 'validation' }] };

/** Each profile with a SHA-256 of what the checker validates it with: it, its parents, its extensions. */
function covered(gated: Gated): Receipt['profiles'] {
  return gated.profiles.map((p) => ({
    url: p.url,
    ...(p.sd.version ? { version: p.sd.version } : {}),
    hash: createHash('sha256')
      .update(JSON.stringify(closure([p.url], gated)))
      .digest('hex'),
  }));
}

const findReceipt = (medplum: MedplumClient) =>
  medplum.searchOne('Basic', owned(medplum, { code: `${PLUMB_SYSTEM}|validation` }));

/** Writes the receipt over the project's last one, as the migration ledger keeps its state. */
async function recordReceipt(medplum: MedplumClient, receipt: Receipt): Promise<string> {
  const held = await findReceipt(medplum);
  const basic: Basic = {
    resourceType: 'Basic',
    code: RECEIPT_CODE,
    extension: [{ url: RECEIPT, valueString: JSON.stringify(receipt) }],
  };
  const written = held
    ? await medplum.updateResource({ ...basic, id: held.id as string })
    : await medplum.createResource(basic);
  return written.id as string;
}

/**
 * The time from which the gate must read, when the project's receipt covers
 * every profile it checks at the same version and content, under this
 * checker; otherwise why it must read everything.
 */
export async function receiptFor(
  medplum: MedplumClient,
  gated: Gated,
  checker: string,
): Promise<{ id: string; since: string } | { reason: string }> {
  const held = await findReceipt(medplum);
  const value = held?.extension?.find((e) => e.url === RECEIPT)?.valueString;
  if (!held || !value) return { reason: 'no receipt from plumb validate' };
  const receipt = JSON.parse(value) as Receipt;
  const id = `receipt Basic/${held.id}`;
  if (receipt.checker !== checker) return { reason: `${id} is from another checker build` };
  for (const p of covered(gated)) {
    const name = p.url.slice(p.url.lastIndexOf('/') + 1);
    const found = receipt.profiles.find((r) => r.url === p.url);
    if (!found) return { reason: `${id} does not cover ${name}` };
    if (found.version !== p.version) {
      return { reason: `${id} covers ${name} ${found.version}, not ${p.version}` };
    }
    if (found.hash !== p.hash) return { reason: `${id} covers other content of ${name}` };
  }
  return { id: held.id as string, since: receipt.began };
}

/** What the checker found across every page: no ids or cursors, which stay in the local file. */
export interface Checked {
  /** The second the run began, by the server's clock: it read what was updated before. */
  began: string;
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
  loaded: Gated,
  botId: string,
  options: Pick<ValidateEnvOptions, 'reportPath' | 'resume' | 'full' | 'onPage' | 'concurrency'> & {
    filename: string;
    /** The routing `forecast` checks unstamped resources with. */
    forecast?: Pick<Routing, 'routes' | 'stamps'>;
    /** Read only what was last updated from this time: what a receipt does not cover. */
    since?: string;
  },
): Promise<Checked> {
  const profiles = loaded.profiles.map((p) => [p.url, p.sd.version]).sort();
  const modes = [options.full ?? false, options.forecast !== undefined, options.since ?? null];
  const key = createHash('sha256')
    .update(JSON.stringify([options.filename, profiles, ...modes]))
    .digest('hex');
  const { saved, warnings } = await start(medplum, options, key);
  const resumed = saved.pages;
  let core: string | undefined;
  const resourceTypes = [...new Set(loaded.profiles.map((p) => p.sd.type))].sort();
  for (const resourceType of resourceTypes) {
    const input = {
      ...checkerInput(loaded, resourceType as ResourceType),
      before: saved.before,
      ...(options.full ? { full: true } : {}),
    };
    await checkType(medplum, saved, options, botId, input, (c) => {
      core = c;
    });
    if (options.forecast) {
      const base = { ...checkerInput(loaded, resourceType as ResourceType), before: saved.before };
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
    began: new Date(Date.parse(saved.before) - 1000).toISOString(),
    types: {},
    profiles: {},
    resumed,
    warnings,
    ...(core ? { core } : {}),
  };
  for (const [type, { slices: _s, done: _d, of: _o, ...report }] of Object.entries(saved.types)) {
    checked.types[type] = report;
  }
  checked.profiles = counted(saved.profiles);
  if (saved.forecast) {
    const types = Object.entries(saved.forecast.types).map(
      ([type, { slices: _s, done: _d, ...report }]) => [type, report],
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
  options: Pick<ValidateEnvOptions, 'reportPath' | 'onPage' | 'concurrency'>,
  botId: string,
  base: CheckerInput,
  routing: Pick<Routing, 'routes' | 'stamps'>,
): Promise<void> {
  const { resourceType } = base;
  saved.forecast ??= { types: {}, profiles: {} };
  const { types, profiles } = saved.forecast;
  const routes = routing.routes[resourceType] ?? [];
  const stamps = Object.fromEntries(
    routes.map((r) => [r.profile, routing.stamps[r.profile] ?? []]),
  );
  const input = { ...base, forecast: { routes, stamps } };
  types[resourceType] ??= {
    read: 0,
    routed: 0,
    failing: 0,
    unrouted: { none: 0, ambiguous: 0 },
    slices: await split(medplum, input, options.concurrency),
    done: false,
  };
  const type = types[resourceType];
  const run = { medplum, botId, saved, concurrency: options.concurrency };
  await drive(run, input, type, (page) => {
    type.read += page.read;
    type.routed += page.stamped;
    type.failing += page.failing;
    type.unrouted.none += page.unrouted?.none ?? 0;
    type.unrouted.ambiguous += page.unrouted?.ambiguous ?? 0;
    addProfiles(profiles, page, resourceType);
    saved.pages++;
    write(options.reportPath, saved);
    const of = saved.types[resourceType]?.unstamped ?? 0;
    return options.onPage?.(resourceType, saved.pages, { read: type.read, of });
  });
}

/** A fresh run, or with `resume` the interrupted one for the same checker and profiles. */
async function start(
  medplum: MedplumClient,
  options: Pick<ValidateEnvOptions, 'reportPath' | 'resume'>,
  key: string,
) {
  const previous = options.resume ? read(options.reportPath) : undefined;
  const resumable = previous?.key === key && !previous.complete;
  const saved: Saved = resumable
    ? previous
    : {
        key,
        complete: false,
        before: await serverTime(medplum),
        pages: 0,
        types: {},
        profiles: {},
      };
  const warnings =
    options.resume && !resumable ? ['Nothing to resume: checked from the start.'] : [];
  return { saved, warnings };
}

/**
 * The server's time, from its Date header, rounded up to the next second so
 * that nothing updated in the current second is left out. For a run that
 * writes nothing it could read again: validate, push's gate, a migration's
 * dry run.
 */
export async function serverTime(medplum: MedplumClient): Promise<string> {
  const response = await fetch(new URL('healthcheck', medplum.getBaseUrl()));
  const date = Date.parse(response.headers.get('date') ?? '');
  if (Number.isNaN(date)) throw new Error(`${medplum.getBaseUrl()} sent no Date header.`);
  return new Date(date + 1000).toISOString();
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
  options: Pick<ValidateEnvOptions, 'reportPath' | 'onPage' | 'concurrency'> & { since?: string },
  botId: string,
  input: CheckerInput,
  onCore: (core: string) => void,
): Promise<void> {
  const { resourceType } = input;
  let type = saved.types[resourceType];
  if (type?.done) return;
  if (!type) {
    // Counted by the CLI's own client, which may read what the checker's policy cannot.
    // From `since`, only what the run will read, so a window with nothing stamped is not unreadable.
    const since = options.since ? { slice: { from: options.since } } : undefined;
    const count = await medplum.search(resourceType as ResourceType, [
      ...(since ? readQuery({ ...input, ...since }) : []),
      ['_summary', 'count'],
      ['_total', 'accurate'],
    ]);
    type = {
      exists: count.total ?? 0,
      read: 0,
      stamped: 0,
      failing: 0,
      unstamped: 0,
      silent: { unknown: 0, versioned: 0, empty: 0 },
      otherProfiles: {},
      stampedOther: 0,
      slices: await split(medplum, input, options.concurrency, options.since),
      done: false,
    };
    saved.types[resourceType] = type;
  }
  for (const url of input.profiles) {
    saved.profiles[url] ??= { resourceType, checked: 0, failing: [], reasons: [] };
  }
  const run = { medplum, botId, saved, concurrency: options.concurrency };
  const current = type;
  await drive(run, input, current, (page) => {
    onCore(page.core);
    merge(saved, current, page, resourceType);
    saved.pages++;
    write(options.reportPath, saved);
    // Without full, every resource read carries a selected stamp.
    const progress = input.full
      ? { read: current.read, of: current.exists }
      : { read: current.stamped, of: current.of ?? (options.since ? current.exists : 0) };
    return options.onPage?.(resourceType, saved.pages, progress);
  });
}

/**
 * Runs `concurrency` pages at a time, each worker taking a slice and paging
 * it to its end in cursor order, then the next. Each page is saved as it
 * returns, its slice's cursor with it, so a page in flight when the run stops
 * is read again on resume, and none twice. A failed page starts no more:
 * the pages in flight are saved, then the first failure is thrown.
 */
async function drive(
  run: { medplum: MedplumClient; botId: string; saved: Saved; concurrency?: number },
  input: CheckerInput,
  type: Sliced,
  save: (page: PageResult) => void | Promise<void>,
): Promise<void> {
  const queue = type.slices.filter((s) => !s.done);
  let failure: { err: unknown } | undefined;
  const worker = async () => {
    for (let slice = queue.shift(); slice && !failure; slice = queue.shift()) {
      while (!slice.done && !failure) {
        const { from, to, cursor } = slice;
        try {
          const page = wellFormed(
            await runPage(run.medplum, run.botId, { ...input, slice: { from, to }, cursor }),
            input.resourceType,
            run.saved.pages + 1,
          );
          slice.cursor = page.next;
          slice.done = !page.next;
          type.done = type.slices.every((s) => s.done);
          await save(page);
        } catch (err) {
          failure ??= { err };
        }
      }
    }
  };
  const workers = Math.min(run.concurrency ?? 1, queue.length);
  await Promise.all(Array.from({ length: workers }, worker));
  if (failure) throw failure.err;
}

// More slices than workers, so one slow slice does not hold up the rest.
const SLICES_PER_WORKER = 4;
// Resources: a smaller slice is not worth the count it takes to split it.
const MIN_SLICE = 1_000;
// A slice narrower than this, in milliseconds, is not split further.
const MIN_SPAN_MS = 1_000;

/**
 * Splits what a type's run reads into slices by `_lastUpdated`, counting with
 * the CLI's client: splits the largest at its midpoint, from the epoch, until
 * each holds about a `SLICES_PER_WORKER`th of a worker's share, then merges
 * empty slices into a neighbour. The counts only balance the work; the
 * slices cover `before` and all earlier whatever they find.
 */
async function split(
  medplum: MedplumClient,
  input: CheckerInput,
  concurrency = 1,
  since?: string,
): Promise<Slice[]> {
  if (concurrency <= 1 || !input.before)
    return [{ ...(since ? { from: since } : {}), done: false }];
  const count = async (from: number | undefined, to: number) => {
    const slice = { ...(from === undefined ? {} : { from: iso(from) }), to: iso(to) };
    const query = [...readQuery({ ...input, slice }), ['_summary', 'count']];
    return (await medplum.search(input.resourceType, query)).total ?? 0;
  };
  const end = Date.parse(input.before);
  const first = since ? Date.parse(since) : undefined;
  const ranges: { from?: number; to: number; n: number }[] = [
    { ...(first === undefined ? {} : { from: first }), to: end, n: await count(first, end) },
  ];
  const target = Math.max(
    MIN_SLICE,
    Math.ceil((ranges[0]?.n ?? 0) / (concurrency * SLICES_PER_WORKER)),
  );
  for (;;) {
    const largest = ranges.reduce((a, b) => (b.n > a.n ? b : a));
    const start = largest.from ?? 0;
    if (largest.n <= target || largest.to - start < MIN_SPAN_MS) break;
    const mid = Math.floor((start + largest.to) / 2);
    const left = await count(largest.from, mid);
    const right = { from: mid, to: largest.to, n: Math.max(0, largest.n - left) };
    ranges.splice(ranges.indexOf(largest), 1, { ...largest, to: mid, n: left }, right);
  }
  const kept = ranges.filter((r, i) => r.n > 0 || i === ranges.length - 1);
  const lower = (i: number) => (i === 0 ? first : kept[i - 1]?.to);
  return kept.map((r, i) => ({
    ...(lower(i) === undefined ? {} : { from: iso(lower(i) as number) }),
    to: iso(r.to),
    done: false,
  }));
}

const iso = (ms: number) => new Date(ms).toISOString();

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
 * For each request the CLI makes where a 429 must not end the run: the
 * client retries that request alone, a poll and not its job, waiting for
 * the reset its RateLimit header names, where by default it gives up on a
 * reset over two seconds away.
 */
export const QUOTA_RETRY = { maxRetries: QUOTA_TRIES, maxRetryTime: QUOTA_WAIT_MS };

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
      { headers: { Prefer: 'respond-async' }, pollStatusOnAccepted: true, ...QUOTA_RETRY },
    );
    const output = job.output?.parameter ?? [];
    const body = output.find((p) => p.name === 'responseBody')?.valueString;
    if (job.status === 'completed' && body !== undefined) {
      const result = JSON.parse(body) as Result | LambdaError;
      if (!isLambdaError(result)) return result;
      const error = [result.errorType, result.errorMessage].filter(Boolean).join(': ');
      throw new Error(`The ${bot}'s run failed: ${error}`);
    }
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

/**
 * What AWS Lambda returns for a run that threw, timed out or ran out of
 * memory: Medplum's awslambda runtime completes the job with it as the bot's
 * return, so it arrives where a page would.
 */
interface LambdaError {
  errorType?: string;
  errorMessage: string;
}

const isLambdaError = (value: unknown): value is LambdaError =>
  typeof (value as LambdaError | null)?.errorMessage === 'string';

/** A page missing a count the run adds up is refused before it is added. */
function wellFormed(page: PageResult, resourceType: string, n: number): PageResult {
  const p: Partial<PageResult> = page ?? {};
  const counts = [p.read, p.stamped, p.failing, p.unstamped, p.silent?.versioned, p.silent?.empty];
  if (counts.every((c) => typeof c === 'number') && p.otherStamps && p.profiles) return page;
  // Keys only: a page's values name records.
  const keys = Object.keys(p).join(', ') || 'nothing';
  throw new Error(
    `The checker returned a malformed page for ${resourceType} (page ${n}): it has ${keys}.`,
  );
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
  if (type.of !== undefined && type.done) {
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
