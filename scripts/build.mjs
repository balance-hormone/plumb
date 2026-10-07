// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

// Package build: the library as ESM (.mjs) and CJS (.cjs) with tsc
// declarations, the CLI as ESM, and the checker bot as one CJS file. Output is
// not minified, so stack traces stay readable.
import { execFileSync } from 'node:child_process';
import { cpSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { CHECKER_BUILD } from '../src/checker/bundle.ts';

rmSync('dist', { recursive: true, force: true });

// `./file.ts?raw` is the file's text, as Vite reads it under Vitest: the
// generated runtime, embedded by src/emit/print.ts (src/emit/raw.d.ts).
const raw = {
  name: 'raw',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: join(args.resolveDir, args.path.slice(0, -'?raw'.length)),
      namespace: 'raw',
    }));
    build.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({
      contents: readFileSync(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

const shared = {
  bundle: true,
  platform: 'node',
  target: 'es2024',
  sourcemap: true,
  packages: 'external',
  plugins: [raw],
};
// CJS has no import.meta, so its url comes from __filename, as ESM's would.
const cjs = {
  ...shared,
  format: 'cjs',
  define: { 'import.meta.url': 'importMetaUrl' },
  banner: { js: "const importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
};

await Promise.all([
  build({ ...shared, entryPoints: ['src/index.ts'], format: 'esm', outfile: 'dist/esm/index.mjs' }),
  build({ ...cjs, entryPoints: ['src/index.ts'], outfile: 'dist/cjs/index.cjs' }),
  build({
    ...shared,
    entryPoints: ['src/testing.ts'],
    format: 'esm',
    outfile: 'dist/esm/testing.mjs',
  }),
  build({ ...cjs, entryPoints: ['src/testing.ts'], outfile: 'dist/cjs/testing.cjs' }),
  build({
    ...shared,
    entryPoints: ['src/vitest.ts'],
    format: 'esm',
    outfile: 'dist/esm/vitest.mjs',
  }),
  build({ ...cjs, entryPoints: ['src/vitest.ts'], outfile: 'dist/cjs/vitest.cjs' }),
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

// tsc declares every module it compiles; ship only those the entry points'
// declarations reach, so internal modules stay out of the published types.
const reached = new Set();
const reach = (file) => {
  if (reached.has(file)) return;
  reached.add(file);
  const specifiers = readFileSync(file, 'utf8').matchAll(
    /(?:from|import\()\s*['"](\.\.?\/[^'"]+)\.js['"]/g,
  );
  for (const [, specifier] of specifiers) reach(join(dirname(file), `${specifier}.d.ts`));
};
for (const entry of ['index', 'testing', 'vitest']) reach(join('dist/esm', `${entry}.d.ts`));
for (const name of readdirSync('dist/esm', { recursive: true })) {
  const file = join('dist/esm', name);
  if (/\.d\.ts(\.map)?$/.test(file) && !reached.has(file.replace(/\.map$/, ''))) rmSync(file);
}
// Deepest first, so a folder holding only emptied folders goes too.
for (const name of readdirSync('dist/esm', { recursive: true }).sort().reverse()) {
  const dir = join('dist/esm', name);
  if (statSync(dir).isDirectory() && readdirSync(dir).length === 0)
    rmSync(dir, { recursive: true });
}

// The package is "type": "module", so without these markers a CJS consumer
// would read dist/cjs/*.d.ts as ESM declarations.
cpSync('dist/esm', 'dist/cjs', {
  recursive: true,
  filter: (src) => !/\.m?js(\.map)?$/.test(src) || src === 'dist/esm',
});
writeFileSync('dist/esm/package.json', '{"type": "module"}\n');
writeFileSync('dist/cjs/package.json', '{"type": "commonjs"}\n');
