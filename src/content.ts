// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { globSync, readFileSync } from 'node:fs';
import { type MedplumClient, OperationOutcomeError, validateResource } from '@medplum/core';
import type {
  CodeSystem,
  OperationOutcomeIssue,
  Organization,
  Questionnaire,
  Resource,
  ValueSet,
} from '@medplum/fhirtypes';
import type { LoadProfilesResult } from './loader.js';
import { claim, differing, PLUMB_SYSTEM, searchAll, tagOf, withPlumbTag } from './project.js';

/** The reference content `push` converges: design 09. */
type Content = Questionnaire | CodeSystem | ValueSet | Organization;

export interface ContentFile {
  file: string;
  resource: Content;
  /** A canonical resource's URL, or an Organization's file `id`. */
  key: string;
}

type ContentErrorCode = 'invalid-content' | 'duplicate-content' | 'content-refused';

export interface LoadContentResult {
  ok: boolean;
  files: ContentFile[];
  errors: { code: ContentErrorCode; message: string; file?: string }[];
}

const CANONICAL = new Set(['Questionnaire', 'CodeSystem', 'ValueSet']);
// Medplum ignores both in a project, so a file of either is named, not just refused.
const NOT_CONTENT: Record<string, string> = {
  SearchParameter:
    "Medplum builds its search index from its own definitions at start and ignores a project's SearchParameters",
  Subscription: 'Subscriptions are declared with the bots they trigger, in a later layer',
};

/**
 * Reads the files `content` names, absolute paths or globs, in order, and
 * checks each one offline: one resource of a content type, keyed by its URL
 * or `id`, that Medplum's validator accepts against base R4 and any selected
 * profile it claims. Nothing is written.
 */
export function loadContent(
  patterns: string[] = [],
  loaded: Pick<LoadProfilesResult, 'profiles'>,
): LoadContentResult {
  const result: LoadContentResult = { ok: false, files: [], errors: [] };
  const fail = (code: ContentErrorCode, message: string, file?: string) =>
    result.errors.push({ code, message, ...(file ? { file } : {}) });
  const files = [...new Set(patterns.flatMap((p) => matches(p, fail)))];
  const keys = new Map<string, string>();
  for (const file of files) {
    const read = readContent(file);
    if (typeof read === 'string') {
      fail('invalid-content', `${file}: ${read}`, file);
      continue;
    }
    const seen = keys.get(read.key);
    if (seen) {
      fail('duplicate-content', `${file} and ${seen} are both ${read.key}.`, file);
      continue;
    }
    keys.set(read.key, file);
    const issues = refusals(read.resource, loaded);
    if (issues.length > 0) {
      for (const issue of issues) {
        fail('content-refused', `${file}: ${describe(issue)}`, file);
      }
      continue;
    }
    result.files.push({ file, ...read });
  }
  result.ok = result.errors.length === 0;
  return result;
}

function matches(pattern: string, fail: (code: ContentErrorCode, message: string) => void) {
  const found = globSync(pattern).sort();
  if (found.length === 0) fail('invalid-content', `${pattern} matches no file.`);
  return found;
}

