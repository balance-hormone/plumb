// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Subscription } from '@medplum/fhirtypes';
import { build } from 'esbuild';
import { beforeAll, describe, expect, test } from 'vitest';
import { applyBots, planBots } from '../../src/bots.js';
import { CHECKER_BUILD } from '../../src/checker/bundle.js';
import type { BotConfig, SubscriptionConfig } from '../../src/config.js';
import { fetchPackages } from '../../src/packages.js';
import { PLUMB_SYSTEM, type ProjectOptions } from '../../src/project.js';
import { push } from '../../src/push.js';
import { applySubscriptions, planSubscriptions } from '../../src/subscriptions.js';
import { connect, server } from './medplum.js';
import { newProject, type TestProject } from './setup.js';

const ECHO = 'exports.handler = async (medplum, event) => ({ echoed: event.input?.id });';

describe.skipIf(!server)(
  'the subscriptions step converges Subscriptions',
  { timeout: 120_000 },
  () => {
    let project: TestProject;
    let medplum: MedplumClient;
    let botId: string;
    const subscriptions: Record<string, SubscriptionConfig> = {
      'new-patient': { criteria: 'Patient?gender=female', interactions: ['create'], bot: 'echo' },
    };

    beforeAll(async () => {
      project = await newProject();
      medplum = await connect(project);
      const file = join(mkdtempSync(join(tmpdir(), 'plumb-subscriptions-')), 'echo.cjs');
      writeFileSync(file, ECHO);
      const bots = { echo: { file, runtime: 'vmcontext' } as BotConfig };
      await applyBots(await planBots(medplum, bots), medplum);
      botId = (await medplum.searchOne('Bot', { identifier: `${PLUMB_SYSTEM}|echo` }))
        ?.id as string;
    }, 60_000);

    const plan = async (config = subscriptions, options?: ProjectOptions) =>
      planSubscriptions(await connect(project), config, options);
    const converge = async (config = subscriptions, options?: ProjectOptions) =>
      applySubscriptions(await plan(config, options), await connect(project), options?.env);
    const held = async (key: string) =>
      (await medplum.searchOne('Subscription', { _tag: `${PLUMB_SYSTEM}|${key}` })) as Subscription;

    test('a push creates the Subscription, delivering to the bot by its id', async () => {
      const first = await plan();
      expect(first.changes).toMatchObject([{ kind: '+', key: 'new-patient' }]);
      await applySubscriptions(first, await connect(project));
      expect(await held('new-patient')).toMatchObject({
        status: 'active',
        criteria: 'Patient?gender=female',
        channel: { type: 'rest-hook', endpoint: `Bot/${botId}` },
      });
      expect((await plan()).changes).toEqual([]);
    });

    test('a matching write runs the bot, seen in its AuditEvent', async () => {
      const patient = await medplum.createResource({ resourceType: 'Patient', gender: 'female' });
      let events: unknown[] = [];
      for (let i = 0; i < 60 && events.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 500));
        events = await medplum.searchResources('AuditEvent', { entity: `Bot/${botId}` });
      }
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).toContain(patient.id);
    });

    test('a criteria change updates the Subscription in place', async () => {
      const before = await held('new-patient');
      const changed = {
        'new-patient': { ...subscriptions['new-patient'], criteria: 'Patient?gender=male' },
      } as Record<string, SubscriptionConfig>;
      const planned = await plan(changed);
      expect(planned.changes).toMatchObject([{ kind: '~', fields: ['criteria'] }]);
      await applySubscriptions(planned, await connect(project));
      const after = await held('new-patient');
      expect(after.id).toBe(before.id);
      expect(after.criteria).toBe('Patient?gender=male');
      await converge();
    });

    test('a Subscription Medplum turned off is reported and set back to active', async () => {
      const current = await held('new-patient');
      await medplum.updateResource({ ...current, status: 'off', error: 'Received status 500' });
      const planned = await plan();
      expect(planned.changes).toMatchObject([
        { kind: '~', fields: ['status'], error: 'Received status 500' },
      ]);
      await applySubscriptions(planned, await connect(project));
      const after = await held('new-patient');
      expect(after.status).toBe('active');
      expect(after.error).toBeUndefined();
    });

    test('a URL delivery reads its secret and header from the environment, and the plan holds neither', async () => {
      const config = {
        ...subscriptions,
        'lab-hook': {
          criteria: 'DiagnosticReport?status=final',
          url: 'https://hooks.example.org/lab',
          secret: { env: 'PLUMB_TEST_HOOK_SECRET' },
          headers: { Authorization: { env: 'PLUMB_TEST_HOOK_TOKEN' } },
          maxAttempts: 2,
        },
      } as Record<string, SubscriptionConfig>;
      expect((await plan(config)).blocked).toEqual([
        {
          code: 'unset-variable',
          message:
            'PLUMB_TEST_HOOK_SECRET is not set: it holds its secret for Subscription lab-hook.',
        },
      ]);
      const env = { PLUMB_TEST_HOOK_SECRET: 's3cret-value', PLUMB_TEST_HOOK_TOKEN: 'Bearer t0ken' };
      const planned = await plan(config, { env });
      expect(JSON.stringify(planned)).not.toMatch(/s3cret-value|t0ken/);
      await applySubscriptions(planned, await connect(project), env);
      const stored = await held('lab-hook');
      expect(stored.channel).toMatchObject({
        endpoint: 'https://hooks.example.org/lab',
        header: ['Authorization: Bearer t0ken'],
      });
      expect(JSON.stringify(stored.extension)).toContain('s3cret-value');
      expect((await plan(config, { env })).changes).toEqual([]);
      const rotated = await plan(config, { env: { ...env, PLUMB_TEST_HOOK_SECRET: 'rotated' } });
      expect(rotated.changes).toMatchObject([
        { kind: '~', key: 'lab-hook', fields: ['extension'] },
      ]);
    });

    test('--prune turns a removed Subscription off; without it, it is kept', async () => {
      expect((await plan({})).changes).toMatchObject([
        { kind: '-', key: 'new-patient', kept: true },
        { kind: '-', key: 'lab-hook', kept: true },
      ]);
      await converge(
        { 'new-patient': subscriptions['new-patient'] as SubscriptionConfig },
        {
          prune: true,
        },
      );
      expect((await held('lab-hook')).status).toBe('off');
      expect((await held('new-patient')).status).toBe('active');
    });
  },
);

