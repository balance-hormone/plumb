// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Communication, OperationOutcome, Patient } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { printFiles } from '../../src/emit/print.js';
import { routingRows } from '../../src/emit/routes.js';
import { transform } from '../../src/emit/transform.js';
import { writeFiles } from '../../src/emit/write.js';
import { loadProfiles } from '../../src/loader.js';
import { typecheck } from './routes.js';

// Design 10's operation contracts, as `generate` writes them for a config that
// lists `operations`: the code a caller and a bot run, and the types that hold
// them to the contract.
const FIXTURES = join(import.meta.dirname, '../fixtures');
const PATIENT = 'http://example.org/fhir/plumb-test/StructureDefinition/cardinality-patient';

const loaded = loadProfiles({
  packages: readdirSync(join(FIXTURES, 'packages')).map((folder) => {
    const [name, version] = folder.split('#') as [string, string];
    return { name, version, dir: join(FIXTURES, 'packages', folder) };
  }),
  igs: ['hl7.fhir.us.core@9.0.0'],
  local: join(FIXTURES, 'profiles/fsh-generated/resources'),
  profiles: [PATIENT],
});
if (!loaded.ok) throw new Error(`load: ${JSON.stringify(loaded.errors)}`);
const { models } = transform(loaded);
const files = printFiles(models, () => 'harness', routingRows(loaded, {}), [], ['./ops/*.ts']);
const out = mkdtempSync(join(tmpdir(), 'plumb-operations-'));
if (!writeFiles(out, files).ok) throw new Error('write failed');

interface Generated {
  defineOperation: <C>(contract: C) => C;
  callOperation: (
    client: unknown,
    operation: unknown,
    input: unknown,
    options?: object,
  ) => Promise<unknown>;
  handleOperation: (
    operation: unknown,
    handler: (medplum: unknown, input: unknown) => unknown,
  ) => (medplum: unknown, event: { input: unknown }) => Promise<unknown>;
  OperationError: new (...args: never[]) => Error & { outcome: OperationOutcome };
}
const generated = (await import(join(out, '_operations.ts'))) as Generated;
const { callOperation, defineOperation, handleOperation, OperationError } = generated;

// A hand-written Standard Schema: what Zod, Valibot or ArkType would hand over.
const draft = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value: unknown) => {
      const text = (value as { text?: unknown } | undefined)?.text;
      return typeof text === 'string'
        ? { value: { text: text.trim() } }
        : { issues: [{ message: 'Required', path: ['text'] }] };
    },
  },
};
const sendMessage = defineOperation({
  code: 'send-message',
  level: 'type',
  resource: 'Communication',
  bot: 'messenger',
  input: draft,
  output: 'Communication',
});
const summarize = defineOperation({
  code: 'summarize',
  level: 'instance',
  resource: 'Patient',
  bot: 'summarizer',
  input: PATIENT,
  output: draft,
});

const communication: Communication = { resourceType: 'Communication', status: 'completed' };
const patient: Patient = {
  resourceType: 'Patient',
  id: 'p1',
  meta: { profile: [PATIENT] },
  identifier: [{ system: 'http://example.org/mrn', value: '1' }],
  name: [{ family: 'Synthetic' }],
  birthDate: '1990-01-01',
};

const failure = async (run: Promise<unknown>) => {
  const err = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof OperationError)) throw new Error(`expected an OperationError, got ${err}`);
  return err;
};

/** A client that records the request and answers with `response`. */
function client(response: unknown | (() => never)) {
  const sent: { url: string; body: unknown; contentType?: string }[] = [];
  return {
    sent,
    fhirUrl: (...path: string[]) => new URL(`https://api.example.org/fhir/R4/${path.join('/')}`),
    post: async (url: URL | string, body: unknown, contentType?: string) => {
      sent.push({ url: String(url), body, contentType });
      return typeof response === 'function' ? (response as () => never)() : response;
    },
  };
}

describe('handleOperation', () => {
  test('passes the checked input to the handler and returns a resource as is, for `return`', async () => {
    const handler = handleOperation(sendMessage, (_medplum, input) => {
      expect(input).toEqual({ text: 'Hi' });
      return communication;
    });
    expect(await handler({}, { input: { text: '  Hi ' } })).toBe(communication);
  });

  test('a JSON output goes back as `{ result }`, a string Medplum maps to the `result` parameter', async () => {
    const handler = handleOperation(summarize, () => ({ text: 'All well' }));
    expect(await handler({}, { input: patient })).toEqual({ result: '{"text":"All well"}' });
  });

  test('a failed check throws an OperationError naming each issue, before or after the handler', async () => {
    const handler = handleOperation(sendMessage, () => patient);
    const input = await failure(handler({}, { input: { to: 'x' } }));
    expect(input.message).toBe('$send-message: input.text: Required');
    expect(input.outcome.issue).toEqual([
      { severity: 'error', code: 'invalid', details: { text: 'input.text: Required' } },
    ]);
    const output = await failure(handler({}, { input: { text: 'Hi' } }));
    expect(output.message).toBe('$send-message: output: expected a Communication, not Patient');
  });

  test('a profile side is read with asProfiled: stamped and meeting the type', async () => {
    const handler = handleOperation(summarize, () => ({ text: 'ok' }));
    const unstamped = await failure(handler({}, { input: { ...patient, meta: undefined } }));
    expect(unstamped.message).toMatch(/^\$summarize: input: .*cardinality-patient/);
  });
});

