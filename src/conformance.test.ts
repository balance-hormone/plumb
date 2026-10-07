// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { AsyncJob, StructureDefinition } from '@medplum/fhirtypes';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CheckerInput } from './checker/handler.js';
import { checkStored, runPage } from './conformance.js';

const page = { core: '5.1.42', next: undefined, results: [] };
const done: AsyncJob = {
  resourceType: 'AsyncJob',
  status: 'completed',
  request: 'x',
  requestTime: '2026-01-01T00:00:00Z',
  output: {
    resourceType: 'Parameters',
    parameter: [{ name: 'responseBody', valueString: JSON.stringify(page) }],
  },
};
// What Medplum's awslambda runtime returns while AWS readies a function.
const notReady = (text: string): AsyncJob => ({
  ...done,
  output: {
    resourceType: 'Parameters',
    parameter: [
      {
        name: 'outcome',
        resource: {
          resourceType: 'OperationOutcome',
          issue: [{ severity: 'error', code: 'exception', details: { text } }],
        },
      },
    ],
  },
});
const PENDING =
  'The operation cannot be performed at this time. The function is currently in the following state: Pending';
const UPDATING =
  'The operation cannot be performed at this time. An update is in progress for resource: arn:aws:lambda:x';

function client(jobs: AsyncJob[]) {
  let calls = 0;
  const medplum = {
    fhirUrl: (...path: string[]) => path.join('/'),
    post: async () => jobs[Math.min(calls++, jobs.length - 1)],
  } as unknown as MedplumClient;
  return { medplum, calls: () => calls };
}

describe('runPage', () => {
  test.each([PENDING, UPDATING])('waits while the bot Lambda is not ready: %s', async (text) => {
    const { medplum, calls } = client([notReady(text), notReady(text), done]);
    const waits: number[] = [];
    const result = await runPage(medplum, 'bot', {} as never, async (ms) => {
      waits.push(ms);
    });
    expect(result).toEqual(page);
    expect(calls()).toBe(3);
    expect(waits).toHaveLength(2);
  });

  test('gives up after a minute of not ready, naming the state', async () => {
    const { medplum } = client([notReady(PENDING)]);
    await expect(runPage(medplum, 'bot', {} as never, async () => {})).rejects.toThrow(
      /still not ready after 60s.*state: Pending/,
    );
  });

  test("a page over the project's rate limit runs again a minute later", async () => {
    const { medplum, calls } = client([notReady('Too Many Requests'), done]);
    const waits: number[] = [];
    const result = await runPage(medplum, 'bot', {}, async (ms) => {
      waits.push(ms);
    });
    expect(result).toEqual(page);
    expect(calls()).toBe(2);
    expect(waits).toEqual([60_000]);
  });

  test('any other failure throws at once, naming the bot', async () => {
    const { medplum } = client([notReady('Bot not found')]);
    await expect(runPage(medplum, 'bot', {}, async () => {}, 'migrator')).rejects.toThrow(
      "The migrator's job ended completed: Bot not found",
    );
  });

  test('any other failure throws at once', async () => {
    const { medplum, calls } = client([notReady('Bot not found')]);
    await expect(runPage(medplum, 'bot', {} as never, async () => {})).rejects.toThrow(
      "The checker's job ended completed: Bot not found",
    );
    expect(calls()).toBe(1);
  });
});

describe('checkStored', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const PROFILE = 'http://example.org/fhir/StructureDefinition/plumb-test-patient';
  const gated = {
    profiles: [{ url: PROFILE, sd: { type: 'Patient' } as StructureDefinition }],
    definitions: new Map(),
  };
  const result = (next?: string) => ({
    core: '5.1.42',
    read: 1,
    stamped: 1,
    failing: 0,
    unstamped: 0,
    silent: { versioned: 0, empty: 0 },
    otherStamps: {},
    profiles: {},
    ...(next ? { next } : {}),
  });
  const job = (body: object): AsyncJob => ({
    ...done,
    output: {
      resourceType: 'Parameters',
      parameter: [{ name: 'responseBody', valueString: JSON.stringify(body) }],
    },
  });
  // The server's clock, by its Date header.
  const serverAt = (date: string) =>
    vi.stubGlobal('fetch', async () => new Response(null, { headers: { date } }));

  function checker(fail?: number) {
    const inputs: CheckerInput[] = [];
    const medplum = {
      getBaseUrl: () => 'http://example.org/',
      fhirUrl: (...path: string[]) => path.join('/'),
      search: async () => ({ resourceType: 'Bundle', type: 'searchset', total: 2 }),
      post: async (_url: string, input: CheckerInput) => {
        inputs.push(input);
        if (inputs.length === fail) throw new Error('interrupted');
        return job(result(input.cursor ? undefined : '1'));
      },
    } as unknown as MedplumClient;
    return { medplum, inputs };
  }

  test("reads what the server last updated before the run began, by the server's clock, resumed or not", async () => {
    const options = {
      reportPath: join(mkdtempSync(join(tmpdir(), 'plumb-check-')), 'validate.json'),
      filename: 'plumb-checker.js',
    };
    serverAt('Tue, 06 Oct 2026 21:00:00 GMT');
    const first = checker(2);
    await expect(checkStored(first.medplum, gated, 'bot', options)).rejects.toThrow('interrupted');
    expect(first.inputs.map((i) => i.before)).toEqual([
      '2026-10-06T21:00:01.000Z',
      '2026-10-06T21:00:01.000Z',
    ]);

    serverAt('Tue, 06 Oct 2026 22:00:00 GMT');
    const resumed = checker();
    await checkStored(resumed.medplum, gated, 'bot', { ...options, resume: true });
    expect(resumed.inputs.map((i) => [i.cursor, i.before])).toEqual([
      ['1', '2026-10-06T21:00:01.000Z'],
    ]);
  });
});
