// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MedplumClient } from '@medplum/core';
import type { AsyncJob, Basic, ParametersParameter } from '@medplum/fhirtypes';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { botFilename } from './bots.js';
import { checkerFilename } from './checker/install.js';
import { loadAndConnect } from './connect.js';
import {
  inOrder,
  type MigrateEnvOptions,
  migrateEnvironment,
  pendingMigrations,
} from './migrate.js';
import type { Migration } from './migrations.js';
import { PLUMB_SYSTEM } from './project.js';

// The client a run connects with, which a test points at its fake server.
vi.mock('./connect.js', async (actual) => ({
  ...(await actual<typeof import('./connect.js')>()),
  loadAndConnect: vi.fn(),
}));

const migration = (id: string, dependsOn?: string[]): Migration => ({
  id,
  resourceType: 'Patient',
  transform: () => undefined,
  from: `${id}.ts`,
  ...(dependsOn ? { dependsOn } : {}),
});

describe('inOrder', () => {
  test('runs a dependency first, and otherwise in id order', () => {
    const ordered = inOrder([
      migration('20261003-c'),
      migration('20261001-a', ['20261004-d']),
      migration('20261004-d', ['20261002-b']),
      migration('20261002-b'),
    ]);
    expect(ordered.map((m) => m.id)).toEqual([
      '20261002-b',
      '20261004-d',
      '20261001-a',
      '20261003-c',
    ]);
  });

  test('ends on a cycle, which checkMigrations reports', () => {
    const ordered = inOrder([
      migration('20261001-a', ['20261002-b']),
      migration('20261002-b', ['20261001-a']),
    ]);
    expect(ordered.map((m) => m.id).sort()).toEqual(['20261001-a', '20261002-b']);
  });
});

describe("pendingMigrations, for push's gate", () => {
  // A project holding no ledger entries: every declared migration is pending.
  const empty = {
    getProject: () => ({ resourceType: 'Project', id: 'p1' }),
    searchOne: async () => undefined,
  } as unknown as MedplumClient;
  const modules = (...sources: [string, string][]) => {
    const dir = mkdtempSync(join(tmpdir(), 'plumb-pending-'));
    for (const [name, source] of sources) writeFileSync(join(dir, name), source);
    return join(dir, '*.ts');
  };
  const module = (id: string, dependsOn: string) =>
    `export default { id: '${id}', resourceType: 'Patient', dependsOn: ['${dependsOn}'], transform: () => undefined };`;

  test('lists a restamp applied before the routing changed', async () => {
    const out = mkdtempSync(join(tmpdir(), 'plumb-pending-out-'));
    writeFileSync(
      join(out, '_restamp.ts'),
      "export const restamps = [{ id: 'plumb-restamp-Patient', resourceType: 'Patient', transform: () => undefined }];",
    );
    writeFileSync(join(out, '_routes.ts'), '// the routing now');
    const state = { status: 'applied', hash: 'the routing then', counts: {}, pages: 1 };
    const applied = {
      getProject: () => ({ resourceType: 'Project', id: 'p1' }),
      searchOne: async () => ({
        resourceType: 'Basic',
        extension: [{ url: `${PLUMB_SYSTEM}#migration`, valueString: JSON.stringify(state) }],
      }),
    } as unknown as MedplumClient;
    const config = {
      igs: [],
      profiles: [],
      out,
      migrations: { bot: 'migrator', modules: [], restamp: true },
    };
    expect((await pendingMigrations(applied, config, ['Patient'])).pending).toEqual([
      { id: 'plumb-restamp-Patient', resourceType: 'Patient' },
    ]);
  });

  test('reports a dependsOn cycle instead of overflowing the stack', async () => {
    const config = {
      igs: [],
      profiles: [],
      out: '',
      migrations: {
        bot: 'migrator',
        modules: [
          modules(
            ['a.ts', module('20261001-a', '20261002-b')],
            ['b.ts', module('20261002-b', '20261001-a')],
          ),
        ],
      },
    };
    const found = await pendingMigrations(empty, config, ['Patient']);
    expect(found.pending).toEqual([]);
    expect(found.error).toMatch(/depends on itself through dependsOn/);
  });
});

