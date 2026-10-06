// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0

// A project as one using plumb-fhir/vitest has it, with Plumb's synthetic profiles.
export default {
  igs: [],
  profiles: ['http://example.org/fhir/plumb-test/StructureDefinition/cardinality-patient'],
  local: '../profiles/fsh-generated/resources',
  out: './generated',
  project: {
    accessPolicies: {
      'front-desk': { name: 'Front desk', resource: [{ resourceType: 'Patient', readonly: true }] },
    },
  },
  // The release the outer server tests run, so this run reuses their server.
  test: { server: process.env.PLUMB_MEDPLUM_SERVER },
};
