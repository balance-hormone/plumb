// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { printFiles } from '../../src/emit/print.js';
import { routingRows } from '../../src/emit/routes.js';
import { transform } from '../../src/emit/transform.js';
import { compareFiles, writeFiles } from '../../src/emit/write.js';
import { loadProfiles } from '../../src/loader.js';

// Goldens detect change, not correctness: each file is read against its
// profile before it is committed. Regenerate with GOLDEN_UPDATE=1.
const US_CORE = 'http://hl7.org/fhir/us/core/StructureDefinition';
const IPS = 'http://hl7.org/fhir/uv/ips/StructureDefinition';
const PROFILES = [
  `${US_CORE}/us-core-patient`,
  `${US_CORE}/us-core-blood-pressure`,
  `${US_CORE}/us-core-observation-lab`,
  `${US_CORE}/us-core-condition-problems-health-concerns`,
  `${IPS}/Patient-uv-ips`,
  `${IPS}/Composition-uv-ips`,
];
const PACKAGES = join(import.meta.dirname, '../fixtures/packages');
const OUT = join(import.meta.dirname, 'generated');

test('generated output matches the committed goldens', () => {
  const loaded = loadProfiles({
    packages: readdirSync(PACKAGES).map((folder) => {
      const [name, version] = folder.split('#') as [string, string];
      return { name, version, dir: join(PACKAGES, folder) };
    }),
    igs: ['hl7.fhir.us.core@9.0.0', 'hl7.fhir.uv.ips@2.0.1'],
    profiles: PROFILES,
  });
  expect(loaded.errors).toEqual([]);
  const { models, errors } = transform(loaded);
  expect(errors).toEqual([]);
  // The fixtures are trimmed packages, so their hashes are not the registry's.
  const files = printFiles(
    models,
    () => 'fixture',
    routingRows(loaded, {
      defaultProfile: {
        Observation: [
          `${US_CORE}/us-core-vital-signs`,
          'https://example.org/fhir/StructureDefinition/org-observation',
        ],
      },
    }),
  );
  if (process.env.GOLDEN_UPDATE) expect(writeFiles(OUT, files).errors).toEqual([]);
  const { stale, errors: folder } = compareFiles(OUT, files);
  expect(folder).toEqual([]);
  expect(stale).toEqual([]);
});
