// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { deepEquals, type MedplumClient, normalizeErrorString, resolveId } from '@medplum/core';
import type { CodeSystem, StructureDefinition, ValueSet } from '@medplum/fhirtypes';
import {
  applyBots,
  type BotPlan,
  botsSummary,
  describeBot,
  missingFeatures,
  planBots,
} from './bots.js';
import { closure, type Gated } from './checker/input.js';
import {
  type CheckerInstall,
  type CheckerOptions,
  checkerFilename,
  installChecker,
} from './checker/install.js';
import { checkBotFiles, environmentSettings } from './config.js';
import { type Checked, checkStored, judge, type ValidateEnvOptions } from './conformance.js';
import { type EnvOptions, type EnvResult, loadAndConnect, steps } from './connect.js';
import {
  applyContent,
  type ContentFile,
  type ContentPlan,
  contentSummary,
  describeContent,
  loadContent,
  planContent,
} from './content.js';
import type { LoadProfilesResult } from './loader.js';
import { pendingMigrations } from './migrate.js';
import {
  applyOperations,
  type Contract,
  checkOperations,
  describeOperation,
  loadOperations,
  type OperationPlan,
  operationsSummary,
  planOperations,
} from './operations.js';
import {
  applyProject,
  type Blocked,
  describeChange,
  type ProjectOptions,
  type ProjectPlan,
  planProject,
  planSummary as projectSummary,
} from './project.js';
import {
  applySubscriptions,
  describeSubscription,
  planSubscriptions,
  type SubscriptionPlan,
  subscriptionsSummary,
} from './subscriptions.js';

type Definition = StructureDefinition | ValueSet | CodeSystem;

type PushStepName =
  | 'load'
  | 'connect'
  | 'checker'
  | 'plan'
  | 'gate'
  | 'apply'
  | 'recheck'
  | 'content'
  | 'project'
  | 'bots'
  | 'operations'
  | 'subscriptions'
  | 'check';

/**
 * What push will do with one definition: the selected profiles, what they
 * depend on, and the ValueSets and CodeSystems they bind.
 */
export interface PlannedDefinition {
  resourceType: Definition['resourceType'];
  url: string;
  version?: string;
  action: 'create' | 'update' | 'unchanged' | 'shadowed' | 'linked';
  /** The version the project holds, when it holds one. */
  held?: string;
  /** Changed content under the version the project already holds. */
  edited?: true;
}

export interface PushResult extends EnvResult<PushStepName> {
  checker?: CheckerInstall;
  plan: PlannedDefinition[];
  /** What would fail the planned profiles, before anything is loaded. */
  gate?: Checked;
  /** What fails the loaded profiles, straight after loading. */
  recheck?: Checked;
  reportPath?: string;
  /** The project's planned changes, when the config declares a project. */
  project?: ProjectPlan;
  /** The reference content's planned changes, when the config lists content. */
  content?: ContentPlan;
  /** The bots' planned changes, when the config declares bots. */
  bots?: BotPlan;
  /** The OperationDefinitions' planned changes, when the config lists operations. */
  operations?: OperationPlan;
  /** The Subscriptions' planned changes, when the config declares any. */
  subscriptions?: SubscriptionPlan;
}

export interface PushOptions extends EnvOptions, ProjectOptions {
  checker: Pick<CheckerOptions, 'code' | 'version'>;
  /** Where the gate's and the re-check's failing ids go, as `validate`'s do. */
  reportPath: string;
  /** Stop after the gate and the project plan, writing nothing. */
  dryRun?: boolean;
  /**
   * Plan without the checker or the gate, write nothing, and fail when push
   * would write anything: drift, as `generate --check` finds stale files.
   */
  check?: boolean;
  onPage?: ValidateEnvOptions['onPage'];
}

/**
 * Installs or updates the checker, then loads the selected profiles and what
 * they depend on, refusing while stored resources would fail them: design
 * 02's push. Nothing is loaded when the gate fails. Profiles loaded and then
 * failed by the re-check stay loaded, as Postgres keeps a `NOT VALID`
 * constraint. Once the gate has passed, the project's own configuration
 * follows: design 06.
 */
