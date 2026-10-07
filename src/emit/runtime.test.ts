// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

// The generated runtime as ordinary source; the goldens and the harness test
// it as written into a project.
import type { QuestionnaireResponse, Resource } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import type { Route } from './routes.js';
import { readAnswers } from './runtime/answers.js';
import { handleMigrations, type JsonPatchOperation } from './runtime/migrations.js';
import { matches, missing } from './runtime/plumb.js';
import { routeTo } from './runtime/route.js';

const LOINC = 'http://loinc.org';
const coded = (...codes: string[]) => ({ coding: codes.map((code) => ({ system: LOINC, code })) });

describe('matches', () => {
  test.each([
    ['a scalar it equals', 'final', 'final', true],
    ['a scalar it does not', 'final', 'amended', false],
    ['an object holding every key of the pattern, and more', { a: 1, b: 2 }, { a: 1 }, true],
    ['an object missing a key', { a: 1 }, { a: 1, b: 2 }, false],
    ['an object against a scalar', 'x', { a: 1 }, false],
    ['null against an object', null, { a: 1 }, false],
    ['an array against one pattern, met by any entry', [1, 2], 2, true],
    ['an array pattern, each entry somewhere', coded('a', 'b', 'c'), coded('c', 'a'), true],
    ['an array pattern, one entry absent', coded('a'), coded('a', 'b'), false],
    ['an array pattern against a scalar', 'a', ['a'], false],
  ])('%s', (_, value, pattern, expected) => {
    expect(matches(value, pattern)).toBe(expected);
  });
});

describe('missing', () => {
  test('a row is met by any of its alternatives', () => {
    const rows = [['status'], ['valueQuantity', 'dataAbsentReason'], ['subject']];
    expect(missing({ status: 'final', dataAbsentReason: {} }, rows)).toEqual(['subject']);
  });

  test('a nested row applies to every entry present, and to none when there is none', () => {
    const rows = [['identifier.system']];
    expect(missing({ identifier: [{ system: 's' }, { value: 'v' }] }, rows)).toEqual([
      'identifier.system',
    ]);
    expect(missing({ identifier: [{ system: 's' }] }, rows)).toEqual([]);
    expect(missing({}, rows)).toEqual([]);
  });

  test('a number names one entry, and key* reaches any depth', () => {
    expect(missing({ component: [{}] }, [['component.1']])).toEqual(['component.1']);
    expect(missing({ component: [{}, {}] }, [['component.1']])).toEqual([]);
    const nested = { item: [{ linkId: 'a', item: [{ text: 'no linkId' }] }] };
    expect(missing(nested, [['item*.linkId']])).toEqual(['item*.linkId']);
  });

  test('null is absent', () => {
    expect(missing({ status: null }, [['status']])).toEqual(['status']);
  });
});

describe('readAnswers', () => {
  const URL = 'http://example.org/fhir/Questionnaire/intake';
  const response = (item: QuestionnaireResponse['item']): QuestionnaireResponse => ({
    resourceType: 'QuestionnaireResponse',
    status: 'completed',
    questionnaire: `${URL}|1.0`,
    item,
  });

  test('reads answers through groups and items under answers: the first, or each one that repeats', () => {
    const answers = readAnswers(
      response([
        {
          linkId: 'group',
          item: [
            { linkId: 'name', answer: [{ valueString: 'A' }, { valueString: 'B' }] },
            { linkId: 'tags', answer: [{ valueString: 'x' }, { valueString: 'y' }] },
          ],
        },
        {
          linkId: 'smokes',
          answer: [
            { valueBoolean: true, item: [{ linkId: 'packs', answer: [{ valueInteger: 2 }] }] },
          ],
        },
        { linkId: 'skipped' },
      ]),
      URL,
      ['tags'],
    );
    expect(answers).toEqual({ name: 'A', tags: ['x', 'y'], smokes: true, packs: 2 });
  });

  test('a linkId such as __proto__ is an ordinary key', () => {
    const answers = readAnswers(
      response([{ linkId: '__proto__', answer: [{ valueString: 'v' }] }]),
      URL,
      [],
    );
    expect(Object.getOwnPropertyDescriptor(answers, '__proto__')?.value).toBe('v');
    expect(Object.getPrototypeOf(answers)).toBe(Object.prototype);
  });

  test('refuses a response to another Questionnaire', () => {
    expect(() => readAnswers({ ...response([]), questionnaire: undefined }, URL, [])).toThrow(
      `The response answers no Questionnaire, not ${URL}.`,
    );
  });
});

