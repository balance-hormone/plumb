// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodeSystem, Organization, Questionnaire } from '@medplum/fhirtypes';
import { beforeAll, describe, expect, test } from 'vitest';
import { bundledChecker } from '../../src/checker/install.js';
import { fetchPackages } from '../../src/packages.js';
import { PLUMB_SYSTEM } from '../../src/project.js';
import { type PushOptions, push } from '../../src/push.js';
import { connect, server } from './medplum.js';
import { linkProject, newProject, type TestProject } from './setup.js';

const BASE = 'http://example.org/fhir/plumb-test';
const CODES = `${BASE}/CodeSystem/visit-reason`;
const REASONS = `${BASE}/ValueSet/visit-reason`;
const INTAKE = `${BASE}/Questionnaire/intake`;

// Synthetic reference content, one file each.
const FILES = {
  'codesystem.json': {
    resourceType: 'CodeSystem',
    url: CODES,
    version: '1.0.0',
    status: 'active',
    content: 'complete',
    concept: [{ code: 'new' }, { code: 'follow-up' }],
  },
  'valueset.json': {
    resourceType: 'ValueSet',
    url: REASONS,
    version: '1.0.0',
    status: 'active',
    compose: { include: [{ system: CODES }] },
  },
  'questionnaire.json': {
    resourceType: 'Questionnaire',
    url: INTAKE,
    version: '1.0.0',
    status: 'active',
    item: [{ linkId: 'reason', type: 'choice', answerValueSet: REASONS }],
  },
  'clinic.json': { resourceType: 'Organization', id: 'main-clinic', name: 'Main Clinic' },
};

