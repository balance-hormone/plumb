// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bundle, Identifier, Patient, Resource } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { printFiles } from '../../src/emit/print.js';
import { writeFiles } from '../../src/emit/write.js';
import { newMigration } from '../../src/migrations.js';
import { typecheck } from './routes.js';

// Design 11's defineMigration, as `generate` writes it for a config with
// `migrations`: the types that hold a transform to its resource type.
const files = printFiles([], () => 'harness', undefined, [], [], undefined, []);
const out = mkdtempSync(join(tmpdir(), 'plumb-migrations-'));
if (!writeFiles(out, files).ok) throw new Error('write failed');

type Patch = { op: string; path: string; from?: string; value?: unknown }[];
interface Migration {
  id: string;
  resourceType: string;
  search?: Record<string, string>;
  transform(resource: Patient): Patch | undefined;
}
interface PageResult {
  read: number;
  changed: number;
  unchanged: number;
  conflict: number;
  failed: number;
  reasons: { message: string; count: number }[];
  forecast?: { stamped: number; failing: number; profiles: object };
  written: { id: string; versionId: string }[];
  next?: string;
}
const { handleMigrations } = (await import(join(out, '_migrations.ts'))) as {
  handleMigrations: (
    migrations: Migration[],
  ) => (medplum: unknown, event: { input: object }) => Promise<PageResult>;
};

test('tsc holds a transform to its resource type and to JSON Patch', () => {
  const source = `
import { defineMigration } from './generated/index.js';

export const birthdate = defineMigration({
  id: '20261006-patient-birthdate',
  resourceType: 'Patient',
  search: { 'birthdate:missing': 'true' },
  transform(patient) {
    if (patient.birthDate) return undefined;
    return [{ op: 'add', path: '/birthDate', value: '1900-01-01' }];
  },
});

export const wrongType = defineMigration({
  id: '20261006-observation',
  resourceType: 'Observation',
  // @ts-expect-error an Observation has no birthDate
  transform: (observation) => (observation.birthDate ? undefined : []),
});

export const notAPatch = defineMigration({
  id: '20261006-not-a-patch',
  resourceType: 'Patient',
  // @ts-expect-error a transform returns JSON Patch operations
  transform: () => [{ op: 'set', path: '/active', value: true }],
});
`;
  expect(typecheck(files, source)).toEqual([]);
});

test('the module plumb migrate new scaffolds compiles against the generated code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plumb-migrate-new-'));
  const created = newMigration(
    {
      igs: [],
      profiles: [],
      out: join(dir, 'generated'),
      migrations: { bot: 'migrator', modules: [join(dir, '*.ts')] },
    },
    'patient-birthdate',
  );
  if (!created.ok) throw new Error(JSON.stringify(created.errors));
  expect(typecheck(files, readFileSync(created.file, 'utf8'))).toEqual([]);
});

test('a MedplumClient is a MigrationClient, and the bot entry is one line', () => {
  const source = `
import type { MedplumClient } from '@medplum/core';
import type { MigrationClient } from './generated/index.js';
export { handler } from './generated/_migrator.js';

declare const client: MedplumClient;
export const medplum: MigrationClient = client;
`;
  expect(typecheck(files, source)).toEqual([]);
});

const CHECKER: Identifier = {
  system: 'https://www.npmjs.com/package/plumb-fhir',
  value: 'checker',
};
const patient = (id: string, fields: Partial<Patient> = {}): Patient => ({
  resourceType: 'Patient',
  id,
  meta: { versionId: `${id}-1` },
  ...fields,
});
const birthdate: Migration = {
  id: '20261006-patient-birthdate',
  resourceType: 'Patient',
  search: { 'birthdate:missing': 'true' },
  transform: (p) =>
    p.birthDate ? undefined : [{ op: 'add', path: '/birthDate', value: '1900-01-01' }],
};

/**
 * A stub client: one page of records, PATCHes answered in turn by `writes`
 * (a version, or a status to refuse with), and the checker's verdict.
 */
