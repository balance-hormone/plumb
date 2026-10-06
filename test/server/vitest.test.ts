// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { expect, test } from 'vitest';
import { server } from './medplum.js';

const FIXTURE = join(import.meta.dirname, '../fixtures/vitest');

// A project's own run, with plumb-fhir/vitest as its globalSetup, against the
// server this run started: it gets a project of its own, and leaves the server up.
test.skipIf(!server)(
  "a project's run gets a pushed project, and leaves a running server running",
  { timeout: 300_000 },
  () => {
    const run = spawnSync('npx', ['vitest', 'run', '--root', FIXTURE], {
      cwd: FIXTURE,
      encoding: 'utf8',
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    // CI forces colour, so the summary is matched without its escape codes.
    expect(stripVTControlCharacters(run.stdout)).toMatch(/Tests\s+2 passed/);
    const ps = spawnSync('docker', ['compose', '-p', 'plumb-medplum', 'ps', '-q', 'medplum'], {
      encoding: 'utf8',
    });
    expect(ps.stdout.trim()).not.toBe('');
  },
);
