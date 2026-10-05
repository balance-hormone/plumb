// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
export default {
  igs: [],
  profiles: ['http://example.org/fhir/plumb-test/StructureDefinition/cardinality-patient'],
  local: '../profiles/fsh-generated/resources',
  out: './generated',
  check: { tsconfig: 'tsconfig.json', baseline: './baseline.json', ignore: ['**/*.stories.ts'] },
};