describe.skipIf(!server)('push runs the subscriptions step last', { timeout: 120_000 }, () => {
  test('--check finds a Subscription edited in the console', async () => {
    const project = await newProject();
    const dir = mkdtempSync(join(tmpdir(), 'plumb-push-subscriptions-'));
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
        bots: { echo: { file, runtime: 'vmcontext' } as BotConfig },
        subscriptions: { 'new-patient': { criteria: 'Patient', bot: 'echo' } },
      },
      environment: { name: 'test', ...project },
      lockPath,
      checker: { code, version: '0.12.0' },
      reportPath: join(dir, '.plumb/validate-test.json'),
    };

    // The bot does not exist yet, so the Subscription names it by key.
    const dry = await push({ ...options, dryRun: true });
    expect(dry.steps.find((s) => s.name === 'subscriptions')).toMatchObject({
      summary: 'plan: 1 to create, 0 to update, 0 to turn off',
      warnings: ['+ Subscription  new-patient  Patient → Bot echo'],
    });

    const pushed = await push(options);
    expect(pushed.errors).toEqual([]);
    expect(pushed.steps.map((s) => s.name).slice(-3)).toEqual([
      'bots',
      'subscriptions',
      'subscriptions',
    ]);
    expect((await push({ ...options, check: true })).steps.at(-1)).toMatchObject({
      summary: 'no drift',
    });

    const medplum = await connect(project);
    const stored = (await medplum.searchOne('Subscription', {
      _tag: `${PLUMB_SYSTEM}|new-patient`,
    })) as Subscription;
    await medplum.updateResource({ ...stored, criteria: 'Patient?gender=male' });
    const drifted = await push({ ...options, check: true });
    expect(drifted.steps.find((s) => s.name === 'subscriptions')?.warnings).toEqual([
      '~ Subscription  new-patient (criteria changed)',
    ]);
    expect(drifted.steps.at(-1)).toMatchObject({ summary: 'drift: 1 subscription', failed: true });
  });
});

describe.skipIf(!server)(
  'push leaves out what is scoped to another environment',
  { timeout: 120_000 },
  () => {
    test('a dev-only bot and its Subscription stay out of prod, and every push names them', async () => {
      const project = await newProject();
      const dir = mkdtempSync(join(tmpdir(), 'plumb-push-scope-'));
      const file = join(dir, 'echo.cjs');
      writeFileSync(file, ECHO);
      const lockPath = join(dir, 'plumb.lock');
      await fetchPackages({ igs: [], lockPath });
      const code = (await build({ ...CHECKER_BUILD, write: false })).outputFiles[0]?.text ?? '';
      const as = (name: string) => ({
        config: {
          igs: [],
          profiles: [],
          out: '',
          bots: {
            echo: { file, runtime: 'vmcontext' } as BotConfig,
            draft: { file, runtime: 'vmcontext', environments: ['dev'] } as BotConfig,
          },
          subscriptions: { 'to-draft': { criteria: 'Patient', bot: 'draft' } },
        },
        environment: { name, ...project },
        lockPath,
        checker: { code, version: '0.12.0' },
        reportPath: join(dir, '.plumb/validate-test.json'),
      });
      const scope = {
        name: 'scope',
        summary: '2 not in prod',
        warnings: ['Bot  draft  only in dev', 'Subscription  to-draft  only in dev'],
      };
      // A fresh login for each read, so nothing comes from a client's cache.
      const held = async () => {
        const fresh = await connect(project);
        return {
          draft: await fresh.searchOne('Bot', { identifier: `${PLUMB_SYSTEM}|draft` }),
          subscription: await fresh.searchOne('Subscription', {
            _tag: `${PLUMB_SYSTEM}|to-draft`,
          }),
        };
      };

      const prod = await push(as('prod'));
      expect(prod.errors).toEqual([]);
      expect(prod.steps.find((s) => s.name === 'scope')).toMatchObject(scope);
      expect(await held()).toEqual({ draft: undefined, subscription: undefined });
      const check = await push({ ...as('prod'), check: true });
      expect(check.steps.find((s) => s.name === 'scope')).toMatchObject(scope);
      expect(check.steps.at(-1)).toMatchObject({ summary: 'no drift' });

      const dev = await push(as('dev'));
      expect(dev.errors).toEqual([]);
      expect(dev.steps.some((s) => s.name === 'scope')).toBe(false);
      const created = await held();
      expect(created.draft).toBeDefined();
      expect(created.subscription).toMatchObject({ status: 'active' });

      // In the same project, prod now finds them and treats them as removed.
      await push({ ...as('prod'), prune: true });
      const pruned = await held();
      expect(pruned.draft?.id).toBe(created.draft?.id);
      expect(pruned.subscription).toMatchObject({ status: 'off' });
    });
  },
);
