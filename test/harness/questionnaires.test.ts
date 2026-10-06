// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CodeSystem,
  Questionnaire,
  QuestionnaireResponse,
  ValueSet,
} from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { printFiles } from '../../src/emit/print.js';
import { printQuestionnaire } from '../../src/emit/questionnaire.js';
import { writeFiles } from '../../src/emit/write.js';
import { typecheck } from './routes.js';

const BASE = 'http://example.org/fhir/plumb-test';
const REASONS: ValueSet = {
  resourceType: 'ValueSet',
  url: `${BASE}/ValueSet/visit-reason`,
  status: 'active',
  compose: { include: [{ system: `${BASE}/CodeSystem/visit-reason` }] },
};
const CODES: CodeSystem = {
  resourceType: 'CodeSystem',
  url: `${BASE}/CodeSystem/visit-reason`,
  status: 'active',
  content: 'complete',
  concept: [{ code: 'new' }, { code: 'follow-up' }, { code: 'urgent' }],
};
// Synthetic: a group, a repeating item, choices by option and by value set, an open choice.
const INTAKE: Questionnaire = {
  resourceType: 'Questionnaire',
  url: `${BASE}/Questionnaire/intake`,
  version: '1.0.0',
  name: 'Intake',
  status: 'active',
  item: [
    { linkId: 'reason', text: 'Reason for visit', type: 'choice', answerValueSet: REASONS.url },
    {
      linkId: 'vitals',
      type: 'group',
      item: [
        { linkId: 'weight-kg', type: 'decimal' },
        { linkId: 'smoker', type: 'boolean' },
      ],
    },
    { linkId: 'allergies', type: 'string', repeats: true },
    {
      linkId: 'contact',
      type: 'choice',
      answerOption: [{ valueCoding: { code: 'phone' } }, { valueCoding: { code: 'email' } }],
    },
    { linkId: 'referrer', type: 'open-choice', answerOption: [{ valueCoding: { code: 'gp' } }] },
    { linkId: 'note', type: 'display', text: 'Thank you' },
  ],
};

const lookup = (url: string) => [REASONS, CODES].find((r) => r.url === url);
const files = printFiles([], () => 'harness', undefined, [printQuestionnaire(INTAKE, lookup)]);

const RESPONSE: QuestionnaireResponse = {
  resourceType: 'QuestionnaireResponse',
  questionnaire: `${INTAKE.url}|1.0.0`,
  status: 'completed',
  item: [
    {
      linkId: 'reason',
      answer: [{ valueCoding: { system: CODES.url, code: 'follow-up' } }],
    },
    {
      linkId: 'vitals',
      item: [
        { linkId: 'weight-kg', answer: [{ valueDecimal: 72.5 }] },
        { linkId: 'smoker', answer: [{ valueBoolean: false }] },
      ],
    },
    { linkId: 'allergies', answer: [{ valueString: 'peanuts' }, { valueString: 'latex' }] },
  ],
};

describe('typed Questionnaire answers', () => {
  test('a response reads into the typed answers, through groups, repeats as arrays', async () => {
    const out = mkdtempSync(join(tmpdir(), 'plumb-questionnaire-'));
    expect(writeFiles(out, files).ok).toBe(true);
    const generated = await import(join(out, 'IntakeAnswers.ts'));
    expect(generated.IntakeUrl).toBe(INTAKE.url);
    expect(generated.intakeAnswers(RESPONSE)).toEqual({
      reason: { system: CODES.url, code: 'follow-up' },
      'weight-kg': 72.5,
      smoker: false,
      allergies: ['peanuts', 'latex'],
    });
    expect(() =>
      generated.intakeAnswers({ ...RESPONSE, questionnaire: `${BASE}/Questionnaire/other` }),
    ).toThrow(`The response answers ${BASE}/Questionnaire/other, not ${INTAKE.url}.`);
  });

  test('tsc accepts the answers as typed, and rejects a misspelled linkId and a code outside the options', () => {
    const source = `
import type { QuestionnaireResponse } from '@medplum/fhirtypes';
import { type IntakeAnswers, type IntakeLinkId, intakeAnswers } from './generated/index.js';

declare const response: QuestionnaireResponse;
const answers = intakeAnswers(response);
const reason: 'new' | 'follow-up' | 'urgent' | undefined = answers.reason?.code;
const weight: number | undefined = answers['weight-kg'];
const allergies: string[] | undefined = answers.allergies;
const referrer: string | undefined = typeof answers.referrer === 'string' ? answers.referrer : answers.referrer?.code;
const linkIds: IntakeLinkId[] = ['reason', 'weight-kg', 'smoker', 'allergies', 'contact', 'referrer'];
// @ts-expect-error a misspelled linkId
answers['wieght-kg'];
// @ts-expect-error a group is not answerable
const group: IntakeLinkId = 'vitals';
// @ts-expect-error a code the options do not offer
const contact: IntakeAnswers = { contact: { code: 'fax' } };
export { allergies, contact, group, linkIds, reason, referrer, weight };
`;
    expect(typecheck(files, source)).toEqual([]);
  });

  test('a choice whose codes cannot be listed is any Coding', () => {
    const { file } = printQuestionnaire(INTAKE, () => undefined);
    expect(file).toContain("  readonly 'reason'?: Coding;");
    expect(file).toContain("  readonly 'contact'?: Coding & { code: 'phone' | 'email' };");
    expect(file).toContain("  readonly 'referrer'?: Coding & { code: 'gp' } | string;");
  });

  test('more codes than maxCodes is any Coding', () => {
    expect(printQuestionnaire(INTAKE, lookup, 2).file).toContain("  readonly 'reason'?: Coding;");
  });
});
