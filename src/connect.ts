// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { MedplumClient, normalizeErrorString } from '@medplum/core';
import type { ResolvedEnvironment } from './config.js';

export type ConnectResult =
  | { ok: true; medplum: MedplumClient; strictMode: boolean; ms: number }
  | { ok: false; error: { code: 'connect-failed'; message: string } };

/**
 * Logs in to an environment with its client credentials. Strict mode is
 * reported, never set: only a super admin can change it.
 */
export async function connect(environment: ResolvedEnvironment): Promise<ConnectResult> {
  const start = performance.now();
  const medplum = new MedplumClient({ baseUrl: environment.baseUrl });
  try {
    // The login reads GET /auth/me, which returns the project to any member.
    await medplum.startClientLogin(environment.clientId, environment.clientSecret);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'connect-failed',
        message: `Could not log in to ${environment.baseUrl} (${environment.name}): ${normalizeErrorString(err)}`,
      },
    };
  }
  return {
    ok: true,
    medplum,
    strictMode: medplum.getProject()?.strictMode === true,
    ms: Math.round(performance.now() - start),
  };
}
