// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { formatStep, run } from './commands.js';

const SYNTHETIC = join(import.meta.dirname, '../test/fixtures/profiles/fsh-generated/resources');
const PLUMB = 'http://example.org/fhir/plumb-test/StructureDefinition';
const BUILT = join(import.meta.dirname, '../dist/esm/cli.mjs');
const CHECKER = join(import.meta.dirname, '../dist/checker.cjs');

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'plumb-cli-'));
  writeFileSync(
    join(root, 'plumb.config.ts'),
    `export default {
      igs: [],
      profiles: ['${PLUMB}/cardinality-patient', '${PLUMB}/sliced-observation'],
      local: ${JSON.stringify(SYNTHETIC)},
      out: './src/fhir/generated',
      environments: {
        prod: {
          baseUrl: 'http://127.0.0.1:9/',
          clientId: { env: 'PROD_CLIENT_ID' },
          clientSecret: { env: 'PROD_CLIENT_SECRET' },
        },
      },
    };`,
  );
  return root;
}

/** Runs the CLI in-process, collecting what it prints. */
async function cli(
  argv: string[],
  cwd = project(),
  env: Record<string, string> = {},
  isTTY = false,
) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    cwd,
    env,
    isTTY,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr, cwd };
}

describe('plumb', () => {
  test('--help prints usage and exits 0', async () => {
    const { code, stdout } = await cli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: plumb generate [--check] [--config <path>]');
  });

  test('--version prints the version', async () => {
    const { code, stdout } = await cli(['--version']);
    expect(code).toBe(0);
    expect(stdout).toBe(
      `${JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')).version}\n`,
    );
  });

  test.each([[[]], [['frobnicate']], [['generate', '--bogus']]])(
    'a usage error exits 2: %j',
    async (argv) => {
      const { code, stderr } = await cli(argv);
      expect(code).toBe(2);
      expect(stderr).toContain('Usage: plumb generate');
    },
  );

  test('a config error exits 2', async () => {
    const { code, stderr } = await cli(['generate'], mkdtempSync(join(tmpdir(), 'plumb-cli-')));
    expect(code).toBe(2);
    expect(stderr).toMatch(/No config file/);
  });

  test('generate prints a line per step and a total, and exits 0', async () => {
    const { code, stderr, cwd } = await cli(['generate']);
    expect(code).toBe(0);
    const lines = stderr.trimEnd().split('\n');
    expect(lines[0]).toBe('plumb generate');
    expect(lines.slice(1, -1)).toEqual([
      expect.stringMatching(/^✔ packages {2}0 cached, 0 fetched {3}\d+ms$/),
      expect.stringMatching(/^✔ load {6}2 profiles {3}\d+ms$/),
      expect.stringMatching(/^✔ emit {6}2 types, 3 slices, 0 code lists {3}\d+ms$/),
      expect.stringMatching(
        /^✔ write {5}4 written, 0 removed, 0 unchanged → src\/fhir\/generated {3}\d+ms$/,
      ),
    ]);
    expect(lines.at(-1)).toMatch(/^Done in \d+(ms|\.\ds)$/);
    expect(existsSync(join(cwd, 'src/fhir/generated/CardinalityPatient.ts'))).toBe(true);
  });

  test('--check passes on up-to-date output', async () => {
    const { cwd } = await cli(['generate']);
    const { code, stderr } = await cli(['generate', '--check'], cwd);
    expect(code).toBe(0);
    expect(stderr).toMatch(/^✔ check {5}up to date/m);
  });

  test('--check lists each stale file and its cause, gives the fix, and exits 1', async () => {
    const { cwd } = await cli(['generate']);
    const file = join(cwd, 'src/fhir/generated/CardinalityPatient.ts');
    writeFileSync(file, `${readFileSync(file, 'utf8')}// edited\n`);
    const { code, stderr } = await cli(['generate', '--check'], cwd);
    expect(code).toBe(1);
    expect(stderr).toMatch(/^✖ check {5}1 stale, 0 missing, 0 extra/m);
    expect(stderr).toMatch(/^ {4}CardinalityPatient\.ts: The regenerated file differs/m);
    expect(stderr).toContain('Run plumb generate to update src/fhir/generated.');
    expect(stderr.trimEnd().split('\n').at(-1)).toMatch(/^Failed in/);
  });

  test('a problem found, such as a lockfile mismatch, exits 1', async () => {
    const { code, stderr } = await cli(['generate', '--check']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/^✖ packages {2}No lockfile/m);
  });

  test('--config takes another path', async () => {
    const cwd = project();
    const { code } = await cli(['generate', '--config', join(cwd, 'plumb.config.ts')], tmpdir());
    expect(code).toBe(0);
  });

  test('--json prints the report on stdout', async () => {
    const { code, stdout } = await cli(['generate', '--json']);
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.ok).toBe(true);
    expect(report.steps.map((s: { name: string }) => s.name)).toEqual([
      'packages',
      'load',
      'emit',
      'write',
    ]);
  });

  test('--quiet prints only problems', async () => {
    const quiet = await cli(['generate', '--quiet']);
    expect(quiet.code).toBe(0);
    expect(quiet.stderr).toBe('');
    const failing = await cli(['generate', '--check', '--quiet']);
    expect(failing.stderr).toMatch(/No lockfile/);
  });

  test('colour only in a terminal, and never with NO_COLOR', async () => {
    expect((await cli(['generate'], project(), {}, true)).stderr).toContain('\u001b[');
    expect((await cli(['generate'], project(), { NO_COLOR: '1' }, true)).stderr).not.toContain(
      '\u001b[',
    );
    expect((await cli(['generate'])).stderr).not.toContain('\u001b[');
  });

  test('push needs --env, a known environment and its credentials, or exits 2', async () => {
    const missing = await cli(['push']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('plumb: push needs --env <name>');
    const unknown = await cli(['push', '--env', 'staging']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('✖ config    No environment "staging": the config has prod.');
    const unset = await cli(['push', '--env', 'prod']);
    expect(unset.code).toBe(2);
    expect(unset.stderr).toContain('PROD_CLIENT_ID is not set');
  });

  // Installing the checker is a server claim, tested in test/server; push reads the built bot.
  test.skipIf(!existsSync(CHECKER) && !process.env.CI)(
    'push loads the profiles, then exits 2 when it cannot connect',
    async () => {
      const { cwd } = await cli(['generate']);
      const env = { PROD_CLIENT_ID: 'id', PROD_CLIENT_SECRET: 'secret' };
      const { code, stderr } = await cli(['push', '--env', 'prod'], cwd, env);
      expect(code).toBe(2);
      const lines = stderr.trimEnd().split('\n');
      expect(lines[0]).toBe('plumb push --env prod');
      expect(lines[1]).toMatch(/^✔ load {6}2 profiles of Observation, Patient {3}\d+(ms|\.\ds)$/);
      expect(lines[2]).toMatch(
        /^✖ connect {3}Could not log in to http:\/\/127\.0\.0\.1:9\/ \(prod\)/,
      );
      expect(lines.at(-1)).toMatch(/^Failed in/);
    },
  );

  // CI builds before it tests; locally this runs once dist/ exists.
  test.skipIf(!existsSync(BUILT) && !process.env.CI)('the built CLI generates and checks', () => {
    const cwd = project();
    const generate = spawnSync(process.execPath, [BUILT, 'generate'], { cwd, encoding: 'utf8' });
    expect(generate.status, generate.stderr).toBe(0);
    const check = spawnSync(process.execPath, [BUILT, 'generate', '--check'], {
      cwd,
      encoding: 'utf8',
    });
    expect(check.status, check.stderr).toBe(0);
  });
});

describe('formatStep', () => {
  test('pads the name and shows the time in ms or seconds', () => {
    expect(
      formatStep(
        {
          name: 'load',
          ms: 2140,
          counts: { profiles: 54, skipped: 1, unresolved: 0 },
          warnings: [],
        },
        '',
      ),
    ).toBe('load      54 profiles, 1 skipped   2.1s');
    expect(
      formatStep({ name: 'packages', ms: 41, counts: { cached: 7, fetched: 0 }, warnings: [] }, ''),
    ).toBe('packages  7 cached, 0 fetched   41ms');
  });
});
