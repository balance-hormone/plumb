// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { newProject } from './project.js';

// The README's quickstart, against a packed tarball in a new project: install,
// configure, generate, use the types and helpers, route and stamp a write,
// validate, then --check. It
// uses Plumb's synthetic profiles as `local`, so it needs npm but not the FHIR
// registry. It installs packages, so it runs in CI, or locally with PLUMB_E2E=1.
const ROOT = join(import.meta.dirname, '../..');
const PLUMB = 'http://example.org/fhir/plumb-test/StructureDefinition';
const run = !!process.env.CI || !!process.env.PLUMB_E2E;

test.skipIf(!run)(
  'a new project follows the quickstart to a passing --check',
  () => {
    // 1. Install.
    const project = newProject('quickstart');
    const { app } = project;

    // 2. Configure.
    cpSync(join(ROOT, 'test/fixtures/profiles/fsh-generated/resources'), join(app, 'profiles'), {
      recursive: true,
    });
    project.write(
      'plumb.config.ts',
      `import { defineConfig } from 'plumb-fhir';

export default defineConfig({
  igs: [],
  profiles: ['${PLUMB}/cardinality-patient', '${PLUMB}/sliced-observation'],
  local: './profiles',
  out: './src/fhir/generated',
});
`,
    );

    // 3. Generate.
    const generated = project.plumb('generate');
    expect(generated.status, generated.stderr).toBe(0);
    expect(generated.stderr).toMatch(/^✔ write/m);

    // 4. Use the types and helpers, type-checked under NodeNext.
    project.write(
      'src/app.ts',
      `import type { Resource } from '@medplum/fhirtypes';
import { validateProfiled } from 'plumb-fhir';
import { type CardinalityPatient, createProfiled, route, SlicedObservation, SlicedObservationProfileUrl } from './fhir/generated/index.js';

export const patient: CardinalityPatient = { resourceType: 'Patient', birthDate: '1970-01-01', name: [{ family: 'Doe' }] };
// @ts-expect-error birthDate is required
export const missing: CardinalityPatient = { resourceType: 'Patient', name: [{ family: 'Doe' }] };
const systolic = SlicedObservation.systolic({ valueQuantity: { value: 120 } });
const report = await validateProfiled(
  { resourceType: 'Observation', status: 'final', code: { text: 'bp' }, component: [systolic] },
  SlicedObservationProfileUrl,
);
// Routing and the stamped write, through a client that writes nothing.
const written: Resource[] = [];
const client = {
  createResource: async <T extends Resource>(r: T): Promise<T> => (written.push(r), r),
  updateResource: async <T extends Resource>(r: T): Promise<T> => r,
};
await createProfiled(client, patient);
console.log(JSON.stringify({ read: SlicedObservation.getSystolic({ component: [systolic] })?.valueQuantity?.value, ok: report.ok, routed: route(patient), stamped: written[0]?.meta?.profile }));
`,
    );
    const tsc = project.tsc();
    expect(tsc.status, tsc.stdout).toBe(0);

    // 5. Validate, with the built helpers at run time. The observation lacks the required
    // diastolic slice, which only validateProfiled catches.
    const ran = project.node('build/app.js');
    expect(ran.status, ran.stderr).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({
      read: 120,
      ok: false,
      routed: `${PLUMB}/cardinality-patient`,
      stamped: [`${PLUMB}/cardinality-patient`],
    });

    // 6. Check.
    const checked = project.plumb('generate', '--check');
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stderr).toMatch(/^✔ check {5}up to date/m);
  },
  180_000,
);
