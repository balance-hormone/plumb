// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';
import { readJson } from '@medplum/definitions';
import type { Bundle, Resource, ResourceType } from '@medplum/fhirtypes';
import { build } from 'esbuild';
import { beforeAll, describe, expect, test } from 'vitest';
import { CHECKER_BUILD } from '../../src/checker/bundle.js';
import type { CheckerInput, PageResult } from '../../src/checker/handler.js';
import { checkerInput } from '../../src/checker/input.js';
import { loadConfig } from '../../src/config.js';
import { loadProfiles } from '../../src/loader.js';
import { lockedPackages } from '../../src/packages.js';
import { validateProfiled } from '../../src/validate.js';
import { contractTables, harnessProject, usCoreCases } from './fixtures.js';

const project = harnessProject();
const BASE = ((readJson('fhir/r4/profiles-resources.json') as Bundle).entry ?? []).flatMap((e) =>
  e.resource?.resourceType === 'StructureDefinition' ? [e.resource] : [],
);
const PATIENT = 'http://example.org/fhir/plumb-test/StructureDefinition/cardinality-patient';
let code: string;
let loaded: Parameters<typeof checkerInput>[0];

beforeAll(async () => {
  const out = await build({ ...CHECKER_BUILD, write: false });
  code = out.outputFiles[0]?.text ?? '';
  const config = await loadConfig({ cwd: project.cwd });
  if (!config.ok) throw new Error('harness config');
  const { igs, local, profiles } = config.config;
  const packages = lockedPackages(join(project.cwd, 'plumb.lock'), project.cacheDir);
  loaded = loadProfiles({ packages, igs, local, profiles });
});

/**
 * Runs the bot as Medplum's vmcontext runtime does: the code evaluated afresh in
 * a new context with only the globals the server provides, so the validator
 * knows only what the input carries. Each page is served by a stub client.
 */
async function run(input: CheckerInput, pages: Resource[][]) {
  const searches: Record<string, string>[] = [];
  const medplum = {
    // The server's base R4, which the bot reads for nested resource types.
    searchOne: async (_type: string, { url }: { url: string }) => BASE.find((sd) => sd.url === url),
    // Filters on _profile as Medplum does: exact stamps, any of a list.
    search: async (resourceType: string, params: Record<string, string>): Promise<Bundle> => {
      searches.push(params);
      const any = params._profile?.split(',');
      const matches = (r: Resource) =>
        (!any || (r.meta?.profile ?? []).some((url) => any.includes(url))) &&
        (params['_profile:missing'] !== 'true' || !r.meta?.profile?.length);
      if (params._summary === 'count') {
        return {
          resourceType: 'Bundle',
          type: 'searchset',
          total: pages.flat().filter(matches).length,
        };
      }
      const i = Number(params._cursor ?? 0);
      const next =
        i + 1 < pages.length ? `http://example.org/fhir/R4/${resourceType}?_cursor=${i + 1}` : '';
      return {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: (pages[i] ?? []).filter(matches).map((resource) => ({ resource })),
        link: next ? [{ relation: 'next', url: next }] : [],
      };
    },
  };
  const sandbox = {
    console,
    fetch,
    require: createRequire(import.meta.url),
    process,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    medplum,
    event: { input },
  };
  const wrapped = `const exports = {}; const module = { exports };\n${code}\nexports.handler(medplum, event);`;
  const result = (await vm.runInNewContext(wrapped, sandbox)) as PageResult;
  return { result, searches };
}

const inputs = new Map<ResourceType, CheckerInput>();
function input(resourceType: ResourceType, cursor?: string, full?: boolean): CheckerInput {
  if (!inputs.has(resourceType)) inputs.set(resourceType, checkerInput(loaded, resourceType));
  return {
    ...(inputs.get(resourceType) as CheckerInput),
    ...(cursor ? { cursor } : {}),
    ...(full ? { full } : {}),
  };
}
const stamped = (resource: Resource, id: string, profile: string[] | undefined): Resource =>
  ({ ...resource, id, meta: { ...resource.meta, profile } }) as Resource;

describe('matches validateProfiled on the contract fixtures', () => {
  test.each(contractTables)('$file', async (table) => {
    const page = table.fixtures.map((f, i) => stamped(f.resource, `f${i}`, [table.profile]));
    const expected: string[] = [];
    for (const resource of page) {
      if (!(await validateProfiled(resource, table.profile, project)).ok) {
        expected.push(resource.id as string);
      }
    }
    const { result } = await run(input(page[0]?.resourceType as ResourceType), [page]);
    expect(result.profiles[table.profile]?.checked).toBe(page.length);
    expect(result.profiles[table.profile]?.failing).toEqual(expected);
  });
});

