// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { bareSushiProject, sushiProject } from '../test/sushi-stub.js';
import { buildFsh, dependencyWarnings } from './sushi.js';

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

describe('dependencyWarnings', () => {
  const project = (yaml: string) => {
    const root = mkdtempSync(join(tmpdir(), 'plumb-fsh-'));
    writeFileSync(join(root, 'sushi-config.yaml'), yaml);
    return root;
  };
  const igs = ['hl7.fhir.us.core@9.0.0', 'hl7.fhir.uv.ips@2.0.0'];

  test('warns for a dependency whose version is not the one igs selects', () => {
    const root = project(
      [
        'canonical: http://example.org/fhir/plumb-test',
        'dependencies:',
        '  hl7.fhir.us.core: "6.1.0" # the version the FSH was written for',
        '  hl7.fhir.uv.ips:',
        '    id: ips',
        '    version: 1.1.0',
        'FSHOnly: true',
      ].join('\n'),
    );
    expect(dependencyWarnings(root, igs)).toEqual([
      'sushi-config.yaml depends on hl7.fhir.us.core 6.1.0, but igs selects 9.0.0. SUSHI builds against 6.1.0 and Plumb types against 9.0.0: make them the same.',
      'sushi-config.yaml depends on hl7.fhir.uv.ips 1.1.0, but igs selects 2.0.0. SUSHI builds against 1.1.0 and Plumb types against 2.0.0: make them the same.',
    ]);
  });

  test('reads sushi-config.yml, as SUSHI does', () => {
    const root = mkdtempSync(join(tmpdir(), 'plumb-fsh-'));
    writeFileSync(join(root, 'sushi-config.yml'), 'dependencies:\n  hl7.fhir.us.core: 6.1.0\n');
    expect(dependencyWarnings(root, igs)).toEqual([
      'sushi-config.yml depends on hl7.fhir.us.core 6.1.0, but igs selects 9.0.0. SUSHI builds against 6.1.0 and Plumb types against 9.0.0: make them the same.',
    ]);
  });

  test('nothing for matching versions, packages igs does not list, or no dependencies', () => {
    const matching = project(
      'dependencies:\n  hl7.fhir.us.core: 9.0.0\n  hl7.terminology.r4: 6.2.0\n',
    );
    expect(dependencyWarnings(matching, igs)).toEqual([]);
    expect(dependencyWarnings(project('canonical: http://example.org\n'), igs)).toEqual([]);
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
