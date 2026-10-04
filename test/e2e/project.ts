// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from 'node:child_process';
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

const ROOT = join(import.meta.dirname, '../..');

/** What is installed here, read from the package itself: `npm ls` fails when CI installs @medplum/* outside the dev range. */
export function version(name: string): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8'));
  return (pkg as { version: string }).version;
}

/**
 * A new project with Plumb installed from a packed tarball, next to the
 * `@medplum/*` and TypeScript versions this repository has, as a user would.
 * Plumb must be built first.
 */
export function newProject(name: string, env: Record<string, string> = {}) {
  if (!existsSync(join(ROOT, 'dist/esm/cli.mjs'))) throw new Error('Build Plumb first.');
  const root = mkdtempSync(join(tmpdir(), `plumb-${name}-`));
  const packDir = join(root, 'pack');
  const app = join(root, 'app');
  mkdirSync(packDir);
  mkdirSync(join(app, 'src'), { recursive: true });
  execFileSync('npm', ['pack', '--silent', '--pack-destination', packDir], { cwd: ROOT });
  const tarball = join(packDir, readdirSync(packDir)[0] as string);
  const npm = (...args: string[]) =>
    execFileSync('npm', [...args, '--no-audit', '--no-fund', '--prefer-offline'], { cwd: app });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name, private: true, type: 'module' }));
  npm('install', '--save-dev', tarball, `typescript@${version('typescript')}`);
  const medplum = ['@medplum/core', '@medplum/definitions', '@medplum/fhirtypes'];
  npm('install', ...medplum.map((p) => `${p}@${version(p)}`));
  writeFileSync(
    join(app, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        skipLibCheck: true,
        outDir: 'build',
        rootDir: 'src',
      },
      include: ['src/**/*.ts'],
    }),
  );
  const exec = (command: string, args: string[]) =>
    spawnSync(command, args, { cwd: app, encoding: 'utf8', env: { ...process.env, ...env } });
  return {
    app,
    npm,
    write: (file: string, text: string) => {
      mkdirSync(dirname(join(app, file)), { recursive: true });
      writeFileSync(join(app, file), text);
    },
    plumb: (...args: string[]) => exec(join(app, 'node_modules/.bin/plumb'), args),
    tsc: () => exec(join(app, 'node_modules/.bin/tsc'), ['-p', '.']),
    node: (file: string) => exec(process.execPath, [file]),
  };
}
