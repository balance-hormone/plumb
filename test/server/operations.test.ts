// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { OperationDefinition, Patient } from '@medplum/fhirtypes';
import { build } from 'esbuild';
import { beforeAll, describe, expect, test } from 'vitest';
import { applyBots, planBots } from '../../src/bots.js';
import type { BotConfig } from '../../src/config.js';
import { printFiles } from '../../src/emit/print.js';
import { writeFiles } from '../../src/emit/write.js';
import {
  applyOperations,
  type Contract,
  loadOperations,
  planOperations,
} from '../../src/operations.js';
import { PLUMB_SYSTEM, type ProjectOptions } from '../../src/project.js';
import { connect, server } from './medplum.js';
import { newProject, type TestProject } from './setup.js';

const CONTRACTS = join(import.meta.dirname, '../fixtures/operations/contracts.ts');

// Each bot is the project's own code around the generated handleOperation,
// bundled as a project would bundle it for vmcontext.
async function bundle(dir: string, name: string, source: string): Promise<string> {
  writeFileSync(join(dir, `${name}.ts`), source);
  const file = join(dir, `${name}.cjs`);
  await build({
    entryPoints: [join(dir, `${name}.ts`)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: file,
    footer: { js: 'Object.assign(exports, module.exports);' },
  });
  return file;
}

interface Generated {
  callOperation: (client: unknown, operation: unknown, input: unknown) => Promise<unknown>;
  OperationError: new (...args: never[]) => Error;
}

describe.skipIf(!server)('the operations step', { timeout: 120_000 }, () => {
  let project: TestProject;
  let medplum: MedplumClient;
  let contracts: Contract[];
  let generated: Generated;
  const typeOf = () => undefined;

  beforeAll(async () => {
    project = await newProject();
    medplum = await connect(project);
    const dir = mkdtempSync(join(tmpdir(), 'plumb-operations-'));
    writeFiles(
      join(dir, 'generated'),
      printFiles([], () => 'test', undefined, [], ['x']),
    );
    generated = (await import(join(dir, 'generated/_operations.ts'))) as Generated;
    const shouter = await bundle(
      dir,
      'shouter',
      `import { handleOperation } from './generated/_operations.ts';
import { shout } from ${JSON.stringify(CONTRACTS)};
export const handler = handleOperation(shout, (_medplum, input) => ({ text: input.text.toUpperCase() }));`,
    );
    const activator = await bundle(
      dir,
      'activator',
      `import { handleOperation } from './generated/_operations.ts';
import { activate } from ${JSON.stringify(CONTRACTS)};
export const handler = handleOperation(activate, (_medplum, patient) => ({ ...patient, active: true }));`,
    );
    const bots: Record<string, BotConfig> = {
      shouter: { file: shouter, runtime: 'vmcontext' },
      activator: { file: activator, runtime: 'vmcontext' },
    };
    await applyBots(await planBots(medplum, bots), medplum);
    const loaded = await loadOperations([CONTRACTS]);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    contracts = loaded.contracts;
  }, 120_000);

  const plan = async (list = contracts, options?: ProjectOptions) =>
    planOperations(await connect(project), list, typeOf, options);
  const held = async (code: string) =>
    (await medplum.searchOne('OperationDefinition', {
      _tag: `${PLUMB_SYSTEM}|${code}`,
    })) as OperationDefinition;
  const shout = () => contracts.find((c) => c.code === 'plumb-shout');
  const activate = () => contracts.find((c) => c.code === 'plumb-activate');

  test("a push writes each contract's OperationDefinition, naming its bot", async () => {
    const first = await plan();
    expect(first.changes.map((c) => [c.kind, c.code])).toEqual([
      ['+', 'plumb-shout'],
      ['+', 'plumb-activate'],
    ]);
    await applyOperations(first, await connect(project));
    const bot = await medplum.searchOne('Bot', { identifier: `${PLUMB_SYSTEM}|shouter` });
    expect(await held('plumb-shout')).toMatchObject({
      code: 'plumb-shout',
      system: true,
      parameter: [{ name: 'result', use: 'out', type: 'string' }],
      extension: [{ valueReference: { reference: `Bot/${bot?.id}` } }],
    });
    expect(await held('plumb-activate')).toMatchObject({
      type: true,
      resource: ['Patient'],
      parameter: [{ name: 'return', type: 'Patient' }],
    });
    expect((await plan()).changes).toEqual([]);
  });

  test('callOperation reaches each bot by code, with JSON and FHIR sides', async () => {
    expect(await generated.callOperation(medplum, shout(), { text: 'hello' })).toEqual({
      text: 'HELLO',
    });
    const patient: Patient = { resourceType: 'Patient', name: [{ family: 'Synthetic' }] };
    expect(await generated.callOperation(medplum, activate(), patient)).toEqual({
      ...patient,
      active: true,
    });
  });

  test("a schema failure in the bot is a 400 with the schema's issues", async () => {
    const sent = medplum.post(
      medplum.fhirUrl('$plumb-shout'),
      { words: 'hello' },
      'application/json',
    );
    await expect(sent).rejects.toThrow(/input\.text: Required/);
    const err = await medplum
      .post(medplum.fhirUrl('$plumb-shout'), { words: 'hello' }, 'application/json')
      .catch((e: { outcome?: { issue?: { code?: string }[] } }) => e);
    expect(err).toMatchObject({ outcome: { issue: [{ code: 'invalid' }] } });
  });

  test('an untagged OperationDefinition with a contract’s code stops the step', async () => {
    const stray = { ...shout(), code: 'plumb-stray' } as Contract;
    await medplum.createResource<OperationDefinition>({
      resourceType: 'OperationDefinition',
      name: 'stray',
      status: 'active',
      kind: 'operation',
      code: 'plumb-stray',
      system: true,
      type: false,
      instance: false,
    });
    expect((await plan([...contracts, stray])).blocked).toMatchObject([
      { code: 'shadowed-operation' },
    ]);
  });

  test('--prune deletes a removed operation; without it, it is kept', async () => {
    const removed = [activate() as Contract];
    expect((await plan(removed)).changes).toEqual([
      expect.objectContaining({ kind: '-', code: 'plumb-shout', kept: true }),
    ]);
    await applyOperations(await plan(removed, { prune: true }), await connect(project));
    expect(await medplum.searchOne('OperationDefinition', { code: 'plumb-shout' })).toBeUndefined();
  });
});

// Parameters is the most natural output for a FHIR operation: the caller
// reads it as the Parameters the bot returned, whatever the release.
describe.skipIf(!server)('an operation whose output is Parameters', { timeout: 120_000 }, () => {
  test('callOperation reads back the Parameters the bot returned', async () => {
    const project = await newProject();
    const medplum = await connect(project);
    const dir = mkdtempSync(join(tmpdir(), 'plumb-operations-parameters-'));
    writeFiles(
      join(dir, 'generated'),
      printFiles([], () => 'test', undefined, [], ['x']),
    );
    const contract = join(dir, 'count.ts');
    writeFileSync(
      contract,
      `export const count = { code: 'plumb-count', level: 'system', bot: 'counter', input: 'Parameters', output: 'Parameters' } as const;`,
    );
    const counter = await bundle(
      dir,
      'counter',
      `import { handleOperation } from './generated/_operations.ts';
import { count } from ${JSON.stringify(contract)};
export const handler = handleOperation(count, () => ({ resourceType: 'Parameters', parameter: [{ name: 'count', valueInteger: 3 }] }));`,
    );
    await applyBots(
      await planBots(medplum, { counter: { file: counter, runtime: 'vmcontext' } }),
      medplum,
    );
    const loaded = await loadOperations([contract]);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    await applyOperations(
      await planOperations(medplum, loaded.contracts, () => undefined),
      await connect(project),
    );
    const generated = (await import(join(dir, 'generated/_operations.ts'))) as Generated;
    const input = { resourceType: 'Parameters', parameter: [{ name: 'of', valueString: 'x' }] };
    expect(await generated.callOperation(medplum, loaded.contracts[0], input)).toEqual({
      resourceType: 'Parameters',
      parameter: [{ name: 'count', valueInteger: 3 }],
    });
  });
});
