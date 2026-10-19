// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync } from 'node:fs';
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

  // Medplum completes the job with Lambda's own error as the bot's return.
  test.each([
    ['Sandbox.Timedout', 'RequestId: x Error: Task timed out after 10.00 seconds'],
    ['Runtime.OutOfMemory', 'RequestId: x Error: Runtime exited with error: signal: killed'],
  ])('a failed Lambda run throws, naming its error: %s', async (errorType, errorMessage) => {
    const failed: AsyncJob = {
      ...done,
      output: {
        resourceType: 'Parameters',
        parameter: [
          { name: 'responseBody', valueString: JSON.stringify({ errorType, errorMessage }) },
        ],
      },
    };
    const { medplum, calls } = client([failed]);
    await expect(runPage(medplum, 'bot', {}, async () => {})).rejects.toThrow(
      `The checker's run failed: ${errorType}: ${errorMessage}`,
    );
    expect(calls()).toBe(1);
  });

  test('any other failure throws at once', async () => {
    const { medplum, calls } = client([notReady('Bot not found')]);
    await expect(runPage(medplum, 'bot', {} as never, async () => {})).rejects.toThrow(
      "The checker's job ended completed: Bot not found",
    );
    expect(calls()).toBe(1);
  });
});

const PROFILE = 'http://example.org/fhir/StructureDefinition/plumb-test-patient';
const gated = {
  profiles: [{ url: PROFILE, sd: { type: 'Patient' } as StructureDefinition }],
  definitions: new Map(),
};
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