describe('matches validateProfiled on the US Core examples', () => {
  const byProfile = Map.groupBy(
    usCoreCases.filter((c) => c.profile && !c.unparseable),
    (c) => c.profile as string,
  );
  test.each([...byProfile])('%s', async (profile, cases) => {
    const page = cases.map((c, i) => stamped(c.resource, `e${i}`, [profile]));
    const expected: string[] = [];
    for (const resource of page) {
      if (!(await validateProfiled(resource, profile, project)).ok) {
        expected.push(resource.id as string);
      }
    }
    const { result } = await run(input(page[0]?.resourceType as ResourceType), [page]);
    expect(result.profiles[profile]?.failing).toEqual(expected);
  });
});

describe('a page', () => {
  const valid = { resourceType: 'Patient', birthDate: '1970-01-01', name: [{ family: 'T' }] };

  const mixed = [
    stamped(valid as Resource, 'a', undefined),
    stamped(valid as Resource, 'b', []),
    stamped(valid as Resource, 'c', [`${PATIENT}|1.0.0`]),
    stamped(valid as Resource, 'd', ['http://example.org/fhir/StructureDefinition/other']),
    stamped(valid as Resource, 'e', [PATIENT]),
  ];

  test('reads only resources with a selected stamp, counting the rest by query', async () => {
    const { result, searches } = await run(input('Patient'), [mixed]);
    const selected = input('Patient').profiles.join(',');
    expect(searches).toContainEqual({ _profile: selected, _count: '100', _sort: '_lastUpdated' });
    expect(result).toMatchObject({
      read: 1,
      stamped: 1,
      unstamped: 0,
      totals: { readable: 5, unstamped: 2, stamped: 1 },
      profiles: { [PATIENT]: { checked: 1, failing: [] } },
    });
    // Counted once, on a run's first page.
    const later = await run(input('Patient', '1'), [[], mixed]);
    expect(later.result.totals).toBeUndefined();
  });

  test('full reads every resource, counting unstamped resources and silent and other stamps', async () => {
    const page = mixed;
    const { result } = await run(input('Patient', undefined, true), [page]);
    expect(result.totals).toBeUndefined();
    expect(result).toMatchObject({
      read: 5,
      stamped: 1,
      failing: 0,
      unstamped: 1,
      silent: { versioned: 1, empty: 1 },
      otherStamps: { 'http://example.org/fhir/StructureDefinition/other': 1 },
      profiles: { [PATIENT]: { checked: 1, failing: [], reasons: [] } },
    });
    expect(result.core).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('counts each record once, however many selected profiles it is checked against', async () => {
    const naming = PATIENT.replace('cardinality-patient', 'naming-patient-a');
    const missing = { resourceType: 'Patient', name: [{ family: 'T' }] };
    const page = [
      stamped(valid as Resource, 'a', [PATIENT, naming]),
      stamped(missing as Resource, 'b', [PATIENT, naming]),
      stamped(valid as Resource, 'c', [PATIENT]),
    ];
    const { result } = await run(input('Patient'), [page]);
    expect(result.profiles[PATIENT]?.checked).toBe(3);
    expect(result.profiles[naming]?.checked).toBe(2);
    const failing = new Set(Object.values(result.profiles).flatMap((p) => p.failing));
    expect(result).toMatchObject({ stamped: 3, failing: failing.size });
  });

  test('groups failure reasons by path and message, without array indexes', async () => {
    const missing = { resourceType: 'Patient', name: [{ family: 'T' }] };
    const page = ['a', 'b', 'c'].map((id) => stamped(missing as Resource, id, [PATIENT]));
    const { result } = await run(input('Patient'), [page]);
    expect(result.profiles[PATIENT]?.failing).toEqual(['a', 'b', 'c']);
    expect(result.profiles[PATIENT]?.reasons).toEqual([
      { path: 'Patient.birthDate', message: expect.any(String), count: 3 },
    ]);
  });

  test('pages by the server cursor, returning the next one until the last page', async () => {
    const pages = [[stamped(valid as Resource, 'a', [PATIENT])], []];
    const first = await run(input('Patient', undefined, true), pages);
    expect(first.searches[0]).toEqual({ _count: '100', _sort: '_lastUpdated' });
    expect(first.result.next).toBe('1');
    const last = await run(input('Patient', '1'), pages);
    expect(last.searches[0]).toMatchObject({ _cursor: '1' });
    expect(last.result.next).toBeUndefined();
  });
});
