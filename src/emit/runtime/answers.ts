// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

// Generated files hold what follows this line.
import type { QuestionnaireResponse, QuestionnaireResponseItem } from '@medplum/fhirtypes';

/**
 * A response's answers by linkId, through groups and items nested under
 * answers, as @medplum/core's getQuestionnaireAnswers reads them: the first
 * answer's value, or every one for an item in `repeats`.
 */
export function readAnswers(
  response: QuestionnaireResponse,
  url: string,
  repeats: readonly string[],
): Record<string, unknown> {
  const answered = response.questionnaire?.split('|')[0];
  if (answered !== url) throw new Error(`The response answers ${answered ?? 'no Questionnaire'}, not ${url}.`);
  // A Map, then own properties: a linkId such as `constructor` or `__proto__` is any other key.
  const answers = new Map<string, unknown>();
  const walk = (items: QuestionnaireResponseItem[] = []): void => {
    for (const item of items) {
      for (const answer of item.answer ?? []) {
        const key = Object.keys(answer).find((k) => k.startsWith('value'));
        const value = key ? (answer as Record<string, unknown>)[key] : undefined;
        if (value !== undefined && repeats.includes(item.linkId)) {
          answers.set(item.linkId, [...((answers.get(item.linkId) as unknown[]) ?? []), value]);
        } else if (value !== undefined && !answers.has(item.linkId)) {
          answers.set(item.linkId, value);
        }
        walk(answer.item);
      }
      walk(item.item);
    }
  };
  walk(response.item);
  return Object.fromEntries(answers);
}
