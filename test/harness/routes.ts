// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Resource } from '@medplum/fhirtypes';
import type { PlumbConfig } from '../../src/config.js';
import { printFiles } from '../../src/emit/print.js';
import { routingRows } from '../../src/emit/routes.js';
import { transform } from '../../src/emit/transform.js';
import { writeFiles } from '../../src/emit/write.js';
import { loadProfiles } from '../../src/loader.js';

const FIXTURES = join(import.meta.dirname, '../fixtures');

export interface GeneratedRoutes {
  route: (resource: Resource) => string | undefined;
  RoutingError: new (...args: never[]) => Error & { candidates: readonly string[] };
  /** A routed profile's selected parents, from the generated table. */
  parentsOf: (profile: string) => readonly string[];
  warnings: string[];
}

interface GeneratedModule {
  route: GeneratedRoutes['route'];
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
  const routing = routingRows(loaded, { routes });
  const out = mkdtempSync(join(tmpdir(), 'plumb-routes-'));
  const written = writeFiles(
    out,
    printFiles(models, () => 'harness', routing),
  );
  if (!written.ok) throw new Error(`write: ${JSON.stringify(written.errors)}`);
  const {
    route,
    RoutingError,
    routes: table,
  } = (await import(join(out, '_routes.ts'))) as GeneratedModule;
  const rows = Object.values(table).flat();
  const parentsOf = (profile: string) => rows.find((row) => row.profile === profile)?.parents ?? [];
  return { route, RoutingError, parentsOf, warnings: routing.warnings };
}