describe('routeTo, the generated route as the checker calls it', () => {
  const PROFILE = 'http://example.org/fhir/StructureDefinition';
  const row = (name: string, codes: string[], parents: string[] = []): Route => ({
    profile: `${PROFILE}/${name}`,
    parents: parents.map((p) => `${PROFILE}/${p}`),
    keys: codes.length > 0 ? [['code', codes.map((c) => coded(c))]] : [],
  });
  const rows = [
    row('parent', ['1', '2']),
    row('child', ['1'], ['parent']),
    row('sibling', ['3']),
    row('other', ['3']),
  ];
  const observation = (code: string) =>
    ({ resourceType: 'Observation', status: 'final', code: coded(code) }) as Resource;

  test('the child over its parent, when both match; the parent when only it does', () => {
    expect(routeTo(rows, observation('1'))).toEqual({ profile: `${PROFILE}/child` });
    expect(routeTo(rows, observation('2'))).toEqual({ profile: `${PROFILE}/parent` });
  });

  test('refuses none and several unrelated matches apart', () => {
    expect(routeTo(rows, observation('9'))).toEqual({ refused: 'none' });
    expect(routeTo(rows, observation('3'))).toEqual({ refused: 'ambiguous' });
    expect(routeTo([], observation('1'))).toEqual({ refused: 'none' });
  });

  test('a row with no keys matches any resource of its type', () => {
    expect(routeTo([row('any', [])], observation('9'))).toEqual({ profile: `${PROFILE}/any` });
  });
});

describe('JSON Patch, as handleMigrations applies it', () => {
  const START = {
    resourceType: 'Patient',
    id: 'p',
    meta: { versionId: '1' },
    name: [{ family: 'A' }],
  };

  /** The record as written after the patch, or the reason it failed. */
  async function patch(operations: JsonPatchOperation[], record: object = START) {
    const written: Resource[] = [];
    const run = handleMigrations([
      { id: 'm', resourceType: 'Patient', transform: () => operations },
    ]);
    const result = await run(
      {
        search: async () => ({
          resourceType: 'Bundle',
          type: 'searchset',
          entry: [{ resource: record as Resource }],
        }),
        readResource: async () => record as Resource,
        updateResource: async (resource) => {
          written.push(resource);
          return { ...resource, meta: { versionId: '2' } };
        },
        executeBot: async () => ({}),
      },
      { input: { id: 'm', start: '2026-01-01T00:00:00Z', write: true } },
    );
    return written[0] ?? result.reasons[0]?.message ?? (result.unchanged ? 'unchanged' : result);
  }

  test('add, replace, remove, move and copy, applied in order to a copy', async () => {
    const before = structuredClone(START);
    expect(
      await patch([
        { op: 'add', path: '/gender', value: 'other' },
        { op: 'add', path: '/name/-', value: { family: 'B' } },
        { op: 'add', path: '/name/0', value: { family: 'Z' } },
        { op: 'replace', path: '/name/1/family', value: 'Y' },
        { op: 'copy', from: '/gender', path: '/a~1b' },
        { op: 'move', from: '/name/2', path: '/contact' },
        { op: 'remove', path: '/gender' },
      ]),
    ).toEqual({
      resourceType: 'Patient',
      id: 'p',
      meta: { versionId: '1' },
      name: [{ family: 'Z' }, { family: 'Y' }],
      contact: { family: 'B' },
      'a/b': 'other',
    });
    expect(START).toEqual(before);
  });

  test('a patch that changes nothing, whatever the order of keys, leaves the record unchanged', async () => {
    expect(
      await patch([
        { op: 'test', path: '/name/0', value: { family: 'A' } },
        { op: 'replace', path: '/meta', value: { versionId: '1' } },
      ]),
    ).toBe('unchanged');
  });

  test.each([
    [[{ op: 'test', path: '/id', value: 'q' }], 'test failed at /id'],
    [[{ op: 'replace', path: '/gender', value: 'x' }], 'nothing at /gender'],
    [[{ op: 'remove', path: '/name/1' }], 'no index 1 at /name/1'],
    [[{ op: 'add', path: '/name/01', value: {} }], 'no index 01 at /name/01'],
    [[{ op: 'copy', from: '/name/length', path: '/n' }], 'nothing at /name/length'],
    [[{ op: 'add', path: '/id/x', value: 1 }], 'nothing to change at /id/x'],
    [[{ op: 'remove', path: '' }], 'cannot remove the whole record'],
    [[{ op: 'add', path: 'id', value: 1 }], 'not a JSON Pointer: id'],
  ] as [JsonPatchOperation[], string][])('%j fails: %s', async (operations, reason) => {
    expect(await patch(operations)).toBe(`The patch does not apply: ${reason}`);
  });
});
