// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { deepEquals, type MedplumClient, normalizeErrorString } from '@medplum/core';
import type { CodeSystem, StructureDefinition, ValueSet } from '@medplum/fhirtypes';
import { closure } from './checker/input.js';
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
import {
  applyProject,
  describeChange,
  type ProjectOptions,
  type ProjectPlan,
  planProject,
  planSummary as projectSummary,
} from './project.js';

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
  | 'check';

/**
 * What push will do with one definition: the selected profiles, what they
 * depend on, and the ValueSets and CodeSystems they bind.
 */
export interface PlannedDefinition {
  resourceType: Definition['resourceType'];
  url: string;
  version?: string;
  action: 'create' | 'update' | 'unchanged' | 'shadowed';
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
  const { loaded, medplum, content } = ready;
  if (options.check) return checkDrift(medplum, loaded, content.files, options, result, step);

  const botId = await checkerStep(medplum, ready.resourceTypes, options, result, step);
  if (!botId) return result;

  const finish = async (ok: boolean) => {
    result.ok = (await converge(medplum, content.files, options, result, step)) && ok;
    return step.done();
  };

  const { planned, held } = await planStep(medplum, loaded, content.files, result, step);
  const changes = result.plan.filter((p) => p.action === 'create' || p.action === 'update');
  if (result.plan.some((p) => p.action === 'shadowed')) return step.done();
  if (changes.length === 0) return finish(true);

  const filename = checkerFilename(options.checker.code, options.checker.version);
  result.reportPath = options.reportPath;
  const check = (name: 'gate' | 'recheck') =>
    checkStored(medplum, loaded, botId, { ...options, filename }).catch((err: unknown) => {
      step.fail(name, [{ code: 'checker-failed', message: normalizeErrorString(err) }]);
      return undefined;
    });

  result.gate = await check('gate');
  if (!result.gate) return result;
  const gate = judge(result.gate, loaded.profiles.length);
  const env = options.environment.name;
  step.finish(
    'gate',
    gate.failed ? failingSummary(result.gate) : 'nothing stored would fail',
    gate.failed
      ? [`Refusing to load: fix or migrate them first, or see plumb validate --env ${env}.`]
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
  const recheck = judge(result.recheck, loaded.profiles.length);
  step.finish(
    'recheck',
    recheck.failed ? failingSummary(result.recheck, true) : 'nothing stored fails',
    recheckNotes(recheck.failed, result.strictMode === true),
    recheck.failed,
  );
  return finish(!recheck.failed);
}

/** Loads and connects, then checks the content offline, before anything is written. */
async function prepare(
  options: PushOptions,
  result: PushResult,
  step: ReturnType<typeof steps<PushStepName, PushResult>>,
) {
  const ready = await loadAndConnect(options, result, step);
  if (!ready) return undefined;
  const bots = checkBotFiles(options.config.bots);
  if (bots.length > 0) return void step.fail('load', bots);
  const content = loadContent(options.config.content, ready.loaded);
  if (!content.ok) return void step.fail('load', content.errors);
  return { ...ready, content };
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
  options: PushOptions,
  result: PushResult,
  step: ReturnType<typeof steps<PushStepName, PushResult>>,
): Promise<PushResult> {
  await planStep(medplum, loaded, files, result, step);
  const ok = await converge(medplum, files, { ...options, dryRun: true }, result, step);
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
  const terminology = drifted.length - profiles;
  const pending = (changes: { kind: string; kept?: true }[] = []) =>
    changes.filter((c) => !c.kept).length;
  const content = pending(result.content?.changes);
  const project = pending(result.project?.changes);
  const blocked = (result.content?.blocked.length ?? 0) + (result.project?.blocked.length ?? 0);
  return [
    profiles > 0 && `${profiles} profile${profiles === 1 ? '' : 's'}`,
    terminology > 0 && `${terminology} terminology`,
    content > 0 && `${content} content`,
    project > 0 && `${project} project change${project === 1 ? '' : 's'}`,
    blocked > 0 && `${blocked} blocked`,
  ].filter((d) => typeof d === 'string');
}

/** The content step, then the project's own, each only when the config declares it. */
async function converge(
  medplum: MedplumClient,
  files: ContentFile[],
  options: PushOptions,
  result: PushResult,
  step: Pick<ReturnType<typeof steps<PushStepName, PushResult>>, 'finish' | 'fail'>,
): Promise<boolean> {
  const content = files.length === 0 || (await contentStep(medplum, files, options, result, step));
  return (
    content &&
    (!declaresProject(options.config) || (await projectStep(medplum, options, result, step)))
  );
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
    [...plan.changes.map(describeContent), ...plan.blocked],
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
    [...plan.changes.map(describeChange), ...plan.blocked, ...plan.warnings],
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
  const held = new Map<string, Definition[]>();
  for (const definition of planned) {
    const found = await medplum.searchResources(definition.resourceType, {
      url: definition.url,
      _count: '100',
    });
    held.set(definition.url as string, found);
  }
  result.plan = planLoad(planned, held);
  const shadowed = result.plan.filter((p) => p.action === 'shadowed');
  step.finish(
    'plan',
    planSummary(result.plan, new Set(loaded.profiles.map((p) => p.url))),
    [
      ...shadowed.map(
        (p) => `${p.url}: the project holds more than one; delete all but one, then push again.`,
      ),
      ...result.plan
        .filter((p) => p.edited)
        .map((p) => `${p.url}|${p.version}: changed without a version bump.`),
      ...(codeless.length > 0
        ? [
            `${codeless.length} CodeSystem${codeless.length === 1 ? '' : 's'} bound ship without their codes, so are not loaded: ${codeless.join(', ')}.`,
          ]
        : []),
    ],
    shadowed.length > 0,
  );
  return { planned, held };
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
 * Compares each planned definition with what the project holds under
 * its URL. Push updates the one it holds rather than adding another, which
 * would shadow it: Medplum picks the "newest" by sorting versions as text.
 */
export function planLoad(
  planned: Definition[],
  held: Map<string, Definition[]>,
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
  if (plan.some((p) => p.action === 'shadowed')) return 'refusing: profiles are shadowed';
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
function failingSummary(checked: Checked, loaded = false): string {
  const failing = Object.entries(checked.profiles).filter(([, p]) => p.failing > 0);
  if (failing.length === 0) return 'a checked type was not readable';
  const count = failing.reduce((n, [, p]) => n + p.failing, 0);
  const names = failing.map(([url]) => url.slice(url.lastIndexOf('/') + 1)).join(', ');
  const verb = !loaded ? 'would fail' : count === 1 ? 'fails' : 'fail';
  return `${count} stored resource${count === 1 ? '' : 's'} ${verb} ${names}`;
}
