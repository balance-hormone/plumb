// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { MedplumClient } from '@medplum/core';
import { inject } from 'vitest';

/** This run's test project, or undefined when the server tests are skipped. */
export const server = inject('medplum');

/** A client logged in to the test project as its CI ClientApplication, an admin. */
export async function connect(): Promise<MedplumClient> {
  if (!server) throw new Error('No Medplum server: run with PLUMB_SERVER=1.');
  const medplum = new MedplumClient({ baseUrl: server.baseUrl });
  await medplum.startClientLogin(server.clientId, server.clientSecret);
  return medplum;
}
