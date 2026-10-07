// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import type { OperationDefinition } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import {
  type Contract,
  checkOperations,
  describeOperation,
  loadOperations,
  type OperationChange,
  operationDefinition,
  operationsSummary,
  planHeldOperations,
} from './operations.js';

const FIXTURE = join(import.meta.dirname, '../test/fixtures/operations');
const PATIENT = 'http://example.org/fhir/plumb-test/StructureDefinition/cardinality-patient';
const schema = { '~standard': { version: 1, vendor: 'test', validate: () => ({ value: {} }) } };
const contract = (fields: Partial<Contract>): Contract => ({
  code: 'send-message',
  level: 'system',
  bot: 'messenger',
  input: schema,
  output: schema,
  from: 'ops.ts#sendMessage',
  ...fields,
});

describe('loadOperations', () => {
  test("collects each module's contracts, by module and export", async () => {
    const loaded = await loadOperations([join(FIXTURE, '*.ts')]);
    expect(loaded.ok && loaded.contracts.map((c) => [c.code, c.from])).toEqual([
      ['plumb-shout', `${join(FIXTURE, 'contracts.ts')}#shout`],
      ['plumb-activate', `${join(FIXTURE, 'contracts.ts')}#activate`],
    ]);
  });

  test('invalid-operation for a path that matches nothing', async () => {
    const loaded = await loadOperations([join(FIXTURE, 'missing/*.ts')]);
    expect(!loaded.ok && loaded.errors.map((e) => e.code)).toEqual(['invalid-operation']);
  });
});

describe('checkOperations', () => {
  test('invalid-operation for a reused code, a built-in code, an unknown bot, no resource, an unselected profile, an instance input', () => {
    const errors = checkOperations(
      [
        contract({}),
        contract({ from: 'ops.ts#again' }),
        contract({ code: 'validate-code', from: 'ops.ts#builtIn' }),
        contract({ code: 'a', bot: 'nobody', from: 'ops.ts#a' }),
        contract({ code: 'b', level: 'type', from: 'ops.ts#b' }),
        contract({ code: 'c', input: 'http://example.org/fhir/other', from: 'ops.ts#c' }),
        contract({ code: 'd', input: PATIENT, from: 'ops.ts#d' }),
        contract({ code: 'e', level: 'instance', resource: 'Patient', from: 'ops.ts#e' }),
        contract({
          code: 'f',
          level: 'instance',
          resource: 'Patient',
          input: 'Observation',
          from: 'ops.ts#f',
        }),
        contract({ code: 'g', level: 'instance', resource: 'Patient', input: 'Patient' }),
        contract({ code: 'h', level: 'instance', resource: 'Patient', input: PATIENT }),
      ],
      { messenger: {} },
      [PATIENT],
    );
    expect(errors.map((e) => e.message)).toEqual([
      'ops.ts#again ($send-message) has the code ops.ts#sendMessage has too.',
      'ops.ts#builtIn ($validate-code) has the code of an operation Medplum already has, which would run instead.',
      'ops.ts#a ($a) names the bot "nobody", which is not a key in bots.',
      'ops.ts#b ($b) is a type operation without a resource.',
      'ops.ts#c ($c) names the profile http://example.org/fhir/other, which is not selected.',
      'ops.ts#e ($e) is an instance operation, so its input is the stored Patient Medplum hands the bot, not JSON.',
      'ops.ts#f ($f) is an instance operation, so its input is the stored Patient Medplum hands the bot, not Observation.',
    ]);
  });
});

describe('planHeldOperations', () => {
  const typeOf = (url: string) => (url === PATIENT ? 'Patient' : undefined);

  test('names a bot this push creates by key; a profile output is its type, with the profile', () => {
    const profiled = contract({
      level: 'type',
      resource: 'Patient',
      input: 'Patient',
      output: PATIENT,
    });
    const [change] = planHeldOperations([profiled], [], [], {}, typeOf).changes;
    expect(change).toMatchObject({
      kind: '+',
      bot: 'messenger',
      definition: { parameter: [{ name: 'return', type: 'Patient', targetProfile: [PATIENT] }] },
    });
    expect(describeOperation(change as OperationChange)).toBe(
      '+ OperationDefinition  $send-message → Bot messenger',
    );
  });

  test('updates the fields that differ, and keeps a removed one without --prune', () => {
    const held: OperationDefinition = {
      ...operationDefinition(contract({}), 'b1', typeOf),
      id: 'o1',
      system: false,
      type: true,
    };
    const removed = {
      ...held,
      id: 'o2',
      code: 'gone',
      meta: { tag: [{ ...held.meta?.tag?.[0], code: 'gone' }] },
    };
    const plan = planHeldOperations(
      [contract({})],
      [held, removed],
      [],
      { messenger: 'b1' },
      typeOf,
    );
    expect(plan.changes).toMatchObject([
      { kind: '~', id: 'o1', fields: ['system', 'type'] },
      { kind: '-', code: 'gone', kept: true },
    ]);
    expect(operationsSummary(plan)).toBe('plan: 0 to create, 1 to update, 0 to delete');
  });
});
