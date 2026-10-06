// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { sushiProject } from '../test/sushi-stub.js';
import type { PlumbConfig } from './config.js';
import { type GenerateResult, generate, type Step } from './generate.js';

const SYNTHETIC = join(import.meta.dirname, '../test/fixtures/profiles/fsh-generated/resources');
const PLUMB = 'http://example.org/fhir/plumb-test/StructureDefinition';

/** A project with its own copy of Plumb's synthetic profiles as its local folder. */
function project(profiles = ['cardinality-patient', 'sliced-observation']) {
  const root = mkdtempSync(join(tmpdir(), 'plumb-generate-'));
  cpSync(SYNTHETIC, join(root, 'profiles'), { recursive: true });
  const config: PlumbConfig = {
    igs: [],
    profiles: profiles.map((p) => `${PLUMB}/${p}`),
    local: join(root, 'profiles'),
    out: join(root, 'generated'),
  };
  return { root, config, lockPath: join(root, 'plumb.lock'), cacheDir: join(root, 'cache') };
}

/** Every file under a folder with its contents, to show nothing was written. */
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => statSync(join(dir, f)).isFile())
      .map((f) => [f, readFileSync(join(dir, f), 'utf8')]),
  );
}

const problems = (r: GenerateResult) => r.stale.map((s) => [s.problem, s.file]);
const codes = (r: GenerateResult) => r.errors.map((e) => e.code);

