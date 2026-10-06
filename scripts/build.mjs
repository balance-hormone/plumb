// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

// Package build: the library as ESM (.mjs) and CJS (.cjs) with tsc
// declarations, the CLI as ESM, and the checker bot as one CJS file. Output is
// not minified, so stack traces stay readable.
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { CHECKER_BUILD } from '../src/checker/bundle.ts';

rmSync('dist', { recursive: true, force: true });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'es2024',
  sourcemap: true,
  packages: 'external',
};

await Promise.all([
  build({ ...shared, entryPoints: ['src/index.ts'], format: 'esm', outfile: 'dist/esm/index.mjs' }),
  build({ ...shared, entryPoints: ['src/index.ts'], format: 'cjs', outfile: 'dist/cjs/index.cjs' }),
  build({
    ...shared,
    entryPoints: ['src/testing.ts'],
    format: 'esm',
    outfile: 'dist/esm/testing.mjs',
  }),
  build({
    ...shared,
    entryPoints: ['src/testing.ts'],
    format: 'cjs',
    outfile: 'dist/cjs/testing.cjs',
  }),
  build({
    ...shared,
    entryPoints: ['src/cli.ts'],
    format: 'esm',
    outfile: 'dist/esm/cli.mjs',
    banner: { js: '#!/usr/bin/env node' },
  }),
  // The checker bot's code, which push deploys; read as text, never imported.
  build({ ...CHECKER_BUILD, outfile: 'dist/checker.cjs' }),
]);

execFileSync('tsc', ['-p', 'tsconfig.build.json'], { stdio: 'inherit' });

// The package is "type": "module", so without these markers a CJS consumer
// would read dist/cjs/*.d.ts as ESM declarations.
cpSync('dist/esm', 'dist/cjs', {
  recursive: true,
  filter: (src) => !/\.m?js(\.map)?$/.test(src) || src === 'dist/esm',
});
writeFileSync('dist/esm/package.json', '{"type": "module"}\n');
writeFileSync('dist/cjs/package.json', '{"type": "commonjs"}\n');