describe.skipIf(!server)('push converges reference content', { timeout: 120_000 }, () => {
  let lockPath: string;
  beforeAll(async () => {
    lockPath = join(mkdtempSync(join(tmpdir(), 'plumb-content-')), 'plumb.lock');
    await fetchPackages({ igs: [], lockPath });
  }, 60_000);

  /** A content folder, and push options against a project of its own. */
  function setup(project: TestProject, files: Record<string, unknown> = FILES) {
    const dir = mkdtempSync(join(tmpdir(), 'plumb-content-files-'));
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), JSON.stringify(body));
    }
    const options: PushOptions = {
      config: { igs: [], profiles: [], out: '', content: [join(dir, '*.json')] },
      environment: { name: 'test', ...project },
      lockPath,
      checker: bundledChecker(),
      reportPath: join(dir, 'validate-test.json'),
    };
    return { dir, options };
  }

  const step = (result: Awaited<ReturnType<typeof push>>) =>
    result.steps.filter((s) => s.name === 'content');

  test('creates the content tagged, in order; a second push plans nothing', async () => {
    const project = await newProject();
    const { options } = setup(project);
    const first = await push(options);
    expect(first.errors).toEqual([]);
    expect(step(first)[0]).toMatchObject({
      summary: 'plan: 4 to create, 0 to update, 0 to retire',
      warnings: [
        `+ CodeSystem    ${CODES}`,
        `+ ValueSet      ${REASONS}`,
        `+ Questionnaire ${INTAKE}`,
        '+ Organization  main-clinic',
      ],
    });
    const medplum = await connect(project);
    const clinic = await medplum.searchOne('Organization', { _tag: `${PLUMB_SYSTEM}|main-clinic` });
    expect(clinic).toMatchObject({ name: 'Main Clinic' });
    expect(clinic?.id).not.toBe('main-clinic');
    // Terminology the content holds takes effect: the ValueSet expands to its codes.
    const expansion = await medplum.valueSetExpand({ url: REASONS });
    expect(expansion.expansion?.contains?.map((c) => c.code).sort()).toEqual(['follow-up', 'new']);

    const second = await push(options);
    expect(second.ok).toBe(true);
    expect(step(second)[0]?.summary).toBe('plan: 0 to create, 0 to update, 0 to retire');
    expect((await push({ ...options, check: true })).ok).toBe(true);
  });

  test('an edit updates in place, flagged without a version bump; an edit in the console is drift', async () => {
    const project = await newProject();
    const { dir, options } = setup(project);
    await push(options);
    const medplum = await connect(project);
    const before = (await medplum.searchOne('Questionnaire', { url: INTAKE })) as Questionnaire;

    writeFileSync(
      join(dir, 'questionnaire.json'),
      JSON.stringify({ ...FILES['questionnaire.json'], title: 'Intake' }),
    );
    const edited = await push(options);
    expect(step(edited)[0]?.warnings).toEqual([
      `~ Questionnaire ${INTAKE} (title; changed without a version bump)`,
    ]);
    const after = (await medplum.searchOne('Questionnaire', { url: INTAKE })) as Questionnaire;
    expect(after).toMatchObject({ id: before.id, title: 'Intake' });

    await medplum.updateResource({ ...after, title: 'Edited by hand' });
    const check = await push({ ...options, check: true });
    expect(check.ok).toBe(false);
    expect(check.steps.at(-1)).toMatchObject({ name: 'check', summary: 'drift: 1 content' });
  });

  test('a removed file is kept, then retired with --prune, never deleted', async () => {
    const project = await newProject();
    const { dir, options } = setup(project);
    await push(options);
    rmSync(join(dir, 'valueset.json'));
    rmSync(join(dir, 'clinic.json'));
    // The Questionnaire names the ValueSet, so it goes too, or the file check refuses it.
    rmSync(join(dir, 'questionnaire.json'));

    const kept = await push(options);
    expect(step(kept)[0]?.warnings).toEqual([
      `- ValueSet      ${REASONS} (kept: pass --prune to retire)`,
      `- Questionnaire ${INTAKE} (kept: pass --prune to retire)`,
      '- Organization  main-clinic (kept: pass --prune to retire)',
    ]);
    const pruned = await push({ ...options, prune: true });
    expect(step(pruned)[0]?.summary).toBe('plan: 0 to create, 0 to update, 3 to retire');

    const medplum = await connect(project);
    expect(await medplum.searchOne('ValueSet', { url: REASONS })).toMatchObject({
      status: 'retired',
    });
    expect(
      (await medplum.searchOne('Organization', {
        _tag: `${PLUMB_SYSTEM}|main-clinic`,
      })) as Organization,
    ).toMatchObject({ active: false });
    // Terminology lookup skips retired content since Medplum 5.1.x; 5.1.0 still resolves it.
    const expand = medplum.valueSetExpand({ url: REASONS });
    if (process.env.PLUMB_MEDPLUM_SERVER === '5.1.0') {
      await expect(expand).resolves.toMatchObject({ status: 'retired' });
    } else {
      await expect(expand).rejects.toThrow(/not found/);
    }
    // Retired content is not retired again.
    expect(step(await push({ ...options, prune: true }))[0]?.summary).toBe(
      'plan: 0 to create, 0 to update, 0 to retire',
    );
  });

  test('untagged content is left alone until --adopt takes it over', async () => {
    const project = await newProject();
    const medplum = await connect(project);
    const handmade = await medplum.createResource({
      ...FILES['codesystem.json'],
      title: 'By hand',
    } as CodeSystem);
    const { options } = setup(project, { 'codesystem.json': FILES['codesystem.json'] });

    const refused = await push(options);
    expect(refused.ok).toBe(false);
    expect(refused.errors).toEqual([]);
    expect(refused.content?.blocked).toEqual([
      {
        code: 'untagged-content',
        message: `CodeSystem "${CODES}" exists untagged; adopt it with --adopt.`,
      },
    ]);
    expect(step(refused)[0]?.warnings).toEqual([
      `CodeSystem "${CODES}" exists untagged; adopt it with --adopt.`,
    ]);
    const adopted = await push({ ...options, adopt: true });
    expect(adopted.ok).toBe(true);
    expect(step(adopted)[0]?.warnings).toEqual([
      `~ CodeSystem    ${CODES} (adopted; title; changed without a version bump)`,
    ]);
    expect(await medplum.readResource('CodeSystem', handmade.id)).toMatchObject({
      meta: { tag: [{ system: PLUMB_SYSTEM, code: CODES }] },
    });
  });

  test("a linked project's tagged content is neither planned nor retired", async () => {
    const linked = await newProject();
    await push(setup(linked).options);
    const project = await newProject();
    await linkProject(project.projectId, linked.projectId);
    // Even with --prune, the linked project's four are not this project's to retire.
    const own = await push({
      ...setup(project, { 'clinic.json': FILES['clinic.json'] }).options,
      prune: true,
    });
    expect(own.errors).toEqual([]);
    expect(step(own)[0]?.summary).toBe('plan: 1 to create, 0 to update, 0 to retire');
  });
});
