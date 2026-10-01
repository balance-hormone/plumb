// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest';
import { connect } from './connect.js';

// Logging in and reading strict mode are server claims, tested in test/server.
test('connect-failed, for a server that cannot be reached', async () => {
  const result = await connect({
    name: 'prod',
    baseUrl: 'http://127.0.0.1:9/',
    clientId: 'id',
    clientSecret: 'secret',
  });
  expect(!result.ok && result.error.code).toBe('connect-failed');
  expect(!result.ok && result.error.message).toMatch(
    /^Could not log in to http:\/\/127\.0\.0\.1:9\/ \(prod\): /,
  );
});
