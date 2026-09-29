// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

// Shared package build: dual ESM (.mjs) and CJS (.cjs) bundles from esbuild,
// declarations from tsc. Output is not minified: consumers minify their own
// bundles, and readable output is easier to debug.
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

rmSync('dist', { recursive: true, force: true });

const shared = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  // Only the CLI kit touches Node; the runtime packages also run in browsers
  // and bots, so they must not assume Node built-ins.
  platform: pkg.bin ? 'node' : 'neutral',
  target: 'es2022',
  sourcemap: true,
  packages: 'external',
  banner: pkg.bin ? { js: '#!/usr/bin/env node' } : undefined,
};

await Promise.all([
  build({ ...shared, format: 'esm', outfile: 'dist/esm/index.mjs' }),
  build({ ...shared, format: 'cjs', outfile: 'dist/cjs/index.cjs' }),
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
