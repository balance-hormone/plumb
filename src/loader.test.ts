// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementDefinitionBinding, StructureDefinition } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { type LoadProfilesResult, loadProfiles } from './loader.js';

const FIXTURES = join(import.meta.dirname, '../test/fixtures');
const LOCAL = join(FIXTURES, 'profiles/fsh-generated/resources');
const PLUMB = 'http://example.org/fhir/plumb-test/StructureDefinition';
const US_CORE = 'http://hl7.org/fhir/us/core/StructureDefinition';

// US Core 9.0.0 and trimmed copies of the dependencies its profiles use.
const usCorePackages = readdirSync(join(FIXTURES, 'packages')).map((folder) => {
  const [name, version] = folder.split('#') as [string, string];
  return { name, version, dir: join(FIXTURES, 'packages', folder) };
});
const US_CORE_IG = 'hl7.fhir.us.core@9.0.0';

const codes = (result: LoadProfilesResult) => result.errors.map((e) => e.code);

function read(file: string): StructureDefinition {
  return JSON.parse(readFileSync(join(LOCAL, file), 'utf8')) as StructureDefinition;
}

/** A local folder holding the given resources. */
function localFolder(...resources: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'plumb-local-'));
  resources.forEach((r, i) => {
    writeFileSync(join(dir, `resource-${i}.json`), JSON.stringify(r));
  });
  return dir;
}

/** A package in the cache layout, declaring the given dependencies. */
function cachedPackage(id: string, dependencies: Record<string, string>, ...resources: object[]) {
  const [name, version] = id.split('@') as [string, string];
  const dir = join(mkdtempSync(join(tmpdir(), 'plumb-pkg-')), `${name}#${version}`);
  mkdirSync(join(dir, 'package'), { recursive: true });
  writeFileSync(
    join(dir, 'package', 'package.json'),
    JSON.stringify({ name, version, fhirVersions: ['4.0.1'], dependencies }),
  );
  resources.forEach((r, i) => {
    writeFileSync(join(dir, 'package', `resource-${i}.json`), JSON.stringify(r));
  });
  return { name, version, dir };
}

/** A synthetic profile, copied from one of Plumb's test profiles with a new URL. */
function variant(file: string, url: string, change: (sd: StructureDefinition) => void = () => {}) {
  const sd = read(file);
  sd.url = url;
  change(sd);
  return sd;
}

