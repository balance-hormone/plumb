// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { globSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MEDPLUM_VERSION, MedplumClient, normalizeErrorString } from '@medplum/core';
import type { Bundle, Project, ProjectMembership, Reference } from '@medplum/fhirtypes';
import { bundledChecker } from './checker/install.js';
import type { PlumbConfig } from './config.js';
import type { EnvStep } from './connect.js';
import { PLUMB_SYSTEM } from './project.js';
import { type PushResult, push } from './push.js';

// One server per machine, found again by its compose project name.
const PROJECT = 'plumb-medplum';
const BASE_URL = 'http://localhost:8103/';
// Seeded on the server's first boot. It works only on a server Plumb started,
// so a test project is never made anywhere else.
const SUPER_ADMIN = {
  clientId: '00000000-0000-4000-8000-000000000001',
  clientSecret: 'plumb-test-super-admin',
};

export type StartServerResult =
  | { ok: true; baseUrl: string; version: string; started: boolean }
  | { ok: false; error: { code: 'docker-unavailable' | 'server-unhealthy'; message: string } };

/** The Medplum server release a test server runs: `test.server`, or the installed `@medplum/core`'s. */
export function serverVersion(config: Pick<PlumbConfig, 'test'> = {}): string {
  // MEDPLUM_VERSION carries the build's commit, as 5.1.42-2a810b6; images are tagged 5.1.42.
  return config.test?.server ?? MEDPLUM_VERSION.replace(/-.*/, '');
}

/**
 * Starts Medplum, Postgres and Redis in Docker and waits for them to pass
 * their health checks, or reuses the server already running. `started` says
 * which, so `stopServer` removes only a server this call started.
 */
export function startServer(config: Pick<PlumbConfig, 'test'> = {}): StartServerResult {
  // A missing docker binary leaves status null.
  if (docker(['info']).status !== 0 || docker(['compose', 'version']).status !== 0) {
    return {
      ok: false,
      error: {
        code: 'docker-unavailable',
        message: 'Docker with Compose is not installed or not running; a test server needs it.',
      },
    };
  }
  const version = serverVersion(config);
  const running = docker([...COMPOSE, 'ps', '-q', 'medplum']).stdout.trim() !== '';
  const up = docker([...COMPOSE, '-f', '-', 'up', '--detach', '--wait'], composeFile(version));
  if (up.status !== 0) {
    return {
      ok: false,
      error: {
        code: 'server-unhealthy',
        message: `Medplum ${version} did not start and pass its health check:\n${up.stderr.trim()}`,
      },
    };
  }
  return { ok: true, baseUrl: BASE_URL, version, started: !running };
}

/** Removes the server and its data, if `startServer` started it; one already running is left. */
export function stopServer(server: { started: boolean }): void {
  if (server.started) docker([...COMPOSE, 'down', '--volumes']);
}