describe('migrate --write, against a fake Medplum', () => {
  const BASE = 'https://medplum.test/';
  const NOW = new Date('2026-10-07T12:00:00Z');
  const json = (body: object, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/fhir+json', ...headers },
    });
  // What Medplum answers over the project's FHIR quota: the reset is up to a minute away.
  const tooMany = () =>
    json(
      {
        resourceType: 'OperationOutcome',
        id: 'too-many-requests',
        issue: [{ severity: 'error', code: 'throttled', details: { text: 'Too Many Requests' } }],
      },
      429,
      { ratelimit: '"fhirInteractions";r=0;t=30' },
    );
  const job = (parameter: ParametersParameter): AsyncJob => ({
    resourceType: 'AsyncJob',
    status: 'completed',
    request: 'x',
    requestTime: NOW.toISOString(),
    output: { resourceType: 'Parameters', parameter: [parameter] },
  });
  const page = (result: object) =>
    job({
      name: 'responseBody',
      valueString: JSON.stringify({
        ...{ read: 20, changed: 20, unchanged: 0, conflict: 0, failed: 0, reasons: [] },
        ...result,
      }),
    });
  const failed = (text: string) =>
    job({
      name: 'outcome',
      resource: {
        resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'exception', details: { text } }],
      },
    });

  let dir: string;
  let options: MigrateEnvOptions;
  /** The ledger as last saved, and every request the fake server answered. */
  let ledger: Basic | undefined;
  let requests: string[];
  type Routes = Record<string, (url: URL, body: string) => Response>;
  const count = (request: string) => requests.filter((r) => r === request).length;

  /**
   * A project with the checker and migrator deployed, whose bot answers
   * `jobs` in turn; each request named in `limited` is over the quota the
   * first time, and `answers` replaces the server's answer to a request.
   */
  function serve(jobs: AsyncJob[], limited: string[] = [], answers: Routes = {}) {
    const refused = new Set<string>();
    const file = join(dir, 'migrator.cjs');
    writeFileSync(file, 'bot');
    const checker = {
      resourceType: 'Bot',
      executableCode: { title: checkerFilename('checker', '1.0.0') },
    };
    const migrator = {
      resourceType: 'Bot',
      id: 'm1',
      executableCode: { title: botFilename('migrator', 'bot', file) },
    };
    const bundle = (found: object[]) =>
      json({
        resourceType: 'Bundle',
        type: 'searchset',
        entry: found.map((resource) => ({ resource })),
      });
    const save = (body: string, status = 200) => {
      const versionId = String(Number(ledger?.meta?.versionId ?? 0) + 1);
      const saved = JSON.parse(body) as Basic;
      ledger = {
        ...saved,
        id: 'l1',
        meta: { ...saved.meta, versionId, lastUpdated: NOW.toISOString() },
      };
      return json(ledger, status);
    };
    const routes: Routes = {
      'GET Bot': (url) =>
        bundle([url.searchParams.get('identifier')?.endsWith('|checker') ? checker : migrator]),
      'GET Basic': () => bundle(ledger ? [ledger] : []),
      'POST Basic': (_, body) => save(body, 201),
      'PUT Basic/l1': (_, body) => save(body),
      'POST Bot/m1/$execute': () =>
        json({ resourceType: 'OperationOutcome', id: 'accepted', issue: [] }, 202, {
          'content-location': `${BASE}fhir/R4/job/j1/status`,
        }),
      'GET job/j1/status': () => json(jobs.shift() as AsyncJob),
      ...answers,
    };
    const fetch = async (href: string, init: RequestInit) => {
      const url = new URL(href);
      const key = `${init.method} ${url.pathname.replace('/fhir/R4/', '')}`;
      requests.push(key);
      if (limited.includes(key) && !refused.has(key)) {
        refused.add(key);
        return tooMany();
      }
      const route = routes[key];
      if (!route) throw new Error(`unexpected ${key}`);
      return route(url, init.body as string);
    };
    vi.mocked(loadAndConnect).mockResolvedValue({
      loaded: { profiles: [], definitions: [] } as never,
      resourceTypes: [],
      medplum: new MedplumClient({ baseUrl: BASE, fetch }),
    });
  }

  const state = () =>
    JSON.parse(ledger?.extension?.[0]?.valueString ?? '{}') as {
      status: string;
      lastError?: string;
    };

  /** The run, with MedplumClient's retry waits, which are timers, passed as they come. */
  async function run(extra: Partial<MigrateEnvOptions> = {}) {
    let done = false;
    const running = migrateEnvironment({ ...options, ...extra }).finally(() => {
      done = true;
    });
    while (!done) {
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    return running;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    dir = mkdtempSync(join(tmpdir(), 'plumb-migrate-'));
    writeFileSync(
      join(dir, '20261001-a.ts'),
      "export default { id: '20261001-a', resourceType: 'Patient', transform: () => undefined };",
    );
    ledger = undefined;
    requests = [];
    options = {
      config: {
        igs: [],
        profiles: [],
        out: dir,
        bots: { migrator: { file: join(dir, 'migrator.cjs') } },
        migrations: { bot: 'migrator', modules: [join(dir, '*.ts')] },
      },
      environment: { name: 'test', baseUrl: BASE, clientId: 'id', clientSecret: 'secret' },
      lockPath: join(dir, 'plumb.lock'),
      checker: { code: 'checker', version: '1.0.0' },
      write: true,
      now: () => NOW,
      wait: async () => {},
    };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("the CLI's own requests over the quota wait for its reset: the page's POST and poll, and the ledger's saves", async () => {
    serve([page({})], ['POST Bot/m1/$execute', 'GET job/j1/status', 'POST Basic', 'PUT Basic/l1']);
    const result = await run();
    expect(result.errors).toEqual([]);
    expect(state().status).toBe('applied');
    // The job is polled again, not run again.
    expect(count('POST Bot/m1/$execute')).toBe(2);
    expect(count('GET job/j1/status')).toBe(2);
  });

  test('a failed page is saved errored, even when that save is over the quota', async () => {
    serve([failed('Bot crashed')], ['PUT Basic/l1']);
    const result = await run();
    expect(result.errors).toEqual([expect.objectContaining({ code: 'migration-failed' })]);
    expect(state()).toMatchObject({
      status: 'errored',
      lastError: expect.stringContaining('Bot crashed'),
    });
  });

  test.each([
    ['a page stopped by the rate limit', page({ next: 'c2', limited: true })],
    ["the bot's job over the quota", failed('Too Many Requests')],
  ])('Ctrl-C during the wait after %s pauses the migration at once', async (_, first) => {
    serve([first, page({})]);
    const controller = new AbortController();
    const result = await run({ signal: controller.signal, wait: async () => controller.abort() });
    expect(result.errors).toEqual([expect.objectContaining({ code: 'migration-paused' })]);
    expect(state().status).toBe('paused');
    expect(count('POST Bot/m1/$execute')).toBe(1);
  });

  /** The ledger of another run, which took its lease `minutes` ago. */
  const another = (minutes: number): Basic => {
    const lease = new Date(NOW.getTime() - minutes * 60_000).toISOString();
    const held = { status: 'running', hash: 'h', counts: {}, pages: 1, lease, holder: 'another' };
    return {
      resourceType: 'Basic',
      id: 'l1',
      meta: { versionId: '1' },
      code: { coding: [{ system: PLUMB_SYSTEM, code: 'migration' }] },
      extension: [{ url: `${PLUMB_SYSTEM}#migration`, valueString: JSON.stringify(held) }],
    };
  };

  test('a lease twenty minutes old is still held: one page and its waits can take that long', async () => {
    serve([page({})]);
    ledger = another(20);
    const result = await run();
    expect(result.errors).toEqual([expect.objectContaining({ code: 'migration-running' })]);
    expect(count('POST Bot/m1/$execute')).toBe(0);
  });

  test("a first run whose create loses Postgres's race to another's is migration-running", async () => {
    serve([page({})], [], {
      // Postgres aborts one of two conditional creates racing for the same tag.
      'POST Basic': () => {
        ledger = another(0);
        const text = 'could not serialize access due to read/write dependencies among transactions';
        return json(
          {
            resourceType: 'OperationOutcome',
            issue: [{ severity: 'error', code: 'conflict', details: { text } }],
          },
          409,
        );
      },
    });
    const result = await run();
    expect(result.errors).toEqual([expect.objectContaining({ code: 'migration-running' })]);
    expect(count('POST Bot/m1/$execute')).toBe(0);
  });
});
