// Shared package build, matching Medplum's layout: dual ESM (.mjs) and CJS
// (.cjs) bundles from esbuild, with declarations emitted separately by tsc.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];
const shared = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'neutral',
  target: 'es2022',
  sourcemap: true,
  external,
};

await Promise.all([
  build({ ...shared, format: 'esm', outfile: 'dist/esm/index.mjs' }),
  build({ ...shared, format: 'cjs', outfile: 'dist/cjs/index.cjs' }),
]);
execSync('tsc -p tsconfig.build.json', { stdio: 'inherit' });