describe('generate', () => {
  test('writes the types and the lock, reporting each step', async () => {
    const p = project();
    const steps: Step[] = [];
    const result = await generate({ ...p, onStep: (s) => steps.push(s) });
    expect(codes(result)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.written).toEqual(
      expect.arrayContaining([
        'CardinalityPatient.ts',
        'SlicedObservation.ts',
        'index.ts',
        '_plumb.ts',
      ]),
    );
    expect(existsSync(p.lockPath)).toBe(true);
    expect(steps.map((s) => s.name)).toEqual(['packages', 'load', 'emit', 'routes', 'write']);
    expect(result.steps).toEqual(steps);
    expect(steps.find((s) => s.name === 'load')?.counts).toMatchObject({ profiles: 2 });
    expect(steps.find((s) => s.name === 'emit')?.counts).toMatchObject({ types: 2, slices: 3 });
    expect(steps.every((s) => s.ms >= 0)).toBe(true);
    expect(result.totalMs).toBeGreaterThanOrEqual(0);
  });

  test('reports a routing row the loaded profile cannot take, and writes nothing', async () => {
    const p = project();
    const url = `${PLUMB}/cardinality-patient`;
    const result = await generate({
      ...p,
      config: { ...p.config, routes: { [url]: { code: ['x'] } } },
    });
    expect(result.errors.map((e) => [e.step, e.code])).toEqual([['load', 'invalid-route-element']]);
    expect(existsSync(p.config.out)).toBe(false);
  });

  test('checks content offline: a refused file fails the load step and writes nothing', async () => {
    const p = project();
    const content = join(p.root, 'content');
    mkdirSync(content);
    writeFileSync(
      join(content, 'clinic.json'),
      JSON.stringify({ resourceType: 'Organization', id: 'main-clinic', name: 'Main Clinic' }),
    );
    writeFileSync(
      join(content, 'search.json'),
      JSON.stringify({ resourceType: 'SearchParameter' }),
    );
    const refused = await generate({
      ...p,
      config: { ...p.config, content: [join(content, '*.json')] },
    });
    expect(refused.errors.map((e) => [e.step, e.code])).toEqual([['load', 'invalid-content']]);
    expect(existsSync(p.config.out)).toBe(false);

    const ok = await generate({
      ...p,
      config: { ...p.config, content: [join(content, 'clinic.json')] },
    });
    expect(ok.steps.find((s) => s.name === 'load')?.counts.content).toBe(1);
  });

  test('writes a Questionnaire listed in content as its typed answers', async () => {
    const p = project();
    const intake = join(import.meta.dirname, '../test/fixtures/content/Questionnaire-intake.json');
    const result = await generate({ ...p, config: { ...p.config, content: [intake] } });
    expect(result.errors).toEqual([]);
    expect(readFileSync(join(p.config.out, 'IntakeAnswers.ts'), 'utf8')).toContain(
      'export function intakeAnswers(response: QuestionnaireResponse): IntakeAnswers {',
    );
    expect(readFileSync(join(p.config.out, 'index.ts'), 'utf8')).toContain(
      "export * from './IntakeAnswers.js';",
    );
  });

  test('passes the value-set size limit to the emitter', async () => {
    const p = project(['bindings-observation']);
    await generate({ ...p, config: { ...p.config, bindings: { maxCodes: 200 } } });
    expect(readFileSync(join(p.config.out, 'BindingsObservation.ts'), 'utf8')).toContain("'c101'");
  });

  test('headers carry each profile version and source hash', async () => {
    const p = project();
    await generate(p);
    const header = readFileSync(join(p.config.out, 'CardinalityPatient.ts'), 'utf8').split('\n');
    expect(header[0]).toBe(
      `// Generated by Plumb from ${PLUMB}/cardinality-patient|0.1.0. Do not edit.`,
    );
    expect(header[1]).toMatch(/^\/\/ Source: local sha256-[A-Za-z0-9+/]+=*$/);
  });

  describe('fsh', () => {
    test('builds the FSH first, then types it as the local workflow does', async () => {
      const local = project();
      await generate(local);
      const fsh = sushiProject({ build: true });
      const config = {
        ...local.config,
        fsh: fsh.root,
        local: join(fsh.root, 'fsh-generated', 'resources'),
      };
      const out = join(fsh.root, 'generated');
      const steps: Step[] = [];
      const result = await generate({
        ...local,
        config: { ...config, out },
        onStep: (s) => steps.push(s),
      });
      expect(codes(result)).toEqual([]);
      expect(steps[0]).toMatchObject({
        name: 'sushi',
        counts: { structureDefinitions: 42, valueSets: 5 },
      });
      expect(snapshot(out)).toEqual(snapshot(local.config.out));
    });

    test('warns on the sushi step when sushi-config.yaml and igs disagree on a version', async () => {
      const p = project();
      const fsh = sushiProject({ build: true });
      writeFileSync(
        join(fsh.root, 'sushi-config.yaml'),
        'canonical: http://example.org/fhir/plumb-test\ndependencies:\n  example.fhir.other: 0.9.0\n',
      );
      const steps: Step[] = [];
      await generate({
        ...p,
        config: { ...p.config, igs: ['example.fhir.other@1.0.0'], fsh: fsh.root },
        onStep: (s) => steps.push(s),
      });
      expect(steps[0]?.warnings).toEqual([
        expect.stringMatching(
          /^sushi-config.yaml depends on example.fhir.other 0.9.0, but igs selects 1.0.0/,
        ),
      ]);
    });

    /** A SUSHI project generated once, with its build and types as committed. */
    async function generatedFsh() {
      const p = project();
      const fsh = sushiProject({ build: true });
      const config = {
        ...p.config,
        fsh: fsh.root,
        local: join(fsh.root, 'fsh-generated', 'resources'),
        out: join(fsh.root, 'generated'),
      };
      expect((await generate({ ...p, config })).ok).toBe(true);
      return { ...p, config, fsh };
    }

    test('check rebuilds into a temporary folder, leaving the project as it is', async () => {
      const p = await generatedFsh();
      const before = snapshot(p.fsh.root);
      const result = await generate({ ...p, check: true });
      expect(codes(result)).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.steps.map((s) => s.name)).toEqual([
        'sushi',
        'packages',
        'load',
        'emit',
        'routes',
        'check',
      ]);
      const [, project, , o, out] = p.fsh.argv();
      expect([project, o]).toEqual([p.fsh.root, '-o']);
      expect(out).not.toContain(p.fsh.root);
      expect(existsSync(out as string)).toBe(false);
      // The stub's argv.json is the one file the run adds.
      const { 'argv.json': _, ...after } = snapshot(p.fsh.root);
      const { 'argv.json': __, ...unchanged } = before;
      expect(after).toEqual(unchanged);
    });

    test('check fails when the committed build differs from what the FSH builds', async () => {
      const p = await generatedFsh();
      const resources = join(p.fsh.root, 'fsh-generated', 'resources');
      const edited = join(resources, 'StructureDefinition-cardinality-patient.json');
      writeFileSync(edited, `${readFileSync(edited, 'utf8')}\n`);
      writeFileSync(join(resources, 'StructureDefinition-removed.json'), '{}');
      rmSync(join(resources, 'ValueSet-plumb-test-colors-vs.json'));
      const result = await generate({ ...p, check: true });
      expect(result.ok).toBe(false);
      expect(problems(result)).toEqual([
        ['stale', 'fsh-generated/resources/StructureDefinition-cardinality-patient.json'],
        ['extra', 'fsh-generated/resources/StructureDefinition-removed.json'],
        ['missing', 'fsh-generated/resources/ValueSet-plumb-test-colors-vs.json'],
      ]);
      expect(result.stale.map((s) => s.cause)).toEqual([
        'differs from what the FSH builds.',
        'is committed, but the FSH no longer builds it.',
        'is built from the FSH, but not committed.',
      ]);
    });

    test('an FSH error stops generate, with its file and line, and writes nothing', async () => {
      const p = project();
      const fsh = sushiProject({
        exitCode: 1,
        log: [
          'error Cannot resolve element from path: nmae',
          '  File: /p/patient.fsh',
          '  Line: 7',
        ],
      });
      const result = await generate({ ...p, config: { ...p.config, fsh: fsh.root } });
      expect(result.errors).toEqual([
        {
          code: 'sushi-error',
          step: 'sushi',
          message: 'Cannot resolve element from path: nmae\n  File: /p/patient.fsh\n  Line: 7',
        },
      ]);
      expect(existsSync(p.config.out)).toBe(false);
    });
  });

  describe('check', () => {
    test('passes on up-to-date output and writes nothing', async () => {
      const p = project();
      await generate(p);
      const before = snapshot(p.root);
      const result = await generate({ ...p, check: true });
      expect(codes(result)).toEqual([]);
      expect(result.stale).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.steps.map((s) => s.name)).toEqual([
        'packages',
        'load',
        'emit',
        'routes',
        'check',
      ]);
      expect(snapshot(p.root)).toEqual(before);
    });

    test('a file edited since it was generated', async () => {
      const p = project();
      await generate(p);
      const file = join(p.config.out, 'CardinalityPatient.ts');
      writeFileSync(file, `${readFileSync(file, 'utf8')}// edited\n`);
      const before = snapshot(p.root);
      const result = await generate({ ...p, check: true });
      expect(result.ok).toBe(false);
      expect(problems(result)).toEqual([['stale', 'CardinalityPatient.ts']]);
      expect(result.stale[0]?.cause).toMatch(/edited by hand, or generated by another version/);
      expect(snapshot(p.root)).toEqual(before);
    });

    test('a profile whose version changed names the change', async () => {
      const p = project();
      await generate(p);
      const sdFile = join(p.config.local as string, 'StructureDefinition-cardinality-patient.json');
      const sd = JSON.parse(readFileSync(sdFile, 'utf8'));
      writeFileSync(sdFile, JSON.stringify({ ...sd, version: '0.2.0' }));
      const result = await generate({ ...p, check: true });
      expect(problems(result)).toEqual([['stale', 'CardinalityPatient.ts']]);
      expect(result.stale[0]?.cause).toContain('0.1.0 → 0.2.0');
    });

    test('a missing file and an extra one', async () => {
      const p = project(['cardinality-patient', 'sliced-observation', 'nesting-patient']);
      await generate(p);
      rmSync(join(p.config.out, 'SlicedObservation.ts'));
      const fewer = { ...p.config, profiles: p.config.profiles.slice(0, 2) };
      const result = await generate({ ...p, config: fewer, check: true });
      expect(problems(result).sort()).toEqual([
        ['extra', 'NestingPatient.ts'],
        ['missing', 'SlicedObservation.ts'],
        ['stale', '_reads.ts'],
        ['stale', '_routes.ts'],
        ['stale', 'index.ts'],
      ]);
    });

    test('a file in out that Plumb did not write', async () => {
      const p = project();
      await generate(p);
      writeFileSync(join(p.config.out, 'mine.ts'), 'export const mine = 1;\n');
      const result = await generate({ ...p, check: true });
      expect(codes(result)).toEqual(['foreign-file']);
      expect(result.errors[0]?.step).toBe('check');
    });

    test('a lockfile that disagrees with the config', async () => {
      const p = project();
      await generate(p);
      const config = { ...p.config, igs: ['example.fhir.other@1.0.0'] };
      const result = await generate({ ...p, config, check: true });
      expect(codes(result)).toEqual(['lock-disagrees']);
      expect(result.errors[0]?.step).toBe('packages');
    });

    test('a profile without a snapshot', async () => {
      const p = project();
      await generate(p);
      const sdFile = join(p.config.local as string, 'StructureDefinition-cardinality-patient.json');
      const { snapshot: _, ...sd } = JSON.parse(readFileSync(sdFile, 'utf8'));
      writeFileSync(sdFile, JSON.stringify(sd));
      const result = await generate({ ...p, check: true });
      expect(codes(result)).toEqual(['no-snapshot']);
      expect(result.errors[0]?.step).toBe('load');
    });
  });
});
