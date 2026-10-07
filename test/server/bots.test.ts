// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, ProjectMembership } from '@medplum/fhirtypes';
import { build } from 'esbuild';
import { beforeAll, describe, expect, test } from 'vitest';
import { applyBots, missingFeatures, planBots } from '../../src/bots.js';
import { CHECKER_BUILD } from '../../src/checker/bundle.js';
import type { BotConfig } from '../../src/config.js';
import { fetchPackages } from '../../src/packages.js';
import { applyProject, PLUMB_SYSTEM, type ProjectOptions, planProject } from '../../src/project.js';
import { push } from '../../src/push.js';
import { newProject as newServerProject } from '../../src/server.js';
import { connectAs } from '../../src/testing.js';
import { connect, server } from './medplum.js';
import { newProject, type TestProject } from './setup.js';

// vmcontext, as the test server runs bots; it calls exports.handler.
const ECHO = 'exports.handler = async (medplum, event) => ({ echoed: event.input });';

describe.skipIf(!server)('the bots step converges bots', { timeout: 120_000 }, () => {
  let project: TestProject;
  const dir = mkdtempSync(join(tmpdir(), 'plumb-bots-'));
  const file = join(dir, 'echo.cjs');
  writeFileSync(file, ECHO);
  const bots: Record<string, BotConfig> = {
    echo: { file, runtime: 'vmcontext', policy: 'echo', publicWebhook: true, timeout: 20 },
  };

  beforeAll(async () => {
    project = await newProject();
    const policies = { accessPolicies: { echo: { resource: [{ resourceType: 'Patient' }] } } };
    const medplum = await connect(project);
    await applyProject(await planProject(policies, medplum), medplum);
  }, 60_000);

  const plan = async (config = bots, options?: ProjectOptions) =>
    planBots(await connect(project), config, options);
  const converge = async (config = bots, options?: ProjectOptions) =>
    applyBots(await plan(config, options), await connect(project));
  const held = async (key: string) => {
    const medplum = await connect(project);
    const bot = (await medplum.searchOne('Bot', { identifier: `${PLUMB_SYSTEM}|${key}` })) as Bot;
    const membership = (await medplum.searchOne('ProjectMembership', {
      profile: `Bot/${bot.id}`,
    })) as ProjectMembership;
    return { bot, membership };
  };

  test('a push creates the bot with its membership and policy, then deploys it', async () => {
    const first = await plan();
    expect(first.changes).toMatchObject([{ kind: '+', key: 'echo' }]);
    const applied = await applyBots(first, await connect(project));
    const { bot, membership } = await held('echo');
    expect(bot).toMatchObject({
      name: 'echo',
      runtimeVersion: 'vmcontext',
      timeout: 20,
      publicWebhook: true,
    });
    expect(bot.executableCode?.title).toMatch(/^echo-[0-9a-f]{16}\.cjs$/);
    expect(membership.accessPolicy?.reference).toMatch(/^AccessPolicy\//);
    expect(applied.webhooks).toEqual([
      { key: 'echo', url: `${project.baseUrl}webhook/${membership.id}` },
    ]);
  });

  test('a second push plans nothing and deploys nothing', async () => {
    const before = await held('echo');
    const second = await plan();
    expect(second).toMatchObject({ changes: [], blocked: [] });
    expect(second.webhooks).toEqual([
      { key: 'echo', url: `${project.baseUrl}webhook/${before.membership.id}` },
    ]);
    expect((await held('echo')).bot.meta?.versionId).toBe(before.bot.meta?.versionId);
  });

  test('the webhook URL push reports runs the bot without a token', async () => {
    const [webhook] = (await plan()).webhooks;
    const response = await fetch(webhook?.url as string, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ echoed: { hello: 'world' } });
  });

  test('a changed file deploys once, and a changed field updates in place', async () => {
    const before = await held('echo');
    writeFileSync(file, `${ECHO}\n// changed`);
    const changed = { echo: { ...bots.echo, timeout: 30 } as BotConfig };
    const planned = await plan(changed);
    expect(planned.changes).toMatchObject([{ kind: '~', key: 'echo', fields: ['timeout'] }]);
    expect(planned.changes[0]).toHaveProperty('deploy');
    await applyBots(planned, await connect(project));
    const after = await held('echo');
    expect(after.bot.id).toBe(before.bot.id);
    expect(after.bot.timeout).toBe(30);
    expect(after.bot.executableCode?.title).not.toBe(before.bot.executableCode?.title);
    expect((await plan(changed)).changes).toEqual([]);
  });

  test('--adopt takes over an untagged bot, keeping its id and membership', async () => {
    const medplum = await connect(project);
    const untagged = await medplum.post<Bot>(`admin/projects/${project.projectId}/bot`, {
      name: 'legacy',
      runtimeVersion: 'vmcontext',
    });
    const config = { legacy: { file, runtime: 'vmcontext' } as BotConfig };
    expect((await plan(config)).blocked).toMatchObject([{ code: 'untagged-bot' }]);
    const membership = await medplum.searchOne('ProjectMembership', {
      profile: `Bot/${untagged.id}`,
    });
    await converge(config, { adopt: true });
    const adopted = await held('legacy');
    expect(adopted.bot.id).toBe(untagged.id);
    expect(adopted.membership.id).toBe(membership?.id);
    expect((await plan(config)).changes).toEqual([]);
  });

  test('bots-disabled and cron-disabled, from the project itself', async () => {
    const scheduled = { echo: { ...bots.echo, cron: '0 14 * * *' } as BotConfig };
    expect((await missingFeatures(await connect(project), scheduled)).map((e) => e.code)).toEqual([
      'cron-disabled',
    ]);
    const bare = await newServerProject(true, []);
    expect((await missingFeatures(await connect(bare), bots)).map((e) => e.code)).toEqual([
      'bots-disabled',
    ]);
  });
});

