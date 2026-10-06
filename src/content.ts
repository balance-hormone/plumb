// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { globSync, readFileSync } from 'node:fs';
import { OperationOutcomeError, validateResource } from '@medplum/core';
import type {
  CodeSystem,
  OperationOutcomeIssue,
  Organization,
  Questionnaire,
  ValueSet,
} from '@medplum/fhirtypes';
import type { LoadProfilesResult } from './loader.js';

/** The reference content `push` converges: design 09. */
type Content = Questionnaire | CodeSystem | ValueSet | Organization;

interface ContentFile {
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
