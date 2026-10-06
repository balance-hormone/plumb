// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { printFiles } from '../../src/emit/print.js';
import { printQuestionnaire } from '../../src/emit/questionnaire.js';
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
// A synthetic Questionnaire, as content lists one.
const INTAKE = JSON.parse(
  readFileSync(join(import.meta.dirname, '../fixtures/content/Questionnaire-intake.json'), 'utf8'),
);

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
    [printQuestionnaire(INTAKE, () => undefined)],
  );
  if (process.env.GOLDEN_UPDATE) expect(writeFiles(OUT, files).errors).toEqual([]);
  const { stale, errors: folder } = compareFiles(OUT, files);
  expect(folder).toEqual([]);
  expect(stale).toEqual([]);
});

// An export nothing imports is reported by unused-export tools (knip) in
// every project that generates, so each one is the index's or a sibling's.
test('every generated export is re-exported by the index or imported by a sibling', () => {
  const files = readdirSync(OUT).filter((f) => f.endsWith('.ts'));
  const source = (f: string) => readFileSync(join(OUT, f), 'utf8');
  const used = new Set<string>();
  for (const f of files) {
    for (const [, names, from] of source(f).matchAll(
      /(?:import|export) \{([^}]*)\} from '\.\/(.+?)\.js'/g,
    )) {
      for (const name of (names as string).split(',')) {
        used.add(`${from}:${name.replace(/\btype\b/, '').trim()}`);
      }
    }
    for (const [, from] of source(f).matchAll(/export \* from '\.\/(.+?)\.js'/g))
      used.add(`${from}:*`);
  }
  const unused = files.flatMap((f) => {
    const module = f.replace(/\.ts$/, '');
    if (f === 'index.ts' || used.has(`${module}:*`)) return [];
    return [
      ...source(f).matchAll(/^export (?:async )?(?:const|function|class|type|interface) (\w+)/gm),
    ]
      .map(([, name]) => name as string)
      .filter((name) => !used.has(`${module}:${name}`))
      .map((name) => `${f}: ${name}`);
  });
  expect(unused).toEqual([]);
});
