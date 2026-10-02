// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Resource } from '@medplum/fhirtypes';
import type { PlumbConfig } from '../../src/config.js';
import { printFiles } from '../../src/emit/print.js';
import { routingRows } from '../../src/emit/routes.js';
import { transform } from '../../src/emit/transform.js';
import { writeFiles } from '../../src/emit/write.js';
import { loadProfiles } from '../../src/loader.js';

const ROOT = join(import.meta.dirname, '../..');
const FIXTURES = join(ROOT, 'test/fixtures');

/** What the stub and real-server tests call: the generated writes, loosely typed. */
interface Client {
  createResource<T extends Resource>(resource: T): Promise<T>;
  updateResource<T extends Resource>(resource: T): Promise<T>;
}
/** What the generated reads call: a MedplumClient, or a stub that records the calls. */
export interface Reader {
  readResource(resourceType: string, id: string): Promise<Resource>;
  readReference(reference: object): Promise<Resource>;
  searchResources(resourceType: string, query: URLSearchParams): Promise<Resource[]>;
}
type Write = <T extends Resource>(
  medplum: Client,
  resource: T,
  options?: { profile: string | false },
) => Promise<T>;

export interface GeneratedRoutes {
  route: (resource: Resource) => string | undefined;
  createProfiled: Write;
  updateProfiled: Write;
  /**
   * Type-checks `source` beside the generated files, in one tsc run with the
   * project's own @medplum/* installed, and returns its diagnostics.
   */
  typecheck: (source: string) => string[];
  RoutingError: new (...args: never[]) => Error & { candidates: readonly string[] };
  /** A routed profile's selected parents, from the generated table. */
  parentsOf: (profile: string) => readonly string[];
  /** The generated presence check: the rows of the profile's `required` the resource lacks. */
  missing: (resource: Resource, profile: string) => string[];
  isProfiled: (resource: Resource, profile: string) => boolean;
  asProfiled: (resource: Resource, profile: string) => Resource;
  pickProfiled: (resources: readonly Resource[], profile: string) => Resource[];
  readProfiled: (
    medplum: Reader,
    profile: string,
    idOrReference: string | object,
  ) => Promise<Resource>;
  searchProfiled: (medplum: Reader, profile: string, query?: unknown) => Promise<Resource[]>;
  ProfileReadError: new (
    ...args: never[]
  ) => Error & {
    profile: string;
    reason: string;
    failed: readonly { reference: string; missing: readonly string[] }[];
    passed: readonly Resource[];
  };
  warnings: string[];
}

interface GeneratedModule {
  route: GeneratedRoutes['route'];
  createProfiled: Write;
  updateProfiled: Write;
  RoutingError: GeneratedRoutes['RoutingError'];
  routes: Record<string, readonly { profile: string; parents: readonly string[] }[]>;
}

/**
 * Generates the profiles' files, as `generate` writes them, and imports the
 * generated `route`: what is tested is the code an app runs.
 */
export async function generatedRoutes(
  profiles: string[],
  routes?: PlumbConfig['routes'],
  defaultProfile?: PlumbConfig['defaultProfile'],
): Promise<GeneratedRoutes> {
  const packages = readdirSync(join(FIXTURES, 'packages')).map((folder) => {
    const [name, version] = folder.split('#') as [string, string];
    return { name, version, dir: join(FIXTURES, 'packages', folder) };
  });
  const loaded = loadProfiles({
    packages,
    igs: ['hl7.fhir.us.core@9.0.0'],
    local: join(FIXTURES, 'profiles/fsh-generated/resources'),
    profiles,
  });
  if (!loaded.ok) throw new Error(`load: ${JSON.stringify(loaded.errors)}`);
  const { models, errors } = transform(loaded);
  if (errors.length > 0) throw new Error(`transform: ${JSON.stringify(errors)}`);
  const routing = routingRows(loaded, { routes, defaultProfile });
  const files = printFiles(models, () => 'harness', routing);
  const out = mkdtempSync(join(tmpdir(), 'plumb-routes-'));
  const written = writeFiles(out, files);
  if (!written.ok) throw new Error(`write: ${JSON.stringify(written.errors)}`);
  const generated = (await import(join(out, '_routes.ts'))) as GeneratedModule;
  const reads = (await import(join(out, '_reads.ts'))) as Pick<
    GeneratedRoutes,
    | 'isProfiled'
    | 'asProfiled'
    | 'pickProfiled'
    | 'readProfiled'
    | 'searchProfiled'
    | 'ProfileReadError'
  > & { required: Record<string, readonly (readonly string[])[]> };
  const plumb = (await import(join(out, '_plumb.ts'))) as {
    missing: (resource: object, rows: readonly (readonly string[])[]) => string[];
  };
  const rows = Object.values(generated.routes).flat();
  const parentsOf = (profile: string) => rows.find((row) => row.profile === profile)?.parents ?? [];
  const { route, RoutingError, createProfiled, updateProfiled } = generated;
  return {
    route,
    RoutingError,
    createProfiled,
    updateProfiled,
    typecheck: (source) => typecheck(files, source),
    parentsOf,
    missing: (resource, profile) => plumb.missing(resource, reads.required[profile] ?? []),
    isProfiled: reads.isProfiled,
    asProfiled: reads.asProfiled,
    pickProfiled: reads.pickProfiled,
    readProfiled: reads.readProfiled,
    searchProfiled: reads.searchProfiled,
    ProfileReadError: reads.ProfileReadError,
    warnings: routing.warnings,
  };
}

function typecheck(files: Map<string, string>, source: string): string[] {
  // Inside node_modules, so the check resolves @medplum/* from the project.
  mkdirSync(join(ROOT, 'node_modules/.cache'), { recursive: true });
  const dir = mkdtempSync(join(ROOT, 'node_modules/.cache/plumb-routes-'));
  writeFiles(join(dir, 'generated'), files);
  writeFileSync(join(dir, 'check.ts'), source);
  const compilerOptions = {
    target: 'ES2024',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions, files: ['check.ts'] }),
  );
  const tsc = spawnSync(join(ROOT, 'node_modules/.bin/tsc'), ['-p', '.', '--pretty', 'false'], {
    cwd: dir,
    encoding: 'utf8',
  });
  return tsc.stdout.split('\n').filter(Boolean);
}
