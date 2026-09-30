// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// The README's quickstart, against a packed tarball in a new project: install,
// configure, generate, use the types and helpers, validate, then --check. It
// uses Plumb's synthetic profiles as `local`, so it needs npm but not the FHIR
// registry. It installs packages, so it runs in CI, or locally with PLUMB_E2E=1.
const ROOT = join(import.meta.dirname, '../..');
const PLUMB = 'http://example.org/fhir/plumb-test/StructureDefinition';
const run = !!process.env.CI || !!process.env.PLUMB_E2E;

test.skipIf(!run)(
  'a new project follows the quickstart to a passing --check',
  () => {
    expect(existsSync(join(ROOT, 'dist/esm/cli.mjs')), 'build first').toBe(true);
    const root = mkdtempSync(join(tmpdir(), 'plumb-quickstart-'));
    const packDir = join(root, 'pack');
    const app = join(root, 'app');
    mkdirSync(packDir);
    mkdirSync(join(app, 'src'), { recursive: true });
    execFileSync('npm', ['pack', '--silent', '--pack-destination', packDir], { cwd: ROOT });
    const tarball = join(packDir, readdirSync(packDir)[0] as string);
    // What is installed here, read from the package itself: `npm ls` fails when the
    // compatibility job installs @medplum/* outside the dev dependency range.
    const version = (name: string) =>
      (
        JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')) as {
          version: string;
        }
      ).version;
    const npm = (...args: string[]) =>
      execFileSync('npm', [...args, '--no-audit', '--no-fund', '--prefer-offline'], { cwd: app });

    // 1. Install.
    writeFileSync(
      join(app, 'package.json'),
      '{ "name": "quickstart", "private": true, "type": "module" }',
    );
    npm('install', '--save-dev', tarball, `typescript@${version('typescript')}`);
    npm(
      'install',
      ...['@medplum/core', '@medplum/definitions', '@medplum/fhirtypes'].map(
        (p) => `${p}@${version(p)}`,
      ),
    );

    // 2. Configure.
    cpSync(join(ROOT, 'test/fixtures/profiles/fsh-generated/resources'), join(app, 'profiles'), {
      recursive: true,
    });
    writeFileSync(
      join(app, 'plumb.config.ts'),
      `import { defineConfig } from 'plumb';

export default defineConfig({
  igs: [],
  profiles: ['${PLUMB}/cardinality-patient', '${PLUMB}/sliced-observation'],
  local: './profiles',
  out: './src/fhir/generated',
});
`,
    );

    // 3. Generate.
    const plumb = (...args: string[]) =>
      spawnSync(join(app, 'node_modules/.bin/plumb'), args, { cwd: app, encoding: 'utf8' });
    const generated = plumb('generate');
    expect(generated.status, generated.stderr).toBe(0);
    expect(generated.stderr).toMatch(/^✔ write/m);

    // 4. Use the types and helpers, type-checked under NodeNext.
    writeFileSync(
      join(app, 'src/app.ts'),
      `import { validateProfiled } from 'plumb';
import { type CardinalityPatient, SlicedObservation, SlicedObservationProfileUrl } from './fhir/generated/index.js';

export const patient: CardinalityPatient = { resourceType: 'Patient', birthDate: '1970-01-01', name: [{ family: 'Doe' }] };
// @ts-expect-error birthDate is required
export const missing: CardinalityPatient = { resourceType: 'Patient', name: [{ family: 'Doe' }] };
const systolic = SlicedObservation.systolic({ valueQuantity: { value: 120 } });
const report = await validateProfiled(
  { resourceType: 'Observation', status: 'final', code: { text: 'bp' }, component: [systolic] },
  SlicedObservationProfileUrl,
);
console.log(JSON.stringify({ read: SlicedObservation.getSystolic({ component: [systolic] })?.valueQuantity?.value, ok: report.ok }));
`,
    );
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
    const tsc = spawnSync(join(app, 'node_modules/.bin/tsc'), ['-p', '.'], {
      cwd: app,
      encoding: 'utf8',
    });
    expect(tsc.status, tsc.stdout).toBe(0);

    // 5. Validate, with the built helpers at run time. The observation lacks the required
    // diastolic slice, which only validateProfiled catches.
    const ran = spawnSync(process.execPath, ['build/app.js'], { cwd: app, encoding: 'utf8' });
    expect(ran.status, ran.stderr).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({ read: 120, ok: false });

    // 6. Check.
    const checked = plumb('generate', '--check');
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stderr).toMatch(/^✔ check {5}up to date/m);
  },
  180_000,
);
