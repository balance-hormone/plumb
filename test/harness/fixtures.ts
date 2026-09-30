// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  indexStructureDefinitionBundle,
  loadDataType,
  OperationOutcomeError,
  validateResource,
} from '@medplum/core';
import { readJson } from '@medplum/definitions';
import type { Bundle, Resource, StructureDefinition } from '@medplum/fhirtypes';

const FIXTURES = join(import.meta.dirname, '../fixtures');
const US_CORE = join(FIXTURES, 'packages/hl7.fhir.us.core#9.0.0/package');
const SYNTHETIC = join(FIXTURES, 'profiles/fsh-generated/resources');

export interface ContractFixture {
  name: string;
  rule: string;
  conforms: boolean;
  compiles: boolean;
  validates: boolean;
  typeGap?: string;
  validatorGap?: string;
  resource: Resource;
}

export interface ContractTable {
  file: string;
  profile: string;
  matrix: string[];
  note?: string;
  assignableTo?: string[];
  fixtures: ContractFixture[];
}

export interface UsCoreExpectations {
  baseTypeOnly: { files: Record<string, string> };
  bundles: { files: string[] };
  primitiveExtensions: { files: string[] };
  unparseableProfiles: { profiles: Record<string, string> };
}

/** One resource from US Core's examples, and the profile it is checked against. */
export interface UsCoreCase {
  name: string;
  resource: Resource;
  /** Undefined for the base type: no US Core profile, or the Bundle itself. */
  profile?: string;
  /** The profile cannot be parsed, so validating against it must throw. */
  unparseable: boolean;
  /** Uses a `_field`, which no type from @medplum/fhirtypes allows. */
  primitiveExtension: boolean;
}

// Design 01, Testing. These lists change only with a reviewed edit there.
export const TYPE_GAPS = new Set([
  'array-length',
  'slice',
  'pattern-coding',
  'invariant',
  'primitive-format',
  'choice-conflict',
  'codeableconcept-binding',
  'unexpandable-valueset',
  'oversize-valueset',
  'target-profile',
  'reference-string',
  'primitive-extension',
]);
export const VALIDATOR_GAPS = new Set([
  'binding',
  'reference-target',
  'extension-contents',
  'extension-slice',
  'slice-contents',
  'slicing-rules',
  'binding-slice',
  'choice-type',
  'choice-conflict',
  'content-reference',
]);

function read<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function structureDefinitions(dir: string): StructureDefinition[] {
  return readdirSync(dir)
    .filter((file) => file.startsWith('StructureDefinition-'))
    .map((file) => read<StructureDefinition>(join(dir, file)));
}

export const contractTables: ContractTable[] = readdirSync(join(FIXTURES, 'contracts'))
  .sort()
  .map((file) => ({
    file,
    ...read<Omit<ContractTable, 'file'>>(join(FIXTURES, 'contracts', file)),
  }));

export const usCoreExpectations = read<UsCoreExpectations>(join(FIXTURES, 'us-core-examples.json'));

function declaredProfile(resource: Resource): string | undefined {
  return resource.meta?.profile?.[0]?.split('|')[0];
}

export const usCoreCases: UsCoreCase[] = readdirSync(join(US_CORE, 'example'))
  .sort()
  .flatMap((file) => {
    const resource = read<Resource>(join(US_CORE, 'example', file));
    const unparseable = usCoreExpectations.unparseableProfiles.profiles;
    const toCase = (name: string, r: Resource, profile: string | undefined): UsCoreCase => ({
      name,
      resource: r,
      profile,
      unparseable: profile !== undefined && profile in unparseable,
      primitiveExtension: usCoreExpectations.primitiveExtensions.files.includes(file),
    });
    if (file in usCoreExpectations.baseTypeOnly.files) return [toCase(file, resource, undefined)];
    if (usCoreExpectations.bundles.files.includes(file)) {
      const entries = (resource as Bundle).entry ?? [];
      return [
        toCase(file, resource, undefined),
        ...entries.flatMap((entry, i) =>
          entry.resource
            ? [toCase(`${file} entry[${i}]`, entry.resource, declaredProfile(entry.resource))]
            : [],
        ),
      ];
    }
    return [toCase(file, resource, declaredProfile(resource))];
  });

const profiles = new Map<string, StructureDefinition>();

/** Loads base R4, US Core and the synthetic profiles into Medplum, once. */
function loadProfiles(): Map<string, StructureDefinition> {
  if (profiles.size > 0) return profiles;
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  const unparseable = usCoreExpectations.unparseableProfiles.profiles;
  for (const sd of [...structureDefinitions(US_CORE), ...structureDefinitions(SYNTHETIC)]) {
    if (!(sd.url in unparseable)) loadDataType(sd);
    profiles.set(sd.url, sd);
  }
  return profiles;
}

/**
 * Whether `validateResource` reports no `error` issue; warnings do not count.
 * Throws when the profile is unknown or Medplum cannot parse it.
 */
export function validates(resource: Resource, profileUrl?: string): boolean {
  let profile: StructureDefinition | undefined;
  if (profileUrl) {
    profile = loadProfiles().get(profileUrl);
    if (!profile) throw new Error(`Unknown profile: ${profileUrl}`);
    // An unparseable profile was skipped above; loading it now surfaces Medplum's error.
    if (profileUrl in usCoreExpectations.unparseableProfiles.profiles) loadDataType(profile);
  } else {
    loadProfiles();
  }
  // validateResource returns warnings, and throws with every issue when any is an error.
  try {
    validateResource(resource, { profile });
    return true;
  } catch (err) {
    if (!(err instanceof OperationOutcomeError)) throw err;
    return !err.outcome.issue?.some((issue) => issue.severity === 'error');
  }
}
