// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { type TarFile, tgz } from '../test/tar-writer.js';
import { type FetchPackagesResult, fetchPackages } from './packages.js';

interface FakePackage {
  files: TarFile[];
  /** Overrides the SHA-1 the manifest advertises. */
  shasum?: string;
}

function manifest(
  name: string,
  version: string,
  deps: Record<string, string> = {},
  fhir = '4.0.1',
) {
  return JSON.stringify({ name, version, fhirVersions: [fhir], dependencies: deps });
}

const A = {
  files: [
    {
      path: 'package/package.json',
      data: manifest('example.fhir.a', '1.0.0', {
        'hl7.fhir.r4.core': '4.0.1',
        'example.fhir.b': '1.0.0',
        'example.fhir.g': '1.0.0',
      }),
    },
    { path: 'package/StructureDefinition-a.json', data: '{"resourceType":"StructureDefinition"}' },
  ],
};
const B = { files: [{ path: 'package/package.json', data: manifest('example.fhir.b', '1.0.0') }] };
// G's own dependency is neither followed nor checked: only an IG's direct dependencies are fetched.
const G = {
  files: [
    {
      path: 'package/package.json',
      data: manifest('example.fhir.g', '1.0.0', { 'example.fhir.e': 'current' }),
    },
  ],
};

/** A registry serving the packages, and a record of every URL fetched. */
function registry(packages: Record<string, FakePackage>) {
  const requests: string[] = [];
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    requests.push(url);
    const [, name, version] = /^https:\/\/[^/]+\/([^/]+)(?:\/([^/]+))?$/.exec(url) ?? [];
    const ids = Object.keys(packages).filter((id) => id.startsWith(`${name}@`));
    if (!version) {
      if (ids.length === 0) return new Response('not found', { status: 404 });
      const versions = Object.fromEntries(
        ids.map((id) => {
          const v = id.split('@')[1] as string;
          const pkg = packages[id] as FakePackage;
          const shasum = pkg.shasum ?? createHash('sha1').update(tgz(pkg.files)).digest('hex');
          return [v, { dist: { shasum, tarball: `https://tarballs.test/${name}/${v}` } }];
        }),
      );
      return Response.json({ name, versions });
    }
    const pkg = packages[`${name}@${version}`];
    return pkg ? new Response(tgz(pkg.files)) : new Response('not found', { status: 404 });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const offline = (async () => {
  throw new Error('offline');
}) as typeof globalThis.fetch;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'plumb-packages-'));
  const project = join(root, 'project');
  mkdirSync(project);
  return { root, project, cacheDir: join(root, 'cache'), lockPath: join(project, 'plumb.lock') };
}

/** Writes a package into the cache as another tool would: extracted, with its own index. */
function precache(cacheDir: string, id: string, files: TarFile[]) {
  const dir = join(cacheDir, id.replace('@', '#'));
  for (const file of [...files, { path: 'package/.index.json', data: '{"files":[]}' }]) {
    mkdirSync(dirname(join(dir, file.path)), { recursive: true });
    writeFileSync(join(dir, file.path), file.data);
  }
}

const codes = (result: FetchPackagesResult) => result.errors.map((e) => e.code);

