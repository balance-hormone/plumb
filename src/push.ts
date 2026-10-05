// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { deepEquals, type MedplumClient, normalizeErrorString } from '@medplum/core';
import type { StructureDefinition } from '@medplum/fhirtypes';
import { closure } from './checker/input.js';
import {
  type CheckerInstall,
  type CheckerOptions,
  checkerFilename,
  installChecker,
} from './checker/install.js';
import { environmentSettings } from './config.js';
import { type Checked, checkStored, judge, type ValidateEnvOptions } from './conformance.js';
import { type EnvOptions, type EnvResult, loadAndConnect, steps } from './connect.js';
import type { LoadProfilesResult } from './loader.js';
import {
  applyProject,
  describeChange,
  type ProjectOptions,
  type ProjectPlan,
  planProject,
  planSummary as projectSummary,
} from './project.js';

type PushStepName =
  | 'load'
  | 'connect'
  | 'checker'
  | 'plan'
  | 'gate'
  | 'apply'
  | 'recheck'
  | 'project';

/** What push will do with one StructureDefinition: the selected profiles and what they depend on. */
export interface PlannedDefinition {
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
}

export interface PushOptions extends EnvOptions, ProjectOptions {
  checker: Pick<CheckerOptions, 'code' | 'version'>;
  /** Where the gate's and the re-check's failing ids go, as `validate`'s do. */
  reportPath: string;
  /** Stop after the gate and the project plan, writing nothing. */
  dryRun?: boolean;
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
  const ready = await loadAndConnect(options, result, step);
  if (!ready) return result;
  const { loaded, medplum } = ready;

  try {
    result.checker = await installChecker(medplum, {
      ...options.checker,
      resourceTypes: ready.resourceTypes,
    });
  } catch (err) {
    return step.fail('checker', [{ code: 'checker-failed', message: normalizeErrorString(err) }]);
  }
  const { status, version, previous, botId } = result.checker;
  step.finish('checker', `plumb-checker ${previous ? `${previous} → ` : ''}${version} ${status}`);

  const finish = async (ok: boolean) => {
    const { project: declared, defaultProfile } = options.config;
    const project =
      (declared || defaultProfile) && (await projectStep(medplum, options, result, step));
    result.ok = ok && project !== false;
    return step.done();
  };

  const { planned, held } = await planStep(medplum, loaded, result, step);
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
  result: PushResult,
  step: { finish: (name: PushStepName, summary: string, w: string[], failed: boolean) => void },
) {
  // Base R4 is the server's own, so only what packages and local files add is planned.
  const planned = closure(
    loaded.profiles.map((p) => p.url),
    loaded,
  ).filter((sd) => loaded.definitions.get(sd.url)?.source !== 'base');
  const held = new Map<string, StructureDefinition[]>();
  for (const sd of planned) {
    const found = await medplum.searchResources('StructureDefinition', {
      url: sd.url,
      _count: '100',
    });
    held.set(sd.url, found);
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
    ],
    shadowed.length > 0,
  );
  return { planned, held };
}

/** Updates the one StructureDefinition the project holds for a URL, or creates it. */
async function apply(
  medplum: MedplumClient,
  changes: PlannedDefinition[],
  planned: StructureDefinition[],
  held: Map<string, StructureDefinition[]>,
): Promise<void> {
  for (const change of changes) {
    const sd = planned.find((d) => d.url === change.url) as StructureDefinition;
    const { id: _, meta: __, ...content } = sd;
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
 * Compares each planned StructureDefinition with what the project holds under
 * its URL. Push updates the one it holds rather than adding another, which
 * would shadow it: Medplum picks the "newest" by sorting versions as text.
 */
export function planLoad(
  planned: StructureDefinition[],
  held: Map<string, StructureDefinition[]>,
): PlannedDefinition[] {
  return planned.map((sd) => {
    const found = held.get(sd.url) ?? [];
    const base = { url: sd.url, ...(sd.version ? { version: sd.version } : {}) };
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

const sameContent = (a: StructureDefinition, b: StructureDefinition) => {
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
  const dependencies = changes.length - named.length;
  return `load ${named.join(', ') || 'no selected profile'}${dependencies ? ` (+${dependencies} dependencies)` : ''}`;
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
