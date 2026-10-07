// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { globSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type MedplumClient, normalizeErrorString } from '@medplum/core';
import type { Bundle, ProjectMembership, Reference } from '@medplum/fhirtypes';
import { bundledChecker } from './checker/install.js';
import type { LoadedConfig, PlumbConfig } from './config.js';
import type { EnvResult, EnvStep } from './connect.js';
import { migrateEnvironment } from './migrate.js';
import { PLUMB_SYSTEM } from './project.js';
import { push } from './push.js';
import { BASE_URL, login, newProject, TEST_PROJECT_VARIABLE, type TestProject } from './server.js';

export {
  type StartServerResult,
  serverVersion,
  startServer,
  stopServer,
  type TestProject,
} from './server.js';

/** The project `plumb-fhir/vitest` made for this run. */
export function testProject(): TestProject {
  const project = process.env[TEST_PROJECT_VARIABLE];
  if (!project) {
    throw new Error(
      'No test project: add plumb-fhir/vitest to globalSetup, and run the tests with Docker running.',
    );
  }
  return JSON.parse(project) as TestProject;
}

export interface TestProjectOptions {
  /** The project's `plumb.lock`, as `generate` wrote it. */
  lockPath: string;
  cacheDir?: string;
  /** Overrides `test.strictMode`. */
  strictMode?: boolean;
  /** Overrides `test.features`. */
  features?: string[];
  /** Overrides `test.seed`; paths and globs resolve against the working directory. */
  seed?: string[];
  /** Where `{ env }` secrets are read from; `process.env` by default. */
  env?: Record<string, string | undefined>;
  onStep?: (step: EnvStep<string>) => void;
}

/** What a push or a migration run did, as a test needs it: never its plans, which may change. */
export interface TestRun {
  ok: boolean;
  errors: { code: string; message: string; step: string }[];
  steps: EnvStep<string>[];
}

const summary = ({ ok, errors, steps }: EnvResult<string>): TestRun => ({ ok, errors, steps });

export type CreateTestProjectResult =
  | ({ ok: true; push: TestRun } & TestProject)
  | {
      ok: false;
      push: TestRun;
      error: { code: 'push-failed' | 'seed-refused'; message: string };
    };

/**
 * Makes a project on the test server as its super admin, pushes the config
 * into it as `push` does into any environment, then loads the seed Bundles in
 * order through the project's admin client.
 */
export async function createTestProject(
  config: LoadedConfig,
  options: TestProjectOptions,
): Promise<CreateTestProjectResult> {
  const project = await newProject(
    options.strictMode ?? config.test?.strictMode ?? true,
    options.features ?? config.test?.features ?? defaultFeatures(config),
  );
  const result = await push({
    // `test.settings` merge over `project.settings`, as an environment's do.
    config: {
      ...config,
      ...(config.bots ? { bots: testBots(config) } : {}),
      environments: { test: { ...ENV_REFS, baseUrl: BASE_URL, settings: config.test?.settings } },
    },
    environment: { name: 'test', ...project },
    lockPath: options.lockPath,
    cacheDir: options.cacheDir,
    checker: bundledChecker(),
    reportPath: join(mkdtempSync(join(tmpdir(), 'plumb-test-')), 'validate-test.json'),
    env: options.env ?? process.env,
    onStep: options.onStep,
  });
  if (!result.ok) {
    // A blocked plan is no error, so its step's lines say why.
    const failed = [
      ...result.errors.map((e) => `${e.step}: ${e.message}`),
      ...result.steps
        .filter((s) => s.failed)
        .flatMap((s) => s.warnings.map((w) => `${s.name}: ${w}`)),
    ].join('\n');
    return {
      ok: false,
      push: summary(result),
      error: { code: 'push-failed', message: `The push into the test project failed.\n${failed}` },
    };
  }
  const refused = await loadSeed(project, options.seed ?? config.test?.seed ?? []);
  if (refused)
    return { ok: false, push: summary(result), error: { code: 'seed-refused', message: refused } };
  return { ok: true, push: summary(result), ...project };
}

export interface TestMigrateOptions {
  /** The project's `plumb.lock`, as `generate` wrote it. */
  lockPath: string;
  cacheDir?: string;
  /** Apply the changes and keep the ledger; otherwise a dry run. */
  write?: boolean;
  /** Only these migrations, by id. */
  ids?: string[];
  /** Applied migrations to run again, by id. */
  rerun?: string[];
  onStep?: (step: EnvStep<string>) => void;
}

/**
 * Runs the config's migrations against a test project, as `plumb migrate
 * --local` does: in this process, with no bot deployed, since a test project
 * holds only synthetic data. A test seeds stale records, migrates, and
 * asserts on the counts or on what the project then holds.
 */
