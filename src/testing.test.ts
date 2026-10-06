// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDPLUM_VERSION } from '@medplum/core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { serverVersion, startServer, stopServer } from './testing.js';

// A stub docker on PATH, so Plumb's side of the contract (its commands, the
// compose file it pipes, how it reads the results) runs without Docker. The
// real one is exercised by every server test in CI.
const STUB = `#!/bin/sh
echo "$*" >> "$STUB_DIR/calls"
case "$*" in
  info) exit "\${STUB_INFO:-0}" ;;
  "compose version") exit 0 ;;
  *" ps "*) [ -n "$STUB_RUNNING" ] && echo 3f2a; exit 0 ;;
  *" up "*) cat > "$STUB_DIR/compose.yml"; echo "image pull failed" >&2; exit "\${STUB_UP:-0}" ;;
esac
`;

function stubDocker(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'plumb-docker-'));
  writeFileSync(join(dir, 'docker'), STUB);
  chmodSync(join(dir, 'docker'), 0o755);
  vi.stubEnv('PATH', `${dir}:${process.env.PATH}`);
  vi.stubEnv('STUB_DIR', dir);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return {
    calls: () => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n'),
    compose: () => readFileSync(join(dir, 'compose.yml'), 'utf8'),
    piped: () => existsSync(join(dir, 'compose.yml')),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const INSTALLED = MEDPLUM_VERSION.replace(/-.*/, '');

describe('startServer', () => {
  test('starts the installed @medplum/core release and waits for its health check', () => {
    const docker = stubDocker();
    expect(startServer()).toEqual({
      ok: true,
      baseUrl: 'http://localhost:8103/',
      version: INSTALLED,
      started: true,
    });
    expect(INSTALLED).toMatch(/^\d+\.\d+\.\d+$/);
    expect(docker.compose()).toContain(`image: medplum/medplum-server:${INSTALLED}\n`);
    expect(docker.calls()).toContain('compose -p plumb-medplum -f - up --detach --wait');
  });

  test('test.server picks the release', () => {
    const docker = stubDocker();
    const server = startServer({ test: { server: '5.1.0' } });
    expect(server.ok && server.version).toBe('5.1.0');
    expect(docker.compose()).toContain('image: medplum/medplum-server:5.1.0\n');
    expect(serverVersion({ test: { server: '5.1.0' } })).toBe('5.1.0');
  });

  test('reuses a running server, and stopServer leaves it running', () => {
    const docker = stubDocker({ STUB_RUNNING: '1' });
    const server = startServer();
    expect(server.ok && server.started).toBe(false);
    if (server.ok) stopServer(server);
    expect(docker.calls().some((call) => call.includes(' down'))).toBe(false);
  });

  test('stopServer removes a server it started, with its data', () => {
    const docker = stubDocker();
    const server = startServer();
    if (server.ok) stopServer(server);
    expect(docker.calls()).toContain('compose -p plumb-medplum down --volumes');
  });

  test('docker-unavailable, with Docker not running', () => {
    const docker = stubDocker({ STUB_INFO: '1' });
    const server = startServer();
    expect(!server.ok && server.error.code).toBe('docker-unavailable');
    expect(docker.piped()).toBe(false);
  });

  test('docker-unavailable, with no docker installed', () => {
    vi.stubEnv('PATH', mkdtempSync(join(tmpdir(), 'plumb-empty-')));
    const server = startServer();
    expect(!server.ok && server.error.code).toBe('docker-unavailable');
  });

  test("server-unhealthy, with Compose's own error", () => {
    stubDocker({ STUB_UP: '1' });
    const server = startServer({ test: { server: '5.1.42' } });
    expect(!server.ok && server.error).toEqual({
      code: 'server-unhealthy',
      message: 'Medplum 5.1.42 did not start and pass its health check:\nimage pull failed',
    });
  });
});
