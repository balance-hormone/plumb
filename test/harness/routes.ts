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
