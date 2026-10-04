// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

// Runs the project's own SUSHI (design 05): Plumb takes no dependency on it,
// and the project pins the version its FSH was written for.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

interface SushiError {
  code: 'sushi-not-installed' | 'sushi-too-old' | 'sushi-error' | 'sushi-failed';
  message: string;
}

export interface FshBuild {
  ok: boolean;
  counts: { structureDefinitions: number; valueSets: number };
  /** SUSHI's warnings, each with its file and line. */
  warnings: string[];
  errors: SushiError[];
}

// `build` and `-o` are SUSHI 3's.
const OLDEST = 3;

/**
 * Builds the SUSHI project in `project` with `--snapshot`, into its own
 * `fsh-generated`, or into `out`.
 */
export function buildFsh(project: string, options: { out?: string } = {}): FshBuild {
  const counts = { structureDefinitions: 0, valueSets: 0 };
  const fail = (...errors: SushiError[]): FshBuild => ({ ok: false, counts, warnings: [], errors });
  const sushi = findSushi(project);
  if ('code' in sushi) return fail(sushi);

  const args = ['build', project, '--snapshot', ...(options.out ? ['-o', options.out] : [])];
  const run = spawnSync(process.execPath, [sushi.bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });
  const messages = parseLog(`${run.stdout ?? ''}${run.stderr ?? ''}`);
  const errors = messages.error.map((message): SushiError => ({ code: 'sushi-error', message }));
  if (run.status !== 0 && errors.length === 0) {
    const why = run.error?.message ?? `exited with ${run.status ?? run.signal}`;
    errors.push({ code: 'sushi-failed', message: `SUSHI ${why}.` });
  }
  const resources = join(options.out ?? join(project, 'fsh-generated'), 'resources');
  const files = existsSync(resources) ? readdirSync(resources) : [];
  counts.structureDefinitions = files.filter((f) => f.startsWith('StructureDefinition-')).length;
  counts.valueSets = files.filter((f) => f.startsWith('ValueSet-')).length;
  return { ok: errors.length === 0, counts, warnings: messages.warn, errors };
}

function findSushi(project: string): { bin: string } | SushiError {
  let manifest: string;
  try {
    manifest = createRequire(join(project, 'package.json')).resolve('fsh-sushi/package.json');
  } catch {
    return {
      code: 'sushi-not-installed',
      message: `"fsh" needs SUSHI, and none is installed for ${project}. Run npm install --save-dev fsh-sushi.`,
    };
  }
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
    version: string;
    bin: string | { sushi: string };
  };
  if (Number.parseInt(pkg.version, 10) < OLDEST) {
    return {
      code: 'sushi-too-old',
      message: `"fsh" needs SUSHI ${OLDEST} or later; ${pkg.version} is installed. Run npm install --save-dev fsh-sushi@latest.`,
    };
  }
  return { bin: join(dirname(manifest), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.sushi) };
}

/**
 * SUSHI logs one message per `level message` line, with its file and line
 * on indented lines after it.
 */
function parseLog(text: string): { error: string[]; warn: string[] } {
  const messages: { level: string; lines: string[] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const start = /^(error|warn|info|debug)\s+(.*)$/.exec(line);
    if (start) messages.push({ level: start[1] as string, lines: [start[2] as string] });
    else if (line.startsWith('  ')) messages.at(-1)?.lines.push(line);
  }
  const of = (level: string) =>
    messages.filter((m) => m.level === level).map((m) => m.lines.join('\n'));
  return { error: of('error'), warn: of('warn') };
}