function client(records: Patient[], writes: (string | number)[] = [], next?: string) {
  const calls = {
    searches: [] as string[],
    writes: [] as unknown[][],
    reads: [] as string[],
    bots: [] as unknown[],
  };
  const stored = new Map(records.map((r) => [r.id as string, r]));
  const medplum = {
    search: async (_type: string, query: string): Promise<Bundle> => {
      calls.searches.push(query);
      return {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: records.map((resource) => ({ resource })),
        link: next
          ? [{ relation: 'next', url: `http://example.org/fhir/R4/Patient?_cursor=${next}` }]
          : [],
      };
    },
    readResource: async (_type: string, id: string): Promise<Resource> => {
      calls.reads.push(id);
      const p = stored.get(id) as Patient;
      return { ...p, meta: { versionId: `${id}-2` } };
    },
    updateResource: async (...args: unknown[]): Promise<Resource> => {
      calls.writes.push(args);
      const answer = writes.shift() ?? 'v2';
      if (typeof answer === 'number') {
        const id =
          answer === 412 ? 'precondition-failed' : answer === 429 ? 'too-many-requests' : 'invalid';
        const text = answer === 412 ? 'Precondition Failed' : 'Missing required property';
        throw Object.assign(new Error(text), {
          outcome: {
            resourceType: 'OperationOutcome',
            id,
            issue: [{ severity: 'error', code: 'processing', details: { text } }],
          },
        });
      }
      return { ...(args[0] as Patient), meta: { versionId: answer } };
    },
    executeBot: async (_id: Identifier, body: unknown) => {
      calls.bots.push(body);
      return { stamped: 1, failing: 0, profiles: {}, read: 1 };
    },
  };
  return { medplum, calls };
}
const START = '2026-10-06T21:00:00.000Z';
const run = (migrations: Migration[], medplum: unknown, input: object) =>
  handleMigrations(migrations)(medplum, { input: { id: birthdate.id, start: START, ...input } });

