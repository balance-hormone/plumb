// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Basic, Patient, Subscription } from '@medplum/fhirtypes';
import { beforeAll, describe, expect, test } from 'vitest';
import { applyBots, planBots } from '../../src/bots.js';
import { bundledChecker } from '../../src/checker/install.js';
import type { BotConfig, PlumbConfig, SubscriptionConfig } from '../../src/config.js';
import { printFiles } from '../../src/emit/print.js';
import { writeFiles } from '../../src/emit/write.js';
import { migrateEnvironment, migrationStatus } from '../../src/migrate.js';
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
});
