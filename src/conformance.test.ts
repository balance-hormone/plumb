// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { AsyncJob } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { runPage } from './conformance.js';

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