describe('callOperation', () => {
  test('POSTs the input as JSON to its level, and reads a resource sent back as is', async () => {
    const medplum = client(communication);
    expect(await callOperation(medplum, sendMessage, { text: 'Hi' })).toEqual(communication);
    expect(medplum.sent).toEqual([
      {
        url: 'https://api.example.org/fhir/R4/Communication/$send-message',
        body: { text: 'Hi' },
        contentType: 'application/json',
      },
    ]);
  });

  test("an instance operation runs on the input's id, and a `result` string is read as JSON", async () => {
    const medplum = client({
      resourceType: 'Parameters',
      parameter: [{ name: 'result', valueString: '{"text":" All well "}' }],
    });
    expect(await callOperation(medplum, summarize, patient)).toEqual({ text: 'All well' });
    expect(medplum.sent[0]).toMatchObject({
      url: 'https://api.example.org/fhir/R4/Patient/p1/$summarize',
      contentType: 'application/fhir+json',
    });
  });

  test('refuses a bad input before sending, and a bad output after', async () => {
    const medplum = client({
      resourceType: 'Parameters',
      parameter: [{ name: 'return', resource: patient }],
    });
    expect((await failure(callOperation(medplum, sendMessage, {}))).message).toBe(
      '$send-message: input.text: Required',
    );
    expect(medplum.sent).toEqual([]);
    expect((await failure(callOperation(medplum, sendMessage, { text: 'Hi' }))).message).toBe(
      '$send-message: output: expected a Communication, not Patient',
    );
  });

  test("the server's refusal becomes an OperationError carrying its OperationOutcome", async () => {
    const outcome: OperationOutcome = {
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'invalid', details: { text: 'input.text: Required' } }],
    };
    const medplum = client(() => {
      throw Object.assign(new Error('Bad request'), { outcome });
    });
    const err = await failure(callOperation(medplum, sendMessage, { text: 'Hi' }));
    expect(err.outcome).toBe(outcome);
  });
});

describe('sides beyond a type and a plain schema object', () => {
  // ArkType's type(...) is a function carrying ~standard, not an object.
  const callable = Object.assign((value: unknown) => value, { '~standard': draft['~standard'] });
  const ark = defineOperation({
    code: 'ark',
    level: 'system',
    input: callable,
    output: callable,
  });
  const count = defineOperation({
    code: 'count',
    level: 'system',
    input: 'Parameters',
    output: 'Parameters',
  });
  const counted = {
    resourceType: 'Parameters',
    parameter: [{ name: 'count', valueInteger: 3 }],
  };

  test('a callable Standard Schema is a JSON side on both ends', async () => {
    const medplum = client({
      resourceType: 'Parameters',
      parameter: [{ name: 'result', valueString: '{"text":"done"}' }],
    });
    expect(await callOperation(medplum, ark, { text: ' Hi ' })).toEqual({ text: 'done' });
    expect(medplum.sent[0]?.contentType).toBe('application/json');
    const handler = handleOperation(ark, () => ({ text: 'done' }));
    expect(await handler({}, { input: { text: 'Hi' } })).toEqual({ result: '{"text":"done"}' });
  });

  test('a Parameters output is read as the Parameters it is', async () => {
    expect(await callOperation(client(counted), count, counted)).toEqual(counted);
    // As Medplum 5.1.0 sends it, through the return parameter.
    const wrapped = {
      resourceType: 'Parameters',
      parameter: [{ name: 'return', resource: counted }],
    };
    expect(await callOperation(client(wrapped), count, counted)).toEqual(counted);
  });

  test('an instance operation with no id is refused before anything is sent', async () => {
    const medplum = client(communication);
    const err = await failure(callOperation(medplum, summarize, { ...patient, id: undefined }));
    expect(err.message).toMatch(/id/);
    expect(medplum.sent).toEqual([]);
  });
});

test('tsc holds callers and handlers to the contract', () => {
  const source = `
import type { MedplumClient } from '@medplum/core';
import type { Communication, Patient } from '@medplum/fhirtypes';
import {
  callOperation,
  defineOperation,
  handleOperation,
  type OperationClient,
  type ProfileTypes,
  type StandardSchemaV1,
} from './generated/index.js';

declare const client: MedplumClient;
// A MedplumClient is a client, with neither the DOM lib nor @types/node.
const medplum: OperationClient = client;
declare const draft: StandardSchemaV1<{ to: string; text: string }, { to: string; text: string; sentAt: Date }>;
declare const profiled: ProfileTypes['${PATIENT}'];

const send = defineOperation({ code: 'send', level: 'type', resource: 'Communication', bot: 'm', input: draft, output: 'Communication' });
const summarize = defineOperation({ code: 'summarize', level: 'instance', resource: 'Patient', bot: 's', input: '${PATIENT}', output: 'Patient' });

export async function caller() {
  const sent: Communication = await callOperation(medplum, send, { to: 'Patient/1', text: 'Hi' });
  // @ts-expect-error the schema's input needs text
  await callOperation(medplum, send, { to: 'Patient/1' });
  const summary: Patient = await callOperation(medplum, summarize, profiled);
  // @ts-expect-error a plain Patient is not the profile's type
  await callOperation(medplum, summarize, {} as Patient);
  return [sent, summary];
}

export const ok = handleOperation(send, async (_medplum: unknown, input) => {
  const when: Date = input.sentAt;
  return { resourceType: 'Communication', status: 'completed', sent: when.toISOString() } as Communication;
});
// @ts-expect-error the handler must return a Communication
export const wrong = handleOperation(send, async () => ({ resourceType: 'Patient' }) as Patient);
`;
  expect(typecheck(files, source)).toEqual([]);
});

test('no operations listed, no _operations.ts and nothing exported for them', () => {
  const plain = printFiles(models, () => 'harness', routingRows(loaded, {}));
  expect(plain.has('_operations.ts')).toBe(false);
  expect(plain.get('index.ts')).not.toContain('_operations');
});
