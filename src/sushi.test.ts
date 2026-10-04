// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { bareSushiProject, sushiProject } from '../test/sushi-stub.js';
import { buildFsh } from './sushi.js';

describe('buildFsh', () => {
  test("runs the project's own SUSHI with --snapshot, and counts what it built", () => {
    const { root, argv } = sushiProject({ build: true, log: ['info  Importing FSH text...'] });
    const result = buildFsh(root);
    expect(result).toMatchObject({ ok: true, errors: [], warnings: [] });
    expect(result.counts).toEqual({ structureDefinitions: 42, valueSets: 5 });
    expect(argv()).toEqual(['build', root, '--snapshot']);
  });

  test('builds into another folder when given one', () => {
    const { root, argv } = sushiProject({ build: true });
    const out = mkdtempSync(join(tmpdir(), 'plumb-fsh-out-'));
    expect(buildFsh(root, { out }).counts.structureDefinitions).toBe(42);
    expect(argv()).toEqual(['build', root, '--snapshot', '-o', out]);
  });

  test("reports SUSHI's errors with their file and line, and its warnings", () => {
    const { root } = sushiProject({
      exitCode: 1,
      log: [
        'info  Importing FSH text...',
        'warn  Element Patient.name has a cardinality that is wider than its base.',
        '  File: /p/input/fsh/patient.fsh',
        '  Line: 4',
        'error Cannot resolve element from path: nmae',
        '  File: /p/input/fsh/patient.fsh',
        '  Line: 7 - 8',
      ],
    });
    const result = buildFsh(root);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        code: 'sushi-error',
        message:
          'Cannot resolve element from path: nmae\n  File: /p/input/fsh/patient.fsh\n  Line: 7 - 8',
      },
    ]);
    expect(result.warnings).toEqual([
      'Element Patient.name has a cardinality that is wider than its base.\n  File: /p/input/fsh/patient.fsh\n  Line: 4',
    ]);
  });

  test('sushi-failed, for a non-zero exit with no error line', () => {
    const { root } = sushiProject({ exitCode: 3, log: ['info  Starting'] });
    expect(buildFsh(root).errors).toEqual([
      { code: 'sushi-failed', message: expect.stringMatching(/exited with 3/) },
    ]);
  });

  test('sushi-not-installed, naming the install command', () => {
    const result = buildFsh(bareSushiProject());
    expect(result.errors).toEqual([
      {
        code: 'sushi-not-installed',
        message: expect.stringContaining('npm install --save-dev fsh-sushi'),
      },
    ]);
  });

  test('sushi-too-old, before SUSHI 3', () => {
    const { root } = sushiProject({ version: '2.10.2' });
    expect(buildFsh(root).errors).toEqual([
      { code: 'sushi-too-old', message: expect.stringContaining('2.10.2') },
    ]);
  });
});

// The real SUSHI, on Plumb's own test profiles. It downloads its own
// dependencies from the FHIR registry, so it runs in CI, or with PLUMB_SUSHI=1.
test.skipIf(!process.env.CI && !process.env.PLUMB_SUSHI)(
  "the project's real SUSHI builds Plumb's test profiles as committed",
  { timeout: 300_000 },
  () => {
    const fixtures = join(import.meta.dirname, '../test/fixtures/profiles');
    const out = mkdtempSync(join(tmpdir(), 'plumb-fsh-real-'));
    const result = buildFsh(fixtures, { out });
    expect(result.errors).toEqual([]);
    expect(result.counts).toEqual({ structureDefinitions: 42, valueSets: 5 });
    const built = join(out, 'fsh-generated', 'resources');
    const committed = join(fixtures, 'fsh-generated', 'resources');
    for (const file of readdirSync(committed).filter((f) => f.startsWith('StructureDefinition-'))) {
      expect(readFileSync(join(built, file), 'utf8'), file).toBe(
        readFileSync(join(committed, file), 'utf8'),
      );
    }
  },
);
