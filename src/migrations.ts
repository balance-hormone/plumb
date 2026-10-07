// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { type ConfigError, checkSearch, importModules, type PlumbConfig } from './config.js';

/** A migration as `defineMigration` makes it, read from a module `migrations.modules` lists. */
export interface Migration {
  id: string;
  resourceType: string;
  search?: Record<string, string>;
  transform: (resource: never) => unknown;
  dependsOn?: string[];
  description?: string;
  /** The module it came from, for errors, and whose hash the ledger records. */
  from: string;
  /** Run again whenever that hash changes, as Plumb's restamps are, rather than reported edited. */
  repeatable?: boolean;
  /** What it runs, as migrationHash: set once it is declared. */
  hash?: string;
}

/**
 * What a migration runs, as one hash: its module and every local file it
 * imports, followed through relative imports, with line endings as LF so a
 * Windows checkout hashes as Linux does. Packages and what it imports from
 * the generated code (\`out\`) are left out: regenerating changes no migration.
 */
export function migrationHash(file: string, out?: string): string {
  const root = dirname(file);
  const seen = new Map<string, string>();
  const visit = (path: string) => {
    if (seen.has(path) || (path !== file && out && !relative(out, path).startsWith('..'))) return;
    const text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
    seen.set(path, text);
    for (const [, specifier] of text.matchAll(IMPORT)) {
      const found = localFile(resolve(dirname(path), specifier as string));
      if (found) visit(found);
    }
  };
  visit(file);
  const sha = createHash('sha256');
  const files = [...seen].map(([path, text]): [string, string] => [
    relative(root, path).split(sep).join('/'),
    text,
  ]);
  for (const [path, text] of files.sort(([a], [b]) => (a < b ? -1 : 1))) {
    sha.update(`${path}\0${text.length}\0${text}`);
  }
  return sha.digest('hex');
}

// A relative specifier in an import, an export from, or a dynamic import.
const IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

/** The file a relative specifier names, as TypeScript resolves a .js to its .ts. */
function localFile(path: string): string | undefined {
  const stem = path.replace(/\.(m|c)?js$/, '');
  return [
    path,
    `${stem}.ts`,
    `${stem}.mts`,
    `${stem}.cts`,
    `${stem}.tsx`,
    join(path, 'index.ts'),
  ].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

// The date keeps ids from two branches apart and sorts them as written.
const ID = /^\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isMigration = (value: unknown): value is Omit<Migration, 'from'> => {
  const v = value as Partial<Migration> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.id === 'string' &&
    typeof v.resourceType === 'string' &&
    typeof v.transform === 'function'
  );
};

/**
 * Imports each module `migrations.modules` names, as the config is imported:
 * each must default-export a migration made by `defineMigration`.
 */
export async function loadMigrations(
  paths: string[],
): Promise<{ ok: true; migrations: Migration[] } | { ok: false; errors: ConfigError[] }> {
  const imported = await importModules(paths, 'migrations.modules', 'invalid-migration');
  if (!imported.ok) return imported;
  const migrations: Migration[] = [];
  const errors: ConfigError[] = [];
  for (const { file, module } of imported.modules) {
    if (isMigration(module.default)) migrations.push({ ...module.default, from: file });
    else {
      errors.push({
        code: 'invalid-migration',
        path: 'migrations.modules',
        message: `${file} does not default-export a migration made by defineMigration.`,
      });
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, migrations };
}

/**
 * The migrations against each other and Medplum's search: an id used twice
 * or not starting with a date, a `dependsOn` naming no migration or making a
 * cycle, an unknown resource type, or a search the runner cannot run.
 */
export function checkMigrations(migrations: Migration[]): ConfigError[] {
  const byId = new Map<string, Migration>();
  const reused: [Migration, string][] = [];
  for (const migration of migrations) {
    const other = byId.get(migration.id);
    if (other) reused.push([migration, `has the id ${other.from} has too`]);
    else byId.set(migration.id, migration);
  }
  return [
    ...reused,
    ...migrations.flatMap((m) => problems(m, byId).map((p): [Migration, string] => [m, p])),
  ].map(([migration, message]) => ({
    code: 'invalid-migration',
    path: 'migrations.modules',
    message: `${migration.from} (${migration.id}) ${message}.`,
  }));
}

/** What is wrong with one migration, given every migration by id. */
function problems(migration: Migration, byId: Map<string, Migration>): string[] {
  const found: string[] = [];
  if (!ID.test(migration.id)) {
    found.push('needs an id of a date and a name, as 20261006-patient-birthdate');
  }
  const search = checkSearch(migration.resourceType, migration.search ?? {});
  if (search) found.push(search);
  for (const id of migration.dependsOn ?? []) {
    if (!byId.has(id)) found.push(`depends on ${id}, which no module declares`);
  }
  if (byId.get(migration.id) === migration && inCycle(migration, byId)) {
    found.push('depends on itself through dependsOn');
  }
  return found;
}

/** Whether following `dependsOn` from a migration comes back to it. */
function inCycle(start: Migration, byId: Map<string, Migration>): boolean {
  const seen = new Set<string>();
  const pending = [...(start.dependsOn ?? [])];
  while (pending.length > 0) {
    const id = pending.pop() as string;
    if (id === start.id) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(byId.get(id)?.dependsOn ?? []));
  }
  return false;
}

export type NewMigrationResult = { ok: true; file: string } | { ok: false; errors: ConfigError[] };

/**
 * Scaffolds `<date>-<name>.ts` in the folder of the first `migrations.modules`
 * pattern, importing `defineMigration` from the generated code.
 */
export function newMigration(
  config: PlumbConfig,
  name: string,
  now: Date = new Date(),
): NewMigrationResult {
  const fail = (message: string): NewMigrationResult => ({
    ok: false,
    errors: [{ code: 'invalid-migration', path: 'migrations.modules', message }],
  });
  const [pattern] = config.migrations?.modules ?? [];
  if (!pattern) return fail('The config has no "migrations.modules" to add a migration to.');
  if (!NAME.test(name)) {
    return fail(`"${name}" is not a migration name: lowercase words joined by hyphens.`);
  }
  const id = `${now.toISOString().slice(0, 10).replaceAll('-', '')}-${name}`;
  const folder = literalFolder(pattern);
  const file = join(folder, `${id}.ts`);
  if (existsSync(file)) return fail(`${file} already exists.`);
  let index = relative(folder, join(config.out, 'index.js')).split(sep).join('/');
  if (!index.startsWith('.')) index = `./${index}`;
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    file,
    `import { defineMigration } from '${index}';

export default defineMigration({
  id: '${id}',
  resourceType: 'Patient',
  transform(resource) {
    return undefined;
  },
});
`,
  );
  return { ok: true, file };
}

/** The folder a pattern names before its first glob character. */
function literalFolder(pattern: string): string {
  const glob = pattern.search(/[*?[{]/);
  return glob === -1 ? dirname(pattern) : dirname(`${pattern.slice(0, glob)}x`);
}
