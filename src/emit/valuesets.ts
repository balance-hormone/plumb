// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import type {
  CodeSystem,
  CodeSystemConcept,
  ValueSet,
  ValueSetComposeInclude,
} from '@medplum/fhirtypes';

export interface Code {
  system: string;
  code: string;
  display?: string;
}

type Lookup = (url: string) => { resourceType: string } | undefined;

/**
 * The codes a value set holds, listed offline as `@medplum/generator`'s
 * `getValueSetValues` does: explicit concepts, and every code of an included
 * code system shipped with its concepts. Undefined when that cannot list it:
 * a rule (filter), or a value set or code system that is not loaded or ships
 * without its concepts.
 */
export function expandValueSet(url: string, lookup: Lookup): Code[] | undefined {
  const vs = lookup(url);
  if (vs?.resourceType !== 'ValueSet') return undefined;
  const { compose, expansion } = vs as ValueSet;
  if (!compose) {
    const contains = expansion?.contains;
    if (!contains) return undefined;
    return contains.flatMap((c) => (c.system && c.code ? [code(c.system, c.code, c.display)] : []));
  }
  const included: Code[] = [];
  for (const include of compose.include) {
    const codes = listInclude(include, lookup);
    if (!codes) return undefined;
    included.push(...codes);
  }
  const excluded = new Set<string>();
  for (const exclude of compose.exclude ?? []) {
    const codes = listInclude(exclude, lookup);
    if (!codes) return undefined;
    for (const c of codes) excluded.add(`${c.system}|${c.code}`);
  }
  const seen = new Set<string>();
  return included.filter((c) => {
    const key = `${c.system}|${c.code}`;
    if (excluded.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function code(system: string, value: string, display?: string): Code {
  return display ? { system, code: value, display } : { system, code: value };
}

function listInclude(include: ValueSetComposeInclude, lookup: Lookup): Code[] | undefined {
  if (include.filter?.length) return undefined;
  // Several value sets in one include are an intersection, which is not worth listing.
  if (include.valueSet?.length) {
    if (include.system || include.concept || include.valueSet.length > 1) return undefined;
    return expandValueSet(include.valueSet[0] as string, lookup);
  }
  if (!include.system) return undefined;
  const system = include.system;
  if (include.concept) return include.concept.map((c) => code(system, c.code, c.display));
  const cs = lookup(system);
  if (cs?.resourceType !== 'CodeSystem' || (cs as CodeSystem).content !== 'complete')
    return undefined;
  const walk = (concepts: CodeSystemConcept[] = []): Code[] =>
    concepts.flatMap((c) => [code(system, c.code, c.display), ...walk(c.concept)]);
  return walk((cs as CodeSystem).concept);
}