describe('loadProfiles', () => {
  test('loads a local profile, parsed by Medplum', () => {
    const result = loadProfiles({
      packages: [],
      igs: [],
      local: LOCAL,
      profiles: [`${PLUMB}/cardinality-patient`],
    });
    expect(codes(result)).toEqual([]);
    expect(result.ok).toBe(true);
    const [profile] = result.profiles;
    expect(profile?.source).toBe('local');
    expect(profile?.schema.url).toBe(`${PLUMB}/cardinality-patient`);
    expect(profile?.schema.type).toBe('Patient');
    expect(profile?.schema.elements.birthDate?.min).toBe(1);
  });

  test('closes over the parent chain, extensions and reference targets', () => {
    const result = loadProfiles({
      packages: [],
      igs: [],
      local: LOCAL,
      profiles: [
        `${PLUMB}/child-observation`,
        `${PLUMB}/extensions-patient`,
        `${PLUMB}/references-observation`,
      ],
    });
    expect(codes(result)).toEqual([]);
    expect(result.definitions.get(`${PLUMB}/parent-observation`)?.source).toBe('local');
    expect(result.definitions.get(`${PLUMB}/care-note`)?.source).toBe('local');
    expect(result.definitions.get(`${PLUMB}/cardinality-patient`)?.source).toBe('local');
    // Base resource definitions always come from Medplum.
    expect(
      result.definitions.get('http://hl7.org/fhir/StructureDefinition/Observation')?.source,
    ).toBe('base');
    // Only what the selected profiles need.
    expect(result.definitions.has(`${PLUMB}/sliced-patient`)).toBe(false);
  });

  test('closes over required bindings, recording what cannot be found offline', () => {
    const result = loadProfiles({
      packages: [],
      igs: [],
      local: LOCAL,
      profiles: [`${PLUMB}/bindings-patient`],
    });
    expect(codes(result)).toEqual([]);
    const vs = 'http://example.org/fhir/plumb-test/ValueSet';
    expect(result.definitions.get(`${vs}/plumb-test-colors-vs`)?.source).toBe('local');
    expect(
      result.definitions.get('http://example.org/fhir/plumb-test/CodeSystem/plumb-test-colors')
        ?.source,
    ).toBe('local');
    expect(
      result.definitions.get('http://hl7.org/fhir/ValueSet/administrative-gender')?.source,
    ).toBe('base');
    expect(result.unresolved.map((u) => u.url)).toContain('http://snomed.info/sct');
  });

  test('follows required bindings, extensible ones on codes, and value sets a value set includes', () => {
    const vs = 'http://example.org/fhir/plumb-test/ValueSet';
    const valueSet = (name: string, compose: object) => ({
      resourceType: 'ValueSet',
      url: `${vs}/${name}`,
      status: 'active',
      compose,
    });
    const local = localFolder(
      valueSet('outer', { include: [{ valueSet: [`${vs}/inner`] }] }),
      valueSet('inner', { include: [{ system: 'http://hl7.org/fhir/administrative-gender' }] }),
      valueSet('loose', { include: [{ system: 'http://hl7.org/fhir/administrative-gender' }] }),
      valueSet('coded', { include: [{ system: 'http://hl7.org/fhir/administrative-gender' }] }),
      variant('StructureDefinition-cardinality-patient.json', `${PLUMB}/bound`, (sd) => {
        const bindings: Record<string, ElementDefinitionBinding> = {
          'Patient.gender': { strength: 'required', valueSet: `${vs}/outer` },
          'Patient.maritalStatus': { strength: 'extensible', valueSet: `${vs}/loose` },
          'Patient.language': { strength: 'extensible', valueSet: `${vs}/coded` },
        };
        for (const e of sd.snapshot?.element ?? []) e.binding = bindings[e.path] ?? e.binding;
      }),
    );
    const result = loadProfiles({ packages: [], igs: [], local, profiles: [`${PLUMB}/bound`] });
    expect(codes(result)).toEqual([]);
    expect(result.definitions.has(`${vs}/inner`)).toBe(true);
    // Extensible on a CodeableConcept is not followed; on a code it is.
    expect(result.definitions.has(`${vs}/loose`)).toBe(false);
    expect(result.definitions.has(`${vs}/coded`)).toBe(true);
  });

  test('profile-not-found', () => {
    const result = loadProfiles({
      packages: [],
      igs: [],
      local: LOCAL,
      profiles: [`${PLUMB}/no-such-profile`],
    });
    expect(codes(result)).toEqual(['profile-not-found']);
  });

  test('no-snapshot', () => {
    const local = localFolder(
      variant('StructureDefinition-cardinality-patient.json', `${PLUMB}/bare`, (sd) => {
        delete sd.snapshot;
      }),
    );
    const result = loadProfiles({ packages: [], igs: [], local, profiles: [`${PLUMB}/bare`] });
    expect(codes(result)).toEqual(['no-snapshot']);
  });

  test('not-r4', () => {
    const local = localFolder(
      variant('StructureDefinition-cardinality-patient.json', `${PLUMB}/r5`, (sd) => {
        // R5's version is outside R4's fhirVersion type.
        (sd as { fhirVersion?: string }).fhirVersion = '5.0.0';
      }),
    );
    const result = loadProfiles({ packages: [], igs: [], local, profiles: [`${PLUMB}/r5`] });
    expect(codes(result)).toEqual(['not-r4']);
  });

  test('unresolved-reference: a parent nothing provides', () => {
    const local = localFolder(
      variant('StructureDefinition-child-observation.json', `${PLUMB}/orphan`),
    );
    const result = loadProfiles({ packages: [], igs: [], local, profiles: [`${PLUMB}/orphan`] });
    expect(codes(result)).toEqual(['unresolved-reference']);
    expect(result.errors[0]?.url).toBe(`${PLUMB}/parent-observation`);
  });

  test('duplicate-definition: a local folder redefining a URL', () => {
    const local = localFolder(
      variant(
        'StructureDefinition-cardinality-patient.json',
        'http://hl7.org/fhir/StructureDefinition/vitalsigns',
      ),
    );
    const result = loadProfiles({
      packages: [],
      igs: [],
      local,
      profiles: ['http://hl7.org/fhir/StructureDefinition/vitalsigns'],
    });
    expect(codes(result)).toEqual(['duplicate-definition']);
  });

  describe('precedence', () => {
    const genderUrl = 'http://hl7.org/fhir/ValueSet/administrative-gender';
    const newerGender = {
      resourceType: 'ValueSet',
      url: genderUrl,
      version: '9.9.9',
      status: 'active',
      compose: { include: [{ system: 'http://hl7.org/fhir/administrative-gender' }] },
    };
    // A profile binding Patient.gender to administrative-gender without a version.
    const bound = (url: string) =>
      variant('StructureDefinition-cardinality-patient.json', url, (sd) => {
        for (const e of sd.snapshot?.element ?? []) {
          if (e.path === 'Patient.gender')
            e.binding = { strength: 'required', valueSet: genderUrl };
        }
      });

    test('an IG resolves against its own dependencies before base R4', () => {
      const dep = cachedPackage('example.fhir.terms@1.0.0', {}, newerGender);
      const ig = cachedPackage(
        'example.fhir.ig@1.0.0',
        { 'example.fhir.terms': '1.0.0' },
        bound(`${PLUMB}/in-ig`),
      );
      const result = loadProfiles({
        packages: [ig, dep],
        igs: ['example.fhir.ig@1.0.0'],
        profiles: [`${PLUMB}/in-ig`],
      });
      expect(codes(result)).toEqual([]);
      expect(result.definitions.get(genderUrl)?.source).toBe('example.fhir.terms@1.0.0');
      expect(result.definitions.get(genderUrl)?.resource.version).toBe('9.9.9');
    });

    test('an IG resolves against itself before its dependencies', () => {
      const dep = cachedPackage('example.fhir.terms@1.0.0', {}, newerGender);
      const ig = cachedPackage(
        'example.fhir.ig@1.0.0',
        { 'example.fhir.terms': '1.0.0' },
        { ...newerGender, version: '8.8.8' },
        bound(`${PLUMB}/in-ig`),
      );
      const result = loadProfiles({
        packages: [ig, dep],
        igs: ['example.fhir.ig@1.0.0'],
        profiles: [`${PLUMB}/in-ig`],
      });
      expect(codes(result)).toEqual([]);
      expect(result.definitions.get(genderUrl)?.resource.version).toBe('8.8.8');
    });

    test('a pinned version wins over precedence', () => {
      const dep = cachedPackage('example.fhir.terms@1.0.0', {}, newerGender);
      const pinned = variant(
        'StructureDefinition-cardinality-patient.json',
        `${PLUMB}/pinned`,
        (sd) => {
          for (const e of sd.snapshot?.element ?? []) {
            if (e.path === 'Patient.gender') {
              e.binding = { strength: 'required', valueSet: `${genderUrl}|4.0.1` };
            }
          }
        },
      );
      const ig = cachedPackage('example.fhir.ig@1.0.0', { 'example.fhir.terms': '1.0.0' }, pinned);
      const result = loadProfiles({
        packages: [ig, dep],
        igs: ['example.fhir.ig@1.0.0'],
        profiles: [`${PLUMB}/pinned`],
      });
      expect(codes(result)).toEqual([]);
      expect(result.definitions.get(genderUrl)?.source).toBe('base');
    });

    test('a definition resolves its own references in its own source first', () => {
      // A dependency shipping a newer code system that base R4's value set also uses.
      const newerCodes = {
        resourceType: 'CodeSystem',
        url: 'http://hl7.org/fhir/administrative-gender',
        version: '9.9.9',
        status: 'active',
        content: 'complete',
        concept: [{ code: 'other-codes' }],
      };
      const dep = cachedPackage('example.fhir.terms@1.0.0', {}, newerCodes);
      const pinned = variant(
        'StructureDefinition-cardinality-patient.json',
        `${PLUMB}/own`,
        (sd) => {
          for (const e of sd.snapshot?.element ?? []) {
            if (e.path === 'Patient.gender') {
              e.binding = { strength: 'required', valueSet: `${genderUrl}|4.0.1` };
            }
          }
        },
      );
      const ig = cachedPackage('example.fhir.ig@1.0.0', { 'example.fhir.terms': '1.0.0' }, pinned);
      const result = loadProfiles({
        packages: [ig, dep],
        igs: ['example.fhir.ig@1.0.0'],
        profiles: [`${PLUMB}/own`],
      });
      expect(codes(result)).toEqual([]);
      expect(
        result.definitions.get('http://hl7.org/fhir/administrative-gender')?.resource.version,
      ).toBe('4.0.1');
    });

    test('a base resource definition always comes from Medplum', () => {
      const shadow = { ...read('StructureDefinition-cardinality-patient.json') };
      shadow.url = 'http://hl7.org/fhir/StructureDefinition/Patient';
      const ig = cachedPackage('example.fhir.ig@1.0.0', {}, shadow, bound(`${PLUMB}/in-ig`));
      const result = loadProfiles({
        packages: [ig],
        igs: ['example.fhir.ig@1.0.0'],
        profiles: [`${PLUMB}/in-ig`],
      });
      expect(codes(result)).toEqual([]);
      expect(
        result.definitions.get('http://hl7.org/fhir/StructureDefinition/Patient')?.source,
      ).toBe('base');
    });

    test('two IGs resolving one URL differently is a warning', () => {
      const dep = cachedPackage('example.fhir.terms@1.0.0', {}, newerGender);
      const first = cachedPackage(
        'example.fhir.first@1.0.0',
        { 'example.fhir.terms': '1.0.0' },
        bound(`${PLUMB}/first`),
      );
      const second = cachedPackage('example.fhir.second@1.0.0', {}, bound(`${PLUMB}/second`));
      const result = loadProfiles({
        packages: [first, second, dep],
        igs: ['example.fhir.first@1.0.0', 'example.fhir.second@1.0.0'],
        profiles: [`${PLUMB}/first`, `${PLUMB}/second`],
      });
      expect(codes(result)).toEqual([]);
      expect(result.warnings.map((w) => [w.code, w.url])).toEqual([
        ['version-conflict', genderUrl],
      ]);
    });
  });

  test('name/* selects only constraints on resources, sorted by URL', () => {
    const custom = variant(
      'StructureDefinition-cardinality-patient.json',
      `${PLUMB}/custom`,
      (sd) => {
        sd.derivation = 'specialization';
      },
    );
    const ig = cachedPackage(
      'example.fhir.ig@1.0.0',
      {},
      variant('StructureDefinition-cardinality-patient.json', `${PLUMB}/zeta`),
      custom,
      variant('StructureDefinition-cardinality-patient.json', `${PLUMB}/alpha`),
    );
    const result = loadProfiles({
      packages: [ig],
      igs: ['example.fhir.ig@1.0.0'],
      profiles: ['example.fhir.ig/*'],
    });
    expect(codes(result)).toEqual([]);
    expect(result.profiles.map((p) => p.url)).toEqual([`${PLUMB}/alpha`, `${PLUMB}/zeta`]);
  });

  describe('US Core 9.0.0', () => {
    test('loads Blood Pressure with its parent chain', () => {
      const result = loadProfiles({
        packages: usCorePackages,
        igs: [US_CORE_IG],
        profiles: [`${US_CORE}/us-core-blood-pressure`],
      });
      expect(codes(result)).toEqual([]);
      expect(result.profiles[0]?.source).toBe(US_CORE_IG);
      expect(result.definitions.get(`${US_CORE}/us-core-vital-signs`)?.source).toBe(US_CORE_IG);
      expect(
        result.definitions.get('http://hl7.org/fhir/StructureDefinition/vitalsigns')?.source,
      ).toBe('base');
    });

    test('loads every resource profile except the one Medplum cannot parse', () => {
      const dir = join(FIXTURES, 'packages/hl7.fhir.us.core#9.0.0/package');
      const urls = readdirSync(dir)
        .filter((f) => f.startsWith('StructureDefinition-'))
        .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as StructureDefinition)
        .filter((sd) => sd.kind === 'resource' && sd.derivation === 'constraint')
        .map((sd) => sd.url);
      const provenance = `${US_CORE}/us-core-provenance`;
      const result = loadProfiles({
        packages: usCorePackages,
        igs: [US_CORE_IG],
        profiles: urls.filter((url) => url !== provenance),
      });
      expect(result.errors).toEqual([]);
      expect(result.profiles).toHaveLength(urls.length - 1);
    });

    test('name/* selects every resource profile in the IG, skipping what Medplum cannot parse', () => {
      const result = loadProfiles({
        packages: usCorePackages,
        igs: [US_CORE_IG],
        profiles: ['hl7.fhir.us.core/*'],
      });
      expect(codes(result)).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.profiles).toHaveLength(54);
      expect(result.profiles.every((p) => p.source === US_CORE_IG)).toBe(true);
      expect(result.profiles.every((p) => p.sd.kind === 'resource')).toBe(true);
      // Extensions are dependencies only, and a dependency's profiles are not selected.
      expect(result.profiles.some((p) => p.url.endsWith('us-core-race'))).toBe(false);
      expect(result.definitions.get(`${US_CORE}/us-core-race`)?.source).toBe(US_CORE_IG);
      expect(result.profiles.some((p) => p.url.includes('/uv/sdc/'))).toBe(false);
      expect(result.warnings.map((w) => [w.code, w.url])).toContainEqual([
        'unparseable-skipped',
        `${US_CORE}/us-core-provenance`,
      ]);
      // Deterministic: sorted by URL.
      const urls = result.profiles.map((p) => p.url);
      expect(urls).toEqual([...urls].sort());
    });

    test('a profile selected both by URL and by name/* is loaded once', () => {
      const result = loadProfiles({
        packages: usCorePackages,
        igs: [US_CORE_IG],
        profiles: [`${US_CORE}/us-core-patient`, 'hl7.fhir.us.core/*'],
      });
      expect(codes(result)).toEqual([]);
      expect(result.profiles.filter((p) => p.url === `${US_CORE}/us-core-patient`)).toHaveLength(1);
      expect(result.profiles[0]?.url).toBe(`${US_CORE}/us-core-patient`);
    });

    test('a profile listed by URL is still an error when Medplum cannot parse it', () => {
      const result = loadProfiles({
        packages: usCorePackages,
        igs: [US_CORE_IG],
        profiles: [`${US_CORE}/us-core-provenance`, 'hl7.fhir.us.core/*'],
      });
      expect(codes(result)).toEqual(['unparseable']);
    });

    test('profile-not-found: name/* for a package that was not fetched', () => {
      const result = loadProfiles({
        packages: usCorePackages,
        igs: [US_CORE_IG, 'hl7.fhir.uv.ips@2.0.0'],
        profiles: ['hl7.fhir.uv.ips/*'],
      });
      expect(codes(result)).toEqual(['profile-not-found']);
    });

    test('unparseable: US Core Provenance', () => {
      const result = loadProfiles({
        packages: usCorePackages,
        igs: [US_CORE_IG],
        profiles: [`${US_CORE}/us-core-provenance`],
      });
      expect(codes(result)).toEqual(['unparseable']);
    });
  });
});
