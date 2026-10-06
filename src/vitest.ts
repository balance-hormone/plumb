// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { startServer, stopServer, TEST_PROJECT_VARIABLE } from './server.js';
import { createTestProject } from './testing.js';

/**
 * Vitest's `globalSetup`: starts the test server, makes this run's project
 * from `plumb.config.ts` and hands it to `testProject()`. Without Docker it
 * fails in CI and, locally, warns and leaves `testProject()` to throw.
 */
export default async function setup(): Promise<(() => void) | undefined> {
  const loaded = await loadConfig({ cwd: process.cwd() });
  if (!loaded.ok) {
    throw new Error(`plumb: ${loaded.errors.map((e) => e.message).join('\n')}`);
  }
  const server = startServer(loaded.config);
  if (!server.ok) {
    if (server.error.code === 'docker-unavailable' && !process.env.CI) {
      console.warn(`plumb: ${server.error.message} Tests that need it fail.`);
      return undefined;
    }
    throw new Error(`plumb: ${server.error.message}`);
  }
  const project = await createTestProject(loaded.config, {
    lockPath: join(dirname(loaded.configPath), 'plumb.lock'),
  });
  if (!project.ok) {
    stopServer(server);
    throw new Error(`plumb: ${project.error.message}`);
  }
  const { baseUrl, projectId, clientId, clientSecret } = project;
  process.env[TEST_PROJECT_VARIABLE] = JSON.stringify({
    baseUrl,
    projectId,
    clientId,
    clientSecret,
  });
  return () => stopServer(server);
}