describe.skipIf(!server)('push runs the bots step after the project', { timeout: 120_000 }, () => {
  test('--dry-run and --check plan the bots; a push converges them; a hand edit is drift', async () => {
    const project = await newProject();
    const dir = mkdtempSync(join(tmpdir(), 'plumb-push-bots-'));
    const file = join(dir, 'echo.cjs');
    writeFileSync(file, ECHO);
    const lockPath = join(dir, 'plumb.lock');
    await fetchPackages({ igs: [], lockPath });
    const code = (await build({ ...CHECKER_BUILD, write: false })).outputFiles[0]?.text ?? '';
    const options = {
      config: {
        igs: [],
        profiles: [],
        out: '',
        project: { accessPolicies: { echo: { resource: [{ resourceType: 'Patient' }] } } },
        bots: { echo: { file, runtime: 'vmcontext', policy: 'echo' } as BotConfig },
      },
      environment: { name: 'test', ...project },
      lockPath,
      checker: { code, version: '0.12.0' },
      reportPath: join(dir, '.plumb/validate-test.json'),
    };

    const before = await push({ ...options, check: true });
    expect(before.steps.map((s) => s.name)).toEqual([
      'load',
      'connect',
      'plan',
      'project',
      'bots',
      'check',
    ]);
    expect(before.steps.at(-1)).toMatchObject({
      summary: 'drift: 1 project change, 1 bot',
      failed: true,
    });

    const dry = await push({ ...options, dryRun: true });
    expect(dry.steps.find((s) => s.name === 'bots')).toMatchObject({
      summary: 'plan: 1 to create, 0 to update, 1 to deploy, 0 to disconnect',
      warnings: ['+ Bot  echo  vmcontext, policy echo'],
    });
    const medplum = await connect(project);
    expect(await medplum.searchResources('Bot', { name: 'echo' })).toHaveLength(0);

    const pushed = await push(options);
    expect(pushed.errors).toEqual([]);
    expect(pushed.steps.filter((s) => s.name === 'bots').map((s) => s.summary)).toEqual([
      'plan: 1 to create, 0 to update, 1 to deploy, 0 to disconnect',
      'applied 1 change',
    ]);
    expect((await push({ ...options, check: true })).steps.at(-1)).toMatchObject({
      summary: 'no drift',
    });

    const bot = (await medplum.searchOne('Bot', { name: 'echo' })) as Bot;
    await medplum.updateResource({ ...bot, timeout: 60 });
    const drifted = await push({ ...options, check: true });
    expect(drifted.steps.find((s) => s.name === 'bots')?.warnings).toEqual([
      '~ Bot  echo (timeout)',
    ]);
    expect(drifted.steps.at(-1)).toMatchObject({ summary: 'drift: 1 bot', failed: true });

    // A blocked plan is a problem found, as content's is: no error, and the drift line still prints.
    await medplum.post<Bot>(`admin/projects/${project.projectId}/bot`, {
      name: 'legacy',
      runtimeVersion: 'vmcontext',
    });
    const legacy = { ...options.config.bots, legacy: { file, runtime: 'vmcontext' } as BotConfig };
    const blocked = await push({
      ...options,
      config: { ...options.config, bots: legacy },
      check: true,
    });
    expect(blocked.errors).toEqual([]);
    expect(blocked.bots?.blocked).toMatchObject([{ code: 'untagged-bot' }]);
    expect(blocked.steps.find((s) => s.name === 'bots')).toMatchObject({
      failed: true,
      warnings: expect.arrayContaining(['Bot "legacy" exists untagged; adopt it with --adopt.']),
    });
    expect(blocked.steps.at(-1)).toMatchObject({
      name: 'check',
      summary: expect.stringContaining('1 blocked'),
    });
  });
});

describe.skipIf(!server)('a policy grants bots by key', { timeout: 120_000 }, () => {
  test("a client whose policy grants bots: ['x'] can run x and not y", async () => {
    const project = await newProject();
    const dir = mkdtempSync(join(tmpdir(), 'plumb-bot-access-'));
    const file = join(dir, 'echo.cjs');
    writeFileSync(file, ECHO);
    const medplum = await connect(project);
    const policies = {
      accessPolicies: { runner: { resource: [{ resourceType: 'Bot', bots: ['x'] }] } },
    };
    await applyProject(await planProject(policies, medplum), medplum);
    const bots = {
      x: { file, runtime: 'vmcontext' } as BotConfig,
      y: { file, runtime: 'vmcontext' } as BotConfig,
    };
    await applyBots(await planBots(medplum, bots), medplum);
    const id = async (key: string) =>
      (await medplum.searchOne('Bot', { identifier: `${PLUMB_SYSTEM}|${key}` }))?.id as string;

    const runner = await connectAs(project, { accessPolicy: 'runner' });
    expect(await runner.executeBot(await id('x'), { hello: 'x' }, 'application/json')).toEqual({
      echoed: { hello: 'x' },
    });
    await expect(
      runner.executeBot(await id('y'), { hello: 'y' }, 'application/json'),
    ).rejects.toThrow(/^(Not found|Forbidden)$/);
  });
});