export async function push(options: PushOptions): Promise<PushResult> {
  const result: PushResult = { ok: false, steps: [], totalMs: 0, errors: [], plan: [] };
  const step = steps<PushStepName, PushResult>(result, options.onStep);
  const ready = await prepare(options, result, step);
  if (!ready) return result;
  const { loaded, medplum, content, operations } = ready;
  if (options.check) {
    return checkDrift(medplum, loaded, content.files, operations, options, result, step);
  }

  const botId = await checkerStep(medplum, ready.resourceTypes, options, result, step);
  if (!botId) return result;

  const finish = async (ok: boolean) => {
    result.ok = (await converge(medplum, content.files, operations, options, result, step)) && ok;
    return step.done();
  };

  const { planned, held } = await planStep(medplum, loaded, content.files, result, step);
  const changes = result.plan.filter((p) => p.action === 'create' || p.action === 'update');
  if (result.plan.some((p) => p.action === 'shadowed' || p.action === 'linked')) return step.done();
  if (changes.length === 0) return finish(true);

  const filename = checkerFilename(options.checker.code, options.checker.version);
  result.reportPath = options.reportPath;
  const gated = gatedProfiles(loaded, changes);
  const check = (name: 'gate' | 'recheck') =>
    checkStored(medplum, gated, botId, { ...options, filename }).catch((err: unknown) => {
      step.fail(name, [{ code: 'checker-failed', message: normalizeErrorString(err) }]);
      return undefined;
    });

  result.gate = await check('gate');
  if (!result.gate) return result;
  const gate = judge(result.gate, gated.profiles.length);
  step.finish(
    'gate',
    gate.failed ? failingSummary(result.gate) : 'nothing stored would fail',
    gate.failed
      ? await refusal(medplum, result.gate, options)
      : options.dryRun
        ? ['Dry run: nothing loaded.']
        : [],
    gate.failed,
  );
  if (gate.failed) return step.done();
  if (options.dryRun) return finish(true);

  try {
    await apply(medplum, changes, planned, held);
  } catch (err) {
    return step.fail('apply', [{ code: 'apply-failed', message: normalizeErrorString(err) }]);
  }
  const created = changes.filter((p) => p.action === 'create').length;
  step.finish('apply', `${created} created, ${changes.length - created} updated`);

  result.recheck = await check('recheck');
  if (!result.recheck) return result;
  const recheck = judge(result.recheck, gated.profiles.length);
  step.finish(
    'recheck',
    recheck.failed ? failingSummary(result.recheck, true) : 'nothing stored fails',
    recheckNotes(recheck.failed, result.strictMode === true),
    recheck.failed,
  );
  return finish(!recheck.failed);
}

/**
 * Loads and connects, then checks the bots' bundles and features and the
 * content, before anything is written.
 */
async function prepare(
  options: PushOptions,
  result: PushResult,
  step: ReturnType<typeof steps<PushStepName, PushResult>>,
) {
  const ready = await loadAndConnect(options, result, step);
  if (!ready) return undefined;
  const files = checkBotFiles(options.config.bots);
  if (files.length > 0) return void step.fail('load', files);
  if (options.config.bots) {
    const missing = await missingFeatures(ready.medplum, options.config.bots);
    if (missing.length > 0) return void step.fail('bots', missing);
  }
  const content = loadContent(options.config.content, ready.loaded);
  if (!content.ok) return void step.fail('load', content.errors);
  const operations = await prepareOperations(options.config, ready.loaded);
  if ('errors' in operations) return void step.fail('load', operations.errors);
  return { ...ready, content, operations };
}

/** The contracts `operations` lists, and each selected profile's resource type. */
interface Operations {
  contracts: Contract[];
  typeOf: (profile: string) => string | undefined;
}

/** Loads the contract modules and checks them against the config and the selected profiles. */
async function prepareOperations(
  config: PushOptions['config'],
  loaded: LoadProfilesResult,
): Promise<Operations | { errors: { code: string; message: string }[] }> {
  const read = await loadOperations(config.operations);
  if (!read.ok) return { errors: read.errors };
  const urls = loaded.profiles.map((p) => p.url);
  const errors = checkOperations(read.contracts, config.bots ?? {}, urls);
  if (errors.length > 0) return { errors };
  const typeOf = (url: string) => loaded.profiles.find((p) => p.url === url)?.sd.type;
  return { contracts: read.contracts, typeOf };
}

