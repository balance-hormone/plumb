// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ts from 'typescript5';
import { afterEach, describe, expect, test } from 'vitest';
import { bareSushiProject } from '../test/sushi-stub.js';
import { formatStep, formatValidation, run } from './commands.js';
import type { TypeReport, ValidateEnvResult } from './conformance.js';

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
      expect.stringMatching(/^✔ packages {2}0 cached, 0 fetched {3}\d+(ms|\.\ds)$/),
      expect.stringMatching(/^✔ load {6}2 profiles {3}\d+(ms|\.\ds)$/),
      expect.stringMatching(/^✔ emit {6}2 types, 3 slices, 0 code lists {3}\d+(ms|\.\ds)$/),
      expect.stringMatching(/^✔ routes {4}2 rows for 2 types {3}\d+(ms|\.\ds)$/),
      expect.stringMatching(
        /^✔ write {5}6 written, 0 removed, 0 unchanged → src\/fhir\/generated {3}\d+(ms|\.\ds)$/,
      ),
    ]);
    expect(lines.at(-1)).toMatch(/^Done in \d+(ms|\.\ds)$/);
    expect(existsSync(join(cwd, 'src/fhir/generated/CardinalityPatient.ts'))).toBe(true);
  });

  test('generate exits 2 when the config names FSH and SUSHI is not installed', async () => {
    const cwd = bareSushiProject();
    writeFileSync(
      join(cwd, 'plumb.config.ts'),
      `export default { igs: [], profiles: ['${PLUMB}/cardinality-patient'], fsh: '.', out: './out' };`,
    );
    const { code, stderr } = await cli(['generate'], cwd);
    expect(code).toBe(2);
    expect(stderr).toContain('npm install --save-dev fsh-sushi');
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
      'routes',
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

  test.each(['push', 'validate'])(
    '%s needs --env, a known environment and its credentials, or exits 2',
    async (command) => {
      const missing = await cli([command]);
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain(`plumb: ${command} needs --env <name>`);
      const unknown = await cli([command, '--env', 'staging']);
      expect(unknown.code).toBe(2);
      expect(unknown.stderr).toContain(
        '✖ config    No environment "staging": the config has prod.',
      );
      const unset = await cli([command, '--env', 'prod']);
      expect(unset.code).toBe(2);
      expect(unset.stderr).toContain('PROD_CLIENT_ID is not set');
    },
  );

  // Installing the checker is a server claim, tested in test/server; push reads the built bot.
  test.skipIf(!existsSync(CHECKER) && !process.env.CI).each(['push', 'validate'])(
    '%s loads the profiles, then exits 2 when it cannot connect',
    async (command) => {
      const { cwd } = await cli(['generate']);
      const env = { PROD_CLIENT_ID: 'id', PROD_CLIENT_SECRET: 'secret' };
      const { code, stderr } = await cli([command, '--env', 'prod'], cwd, env);
      expect(code).toBe(2);
      const lines = stderr.trimEnd().split('\n');
      expect(lines[0]).toBe(`plumb ${command} --env prod`);
      expect(lines[1]).toMatch(/^✔ load {6}2 profiles of Observation, Patient {3}\d+(ms|\.\ds)$/);
      expect(lines[2]).toMatch(
        /^✖ connect {3}Could not log in to http:\/\/127\.0\.0\.1:9\/ \(prod\)/,
      );
      expect(lines.at(-1)).toMatch(/^Failed in/);
    },
  );

  test.skipIf(!existsSync(CHECKER) && !process.env.CI).each(['push', 'validate'])(
    '%s reads credentials from each --env-file, the environment winning',
    async (command) => {
      const { cwd } = await cli(['generate']);
      writeFileSync(join(cwd, '.env'), 'PROD_CLIENT_ID=from-file\n');
      writeFileSync(join(cwd, '.env.local'), '# local\nPROD_CLIENT_SECRET="secret"\n');
      const argv = [command, '--env', 'prod', '--env-file', '.env', '--env-file', '.env.local'];
      const { code, stderr } = await cli(argv, cwd, { PROD_CLIENT_ID: 'id' });
      expect(code).toBe(2);
      expect(stderr).not.toContain('is not set');
      expect(stderr).toMatch(/✖ connect {3}Could not log in/);
    },
  );

  test('a missing --env-file exits 2, naming it', async () => {
    const { code, stderr } = await cli(['validate', '--env', 'prod', '--env-file', '.env.missing']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/plumb: no env file at .*\.env\.missing/);
  });

  // CI builds before it tests; locally this runs once dist/ exists. Two
  // processes each load the profiles, which can pass 5s alongside other suites.
  test.skipIf(!existsSync(BUILT) && !process.env.CI)(
    'the built CLI generates and checks',
    { timeout: 30_000 },
    () => {
      const cwd = project();
      const generate = spawnSync(process.execPath, [BUILT, 'generate'], { cwd, encoding: 'utf8' });
      expect(generate.status, generate.stderr).toBe(0);
      const check = spawnSync(process.execPath, [BUILT, 'generate', '--check'], {
        cwd,
        encoding: 'utf8',
      });
      expect(check.status, check.stderr).toBe(0);
    },
  );

  // dist/esm has a package.json of its own, holding only its module type, so
  // the built CLI must find Plumb's own to read its version and its checker.
  test.skipIf(!existsSync(BUILT) && !process.env.CI)(
    "the built CLI reads Plumb's version and checker",
    { timeout: 30_000 },
    () => {
      const { version: expected } = JSON.parse(
        readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'),
      ) as { version: string };
      const version = spawnSync(process.execPath, [BUILT, '--version'], { encoding: 'utf8' });
      expect(version.stdout.trim()).toBe(expected);

      const cwd = project();
      expect(spawnSync(process.execPath, [BUILT, 'generate'], { cwd }).status).toBe(0);
      const validate = spawnSync(process.execPath, [BUILT, 'validate', '--env', 'prod'], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, PROD_CLIENT_ID: 'id', PROD_CLIENT_SECRET: 'secret' },
      });
      expect(validate.stderr).toMatch(/✖ connect {3}Could not log in/);
    },
  );
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

