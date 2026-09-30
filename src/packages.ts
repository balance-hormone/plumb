// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readTar } from './tar.js';

// Never npm: official FHIR package names there are security placeholders.
const REGISTRY = 'https://packages.fhir.org';
// Base R4 comes from @medplum/definitions, the source of @medplum/fhirtypes.
const BASE_R4 = 'hl7.fhir.r4.core';
// Other tools regenerate these indexes in the cache, so they are not package content.
const INDEX_FILES = new Set(['.index.json', '.index.db']);
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

type PackageErrorCode =
  | 'registry-error'
  | 'download-mismatch'
  | 'invalid-package'
  | 'inexact-dependency'
  | 'not-r4'
  | 'integrity-mismatch'
  | 'lock-missing'
  | 'lock-disagrees';

interface PackageError {
  code: PackageErrorCode;
  message: string;
  /** The package, as `name@version`, when the error is about one. */
  package?: string;
}

interface CachedPackage {
  name: string;
  version: string;
  /** The package's folder in the cache; its files are under `package/`. */
  dir: string;
  /** Downloaded by this run, rather than found in the cache. */
  fetched: boolean;
}

export interface FetchPackagesResult {
  ok: boolean;
  packages: CachedPackage[];
  lockWritten: boolean;
  errors: PackageError[];
}

export interface FetchPackagesOptions {
  /** The config's IGs, as `name@version`. */
  igs: string[];
  lockPath: string;
  /** The shared FHIR package cache. */
  cacheDir?: string;
  /** Write nothing to the project, and fail unless the lock matches. */
  check?: boolean;
  fetch?: typeof globalThis.fetch;
}

interface Lock {
  lockfileVersion: 1;
  igs: string[];
  packages: Record<string, { integrity: string }>;
}

