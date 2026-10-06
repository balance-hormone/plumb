// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { MEDPLUM_VERSION } from '@medplum/core';
import type { PlumbConfig } from './config.js';

// One server per machine, found again by its compose project name.
const PROJECT = 'plumb-medplum';
const BASE_URL = 'http://localhost:8103/';

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
      MEDPLUM_DEFAULT_SUPER_ADMIN_CLIENT_ID: 00000000-0000-4000-8000-000000000001
      MEDPLUM_DEFAULT_SUPER_ADMIN_CLIENT_SECRET: plumb-test-super-admin
    # The image has no shell or curl, so the check is Node's own fetch.
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('${BASE_URL}healthcheck').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
      interval: 3s
      start_period: 30s
      retries: 100
`;