/** Installs or updates the checker; returns its bot's id, or nothing when that failed. */
async function checkerStep(
  medplum: MedplumClient,
  resourceTypes: string[],
  options: PushOptions,
  result: PushResult,
  step: ReturnType<typeof steps<PushStepName, PushResult>>,
): Promise<string | undefined> {
  try {
    result.checker = await installChecker(medplum, { ...options.checker, resourceTypes });
  } catch (err) {
    step.fail('checker', [{ code: 'checker-failed', message: normalizeErrorString(err) }]);
    return undefined;
  }
  const { status, version, previous, botId } = result.checker;
  step.finish('checker', `plumb-checker ${previous ? `${previous} → ` : ''}${version} ${status}`);
  return botId;
}

const declaresProject = (config: PushOptions['config']) =>
  config.project !== undefined || config.defaultProfile !== undefined;

/** `--check`: both plans, and a failed step naming what push would write. */
async function checkDrift(
  medplum: MedplumClient,
  loaded: LoadProfilesResult,
  files: ContentFile[],
  operations: Operations,
  options: PushOptions,
  result: PushResult,
  step: ReturnType<typeof steps<PushStepName, PushResult>>,
): Promise<PushResult> {
  await planStep(medplum, loaded, files, result, step);
  const dry = { ...options, dryRun: true };
  const ok = await converge(medplum, files, operations, dry, result, step);
  if (!ok && result.errors.length > 0) return step.done();
  const drift = driftOf(result);
  const env = options.environment.name;
  step.finish(
    'check',
    drift.length > 0 ? `drift: ${drift.join(', ')}` : 'no drift',
    drift.length > 0 ? [`Run plumb push --env ${env} to converge.`] : [],
    drift.length > 0,
  );
  result.ok = drift.length === 0;
  return step.done();
}

