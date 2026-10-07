// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Basic, OperationDefinition, Patient, Subscription } from '@medplum/fhirtypes';
import { build } from 'esbuild';
import { beforeAll, describe, expect, test } from 'vitest';
import { applyBots, planBots } from '../../src/bots.js';
import { CHECKER_BUILD } from '../../src/checker/bundle.js';
import { bundledChecker, installChecker } from '../../src/checker/install.js';
import type { BotConfig, PlumbConfig, SubscriptionConfig } from '../../src/config.js';
import { printFiles } from '../../src/emit/print.js';
import { writeFiles } from '../../src/emit/write.js';
import { migrateEnvironment, migrationStatus } from '../../src/migrate.js';
import { applyOperations, type Contract, planOperations } from '../../src/operations.js';
import { fetchPackages } from '../../src/packages.js';
import { PLUMB_SYSTEM } from '../../src/project.js';
import { applySubscriptions, planSubscriptions } from '../../src/subscriptions.js';
import { connect, server } from './medplum.js';
import { linkProject, newProject, type TestProject } from './setup.js';

const ECHO = 'exports.handler = async () => ({});';
const BACKFILL = '20261007-patient-active';

// A project linked to another sees that project's resources in its searches,
// Plumb's tags and identifiers included. None of them is this project's.
describe.skipIf(!server)("a linked project's Plumb resources", { timeout: 120_000 }, () => {
  let ours: TestProject;
  let theirs: TestProject;
  let dir: string;
  let bots: Record<string, BotConfig>;

  beforeAll(async () => {
    theirs = await newProject();
    ours = await newProject();
    await linkProject(ours.projectId, theirs.projectId);
    dir = mkdtempSync(join(tmpdir(), 'plumb-linked-'));
    writeFileSync(join(dir, 'echo.cjs'), ECHO);
    bots = { echo: { file: join(dir, 'echo.cjs'), runtime: 'vmcontext' } };
    // The linked project deployed the same bot key first.
    await applyBots(await planBots(await connect(theirs), bots), await connect(theirs));
  }, 120_000);

  test("a Subscription delivers to this project's bot, never the linked project's", async () => {
    const medplum = await connect(ours);
    await applyBots(await planBots(medplum, bots), medplum);
    const config: Record<string, SubscriptionConfig> = {
      'new-patient': { criteria: 'Patient', interactions: ['create'], bot: 'echo' },
    };
    await applySubscriptions(await planSubscriptions(medplum, config), medplum);
    const own = (await medplum.searchResources('Bot', { identifier: `${PLUMB_SYSTEM}|echo` })).find(
      (b) => b.meta?.project === ours.projectId,
    );
    const subscription = (await medplum.searchResources('Subscription', {})).find(
      (s) => s.meta?.project === ours.projectId,
    ) as Subscription;
    expect(subscription.channel.endpoint).toBe(`Bot/${own?.id}`);
  });

  test("a linked project's applied ledger entry neither skips nor blocks this project's run", async () => {
    const state = { status: 'applied', hash: 'theirs', counts: {}, pages: 1 };
    const held = await (await connect(theirs)).createResource<Basic>({
      resourceType: 'Basic',
      meta: { tag: [{ system: PLUMB_SYSTEM, code: BACKFILL }] },
      code: { coding: [{ system: PLUMB_SYSTEM, code: 'migration' }] },
      extension: [{ url: `${PLUMB_SYSTEM}#migration`, valueString: JSON.stringify(state) }],
    });
    const medplum = await connect(ours);
    await medplum.createResource<Patient>({ resourceType: 'Patient', name: [{ family: 'L' }] });
    mkdirSync(join(dir, 'migrations'));
    writeFileSync(
      join(dir, `migrations/${BACKFILL}.ts`),
      `export default {
  id: '${BACKFILL}',
  resourceType: 'Patient',
  transform: (p) => (p.active ? undefined : [{ op: 'add', path: '/active', value: true }]),
};
`,
    );
    writeFiles(
      join(dir, 'generated'),
      printFiles([], () => 'test', undefined, [], [], undefined, [`../migrations/${BACKFILL}.js`]),
    );
    const config: PlumbConfig = {
      igs: [],
      profiles: [],
      out: join(dir, 'generated'),
      bots: { migrator: { file: join(dir, 'migrator.cjs') } },
      migrations: { bot: 'migrator', modules: [join(dir, 'migrations/*.ts')] },
    };
    const lockPath = join(dir, 'plumb.lock');
    await fetchPackages({ igs: [], lockPath });
    const environment = { name: 'test', ...ours, synthetic: true };

    const before = await migrationStatus({ config, environment });
    expect(before.migrations[BACKFILL]?.status).toBe('pending');
    const run = await migrateEnvironment({
      config,
      environment,
      lockPath,
      checker: bundledChecker(),
      local: true,
      write: true,
    });
    expect(run.errors).toEqual([]);
    expect(run.migrations[BACKFILL]).toMatchObject({ ran: true, counts: { changed: 1 } });
    const after = await (await connect(theirs)).readResource('Basic', held.id as string);
    expect(after.meta?.versionId).toBe(held.meta?.versionId);
  });

  test("a linked project's scheduled bot is neither planned here nor cleared by --prune", async () => {
    const nightly = { nightly: { ...bots.echo, cron: '0 3 * * *' } as BotConfig };
    const linked = await connect(theirs);
    await applyBots(await planBots(linked, nightly), linked);
    const medplum = await connect(ours);
    expect((await planBots(medplum, {}, { prune: true })).changes).toEqual([]);
    expect((await planBots(medplum, nightly)).changes).toMatchObject([
      { kind: '+', key: 'nightly' },
    ]);
  });

  test("a linked project's Subscription is neither planned here nor turned off by --prune", async () => {
    const config: Record<string, SubscriptionConfig> = {
      'linked-only': { criteria: 'Practitioner', interactions: ['create'], bot: 'echo' },
    };
    const linked = await connect(theirs);
    await applySubscriptions(await planSubscriptions(linked, config), linked);
    const medplum = await connect(ours);
    const pruned = await planSubscriptions(medplum, {}, { prune: true });
    expect(pruned.changes.map((c) => c.key)).not.toContain('linked-only');
    const planned = await planSubscriptions(medplum, config);
    expect(planned.changes.filter((c) => c.key === 'linked-only')).toMatchObject([{ kind: '+' }]);
  });

  test("an untagged OperationDefinition in a linked project shadows a contract's code", async () => {
    await (await connect(theirs)).createResource<OperationDefinition>({
      resourceType: 'OperationDefinition',
      name: 'linked',
      status: 'active',
      kind: 'operation',
      code: 'plumb-linked',
      system: true,
      type: false,
      instance: false,
    });
    const contract: Contract = {
      code: 'plumb-linked',
      level: 'system',
      bot: 'echo',
      input: 'Parameters',
      output: 'Parameters',
      from: 'linked.test.ts',
    };
    const planned = await planOperations(await connect(ours), [contract], () => undefined);
    expect(planned.blocked).toMatchObject([{ code: 'shadowed-operation' }]);
    expect(planned.changes).toEqual([]);
  });

  test("a linked project's tagged OperationDefinition is neither planned here nor deleted by --prune", async () => {
    const held = await (await connect(theirs)).createResource<OperationDefinition>({
      resourceType: 'OperationDefinition',
      meta: { tag: [{ system: PLUMB_SYSTEM, code: 'plumb-theirs' }] },
      name: 'theirs',
      status: 'active',
      kind: 'operation',
      code: 'plumb-theirs',
      system: true,
      type: false,
      instance: false,
    });
    const medplum = await connect(ours);
    const planned = await planOperations(medplum, [], () => undefined, { prune: true });
    expect(planned).toEqual({ changes: [], blocked: [] });
    await applyOperations(planned, medplum);
    const after = await (await connect(theirs)).readResource(
      'OperationDefinition',
      held.id as string,
    );
    expect(after.meta?.versionId).toBe(held.meta?.versionId);
  });

  // Last: migrate looks for this project's checker, so the ledger test runs without one.
  test("a linked project's checker is not this project's: push installs its own", async () => {
    const code = (await build({ ...CHECKER_BUILD, write: false })).outputFiles[0]?.text ?? '';
    const options = { code, version: 'test', resourceTypes: ['Patient'] };
    const theirsChecker = await installChecker(await connect(theirs), options);
    const before = await (await connect(theirs)).readResource('Bot', theirsChecker.botId);
    const installed = await installChecker(await connect(ours), options);
    expect(installed.status).toBe('installed');
    expect(installed.botId).not.toBe(theirsChecker.botId);
    const own = await (await connect(ours)).readResource('Bot', installed.botId);
    expect(own.meta?.project).toBe(ours.projectId);
    const after = await (await connect(theirs)).readResource('Bot', theirsChecker.botId);
    expect(after.meta?.versionId).toBe(before.meta?.versionId);
  });
});