describe('handleMigrations', () => {
  test("reads the migration's search before the run started, by cursor, in Medplum's order", async () => {
    const { medplum, calls } = client([], [], 'c2');
    const result = await run([birthdate], medplum, { cursor: 'c1', count: 5000 });
    expect(calls.searches).toEqual([
      `birthdate%3Amissing=true&_lastUpdated=lt${encodeURIComponent(START)}&_sort=_lastUpdated&_count=1000&_cursor=c1`,
    ]);
    expect(result.next).toBe('c2');
  });

  test('a dry run counts each record and writes nothing', async () => {
    const { medplum, calls } = client([patient('a'), patient('b', { birthDate: '1970-01-01' })]);
    const result = await run(
      [
        {
          ...birthdate,
          transform: (p) =>
            p.id === 'b'
              ? [{ op: 'replace', path: '/birthDate', value: '1970-01-01' }]
              : birthdate.transform(p),
        },
      ],
      medplum,
      {},
    );
    expect(result).toMatchObject({
      read: 2,
      changed: 1,
      unchanged: 1,
      conflict: 0,
      failed: 0,
      written: [],
    });
    expect(calls.writes).toEqual([]);
  });

  test('a write puts the patched record against the version read and records the version written', async () => {
    const { medplum, calls } = client([patient('a')], ['a-2']);
    const result = await run([birthdate], medplum, { write: true });
    expect(calls.writes).toEqual([
      [{ ...patient('a'), birthDate: '1900-01-01' }, { headers: { 'If-Match': 'W/"a-1"' } }],
    ]);
    expect(result).toMatchObject({ changed: 1, written: [{ id: 'a', versionId: 'a-2' }] });
  });

  test('a record changed since it was read is read again; changed twice, it is a conflict', async () => {
    const once = client([patient('a')], [412, 'a-3']);
    expect(await run([birthdate], once.medplum, { write: true })).toMatchObject({
      changed: 1,
      written: [{ id: 'a', versionId: 'a-3' }],
    });
    expect(once.calls.reads).toEqual(['a']);
    expect(once.calls.writes[1]?.[1]).toEqual({ headers: { 'If-Match': 'W/"a-2"' } });
    const twice = client([patient('a')], [412, 412]);
    expect(await run([birthdate], twice.medplum, { write: true })).toMatchObject({
      changed: 0,
      conflict: 1,
      written: [],
    });
  });

  test("Medplum's refusal and a patch that does not apply fail the record, with reasons", async () => {
    const refused = client([patient('a'), patient('b')], [400, 400]);
    expect((await run([birthdate], refused.medplum, { write: true })).reasons).toEqual([
      { message: 'Missing required property', count: 2 },
    ]);
    const broken = client([patient('a')]);
    const result = await run(
      [{ ...birthdate, transform: () => [{ op: 'remove', path: '/gender' }] }],
      broken.medplum,
      { write: true },
    );
    expect(result).toMatchObject({
      failed: 1,
      reasons: [{ message: 'The patch does not apply: nothing at /gender', count: 1 }],
    });
    expect(broken.calls.writes).toEqual([]);
  });

  test('the changed records, as patched, go to the checker; none, no call', async () => {
    const forecast = { checker: CHECKER, profiles: ['http://example.org/p'], definitions: 'gz' };
    const { medplum, calls } = client([patient('a'), patient('b', { birthDate: '1970-01-01' })]);
    const result = await run([birthdate], medplum, { forecast });
    expect(calls.bots).toEqual([
      {
        resourceType: 'Patient',
        profiles: forecast.profiles,
        definitions: 'gz',
        resources: [{ ...patient('a'), birthDate: '1900-01-01' }],
      },
    ]);
    expect(result.forecast).toEqual({ stamped: 1, failing: 0, profiles: {} });
    const none = client([patient('b', { birthDate: '1970-01-01' })]);
    await run([birthdate], none.medplum, { forecast });
    expect(none.calls.bots).toEqual([]);
  });

  test("over the project's rate limit, the page stops, counting only what it wrote, to run again", async () => {
    const { medplum, calls } = client([patient('a'), patient('b'), patient('c')], ['v2', 429]);
    const result = await run([birthdate], medplum, {
      write: true,
      forecast: { checker: { system: 'x', value: 'checker' }, profiles: [], definitions: '[]' },
    });
    // The record written is counted and forecast; those not, read again with the page, are not.
    expect(result).toMatchObject({ limited: true, read: 1, changed: 1, unchanged: 0, failed: 0 });
    expect(result.written).toEqual([{ id: 'a', versionId: 'v2' }]);
    expect(result.next).toBeUndefined();
    expect(calls.writes).toHaveLength(2);
    expect(calls.bots).toHaveLength(1);
  });

  test('a page for another version of a migration than the bot was built from is refused', async () => {
    const { medplum, calls } = client([patient('a')]);
    const built = { ...birthdate, hash: 'built' } as Migration;
    await expect(run([built], medplum, { write: true, hash: 'edited' })).rejects.toThrow(
      /built from another version of 20261006-patient-birthdate/,
    );
    expect(calls.writes).toEqual([]);
    await expect(run([built], medplum, { hash: 'built' })).resolves.toMatchObject({ read: 1 });
  });

  test('a migration the bot does not have is refused', async () => {
    const { medplum } = client([]);
    await expect(
      handleMigrations([])(medplum, { input: { id: 'x', start: START } }),
    ).rejects.toThrow(/no migration x: deploy its current build/);
  });

  test.each([
    [
      [{ op: 'add', path: '/name/-', value: { family: 'B' } }],
      { name: [{ family: 'A' }, { family: 'B' }] },
    ],
    [
      [{ op: 'add', path: '/name/0', value: { family: 'B' } }],
      { name: [{ family: 'B' }, { family: 'A' }] },
    ],
    [[{ op: 'move', from: '/name/0/family', path: '/name/0/text' }], { name: [{ text: 'A' }] }],
    [
      [{ op: 'copy', from: '/name/0', path: '/name/1' }],
      { name: [{ family: 'A' }, { family: 'A' }] },
    ],
    [
      [
        { op: 'test', path: '/name/0/family', value: 'A' },
        { op: 'remove', path: '/name' },
      ],
      {},
    ],
    [
      [
        { op: 'add', path: '/extension', value: [{ url: 'http://example.org/a~/b' }] },
        { op: 'test', path: '/extension/0/url', value: 'http://example.org/a~/b' },
      ],
      { name: [{ family: 'A' }], extension: [{ url: 'http://example.org/a~/b' }] },
    ],
  ])('applies JSON Patch %j', async (patch, expected) => {
    const forecast = { checker: CHECKER, profiles: [], definitions: '' };
    const { medplum, calls } = client([patient('a', { name: [{ family: 'A' }] })]);
    await run([{ ...birthdate, transform: () => patch }], medplum, { forecast });
    const [sent] = calls.bots as { resources: Patient[] }[];
    const { resourceType, id, meta, ...rest } = (sent as { resources: Patient[] })
      .resources[0] as Patient;
    expect(rest).toEqual(expected);
  });

  test.each([
    [[{ op: 'test', path: '/name/0/family', value: 'B' }], 'test failed at /name/0/family'],
    [[{ op: 'replace', path: '/gender', value: 'other' }], 'nothing at /gender'],
    [[{ op: 'add', path: '/name/5', value: {} }], 'no index 5 at /name/5'],
    [[{ op: 'remove', path: '' }], 'cannot remove the whole record'],
    // RFC 6901: a pointer is empty or starts with '/'; 'active' would write 'ctive'.
    [[{ op: 'add', path: 'active', value: true }], 'not a JSON Pointer: active'],
    // An array's own `length` is not an element.
    [[{ op: 'test', path: '/name/length', value: 1 }], 'nothing at /name/length'],
  ])('refuses JSON Patch %j', async (patch, reason) => {
    const { medplum } = client([patient('a', { name: [{ family: 'A' }] })]);
    const result = await run([{ ...birthdate, transform: () => patch }], medplum, {});
    expect(result.reasons).toEqual([{ message: `The patch does not apply: ${reason}`, count: 1 }]);
  });
});
