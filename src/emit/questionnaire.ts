// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import type { Questionnaire, QuestionnaireItem } from '@medplum/fhirtypes';
import type { ContentFile } from '../content.js';
import type { LoadProfilesResult } from '../loader.js';
import { MARKER, quote } from './print.js';
import { expandValueSet } from './valuesets.js';

type Lookup = Parameters<typeof expandValueSet>[1];

/** An item's answer type, by `item.type`; group and display items hold none. */
const ANSWER: Record<string, string | undefined> = {
  boolean: 'boolean',
  decimal: 'number',
  integer: 'number',
  date: 'string',
  dateTime: 'string',
  time: 'string',
  string: 'string',
  text: 'string',
  url: 'string',
  attachment: 'Attachment',
  reference: 'Reference',
  quantity: 'Quantity',
};

interface Answer {
  linkId: string;
  text?: string;
  type: string;
  repeats: boolean;
}

/**
 * The file for one Questionnaire: its URL, its linkIds, each answer's type
 * and a reader for its responses. Choice codes are a literal union when the
 * answer options or the answer value set list them offline, within maxCodes.
 */
export function printQuestionnaire(
  questionnaire: Questionnaire,
  lookup: Lookup,
  maxCodes = 100,
): { name: string; file: string } {
  const name = typeName(questionnaire);
  const fn = `${name[0]?.toLowerCase()}${name.slice(1)}Answers`;
  const answers = flatten(questionnaire.item).map((item) => answer(item, lookup, maxCodes));
  const url = questionnaire.url as string;
  // Only the types an answer uses, so a project with noUnusedLocals compiles it.
  const types = ['Attachment', 'Coding', 'Quantity', 'Reference'].filter((t) =>
    answers.some((a) => a.type.includes(t)),
  );
  const fields = answers.map((a) => [
    ...(a.text ? [`  /** ${a.text.replace(/\*\//g, '*\\/')} */`] : []),
    `  readonly ${quote(a.linkId)}?: ${a.repeats ? arrayOf(a.type) : a.type};`,
  ]);
  const repeats = answers.filter((a) => a.repeats).map((a) => quote(a.linkId));
  const file = [
    `${MARKER} from Questionnaire ${url}${questionnaire.version ? `|${questionnaire.version}` : ''}. Do not edit.`,
    `import type { ${[...types, 'QuestionnaireResponse'].sort().join(', ')} } from '@medplum/fhirtypes';`,
    "import { readAnswers } from './_plumb.js';",
    '',
    `/** The canonical URL of ${questionnaire.title ?? name}. */`,
    `export const ${name}Url = ${quote(url)};`,
    '',
    '/** Each answerable item. */',
    `export type ${name}LinkId = ${answers.map((a) => quote(a.linkId)).join(' | ') || 'never'};`,
    '',
    '/**',
    ` * Each answer to ${questionnaire.title ?? name}, by linkId. Every one may be`,
    ' * missing: the server never checks a response against its Questionnaire.',
    ' */',
    `export interface ${name}Answers {`,
    ...fields.flat(),
    '}',
    '',
    `/** Reads a response to ${name}, through nested items; throws for a response to another Questionnaire. */`,
    `export function ${fn}(response: QuestionnaireResponse): ${name}Answers {`,
    `  return readAnswers(response, ${name}Url, [${repeats.join(', ')}]) as ${name}Answers;`,
    '}',
    '',
  ].join('\n');
  return { name, file };
}

const arrayOf = (type: string) => (/^\w+$/.test(type) ? `${type}[]` : `(${type})[]`);

/** Every answerable item, through groups and items nested under questions. */
function flatten(items: QuestionnaireItem[] = []): QuestionnaireItem[] {
  return items.flatMap((item) => [
    ...(item.type === 'group' || item.type === 'display' ? [] : [item]),
    ...flatten(item.item),
  ]);
}

function answer(item: QuestionnaireItem, lookup: Lookup, maxCodes: number): Answer {
  const base = { linkId: item.linkId, text: item.text, repeats: item.repeats === true };
  if (item.type !== 'choice' && item.type !== 'open-choice') {
    return { ...base, type: ANSWER[item.type] ?? 'unknown' };
  }
  const codes = choiceCodes(item, lookup);
  const coding =
    codes && codes.length > 0 && codes.length <= maxCodes
      ? `Coding & { code: ${codes.map(quote).join(' | ')} }`
      : 'Coding';
  // An open choice also takes free text.
  return { ...base, type: item.type === 'open-choice' ? `${coding} | string` : coding };
}

/** The codes a choice offers: its coded answer options, or its answer value set's codes. */
function choiceCodes(item: QuestionnaireItem, lookup: Lookup): string[] | undefined {
  if (item.answerOption?.length) {
    const codes = item.answerOption.map((o) => o.valueCoding?.code);
    return codes.every((c) => c !== undefined) ? [...new Set(codes as string[])] : undefined;
  }
  if (!item.answerValueSet) return undefined;
  const listed = expandValueSet(item.answerValueSet.split('|')[0] as string, lookup);
  return listed && [...new Set(listed.map((c) => c.code))];
}

/** The type's name: the Questionnaire's `name`, or its URL's last segment, in PascalCase. */
function typeName(questionnaire: Questionnaire): string {
  const source = questionnaire.name ?? questionnaire.url?.split('/').pop() ?? 'Questionnaire';
  const words = source.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const name = words.map((w) => `${w[0]?.toUpperCase()}${w.slice(1)}`).join('');
  return /^[A-Za-z]/.test(name) ? name : `Q${name}`;
}

/** One file per Questionnaire the content lists, with codes looked up in what is loaded. */
export function printQuestionnaires(
  files: ContentFile[],
  loaded: Pick<LoadProfilesResult, 'definitions'>,
  maxCodes?: number,
) {
  const lookup = (url: string) => loaded.definitions.get(url)?.resource;
  return files.flatMap((f) =>
    f.resource.resourceType === 'Questionnaire'
      ? [printQuestionnaire(f.resource, lookup, maxCodes)]
      : [],
  );
}
