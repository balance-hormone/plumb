// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { MedplumClient } from '@medplum/core';
import type { Bundle } from '@medplum/fhirtypes';
import type { TestProject } from 'vitest/node';
import { startServer, stopServer } from '../../src/testing.js';

// The mock client enforces neither profiles, strict mode nor access policies, so
// server claims are tested against Medplum itself, in Docker. It runs in CI's
// server job, or locally with PLUMB_SERVER=1; each run gets a project of its own.
const BASE_URL = 'http://localhost:8103/';
// Seeded by the test server on its first boot.
const SUPER_ADMIN = ['00000000-0000-4000-8000-000000000001', 'plumb-test-super-admin'] as const;

export interface TestServer {
  baseUrl: string;
  projectId: string;
  clientId: string;
  clientSecret: string;
}

declare module 'vitest' {
  interface ProvidedContext {
    medplum: TestServer | undefined;
  }
}

export default async function setup(project: TestProject) {
  project.provide('medplum', undefined);
  if (!process.env.PLUMB_SERVER) return;
  const server = startServer({ test: { server: process.env.PLUMB_MEDPLUM_SERVER } });
  if (!server.ok) {
    if (server.error.code === 'docker-unavailable' && !process.env.CI) {
      console.warn('Docker is not running, so the Medplum server tests are skipped.');
      return;
    }
    throw new Error(server.error.message);
  }
  project.provide('medplum', await newProject(SEED));
  // A server already running, as one left by an interrupted run, is left running.
  return () => stopServer(server);
}

/**
 * A strict project with bots, a CI client that is its admin, and synthetic
 * data. Tests that count what a project holds make their own; tests of what a
 * loose project stores make one with `strictMode: false`.
 */
export async function newProject(seed?: Bundle, { strictMode = true } = {}): Promise<TestServer> {
  const admin = new MedplumClient({ baseUrl: BASE_URL });
  await admin.startClientLogin(...SUPER_ADMIN);
  const project = await admin.createResource({
    resourceType: 'Project',
    name: `plumb-test-${crypto.randomUUID()}`,
    strictMode,
    features: ['bots'],
  });
  const client = await admin.post(`admin/projects/${project.id}/client`, { name: 'Plumb CI' });
  const membership = await admin.searchOne('ProjectMembership', {
    profile: `ClientApplication/${client.id}`,
  });
  if (!membership) throw new Error('The CI client has no membership.');
  await admin.updateResource({ ...membership, admin: true });

  const ci = new MedplumClient({ baseUrl: BASE_URL });
  await ci.startClientLogin(client.id, client.secret);
  if (seed) await ci.executeBatch(seed);
  return {
    baseUrl: BASE_URL,
    projectId: project.id,
    clientId: client.id,
    clientSecret: client.secret,
  };
}

/** Links `linked` into `project`, which only a super admin can do. */
export async function linkProject(project: string, linked: string): Promise<void> {
  const admin = new MedplumClient({ baseUrl: BASE_URL });
  await admin.startClientLogin(...SUPER_ADMIN);
  const current = await admin.readResource('Project', project);
  await admin.updateResource({
    ...current,
    link: [{ project: { reference: `Project/${linked}` } }],
  });
}

const SEED: Bundle = {
  resourceType: 'Bundle',
  type: 'transaction',
  entry: [
    {
      fullUrl: 'urn:uuid:7d0c4f55-5b51-4f3e-9d0b-0d8a2b1e6a01',
      request: { method: 'POST', url: 'Patient' },
      resource: {
        resourceType: 'Patient',
        name: [{ family: 'Synthetic', given: ['Ada'] }],
        gender: 'female',
      },
    },
    {
      request: { method: 'POST', url: 'Observation' },
      resource: {
        resourceType: 'Observation',
        status: 'final',
        code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
        subject: { reference: 'urn:uuid:7d0c4f55-5b51-4f3e-9d0b-0d8a2b1e6a01' },
        valueQuantity: {
          value: 72,
          unit: '/min',
          system: 'http://unitsofmeasure.org',
          code: '/min',
        },
      },
    },
  ],
};
