// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest';
import { connect } from '../../src/connect.js';
import { server } from './medplum.js';

const environment = () => ({
  name: 'test',
  baseUrl: server?.baseUrl ?? '',
  clientId: server?.clientId ?? '',
  clientSecret: server?.clientSecret ?? '',
});

test.skipIf(!server)('connects with client credentials and reports strict mode', async () => {
  const result = await connect(environment());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // setup.ts creates the test project strict.
  expect(result.strictMode).toBe(true);
  expect(result.medplum.getProject()?.id).toBe(server?.projectId);
});

test.skipIf(!server)('connect-failed, for a wrong client secret', async () => {
  const result = await connect({ ...environment(), clientSecret: 'wrong' });
  expect(!result.ok && result.error.code).toBe('connect-failed');
});