describe('formatValidation', () => {
  const type = (t: Partial<TypeReport>): TypeReport => ({
    exists: 0,
    read: 0,
    stamped: 0,
    failing: 0,
    unstamped: 0,
    silent: { unknown: 0, versioned: 0, empty: 0 },
    otherProfiles: {},
    ...t,
  });
  const profile = (resourceType: string, checked: number, failing: number) => ({
    resourceType,
    checked,
    failing,
    reasons: [],
  });

  test('tells the kinds of empty apart, then lists what was not validated', () => {
    const result: ValidateEnvResult = {
      ok: false,
      steps: [],
      totalMs: 0,
      errors: [],
      shadowed: [],
      resumed: 0,
      types: {
        Encounter: type({ exists: 2, read: 2, stamped: 2 }),
        Observation: type({ exists: 3, read: 3, unstamped: 3 }),
        Patient: type({
          exists: 9,
          read: 9,
          stamped: 4,
          failing: 1,
          unstamped: 1,
          silent: { unknown: 1, versioned: 2, empty: 0 },
          otherProfiles: { [`${PLUMB}/other`]: 1 },
        }),
        Questionnaire: type({ exists: 4 }),
        Basic: type({}),
      },
      profiles: {
        [`${PLUMB}/encounter`]: profile('Encounter', 2, 0),
        [`${PLUMB}/observation`]: profile('Observation', 0, 0),
        // One record is stamped with both, a child and its parent.
        [`${PLUMB}/patient-parent`]: profile('Patient', 1, 0),
        [`${PLUMB}/patient`]: {
          ...profile('Patient', 4, 1),
          reasons: [{ path: 'Patient.birthDate', message: 'Missing required property', count: 1 }],
        },
      },
    };
    expect(formatValidation(result)).toEqual([
      '    Encounter: 2 of 2 read, all 2 stamped passed',
      '      encounter   2 checked, 0 failures',
      '    Observation: 3 of 3 read, none carries a selected profile; 3 unstamped',
      '      observation   0 checked, 0 failures',
      '    Patient: 9 of 9 read, 1 of 4 stamped fail; 1 unstamped; silent stamps: 1 unknown profile URL, 2 url|version; 1 stamped with profiles not selected',
      '      patient-parent   1 checked, 0 failures',
      '      patient   4 checked, 1 failure',
      '        Patient.birthDate: Missing required property   (1)',
      "    Questionnaire: 0 of 4 readable: check plumb-checker's AccessPolicy",
      '    Basic: none stored',
    ]);
  });
});

describe('plumb check', () => {
  const FIXTURE = join(import.meta.dirname, '../test/fixtures/check');
  const BASELINE = join(FIXTURE, 'baseline.json');
  const check = async (...argv: string[]) => {
    let stderr = '';
    const code = await run(['check', ...argv], {
      cwd: FIXTURE,
      env: {},
      isTTY: false,
      typescript: ts,
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
    });
    return { code, stderr };
  };
  afterEach(() => rmSync(BASELINE, { force: true }));

  test('names each raw access to a profiled type, and exits 1', { timeout: 30_000 }, async () => {
    const { code, stderr } = await check();
    expect(code).toBe(1);
    expect(stderr).toMatch(/✖ check {5}2 new, 0 in the baseline, in 3 files/);
    expect(stderr).toContain('src/reads.ts:7:9  readResource Patient  → readProfiled');
    expect(stderr).toContain('src/reads.ts:12:9  searchOne Patient  → searchProfiled');
  });

  test('a baseline accepts them; it refuses to grow without --allow-growth', {
    timeout: 30_000,
  }, async () => {
    expect((await check('--update-baseline')).code).toBe(1);
    expect(existsSync(BASELINE)).toBe(false);
    expect((await check('--update-baseline', '--allow-growth')).code).toBe(0);
    expect(JSON.parse(readFileSync(BASELINE, 'utf8'))).toEqual({
      'src/reads.ts|readResource|Patient': 1,
      'src/reads.ts|searchOne|Patient': 1,
    });
    const { code, stderr } = await check();
    expect(code).toBe(0);
    expect(stderr).toMatch(/✔ check {5}0 new, 2 in the baseline, in 3 files/);
  });

  test("exits 2 when the project's TypeScript has no compiler API", async () => {
    let stderr = '';
    const code = await run(['check'], {
      cwd: FIXTURE,
      env: {},
      isTTY: false,
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
    });
    expect(code).toBe(2);
    expect(stderr).toContain('needs TypeScript 5 or 6');
  });
});