/** What push would write, by kind, as the check's line names it. */
function driftOf(result: PushResult): string[] {
  const drifted = result.plan.filter((p) => p.action !== 'unchanged');
  const profiles = drifted.filter((p) => p.resourceType === 'StructureDefinition').length;
  const pending = (changes: { kind: string; kept?: true }[] = []) =>
    changes.filter((c) => !c.kept).length;
  const plans = [
    result.content,
    result.project,
    result.bots,
    result.operations,
    result.subscriptions,
  ];
  const blocked = plans.reduce((n, plan) => n + (plan?.blocked.length ?? 0), 0);
  const counts: [number, string, string?][] = [
    [profiles, 'profile', 'profiles'],
    [drifted.length - profiles, 'terminology'],
    [pending(result.content?.changes), 'content'],
    [pending(result.project?.changes), 'project change', 'project changes'],
    [pending(result.bots?.changes), 'bot', 'bots'],
    [pending(result.operations?.changes), 'operation', 'operations'],
    [pending(result.subscriptions?.changes), 'subscription', 'subscriptions'],
    [blocked, 'blocked'],
  ];
  return counts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 || !many ? one : many}`);
}

/**
 * The content step, then the project's own, then the bots, then the
 * operations and Subscriptions, each only when the config declares it: a
 * bot's policy and secrets come from the project, and nothing reaches a bot
 * before its code is deployed.
 */
async function converge(
  medplum: MedplumClient,
  files: ContentFile[],
  operations: Operations,
  options: PushOptions,
  result: PushResult,
  step: Pick<ReturnType<typeof steps<PushStepName, PushResult>>, 'finish' | 'fail'>,
): Promise<boolean> {
  const content = files.length === 0 || (await contentStep(medplum, files, options, result, step));
  const project =
    content &&
    (!declaresProject(options.config) || (await projectStep(medplum, options, result, step)));
  const bots =
    project && (!options.config.bots || (await botsStep(medplum, options, result, step)));
  const contracts =
    bots &&
    (!options.config.operations ||
      (await operationsStep(medplum, operations, options, result, step)));
  return (
    contracts &&
    (!options.config.subscriptions || (await subscriptionsStep(medplum, options, result, step)))
  );
}

/** A blocked plan's lines under its step; its codes are in the plan, for `--json`. */
const messages = (blocked: Blocked[]) => blocked.map((b) => b.message);

/**
 * Plans the OperationDefinitions, then writes them unless the plan is blocked
 * or this is a dry run. Returns whether it succeeded.
 */
async function operationsStep(
  medplum: MedplumClient,
  operations: Operations,
  options: PushOptions,
  result: PushResult,
  step: Pick<ReturnType<typeof steps<PushStepName, PushResult>>, 'finish' | 'fail'>,
): Promise<boolean> {
  try {
    result.operations = await planOperations(
      medplum,
      operations.contracts,
      operations.typeOf,
      options,
    );
  } catch (err) {
    step.fail('operations', [{ code: 'operations-failed', message: normalizeErrorString(err) }]);
    return false;
  }
  const plan = result.operations;
  const blocked = plan.blocked.length > 0;
  step.finish(
    'operations',
    operationsSummary(plan),
    [...plan.changes.map(describeOperation), ...messages(plan.blocked)],
    blocked,
  );
  const pending = plan.changes.some((c) => !('kept' in c && c.kept));
  if (blocked || options.dryRun || !pending) return !blocked;
  try {
    const written = await applyOperations(plan, medplum);
    step.finish('operations', `applied ${written} change${written === 1 ? '' : 's'}`);
  } catch (err) {
    step.fail('operations', [{ code: 'operations-failed', message: normalizeErrorString(err) }]);
    return false;
  }
  return true;
}

/**
 * Plans the Subscriptions, then writes them unless the plan is blocked or this
 * is a dry run. Returns whether it succeeded.
 */
async function subscriptionsStep(
  medplum: MedplumClient,
  options: PushOptions,
  result: PushResult,
  step: Pick<ReturnType<typeof steps<PushStepName, PushResult>>, 'finish' | 'fail'>,
): Promise<boolean> {
  try {
    result.subscriptions = await planSubscriptions(
      medplum,
      options.config.subscriptions ?? {},
      options,
    );
  } catch (err) {
    step.fail('subscriptions', [
      { code: 'subscriptions-failed', message: normalizeErrorString(err) },
    ]);
    return false;
  }
  const plan = result.subscriptions;
  const blocked = plan.blocked.length > 0;
  step.finish(
    'subscriptions',
    subscriptionsSummary(plan),
    [...plan.changes.map(describeSubscription), ...messages(plan.blocked)],
    blocked,
  );
  const pending = plan.changes.some((c) => !('kept' in c && c.kept));
  if (blocked || options.dryRun || !pending) return !blocked;
  try {
    const written = await applySubscriptions(plan, medplum, options.env);
    step.finish('subscriptions', `applied ${written} change${written === 1 ? '' : 's'}`);
  } catch (err) {
    step.fail('subscriptions', [
      { code: 'subscriptions-failed', message: normalizeErrorString(err) },
    ]);
    return false;
  }
  return true;
}

/**
 * Plans the bots, then writes and deploys them unless the plan is blocked or
 * this is a dry run. Returns whether it succeeded.
 */
async function botsStep(
  medplum: MedplumClient,
  options: PushOptions,
  result: PushResult,
  step: Pick<ReturnType<typeof steps<PushStepName, PushResult>>, 'finish' | 'fail'>,
): Promise<boolean> {
  try {
    result.bots = await planBots(medplum, options.config.bots ?? {}, options);
  } catch (err) {
    step.fail('bots', [{ code: 'bots-failed', message: normalizeErrorString(err) }]);
    return false;
  }
  const plan = result.bots;
  const blocked = plan.blocked.length > 0;
  const webhooks = (list: BotPlan['webhooks']) => list.map((w) => `webhook  ${w.key}  ${w.url}`);
  step.finish(
    'bots',
    botsSummary(plan),
    [
      ...plan.changes.map(describeBot),
      ...webhooks(plan.webhooks),
      ...plan.warnings,
      ...messages(plan.blocked),
    ],
    blocked,
  );
  const pending = plan.changes.some((c) => !('kept' in c && c.kept));
  if (blocked || options.dryRun || !pending) return !blocked;
  try {
    const applied = await applyBots(plan, medplum);
    step.finish(
      'bots',
      `applied ${applied.written} change${applied.written === 1 ? '' : 's'}`,
      webhooks(applied.webhooks),
    );
  } catch (err) {
    step.fail('bots', [{ code: 'bots-failed', message: normalizeErrorString(err) }]);
    return false;
  }
  return true;
}

/**
 * Plans the reference content, then writes it unless the plan is blocked or
 * this is a dry run. Returns whether it succeeded.
 */
async function contentStep(
  medplum: MedplumClient,
  files: ContentFile[],
  options: PushOptions,
  result: PushResult,
  step: Pick<ReturnType<typeof steps<PushStepName, PushResult>>, 'finish' | 'fail'>,
): Promise<boolean> {
  try {
    result.content = await planContent(medplum, files, options);
  } catch (err) {
    step.fail('content', [{ code: 'content-failed', message: normalizeErrorString(err) }]);
    return false;
  }
  const plan = result.content;
  const blocked = plan.blocked.length > 0;
  step.finish(
    'content',
    contentSummary(plan),
    [...plan.changes.map(describeContent), ...messages(plan.blocked)],
    blocked,
  );
  const pending = plan.changes.some((c) => !('kept' in c && c.kept));
  if (blocked || options.dryRun || !pending) return !blocked;
  try {
    const written = await applyContent(plan, medplum);
    step.finish('content', `applied ${written} change${written === 1 ? '' : 's'}`);
  } catch (err) {
    step.fail('content', [{ code: 'content-failed', message: normalizeErrorString(err) }]);
    return false;
  }
  return true;
}

/**
 * Plans the project's configuration, then writes it unless the plan is
 * blocked or this is a dry run. Returns whether it succeeded.
 */
async function projectStep(
  medplum: MedplumClient,
  options: PushOptions,
  result: PushResult,
  step: Pick<ReturnType<typeof steps<PushStepName, PushResult>>, 'finish' | 'fail'>,
): Promise<boolean> {
  let plan: ProjectPlan;
  try {
    const { config, environment } = options;
    const target = {
      ...config.project,
      settings: environmentSettings(config, environment.name),
      ...(config.defaultProfile ? { defaultProfile: config.defaultProfile } : {}),
    };
    plan = await planProject(target, medplum, options);
  } catch (err) {
    step.fail('project', [{ code: 'project-failed', message: normalizeErrorString(err) }]);
    return false;
  }
  result.project = plan;
  const blocked = plan.blocked.length > 0;
  step.finish(
    'project',
    projectSummary(plan),
    [...plan.changes.map(describeChange), ...messages(plan.blocked), ...plan.warnings],
    blocked,
  );
  const pending = plan.changes.some((c) => !('kept' in c));
  if (blocked || options.dryRun || !pending) return !blocked;
  try {
    const { written, created } = await applyProject(plan, medplum, options.env);
    // A created client's id is printed; its secret is read in the console.
    step.finish(
      'project',
      `applied ${written} change${written === 1 ? '' : 's'}`,
      created.map((c) => `ClientApplication ${c.key} created: ${c.id}`),
    );
  } catch (err) {
    step.fail('project', [{ code: 'project-failed', message: normalizeErrorString(err) }]);
    return false;
  }
  return true;
}

/** The selected profiles and what they depend on, against what the project holds. */
async function planStep(
  medplum: MedplumClient,
  loaded: LoadProfilesResult,
  files: ContentFile[],
  result: PushResult,
  step: { finish: (name: PushStepName, summary: string, w: string[], failed: boolean) => void },
) {
  // Base R4 is the server's own, so only what packages and local files add is
  // planned. Terminology loads first, so nothing written binds to a ValueSet
  // the server lacks.
  const { terminology, codeless } = boundTerminology(loaded);
  // Content the config lists is the content step's, tagged as such.
  const listed = new Set(files.map((f) => f.key));
  const planned: Definition[] = [
    ...terminology.filter((t) => !listed.has(t.url as string)),
    ...closure(
      loaded.profiles.map((p) => p.url),
      loaded,
    ).filter((sd) => loaded.definitions.get(sd.url)?.source !== 'base'),
  ];
  const { held, server, ours } = await heldCopies(medplum, planned);
  // The server's own copy is its business, as base R4 is: nothing is loaded over it.
  const loading = planned.filter((d) => !server.has(d.url as string));
  result.plan = planLoad(loading, held, ours);
  const shadowed = result.plan.filter((p) => p.action === 'shadowed');
  const linked = result.plan.filter((p) => p.action === 'linked');
  step.finish(
    'plan',
    planSummary(result.plan, new Set(loaded.profiles.map((p) => p.url))),
    [
      ...shadowed.map(
        (p) => `${p.url}: the project holds more than one; delete all but one, then push again.`,
      ),
      ...linked.map(
        (p) =>
          `${p.url}: a linked project holds it, and a copy here would shadow it; load it there, or unlink the project.`,
      ),
      ...(server.size > 0 ? [`${server.size} held by the server itself, so not loaded.`] : []),
      ...result.plan
        .filter((p) => p.edited)
        .map((p) => `${p.url}|${p.version}: changed without a version bump.`),
      ...(codeless.length > 0
        ? [
            `${codeless.length} CodeSystem${codeless.length === 1 ? '' : 's'} bound ship without their codes, so are not loaded: ${codeless.join(', ')}.`,
          ]
        : []),
    ],
    shadowed.length + linked.length > 0,
  );
  return { planned: loading, held };
}

/**
 * The copies of each planned definition that matter to this project: its own,
 * which push updates, and a linked project's, which it must not shadow. A copy
 * in neither is the server's own, such as the terminology Medplum's base
 * project holds, which a project admin can neither update nor shadow.
 */
async function heldCopies(medplum: MedplumClient, planned: Definition[]) {
  const project = await medplum.readResource('Project', medplum.getProject()?.id as string);
  const linked = new Set(project.link?.map((l) => resolveId(l.project)));
  const held = new Map<string, Definition[]>();
  const server = new Set<string>();
  for (const definition of planned) {
    const url = definition.url as string;
    const found = await medplum.searchResources(definition.resourceType, { url, _count: '100' });
    const visible = found.filter(
      (d) => d.meta?.project === project.id || linked.has(d.meta?.project),
    );
    if (visible.length === 0 && found.length > 0) server.add(url);
    held.set(url, visible);
  }
  return { held, server, ours: (d: Definition) => d.meta?.project === project.id };
}

/**
 * The selected profiles, and every other resource profile push creates or
 * updates, such as a parent: strict mode enforces each one a resource is
 * stamped with, selected or not.
 */
function gatedProfiles(loaded: LoadProfilesResult, changes: PlannedDefinition[]): Gated {
  const selected = new Set(loaded.profiles.map((p) => p.url));
  const others = changes.flatMap((c) => {
    const sd = loaded.definitions.get(c.url)?.resource;
    return !selected.has(c.url) &&
      sd?.resourceType === 'StructureDefinition' &&
      sd.kind === 'resource' &&
      sd.derivation === 'constraint'
      ? [{ url: c.url, sd }]
      : [];
  });
  return { profiles: [...loaded.profiles, ...others], definitions: loaded.definitions };
}

/** Updates the one definition the project holds for a URL, or creates it. */
async function apply(
  medplum: MedplumClient,
  changes: PlannedDefinition[],
  planned: Definition[],
  held: Map<string, Definition[]>,
): Promise<void> {
  for (const change of changes) {
    const definition = planned.find((d) => d.url === change.url) as Definition;
    const { id: _, meta: __, ...content } = definition;
    const target = held.get(change.url)?.[0];
    if (target) await medplum.updateResource({ ...content, id: target.id });
    else await medplum.createResource(content);
  }
}

/** Strict mode is reported, never set: only a super admin can change it. */
function recheckNotes(failed: boolean, strictMode: boolean): string[] {
  const notes = failed ? ['Written between the gate and loading; the profiles stay loaded.'] : [];
  if (!strictMode) {
    notes.push(
      `Strict mode is off, and only a super admin can turn it on${failed ? '' : '; every stamped resource checked passes its profiles'}.`,
    );
  }
  return notes;
}

/**
 * The ValueSets and CodeSystems the selected profiles bind, as the loader
 * resolved them, less base R4's. A CodeSystem without its concepts (SNOMED CT
 * in a package) is listed instead: its codes come from Medplum.
 */
export function boundTerminology(loaded: Pick<LoadProfilesResult, 'definitions'>) {
  const terminology: (ValueSet | CodeSystem)[] = [];
  const codeless: string[] = [];
  for (const { resource, source } of loaded.definitions.values()) {
    if (source === 'base' || resource.resourceType === 'StructureDefinition') continue;
    if (resource.resourceType === 'CodeSystem' && resource.content === 'not-present') {
      codeless.push(resource.url as string);
    } else terminology.push(resource);
  }
  // A ValueSet's codes come from its CodeSystems, so they load first.
  terminology.sort(
    (a, b) => Number(a.resourceType === 'ValueSet') - Number(b.resourceType === 'ValueSet'),
  );
  return { terminology, codeless };
}

/**
 * Compares each planned definition with what the project and its linked
 * projects hold under its URL. Push updates the one the project holds rather
 * than adding another, which would shadow it: Medplum picks the "newest" by
 * sorting versions as text. A linked project's only copy is refused alike.
 */
export function planLoad(
  planned: Definition[],
  held: Map<string, Definition[]>,
  ours: (held: Definition) => boolean = () => true,
): PlannedDefinition[] {
  return planned.map((sd) => {
    const found = held.get(sd.url as string) ?? [];
    const base = {
      resourceType: sd.resourceType,
      url: sd.url as string,
      ...(sd.version ? { version: sd.version } : {}),
    };
    const current = found[0];
    if (found.length > 1) return { ...base, action: 'shadowed' };
    if (!current) return { ...base, action: 'create' };
    if (!ours(current)) return { ...base, action: 'linked' };
    const was = current.version ? { held: current.version } : {};
    if (sameContent(sd, current)) return { ...base, ...was, action: 'unchanged' };
    return {
      ...base,
      ...was,
      action: 'update',
      ...(current.version === sd.version ? { edited: true } : {}),
    };
  });
}

const sameContent = (a: Definition, b: Definition) => {
  const { id: _a, meta: _am, ...left } = a;
  const { id: _b, meta: _bm, ...right } = b;
  return deepEquals(left, right);
};

/** The selected profiles push loads by name and version, then a count of their dependencies. */
function planSummary(plan: PlannedDefinition[], selected: Set<string>): string {
  const changes = plan.filter((p) => p.action === 'create' || p.action === 'update');
  if (plan.some((p) => p.action === 'shadowed' || p.action === 'linked')) {
    return 'refusing: profiles are shadowed';
  }
  if (changes.length === 0) return `${plan.length} up to date, nothing to load`;
  const named = changes
    .filter((p) => selected.has(p.url))
    .map((p) => `${p.url.slice(p.url.lastIndexOf('/') + 1)}${p.version ? ` ${p.version}` : ''}`);
  const terminology = changes.filter((p) => p.resourceType !== 'StructureDefinition').length;
  const dependencies = changes.length - named.length - terminology;
  const extra = [
    dependencies && `+${dependencies} dependencies`,
    terminology && `+${terminology} terminology`,
  ].filter(Boolean);
  return `load ${named.join(', ') || 'no selected profile'}${extra.length ? ` (${extra.join(', ')})` : ''}`;
}

/** What fails: `loaded` once the profiles are in the project, before that what would. */
/** Why the gate refused, naming the pending migrations on each failing type. */
async function refusal(
  medplum: MedplumClient,
  gate: Checked,
  options: PushOptions,
): Promise<string[]> {
  const env = options.environment.name;
  const types = [
    ...new Set(
      Object.values(gate.profiles)
        .filter((p) => p.failing > 0)
        .map((p) => p.resourceType),
    ),
  ];
  const found = await pendingMigrations(medplum, options.config, types);
  const lines = found.pending.map((m) => `pending: ${m.id} (${m.resourceType})`);
  if (found.error) lines.push(`Pending migrations not listed: ${found.error}`);
  lines.push(
    found.pending.length > 0
      ? `Refusing to load: run plumb migrate --env ${env} --write, or see plumb validate --env ${env}.`
      : `Refusing to load: fix or migrate them first, or see plumb validate --env ${env}.`,
  );
  return lines;
}

function failingSummary(checked: Checked, loaded = false): string {
  const failing = Object.entries(checked.profiles).filter(([, p]) => p.failing > 0);
  if (failing.length === 0) return 'a checked type was not readable';
  const count = failing.reduce((n, [, p]) => n + p.failing, 0);
  const names = failing.map(([url]) => url.slice(url.lastIndexOf('/') + 1)).join(', ');
  const verb = !loaded ? 'would fail' : count === 1 ? 'fails' : 'fail';
  return `${count} stored resource${count === 1 ? '' : 's'} ${verb} ${names}`;
}