describe('checkStored', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  function checker(fail?: number, body = result) {
    const inputs: CheckerInput[] = [];
    const medplum = {
      getBaseUrl: () => 'http://example.org/',
      fhirUrl: (...path: string[]) => path.join('/'),
      search: async () => ({ resourceType: 'Bundle', type: 'searchset', total: 2 }),
      post: async (_url: string, input: CheckerInput) => {
        inputs.push(input);
        if (inputs.length === fail) throw new Error('interrupted');
        return job(body(input.cursor ? undefined : '1'));
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

  test.each([
    ['without silent', ({ silent, ...page }: ReturnType<typeof result>) => page],
    ['without counts', ({ read, ...page }: ReturnType<typeof result>) => page],
  ])('a page %s fails the run, naming the type and page', async (_, without) => {
    const options = {
      reportPath: join(mkdtempSync(join(tmpdir(), 'plumb-check-')), 'validate.json'),
      filename: 'plumb-checker.js',
    };
    serverAt('Tue, 06 Oct 2026 21:00:00 GMT');
    const { medplum } = checker(undefined, (next) => without(result(next)) as never);
    await expect(checkStored(medplum, gated, 'bot', options)).rejects.toThrow(
      /^The checker returned a malformed page for Patient \(page 1\): it has core, /,
    );
  });
});

describe('checkStored with concurrency', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Synthetic records, last updated over nine months, every seventh failing.
  const START = Date.parse('2026-01-01T00:00:00Z');
  const records = Array.from({ length: 3_000 }, (_, i) => ({
    id: `p${i}`,
    // Bunched, as an import leaves them: most in the last tenth of the span.
    at: START + Math.floor((i % 10 === 0 ? i : 2_700 + (i % 300)) * 7_000_000 + i),
    failing: i % 7 === 0,
  }));
  const reason = { path: 'Patient.birthDate', message: 'Missing required property' };

  const within = (at: number, from?: string, to?: string) =>
    (from === undefined || at >= Date.parse(from)) && (to === undefined || at < Date.parse(to));

  /** One page of `records`, as the checker reads it. */
  function pageOf(input: CheckerInput) {
    const { from, to = input.before } = input.slice ?? {};
    const matching = records.filter((r) => within(r.at, from, to));
    const start = Number(input.cursor ?? 0);
    const read = matching.slice(start, start + 100);
    const failing = read.filter((r) => r.failing).map((r) => r.id);
    const next = start + 100 < matching.length ? String(start + 100) : undefined;
    const first = !input.cursor && !from;
    return {
      core: '5.1.42',
      read: read.length,
      stamped: read.length,
      failing: failing.length,
      unstamped: 0,
      silent: { versioned: 0, empty: 0 },
      otherStamps: {},
      profiles: {
        [PROFILE]: {
          checked: read.length,
          failing,
          reasons: failing.length ? [{ ...reason, count: failing.length }] : [],
        },
      },
      ...(first
        ? { totals: { readable: records.length, unstamped: 0, stamped: records.length } }
        : {}),
      ...(next ? { next } : {}),
    };
  }

  /** Reads `records` as the checker would, `fail` deciding which requests throw. */
  function fake(fail: (input: CheckerInput, n: number) => boolean = () => false) {
    const inputs: CheckerInput[] = [];
    let inFlight = 0;
    let most = 0;
    const medplum = {
      getBaseUrl: () => 'http://example.org/',
      fhirUrl: (...path: string[]) => path.join('/'),
      search: async (_type: string, query: string[][] | Record<string, string>) => {
        const bounds = Array.isArray(query) ? query.filter(([k]) => k === '_lastUpdated') : [];
        const from = bounds.find(([, v]) => v?.startsWith('ge'))?.[1]?.slice(2);
        const to = bounds.find(([, v]) => v?.startsWith('lt'))?.[1]?.slice(2);
        const total = records.filter((r) => within(r.at, from, to)).length;
        return { resourceType: 'Bundle', type: 'searchset', total };
      },
      post: async (_url: string, input: CheckerInput) => {
        inputs.push(input);
        const n = inputs.length;
        most = Math.max(most, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, n % 3));
        inFlight--;
        if (fail(input, n)) {
          return job({ errorType: 'Sandbox.Timedout', errorMessage: 'Task timed out' });
        }
        return job(pageOf(input));
      },
    } as unknown as MedplumClient;
    return { medplum, inputs, most: () => most };
  }

  const reportPath = () => join(mkdtempSync(join(tmpdir(), 'plumb-check-')), 'validate.json');
  const options = { filename: 'plumb-checker.js' };
  const failingIds = (path: string) =>
    (JSON.parse(readFileSync(path, 'utf8')).profiles[PROFILE].failing as string[]).sort();
  const expected = records
    .filter((r) => r.failing)
    .map((r) => r.id)
    .sort();

  async function sequential() {
    const path = reportPath();
    const result = await checkStored(fake().medplum, gated, 'bot', {
      ...options,
      reportPath: path,
    });
    return { result, path };
  }

  test('pages slices at once, to the same totals as one pass', async () => {
    serverAt('Tue, 06 Oct 2026 21:00:00 GMT');
    const one = await sequential();
    expect(one.result.types.Patient).toMatchObject({ read: 3_000, stamped: 3_000, failing: 429 });

    const path = reportPath();
    const run = fake();
    const four = await checkStored(run.medplum, gated, 'bot', {
      ...options,
      reportPath: path,
      concurrency: 4,
    });
    expect(four.types).toEqual(one.result.types);
    expect(four.profiles).toEqual(one.result.profiles);
    expect(failingIds(path)).toEqual(expected);
    expect(run.most()).toBe(4);
    // Each slice reads from its own start, so more than one page had no cursor.
    expect(run.inputs.filter((i) => !i.cursor).length).toBeGreaterThan(4);
  });

  test('an interrupted concurrent run resumes without reading a page twice or skipping one', async () => {
    serverAt('Tue, 06 Oct 2026 21:00:00 GMT');
    const one = await sequential();
    const path = reportPath();
    let pages = 0;
    const first = fake();
    await expect(
      checkStored(first.medplum, gated, 'bot', {
        ...options,
        reportPath: path,
        concurrency: 4,
        onPage: () => {
          if (++pages === 7) throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.complete).toBe(false);
    expect(saved.types.Patient.slices.length).toBeGreaterThan(4);

    const resumed = fake();
    const result = await checkStored(resumed.medplum, gated, 'bot', {
      ...options,
      reportPath: path,
      resume: true,
      concurrency: 4,
    });
    // The pages in flight when it stopped were saved too, and none started after.
    expect(first.inputs).toHaveLength(saved.pages);
    expect(result.resumed).toBe(saved.pages);
    expect(result.types).toEqual(one.result.types);
    expect(result.profiles).toEqual(one.result.profiles);
    expect(failingIds(path)).toEqual(expected);
  });

  test('a failed page stops the run, naming its error, and runs again on resume', async () => {
    serverAt('Tue, 06 Oct 2026 21:00:00 GMT');
    const one = await sequential();
    const path = reportPath();
    let failed: CheckerInput | undefined;
    const first = fake((input, n) => {
      if (n !== 5) return false;
      failed = input;
      return true;
    });
    await expect(
      checkStored(first.medplum, gated, 'bot', { ...options, reportPath: path, concurrency: 4 }),
    ).rejects.toThrow("The checker's run failed: Sandbox.Timedout: Task timed out");

    const resumed = fake();
    const result = await checkStored(resumed.medplum, gated, 'bot', {
      ...options,
      reportPath: path,
      resume: true,
      concurrency: 4,
    });
    const same = (i: CheckerInput) =>
      i.cursor === failed?.cursor && i.slice?.from === failed?.slice?.from;
    expect(resumed.inputs.filter(same)).toHaveLength(1);
    expect(result.types).toEqual(one.result.types);
    expect(result.profiles).toEqual(one.result.profiles);
    expect(failingIds(path)).toEqual(expected);
  });
});
