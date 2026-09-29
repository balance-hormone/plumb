// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

// Every source file carries an SPDX header, as Medplum's do, so code can move
// upstream without a licensing pass. Biome has no header rule, hence this.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const HEADER = [
  '// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors',
  '// SPDX-License-Identifier: Apache-2.0',
].join('\n');

const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '*.ts', '*.mjs', '*.cjs', '*.js'],
  {
    encoding: 'utf8',
  },
)
  .split('\n')
  .filter(Boolean);

const missing = files.filter(
  (file) =>
    !readFileSync(file, 'utf8')
      .replace(/^#!.*\n/, '')
      .startsWith(HEADER),
);

if (missing.length > 0) {
  console.error(`Missing SPDX header:\n${missing.map((f) => `  ${f}`).join('\n')}`);
  process.exit(1);
}