/** A project on the test server, reached as its admin client. */
export interface TestProject {
  baseUrl: string;
  projectId: string;
  clientId: string;
  clientSecret: string;
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

export type CreateTestProjectResult =
  | ({ ok: true; push: PushResult } & TestProject)
  | {
      ok: false;
      push: PushResult;
      error: { code: 'push-failed' | 'seed-refused'; message: string };
    };

/**
 * Makes a project on the test server as its super admin, pushes the config
 * into it as `push` does into any environment, then loads the seed Bundles in
 * order through the project's admin client.
 */
export async function createTestProject(
  config: PlumbConfig,
  options: TestProjectOptions,
): Promise<CreateTestProjectResult> {
  const project = await newProject(
    options.strictMode ?? config.test?.strictMode ?? true,
    options.features ?? config.test?.features ?? ['bots'],
  );
  const result = await push({
    // `test.settings` merge over `project.settings`, as an environment's do.
    config: {
      ...config,
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
    const failed = result.errors.map((e) => `${e.step}: ${e.message}`).join('\n');
    return {
      ok: false,
      push: result,
      error: { code: 'push-failed', message: `The push into the test project failed.\n${failed}` },
    };
  }
  const refused = await loadSeed(project, options.seed ?? config.test?.seed ?? []);
  if (refused)
    return { ok: false, push: result, error: { code: 'seed-refused', message: refused } };
  return { ok: true, push: result, ...project };
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

async function login(baseUrl: string, clientId: string, clientSecret: string) {
  const medplum = new MedplumClient({ baseUrl });
  await medplum.startClientLogin(clientId, clientSecret);
  return medplum;
}

// The test environment's credentials are passed resolved; these names are never read.
const ENV_REFS = { clientId: { env: '' }, clientSecret: { env: '' } };

async function newProject(strictMode: boolean, features: string[]): Promise<TestProject> {
  const admin = await login(BASE_URL, SUPER_ADMIN.clientId, SUPER_ADMIN.clientSecret);
  const project = await admin.createResource({
    resourceType: 'Project',
    name: `plumb-test-${crypto.randomUUID()}`,
    strictMode,
    // Medplum's own list of feature names; the config takes any, as Medplum may add one.
    features: features as Project['features'],
  });
  const client = await admin.post(`admin/projects/${project.id}/client`, {
    name: 'Plumb test admin',
  });
  const membership = await admin.searchOne('ProjectMembership', {
    profile: `ClientApplication/${client.id}`,
  });
  await admin.updateResource({ ...(membership as ProjectMembership), admin: true });
  return {
    baseUrl: BASE_URL,
    projectId: project.id,
    clientId: client.id,
    clientSecret: client.secret,
  };
}

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

const COMPOSE = ['compose', '-p', PROJECT];

const docker = (args: string[], input?: string) =>
  spawnSync('docker', args, { encoding: 'utf8', input, stdio: 'pipe' });

// Given to Compose on stdin, so the package needs no file path that differs
// between source, ESM and CJS.
const composeFile = (version: string) => `name: ${PROJECT}

services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: medplum
      POSTGRES_PASSWORD: medplum
    healthcheck:
      test: pg_isready -U medplum
      interval: 2s
      retries: 30

  redis:
    image: redis:7
    command: redis-server --requirepass medplum
    healthcheck:
      test: redis-cli -a medplum ping
      interval: 2s
      retries: 30

  medplum:
    image: medplum/medplum-server:${version}
    command: env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    ports:
      - 8103:8103
    environment:
      MEDPLUM_PORT: 8103
      MEDPLUM_BASE_URL: ${BASE_URL}
      MEDPLUM_APP_BASE_URL: http://localhost:3000/
      MEDPLUM_DATABASE_HOST: postgres
      MEDPLUM_DATABASE_PORT: 5432
      MEDPLUM_DATABASE_DBNAME: medplum
      MEDPLUM_DATABASE_USERNAME: medplum
      MEDPLUM_DATABASE_PASSWORD: medplum
      MEDPLUM_REDIS_HOST: redis
      MEDPLUM_REDIS_PORT: 6379
      MEDPLUM_REDIS_PASSWORD: medplum
      MEDPLUM_BINARY_STORAGE: file:./binary/
      MEDPLUM_SUPPORT_EMAIL: support@example.com
      # Bots run on vmcontext here; hosted Medplum runs them on Lambda.
      MEDPLUM_VM_CONTEXT_BOTS_ENABLED: 'true'
      # Bots created without a runtime, as push creates the checker, get this one.
      MEDPLUM_DEFAULT_BOT_RUNTIME_VERSION: vmcontext
      # Seeded on first boot, and used only to create test projects. The
      # server is Plumb's own and listens on localhost.
      MEDPLUM_DEFAULT_SUPER_ADMIN_CLIENT_ID: ${SUPER_ADMIN.clientId}
      MEDPLUM_DEFAULT_SUPER_ADMIN_CLIENT_SECRET: ${SUPER_ADMIN.clientSecret}
    # The image has no shell or curl, so the check is Node's own fetch.
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('${BASE_URL}healthcheck').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
      interval: 3s
      start_period: 30s
      retries: 100
`;