function readContent(file: string): Omit<ContentFile, 'file'> | string {
  let resource: { resourceType?: unknown; url?: unknown; id?: unknown };
  try {
    resource = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return `not JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
  const type = String(resource?.resourceType);
  if (type in NOT_CONTENT) return `a ${type} is not content: ${NOT_CONTENT[type]}.`;
  if (!CANONICAL.has(type) && type !== 'Organization') {
    return `a ${type} is not content; content is a Questionnaire, CodeSystem, ValueSet or Organization.`;
  }
  const key = CANONICAL.has(type) ? resource.url : resource.id;
  if (typeof key !== 'string' || key === '') {
    return CANONICAL.has(type)
      ? `a ${type} needs its canonical url.`
      : 'an Organization needs an id, its key.';
  }
  return { resource: resource as Content, key };
}

/** The validator's errors, against base R4 and each selected profile the resource claims. */
function refusals(resource: Content, loaded: Pick<LoadProfilesResult, 'profiles'>) {
  const profiles = (resource.meta?.profile ?? []).flatMap((url) => {
    const profile = loaded.profiles.find((p) => p.url === url);
    return profile ? [profile.sd] : [];
  });
  return [undefined, ...profiles].flatMap((profile) => {
    try {
      validateResource(resource, profile ? { profile } : {});
      return [];
    } catch (err) {
      // validateResource throws with every issue when any is an error.
      if (!(err instanceof OperationOutcomeError)) throw err;
      return (err.outcome.issue ?? []).filter(
        (i) => i.severity === 'error' || i.severity === 'fatal',
      );
    }
  });
}

const describe = (issue: OperationOutcomeIssue) =>
  `${issue.expression?.[0] ?? issue.location?.[0] ?? ''}${issue.expression || issue.location ? ': ' : ''}${issue.details?.text ?? issue.diagnostics ?? issue.code}`;

const ORDER = ['CodeSystem', 'ValueSet', 'Questionnaire', 'Organization'] as const;

/** One write the content step plans: `+` create, `~` update, `-` retire. */
export type ContentChange =
  | { kind: '+'; type: Content['resourceType']; key: string; resource: Content }
  | {
      kind: '~';
      type: Content['resourceType'];
      key: string;
      id: string;
      /** The top-level fields that differ from the file. */
      fields: string[];
      /** An untagged resource, tagged and taken over with `--adopt`. */
      adopt?: true;
      /** Changed under the version the project already holds. */
      edited?: true;
      resource: Content;
    }
  | {
      kind: '-';
      type: Content['resourceType'];
      key: string;
      id: string;
      /** Listed but not retired, without `--prune`. */
      kept?: true;
    };

export interface ContentPlan {
  changes: ContentChange[];
  /** Why nothing in the content step can be applied. */
  blocked: string[];
}

/**
 * Plans the content against what the target project holds: each file's
 * resource found by Plumb's tag, with its URL or key as code, in dependency
 * order. Only the project's own resources are read, as `planProject` does.
 */
export async function planContent(
  medplum: MedplumClient,
  files: ContentFile[],
  options: { adopt?: boolean; prune?: boolean } = {},
): Promise<ContentPlan> {
  const plan: ContentPlan = { changes: [], blocked: [] };
  const retired: ContentChange[] = [];
  for (const type of ORDER) {
    const typed = await planType(medplum, type, files, options);
    plan.changes.push(...typed.changes);
    plan.blocked.push(...typed.blocked);
    retired.push(...typed.retired);
  }
  plan.changes.push(...retired);
  return plan;
}

/** One type's changes, and its tagged content whose file is gone. */
async function planType(
  medplum: MedplumClient,
  type: (typeof ORDER)[number],
  files: ContentFile[],
  options: { adopt?: boolean; prune?: boolean },
) {
  const project = medplum.getProject()?.id;
  const ours = (r: Resource) => r.meta?.project === project;
  const tagged = (await searchAll(medplum, type, { _tag: `${PLUMB_SYSTEM}|` })).filter(
    ours,
  ) as Content[];
  const byKey = Map.groupBy(tagged, (r) => tagOf(r) as string);
  const mine = files.filter((f) => f.resource.resourceType === type);
  const changes: ContentChange[] = [];
  const blocked: string[] = [];
  for (const file of mine) {
    const untagged = (await untaggedMatches(medplum, file)).filter(ours);
    const claimed = claim(type, file.key, file.key, byKey.get(file.key) ?? [], untagged, options);
    if (typeof claimed === 'string') blocked.push(claimed);
    else {
      const change = planOne(file, claimed);
      if (change) changes.push(change);
    }
  }
  const keys = new Set(mine.map((f) => f.key));
  const gone = [...byKey].filter(([key]) => !keys.has(key));
  return { changes, blocked, retired: retirements(type, gone, options.prune) };
}

/** Tagged content whose file is gone: listed, and retired only with --prune. */
function retirements(
  type: Content['resourceType'],
  gone: [string, Content[]][],
  prune?: boolean,
): ContentChange[] {
  const kept = prune ? {} : { kept: true as const };
  return gone.flatMap(([key, found]) =>
    found
      .filter((r) => !isRetired(r))
      .map((r) => ({ kind: '-' as const, type, key, id: r.id as string, ...kept })),
  );
}

/** Untagged resources an `--adopt` could take over: a canonical's URL, an Organization's name. */
async function untaggedMatches(medplum: MedplumClient, file: ContentFile): Promise<Content[]> {
  const { resource } = file;
  const query =
    resource.resourceType === 'Organization'
      ? { 'name:exact': resource.name ?? file.key }
      : { url: file.key };
  const found = (await medplum.searchResources(resource.resourceType, {
    ...query,
    _count: '100',
  })) as Content[];
  return found.filter((r) => tagOf(r) === undefined);
}

/** One file's change, or nothing when the project holds it as written. */
function planOne(
  file: ContentFile,
  { current, adopt }: { current?: Content; adopt?: true },
): ContentChange | undefined {
  const type = file.resource.resourceType;
  const desired = withTag(file, current);
  if (!current) return { kind: '+', type, key: file.key, resource: desired };
  const fields = differing(desired, current);
  if (fields.length === 0 && !adopt) return undefined;
  const version = 'version' in desired ? desired.version : undefined;
  const edited =
    type !== 'Organization' &&
    fields.length > 0 &&
    version === (current as { version?: string }).version;
  return {
    kind: '~',
    type,
    key: file.key,
    id: current.id as string,
    fields,
    ...(adopt ? { adopt } : {}),
    ...(edited ? { edited: true as const } : {}),
    resource: desired,
  };
}

/** The file as written, less its id (an Organization's key, never its server id), tagged. */
function withTag(file: ContentFile, current?: Content): Content {
  const { id: _, ...content } = file.resource;
  return withPlumbTag(content as Content, file.key, current);
}

const isRetired = (r: Content) =>
  r.resourceType === 'Organization' ? r.active === false : r.status === 'retired';

/**
 * Writes the plan in order. Removal retires: a canonical resource becomes
 * `retired` and an Organization inactive, so what points at it still resolves.
 */
export async function applyContent(plan: ContentPlan, medplum: MedplumClient): Promise<number> {
  let written = 0;
  for (const change of plan.changes) {
    if (change.kind === '-' && change.kept) continue;
    if (change.kind === '+') await medplum.createResource(change.resource);
    else if (change.kind === '~') await medplum.updateResource(change.resource);
    else {
      const current = (await medplum.readResource(change.type, change.id)) as Content;
      await medplum.updateResource(
        current.resourceType === 'Organization'
          ? { ...current, active: false }
          : { ...current, status: 'retired' },
      );
    }
    written++;
  }
  return written;
}

/** One change as the plan prints it. */
export function describeContent(change: ContentChange): string {
  const line = `${change.kind} ${change.type.padEnd(13)} ${change.key}`;
  if (change.kind === '-')
    return change.kept ? `${line} (kept: pass --prune to retire)` : `${line} (retire)`;
  if (change.kind === '+') return line;
  const notes = [
    change.adopt && 'adopted',
    change.fields.length > 0 && change.fields.join(', '),
    change.edited && 'changed without a version bump',
  ].filter(Boolean);
  return `${line} (${notes.join('; ')})`;
}

/** The step's line: what it will write. */
export function contentSummary(plan: ContentPlan): string {
  const count = (kind: ContentChange['kind']) =>
    plan.changes.filter((c) => c.kind === kind && !('kept' in c && c.kept)).length;
  if (plan.blocked.length > 0) return 'refusing: see below';
  return `plan: ${count('+')} to create, ${count('~')} to update, ${count('-')} to retire`;
}

/**
 * Adds the content's ValueSets and CodeSystems to what is loaded, as the
 * project's own terminology, so bindings and Questionnaire choices list them.
 */
export function addContentTerminology(
  loaded: Pick<LoadProfilesResult, 'definitions'>,
  files: ContentFile[],
): void {
  for (const { resource, key } of files) {
    if (resource.resourceType === 'ValueSet' || resource.resourceType === 'CodeSystem') {
      if (!loaded.definitions.has(key))
        loaded.definitions.set(key, { resource, source: 'content' });
    }
  }
}