class Failure extends Error {
  readonly code: PackageErrorCode;
  constructor(code: PackageErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

type Files = [path: string, data: Buffer][];

/**
 * Makes sure every IG and its dependencies are in the shared FHIR package
 * cache, verified against `plumb.lock`, and records any new package in it.
 * A package is locked only after its content matches the registry's tarball.
 */
export async function fetchPackages(options: FetchPackagesOptions): Promise<FetchPackagesResult> {
  const { lockPath, check = false, fetch = globalThis.fetch } = options;
  const cacheDir = options.cacheDir ?? join(homedir(), '.fhir', 'packages');
  const igs = [...options.igs].sort();
  const lock = existsSync(lockPath)
    ? (JSON.parse(readFileSync(lockPath, 'utf8')) as Lock)
    : undefined;
  const fail = (...errors: PackageError[]): FetchPackagesResult => ({
    ok: false,
    packages: [],
    lockWritten: false,
    errors,
  });

  const lockError = check ? checkLock(lock, igs, lockPath) : undefined;
  if (lockError) return fail(lockError);
  const { packages, integrities, errors } = await resolve(igs, lock, check, cacheDir, fetch);
  if (errors.length > 0) return fail(...errors);
  if (check && Object.keys(lock?.packages ?? {}).length !== Object.keys(integrities).length) {
    return fail({
      code: 'lock-disagrees',
      message: 'plumb.lock lists packages the IGs no longer need. Run plumb generate.',
    });
  }

  const text = `${JSON.stringify({ lockfileVersion: 1, igs, packages: integrities } satisfies Lock, null, 2)}\n`;
  const lockWritten = !check && (!existsSync(lockPath) || readFileSync(lockPath, 'utf8') !== text);
  if (lockWritten) writeFileSync(lockPath, text);
  return { ok: true, packages, lockWritten, errors: [] };
}

/** In check mode, the lock must exist and be for exactly the config's IGs. */
function checkLock(
  lock: Lock | undefined,
  igs: string[],
  lockPath: string,
): PackageError | undefined {
  if (!lock) {
    return { code: 'lock-missing', message: `No lockfile at ${lockPath}. Run plumb generate.` };
  }
  if (JSON.stringify(lock.igs) === JSON.stringify(igs)) return undefined;
  return {
    code: 'lock-disagrees',
    message: `plumb.lock is for ${lock.igs.join(', ') || 'no IGs'}; the config names ${igs.join(', ') || 'none'}. Run plumb generate.`,
  };
}

/**
 * Caches the IGs and the dependencies each IG declares, one level only:
 * following dependencies of dependencies reaches example packages, other
 * FHIR versions and several versions of one package. Anything a profile
 * needs beyond them is the loader's "a reference nothing provides" error.
 */
async function resolve(
  igs: string[],
  lock: Lock | undefined,
  check: boolean,
  cacheDir: string,
  fetch: typeof globalThis.fetch,
) {
  const packages: CachedPackage[] = [];
  const integrities: Lock['packages'] = {};
  const errors: PackageError[] = [];
  const queue = [...igs];
  const roots = new Set(igs);
  const seen = new Set<string>();
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const locked = lock?.packages[id]?.integrity;
      if (check && !locked) throw new Failure('lock-disagrees', `plumb.lock does not list ${id}.`);
      const { pkg, integrity } = await ensureCached(id, cacheDir, locked, fetch);
      const manifest = readManifest(id, pkg.dir);
      if (roots.has(id)) queue.push(...dependenciesOf(id, manifest));
      packages.push(pkg);
      integrities[id] = { integrity };
    } catch (err) {
      if (!(err instanceof Failure)) throw err;
      errors.push({ code: err.code, message: err.message, package: id });
    }
  }
  const sorted = Object.fromEntries(
    Object.entries(integrities).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return { packages, integrities: sorted, errors };
}

async function ensureCached(
  id: string,
  cacheDir: string,
  locked: string | undefined,
  fetch: typeof globalThis.fetch,
): Promise<{ pkg: CachedPackage; integrity: string }> {
  const at = id.lastIndexOf('@');
  const name = id.slice(0, at);
  const version = id.slice(at + 1);
  const dir = join(cacheDir, `${name}#${version}`);
  let fetched = false;
  let integrity: string;
  if (existsSync(join(dir, 'package', 'package.json'))) {
    integrity = hash(readDir(dir));
    // A copy another tool cached is trusted only once it matches the registry.
    if (!locked && hash(await download(name, version, fetch)) !== integrity) {
      throw new Failure(
        'integrity-mismatch',
        `The cached copy of ${id} in ${dir} differs from the registry's. Delete that folder and run again.`,
      );
    }
  } else {
    const files = await download(name, version, fetch);
    integrity = hash(files);
    write(files, dir, cacheDir);
    fetched = true;
  }
  if (locked && locked !== integrity) {
    throw new Failure(
      'integrity-mismatch',
      `${id} in ${dir} does not match plumb.lock. Delete that folder and run again.`,
    );
  }
  return { pkg: { name, version, dir, fetched }, integrity };
}

interface Manifest {
  fhirVersions?: string[];
  dependencies?: Record<string, string>;
}

/** Reads a cached package's manifest, which must be for FHIR R4. */
function readManifest(id: string, dir: string): Manifest {
  const manifest = JSON.parse(
    readFileSync(join(dir, 'package', 'package.json'), 'utf8'),
  ) as Manifest;
  if (manifest.fhirVersions && !manifest.fhirVersions.some((v) => v.startsWith('4.0'))) {
    throw new Failure('not-r4', `${id} is for FHIR ${manifest.fhirVersions.join(', ')}, not R4.`);
  }
  return manifest;
}

function dependenciesOf(id: string, manifest: Manifest): string[] {
  return Object.entries(manifest.dependencies ?? {})
    .filter(([name]) => name !== BASE_R4)
    .map(([name, version]) => {
      if (!EXACT_VERSION.test(version)) {
        throw new Failure(
          'inexact-dependency',
          `${id} depends on ${name}@${version}, which is not an exact version.`,
        );
      }
      return `${name}@${version}`;
    });
}

async function download(
  name: string,
  version: string,
  fetch: typeof globalThis.fetch,
): Promise<Files> {
  const id = `${name}@${version}`;
  const get = async (url: string): Promise<Response> => {
    const response = await fetch(url).catch((err: unknown) => {
      throw new Failure('registry-error', `Could not reach ${url}: ${String(err)}`);
    });
    if (!response.ok) throw new Failure('registry-error', `${url} returned ${response.status}.`);
    return response;
  };
  const manifest = (await (await get(`${REGISTRY}/${name}`)).json()) as {
    versions?: Record<string, { dist?: { tarball?: string; shasum?: string } }>;
  };
  const dist = manifest.versions?.[version]?.dist;
  if (!dist?.tarball || !dist.shasum) {
    throw new Failure('registry-error', `The registry has no ${id}.`);
  }
  const tarball = Buffer.from(await (await get(dist.tarball)).arrayBuffer());
  if (createHash('sha1').update(tarball).digest('hex') !== dist.shasum) {
    throw new Failure(
      'download-mismatch',
      `The download of ${id} does not match the registry's SHA-1.`,
    );
  }

  let files: Files;
  try {
    files = readTar(gunzipSync(tarball)).map((entry) => [entry.path, entry.data]);
  } catch (err) {
    throw new Failure('invalid-package', `${id} is not a valid package: ${String(err)}`);
  }
  // A tarball entry must stay inside package/, or extracting it could write anywhere.
  const unsafe = files.find(([path]) => {
    const parts = path.split('/');
    return (
      parts[0] !== 'package' || parts.some((p) => p === '..' || p === '') || path.includes('\\')
    );
  });
  if (unsafe) throw new Failure('invalid-package', `${id} contains the unsafe path ${unsafe[0]}.`);
  if (!files.some(([path]) => path === 'package/package.json')) {
    throw new Failure('invalid-package', `${id} has no package/package.json.`);
  }
  return files;
}

/** Extracts to a temporary folder first, so a failure never leaves half a package. */
function write(files: Files, dir: string, cacheDir: string): void {
  mkdirSync(cacheDir, { recursive: true });
  const tmp = mkdtempSync(join(cacheDir, '.plumb-'));
  try {
    for (const [path, data] of files) {
      mkdirSync(dirname(join(tmp, path)), { recursive: true });
      writeFileSync(join(tmp, path), data);
    }
    renameSync(tmp, dir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function readDir(dir: string): Files {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return [relative(dir, path).split(sep).join('/'), readFileSync(path)];
    });
}

/** SHA-256 over each file's path and bytes, in path order, leaving out cache indexes. */
function hash(files: Files): string {
  const sha = createHash('sha256');
  const content = files
    .filter(([path]) => !INDEX_FILES.has(path.slice(path.lastIndexOf('/') + 1)))
    .sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [path, data] of content) sha.update(`${path}\0${data.length}\0`).update(data);
  return `sha256-${sha.digest('base64')}`;
}
