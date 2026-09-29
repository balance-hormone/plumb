// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

// PostToolUse hook: lint the edited file and, for TypeScript under src/,
// typecheck the project, so the agent fixes failures in the same turn. Exit
// code 2 returns stderr to Claude.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const file = JSON.parse(readFileSync(0, 'utf8')).tool_input?.file_path;
if (!file || !existsSync(file)) process.exit(0);

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: dirname(file),
  encoding: 'utf8',
}).trim();
const path = relative(root, file);
if (path.startsWith('..')) process.exit(0);

const run = (bin, args) => {
  const result = spawnSync(join(root, 'node_modules/.bin', bin), args, {
    cwd: root,
    encoding: 'utf8',
  });
  return result.status === 0 ? '' : `${bin} ${args.join(' ')}\n${result.stdout}${result.stderr}`;
};

const failures = [
  run('biome', ['check', '--no-errors-on-unmatched', '--files-ignore-unknown=true', path]),
];
if (/^src\/.*\.[cm]?tsx?$/.test(path)) failures.push(run('tsc', ['--noEmit']));

const output = failures.filter(Boolean).join('\n');
if (output) {
  console.error(output);
  process.exit(2);
}