export async function migrate(
  project: TestProject,
  config: LoadedConfig,
  options: TestMigrateOptions,
): Promise<TestRun> {
  const result = await migrateEnvironment({
    config,
    environment: { name: 'test', ...project, synthetic: true },
    lockPath: options.lockPath,
    cacheDir: options.cacheDir,
    checker: bundledChecker(),
    local: true,
    write: options.write,
    ...(options.ids ? { ids: options.ids } : {}),
    ...(options.rerun ? { rerun: options.rerun } : {}),
    onStep: options.onStep,
  });
  return summary(result);
}

/** `bots`, and `cron` when a bot has a schedule, so the declared bots run as they would. */
const defaultFeatures = (config: PlumbConfig) =>
  Object.values(config.bots ?? {}).some((bot) => bot.cron) ? ['bots', 'cron'] : ['bots'];

/**
 * The bots as the test server runs them: every one on vmcontext, whatever its
 * `runtime`, from its `test.bots` build when the config names one.
 */
function testBots(config: PlumbConfig): PlumbConfig['bots'] {
  return Object.fromEntries(
    Object.entries(config.bots ?? {}).map(([key, bot]) => [
      key,
      { ...bot, runtime: 'vmcontext' as const, ...config.test?.bots?.[key] },
    ]),
  );
}

/** Who `connectAs` logs in as; the project's admin client when omitted. */
export type ConnectAs =
  | { client: string }
  | { accessPolicy: string; parameters?: Record<string, string | Reference> };

export class ConnectAsError extends Error {
  readonly code: 'unknown-client' | 'unknown-policy';
  constructor(code: ConnectAsError['code'], message: string) {
    super(message);
    this.name = 'ConnectAsError';
    this.code = code;
  }
}

/**
 * A client logged in to a test project: as its admin client, as a client the
 * config declares, or as a new client whose membership has one of the
 * config's AccessPolicies. Keys are found by the tag `push` gives what it
 * manages, so AccessPolicies are tested by acting as them.
 */
export async function connectAs(project: TestProject, as?: ConnectAs): Promise<MedplumClient> {
  const admin = await login(project.baseUrl, project.clientId, project.clientSecret);
  if (!as) return admin;
  if ('client' in as) {
    const client = await tagged(admin, 'ClientApplication', as.client);
    if (!client?.id || !client.secret) {
      throw new ConnectAsError('unknown-client', `No client "${as.client}" in project.clients.`);
    }
    return login(project.baseUrl, client.id, client.secret);
  }
  const policy = await tagged(admin, 'AccessPolicy', as.accessPolicy);
  if (!policy?.id) {
    throw new ConnectAsError(
      'unknown-policy',
      `No AccessPolicy "${as.accessPolicy}" in project.accessPolicies.`,
    );
  }
  const client = await admin.post(`admin/projects/${project.projectId}/client`, {
    name: `plumb-test-${as.accessPolicy}`,
  });
  const membership = (await admin.searchOne('ProjectMembership', {
    profile: `ClientApplication/${client.id}`,
  })) as ProjectMembership;
  const parameter = Object.entries(as.parameters ?? {}).map(([name, value]) =>
    typeof value === 'string' ? { name, valueString: value } : { name, valueReference: value },
  );
  await admin.updateResource({
    ...membership,
    access: [{ policy: { reference: `AccessPolicy/${policy.id}` }, parameter }],
  });
  return login(project.baseUrl, client.id, client.secret);
}

const tagged = <T extends 'ClientApplication' | 'AccessPolicy'>(
  medplum: MedplumClient,
  type: T,
  key: string,
) => medplum.searchOne(type, { _tag: `${PLUMB_SYSTEM}|${key}` });

// The test environment's credentials are passed resolved; these names are never read.
const ENV_REFS = { clientId: { env: '' }, clientSecret: { env: '' } };

/** Loads each seed file in order; returns why one was refused, naming its entry. */
async function loadSeed(project: TestProject, patterns: string[]): Promise<string | undefined> {
  const medplum = await connectAs(project);
  for (const pattern of patterns) {
    const files = globSync(resolve(pattern)).sort();
    if (files.length === 0) return `Seed ${pattern} matches no file.`;
    for (const file of files) {
      const refused = await loadSeedFile(medplum, file);
      if (refused) return refused;
    }
  }
  return undefined;
}

async function loadSeedFile(medplum: MedplumClient, file: string): Promise<string | undefined> {
  const bundle = JSON.parse(readFileSync(file, 'utf8')) as Bundle;
  if (bundle.resourceType !== 'Bundle' || !['transaction', 'batch'].includes(bundle.type)) {
    return `Seed ${file} is not a transaction or batch Bundle.`;
  }
  let response: Bundle;
  try {
    response = await medplum.executeBatch(bundle);
  } catch (err) {
    // A transaction is refused whole, with the server's issue.
    return `Seed ${file} was refused: ${normalizeErrorString(err)}`;
  }
  // A batch answers each entry on its own.
  const failed = response.entry?.findIndex((e) => !e.response?.status.startsWith('2')) ?? -1;
  if (failed < 0) return undefined;
  const outcome = response.entry?.[failed]?.response?.outcome;
  return `Seed ${file}, entry ${failed}, was refused: ${normalizeErrorString(outcome)}`;
}
