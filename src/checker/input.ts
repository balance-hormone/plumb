// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { gzipSync } from 'node:zlib';
import { readJson } from '@medplum/definitions';
import type { Bundle, ResourceType, StructureDefinition } from '@medplum/fhirtypes';
import type { LoadProfilesResult } from '../loader.js';
import type { CheckerInput } from './handler.js';

const sds = (file: string) =>
  ((readJson(file) as Bundle).entry ?? []).flatMap((e) =>
    e.resource?.resourceType === 'StructureDefinition' ? [e.resource] : [],
  );
let base: { types: StructureDefinition[]; resources: Map<string, StructureDefinition> };

/**
 * The checker's input for one resource type: the selected profiles of that
 * type, what they depend on, and the base R4 definitions the validator needs,
 * which the bot's own `@medplum/core` does not have.
 */
export function checkerInput(
  loaded: Pick<LoadProfilesResult, 'profiles' | 'definitions'>,
  resourceType: ResourceType,
): CheckerInput {
  base ??= {
    types: sds('fhir/r4/profiles-types.json'),
    resources: new Map(sds('fhir/r4/profiles-resources.json').map((sd) => [sd.type, sd])),
  };
  const selected = loaded.profiles.filter((p) => p.sd.type === resourceType).map((p) => p.url);
  const resources = ['Resource', 'DomainResource', resourceType].flatMap((id) => {
    const sd = base.resources.get(id);
    return sd ? [sd] : [];
  });
  const definitions = { base: [...base.types, ...resources], profiles: closure(selected, loaded) };
  return {
    resourceType,
    profiles: selected,
    definitions: gzipSync(JSON.stringify(definitions)).toString('base64'),
  };
}

/** The profiles, their parents and the extensions they name, as the loader walked them. */
export function closure(urls: string[], loaded: Pick<LoadProfilesResult, 'definitions'>) {
  const found = new Map<string, StructureDefinition>();
  const todo = [...urls];
  for (let url = todo.pop(); url !== undefined; url = todo.pop()) {
    const sd = loaded.definitions.get(url.split('|')[0] as string)?.resource;
    if (sd?.resourceType !== 'StructureDefinition' || found.has(sd.url)) continue;
    found.set(sd.url, sd);
    if (sd.baseDefinition) todo.push(sd.baseDefinition);
    for (const element of sd.snapshot?.element ?? []) {
      for (const type of element.type ?? []) todo.push(...(type.profile ?? []));
    }
  }
  return [...found.values()];
}
