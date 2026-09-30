// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { newProject } from './project.js';

// Against the real FHIR package registry, with a fresh package cache each run,
// so fetching and verify-once are exercised: the offline tests cannot notice a
// change in the registry or in published packages. It downloads several hundred
// megabytes, so it runs only with PLUMB_REGISTRY=1 (the nightly workflow).
const run = !!process.env.PLUMB_REGISTRY;
const README = readFileSync(join(import.meta.dirname, '../../README.md'), 'utf8');
const blocks = [...README.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] as string);
const block = (start: string) => {
  const found = blocks.find((b) => b.includes(start));
  if (!found) throw new Error(`No README code block with ${start}`);
  return found;
};

/** A new project whose package cache starts empty. */
const freshProject = (name: string) =>
  newProject(name, { HOME: mkdtempSync(join(tmpdir(), `plumb-${name}-home-`)) });

test.skipIf(!run)(
  "the README's quickstart works as written",
  () => {
    const project = freshProject('registry-readme');
    project.write('plumb.config.ts', block("import { defineConfig } from 'plumb-fhir';"));
    const generated = project.plumb('generate');
    expect(generated.status, generated.stderr).toBe(0);
    expect(generated.stderr).toMatch(/^✔ packages {2}0 cached, \d+ fetched/m);

    // Its usage example and validateProfiled test, as one module that prints the verdict.
    const usage = block("import { createReference } from '@medplum/core';");
    const check = block("import { validateProfiled } from 'plumb-fhir';")
      .replace(/test\('[^']*', async \(\) => \{/, '{')
      .replace('expect(report.errors).toEqual([]);', 'console.log(JSON.stringify(report.errors));')
      .replace(/\}\);\s*$/, '}\n');
    project.write('src/app.ts', `${usage}\n${check}`);
    const tsc = project.tsc();
    expect(tsc.status, tsc.stdout).toBe(0);
    const ran = project.node('build/app.js');
    expect(ran.status, ran.stderr).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual([]);

    const checked = project.plumb('generate', '--check');
    expect(checked.status, checked.stderr).toBe(0);
  },
  600_000,
);

test.skipIf(!run)(
  'IPS 2.0.1 generates and checks',
  () => {
    const project = freshProject('registry-ips');
    project.write(
      'plumb.config.ts',
      `export default {
  igs: ['hl7.fhir.uv.ips@2.0.1'],
  profiles: ['hl7.fhir.uv.ips/*'],
  out: './src/fhir/generated',
};
`,
    );
    const generated = project.plumb('generate');
    expect(generated.status, generated.stderr).toBe(0);
    project.write('src/app.ts', "export * from './fhir/generated/index.js';\n");
    const tsc = project.tsc();
    expect(tsc.status, tsc.stdout).toBe(0);
    const checked = project.plumb('generate', '--check');
    expect(checked.status, checked.stderr).toBe(0);
  },
  600_000,
);