describe('fetchPackages', () => {
  test('fetches an IG and its direct dependencies, skipping base R4, and writes the lock', async () => {
    const { cacheDir, lockPath } = setup();
    const reg = registry({
      'example.fhir.a@1.0.0': A,
      'example.fhir.b@1.0.0': B,
      'example.fhir.g@1.0.0': G,
    });
    const result = await fetchPackages({
      igs: ['example.fhir.a@1.0.0'],
      lockPath,
      cacheDir,
      fetch: reg.fetch,
    });

    expect(codes(result)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.lockWritten).toBe(true);
    expect(result.packages.map((p) => [p.name, p.version, p.fetched])).toEqual([
      ['example.fhir.a', '1.0.0', true],
      ['example.fhir.b', '1.0.0', true],
      ['example.fhir.g', '1.0.0', true],
    ]);
    expect(reg.requests.some((url) => url.includes('hl7.fhir.r4.core'))).toBe(false);
    expect(reg.requests.some((url) => url.includes('example.fhir.e'))).toBe(false);
    expect(
      existsSync(join(cacheDir, 'example.fhir.a#1.0.0/package/StructureDefinition-a.json')),
    ).toBe(true);
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(lock.igs).toEqual(['example.fhir.a@1.0.0']);
    expect(Object.keys(lock.packages)).toEqual([
      'example.fhir.a@1.0.0',
      'example.fhir.b@1.0.0',
      'example.fhir.g@1.0.0',
    ]);
    expect(lock.packages['example.fhir.a@1.0.0'].integrity).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
  });

  test('a cache hit with a lock needs no network and writes nothing', async () => {
    const { cacheDir, lockPath } = setup();
    const reg = registry({
      'example.fhir.a@1.0.0': A,
      'example.fhir.b@1.0.0': B,
      'example.fhir.g@1.0.0': G,
    });
    await fetchPackages({ igs: ['example.fhir.a@1.0.0'], lockPath, cacheDir, fetch: reg.fetch });
    const lock = readFileSync(lockPath, 'utf8');

    const result = await fetchPackages({
      igs: ['example.fhir.a@1.0.0'],
      lockPath,
      cacheDir,
      fetch: offline,
    });
    expect(codes(result)).toEqual([]);
    expect(result.lockWritten).toBe(false);
    expect(result.packages.every((p) => !p.fetched)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(lock);
  });

  test('verifies a copy another tool cached against the registry before locking it', async () => {
    const { cacheDir, lockPath } = setup();
    precache(cacheDir, 'example.fhir.b@1.0.0', B.files);
    const reg = registry({ 'example.fhir.b@1.0.0': B });
    const result = await fetchPackages({
      igs: ['example.fhir.b@1.0.0'],
      lockPath,
      cacheDir,
      fetch: reg.fetch,
    });
    expect(codes(result)).toEqual([]);
    expect(result.packages[0]?.fetched).toBe(false);
    expect(reg.requests).toContain('https://tarballs.test/example.fhir.b/1.0.0');
  });

  test('integrity-mismatch: a cached copy that differs from the registry is not locked', async () => {
    const { cacheDir, lockPath } = setup();
    precache(cacheDir, 'example.fhir.b@1.0.0', [
      { path: 'package/package.json', data: manifest('example.fhir.b', '1.0.0') },
      { path: 'package/extra.json', data: '{}' },
    ]);
    const reg = registry({ 'example.fhir.b@1.0.0': B });
    const result = await fetchPackages({
      igs: ['example.fhir.b@1.0.0'],
      lockPath,
      cacheDir,
      fetch: reg.fetch,
    });
    expect(codes(result)).toEqual(['integrity-mismatch']);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('integrity-mismatch: a cached package changed after it was locked', async () => {
    const { cacheDir, lockPath } = setup();
    const reg = registry({
      'example.fhir.a@1.0.0': A,
      'example.fhir.b@1.0.0': B,
      'example.fhir.g@1.0.0': G,
    });
    await fetchPackages({ igs: ['example.fhir.a@1.0.0'], lockPath, cacheDir, fetch: reg.fetch });
    writeFileSync(join(cacheDir, 'example.fhir.a#1.0.0/package/StructureDefinition-a.json'), '{}');
    const lock = readFileSync(lockPath, 'utf8');

    const result = await fetchPackages({
      igs: ['example.fhir.a@1.0.0'],
      lockPath,
      cacheDir,
      fetch: offline,
    });
    expect(codes(result)).toEqual(['integrity-mismatch']);
    expect(result.errors[0]?.package).toBe('example.fhir.a@1.0.0');
    expect(readFileSync(lockPath, 'utf8')).toBe(lock);
  });

  test('download-mismatch: a tarball whose SHA-1 differs from the registry is not cached', async () => {
    const { cacheDir, lockPath } = setup();
    const reg = registry({ 'example.fhir.b@1.0.0': { ...B, shasum: '0'.repeat(40) } });
    const result = await fetchPackages({
      igs: ['example.fhir.b@1.0.0'],
      lockPath,
      cacheDir,
      fetch: reg.fetch,
    });
    expect(codes(result)).toEqual(['download-mismatch']);
    expect(existsSync(join(cacheDir, 'example.fhir.b#1.0.0'))).toBe(false);
  });

  test('registry-error: a package the registry does not have', async () => {
    const { cacheDir, lockPath } = setup();
    const result = await fetchPackages({
      igs: ['example.fhir.missing@1.0.0'],
      lockPath,
      cacheDir,
      fetch: registry({}).fetch,
    });
    expect(codes(result)).toEqual(['registry-error']);
  });

  test('registry-error: the network fails', async () => {
    const { cacheDir, lockPath } = setup();
    const result = await fetchPackages({
      igs: ['example.fhir.b@1.0.0'],
      lockPath,
      cacheDir,
      fetch: offline,
    });
    expect(codes(result)).toEqual(['registry-error']);
  });

  test('invalid-package: a tarball with a path outside the package', async () => {
    const { root, cacheDir, lockPath } = setup();
    const evil = { files: [...B.files, { path: 'package/../../escaped.json', data: '{}' }] };
    const result = await fetchPackages({
      igs: ['example.fhir.b@1.0.0'],
      lockPath,
      cacheDir,
      fetch: registry({ 'example.fhir.b@1.0.0': evil }).fetch,
    });
    expect(codes(result)).toEqual(['invalid-package']);
    expect(existsSync(join(root, 'escaped.json'))).toBe(false);
    expect(existsSync(join(cacheDir, 'escaped.json'))).toBe(false);
  });

  test('inexact-dependency and not-r4', async () => {
    const { cacheDir, lockPath } = setup();
    const loose = {
      files: [
        {
          path: 'package/package.json',
          data: manifest('example.fhir.c', '1.0.0', { 'example.fhir.b': 'current' }),
        },
      ],
    };
    const r5 = {
      files: [
        { path: 'package/package.json', data: manifest('example.fhir.d', '1.0.0', {}, '5.0.0') },
      ],
    };
    const result = await fetchPackages({
      igs: ['example.fhir.c@1.0.0', 'example.fhir.d@1.0.0'],
      lockPath,
      cacheDir,
      fetch: registry({ 'example.fhir.c@1.0.0': loose, 'example.fhir.d@1.0.0': r5 }).fetch,
    });
    expect(codes(result)).toEqual(['inexact-dependency', 'not-r4']);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('changing igs rewrites the lock', async () => {
    const { cacheDir, lockPath } = setup();
    const reg = registry({
      'example.fhir.a@1.0.0': A,
      'example.fhir.b@1.0.0': B,
      'example.fhir.g@1.0.0': G,
    });
    await fetchPackages({ igs: ['example.fhir.a@1.0.0'], lockPath, cacheDir, fetch: reg.fetch });
    const result = await fetchPackages({
      igs: ['example.fhir.b@1.0.0'],
      lockPath,
      cacheDir,
      fetch: reg.fetch,
    });
    expect(result.lockWritten).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(lockPath, 'utf8')).packages)).toEqual([
      'example.fhir.b@1.0.0',
    ]);
  });

  describe('check', () => {
    test('passes with a matching lock, filling the cache but writing nothing to the project', async () => {
      const first = setup();
      const reg = registry({
        'example.fhir.a@1.0.0': A,
        'example.fhir.b@1.0.0': B,
        'example.fhir.g@1.0.0': G,
      });
      const igs = ['example.fhir.a@1.0.0'];
      await fetchPackages({ igs, ...first, fetch: reg.fetch });

      // A fresh CI runner: the committed lock, an empty cache.
      const ci = setup();
      writeFileSync(ci.lockPath, readFileSync(first.lockPath));
      const result = await fetchPackages({ igs, ...ci, check: true, fetch: reg.fetch });
      expect(codes(result)).toEqual([]);
      expect(result.lockWritten).toBe(false);
      expect(result.packages.every((p) => p.fetched)).toBe(true);
      expect(readdirSync(ci.project)).toEqual(['plumb.lock']);
      expect(readFileSync(ci.lockPath, 'utf8')).toBe(readFileSync(first.lockPath, 'utf8'));
    });

    test('never rewrites the lock, even one formatted differently', async () => {
      const { cacheDir, lockPath } = setup();
      const reg = registry({ 'example.fhir.b@1.0.0': B });
      await fetchPackages({ igs: ['example.fhir.b@1.0.0'], lockPath, cacheDir, fetch: reg.fetch });
      const minified = JSON.stringify(JSON.parse(readFileSync(lockPath, 'utf8')));
      writeFileSync(lockPath, minified);
      const result = await fetchPackages({
        igs: ['example.fhir.b@1.0.0'],
        lockPath,
        cacheDir,
        check: true,
        fetch: reg.fetch,
      });
      expect(codes(result)).toEqual([]);
      expect(result.lockWritten).toBe(false);
      expect(readFileSync(lockPath, 'utf8')).toBe(minified);
    });

    test('lock-disagrees: the lock lists a package the IGs no longer need', async () => {
      const { cacheDir, lockPath } = setup();
      const reg = registry({ 'example.fhir.b@1.0.0': B });
      await fetchPackages({ igs: ['example.fhir.b@1.0.0'], lockPath, cacheDir, fetch: reg.fetch });
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      lock.packages['example.fhir.stale@1.0.0'] = { integrity: 'sha256-AAAA' };
      writeFileSync(lockPath, JSON.stringify(lock));
      const result = await fetchPackages({
        igs: ['example.fhir.b@1.0.0'],
        lockPath,
        cacheDir,
        check: true,
        fetch: reg.fetch,
      });
      expect(codes(result)).toEqual(['lock-disagrees']);
    });

    test('lock-missing', async () => {
      const { project, cacheDir, lockPath } = setup();
      const result = await fetchPackages({
        igs: ['example.fhir.b@1.0.0'],
        lockPath,
        cacheDir,
        check: true,
        fetch: registry({ 'example.fhir.b@1.0.0': B }).fetch,
      });
      expect(codes(result)).toEqual(['lock-missing']);
      expect(readdirSync(project)).toEqual([]);
    });

    test('lock-disagrees: the config names IGs the lock does not', async () => {
      const { cacheDir, lockPath } = setup();
      const reg = registry({
        'example.fhir.a@1.0.0': A,
        'example.fhir.b@1.0.0': B,
        'example.fhir.g@1.0.0': G,
      });
      await fetchPackages({ igs: ['example.fhir.b@1.0.0'], lockPath, cacheDir, fetch: reg.fetch });
      const lock = readFileSync(lockPath, 'utf8');
      const result = await fetchPackages({
        igs: ['example.fhir.a@1.0.0'],
        lockPath,
        cacheDir,
        check: true,
        fetch: reg.fetch,
      });
      expect(codes(result)).toEqual(['lock-disagrees']);
      expect(readFileSync(lockPath, 'utf8')).toBe(lock);
    });
  });
});
