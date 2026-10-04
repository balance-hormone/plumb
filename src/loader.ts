// SPDX-FileCopyrightText: Copyright Balance Hormone Center and Plumb contributors
// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type InternalTypeSchema,
  indexStructureDefinitionBundle,
  loadDataType,
  parseStructureDefinition,
} from '@medplum/core';
import { readJson } from '@medplum/definitions';
import type {
  Bundle,
  CodeSystem,
  ElementDefinition,
  StructureDefinition,
  ValueSet,
} from '@medplum/fhirtypes';

type Conformance = StructureDefinition | ValueSet | CodeSystem;
const KINDS = new Set(['StructureDefinition', 'ValueSet', 'CodeSystem']);
// Base R4 resource and type definitions: always Medplum's, so generated types
// narrow exactly what @medplum/fhirtypes was generated from.
const CORE_FILES = ['fhir/r4/profiles-types.json', 'fhir/r4/profiles-resources.json'];
// The rest of base R4, which an IG's dependencies may supersede.
const BASE_FILES = [
  'fhir/r4/profiles-others.json',
  'fhir/r4/extension-definitions.json',
  'fhir/r4/valuesets.json',
  'fhir/r4/v3-codesystems.json',
  'fhir/r4/v2-tables.json',
];

type LoadWarningCode = 'version-conflict' | 'unparseable-skipped' | 'base-version-mismatch';

type LoadErrorCode =
  | 'profile-not-found'
  | 'no-snapshot'
  | 'not-r4'
  | 'unresolved-reference'
  | 'duplicate-definition'
  | 'unparseable';

interface LoadIssue<Code extends string> {
  code: Code;
  message: string;
  url?: string;
}

interface LoadedProfile {
  url: string;
  /** `local`, `base`, or the package as `name@version`. */
  source: string;
  sd: StructureDefinition;
  schema: InternalTypeSchema;
}

export interface LoadProfilesResult {
  ok: boolean;
  /** The selected profiles, in config order. */
  profiles: LoadedProfile[];
  /** Everything the selected profiles depend on, by canonical URL. */
  definitions: Map<string, { resource: Conformance; source: string }>;
  /**
   * Value sets and code systems whose codes cannot be listed offline: no source
   * provides them, or a code system ships without its concepts (SNOMED CT in base R4).
   */
  unresolved: { url: string; from: string }[];
  warnings: LoadIssue<LoadWarningCode>[];
  errors: LoadIssue<LoadErrorCode>[];
}

export interface LoadProfilesOptions {
  /** Every cached package: the IGs and their dependencies. */
  packages: { name: string; version: string; dir: string }[];
  /** The config's IGs, as `name@version`. */
  igs: string[];
  /** A folder of the project's own StructureDefinition, ValueSet and CodeSystem JSON. */
  local?: string;
  /** Canonical URLs, or `name/*` for every resource profile in an IG `igs` lists. */
  profiles: string[];
}

interface Entry {
  url: string;
  version?: string;
  source: string;
  /** Package files are read again only when needed, so the index stays small. */
  file?: string;
  resource?: Conformance;
}

interface Source {
  id: string;
  defs: Map<string, Entry>;
}

function addEntry(source: Source, resource: Conformance, file?: string): void {
  if (!KINDS.has(resource.resourceType) || !resource.url || source.defs.has(resource.url)) return;
  source.defs.set(resource.url, {
    url: resource.url,
    version: resource.version,
    source: source.id,
    ...(file ? { file } : { resource }),
  });
}

function bundleSource(id: string, files: string[]): Source {
  const source: Source = { id, defs: new Map() };
  for (const file of files) {
    for (const entry of (readJson(file) as Bundle).entry ?? []) {
      if (entry.resource) addEntry(source, entry.resource as Conformance);
    }
  }
  return source;
}

function folderSource(id: string, dir: string, keepContent: boolean): Source {
  const source: Source = { id, defs: new Map() };
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json') || name === 'package.json' || name.startsWith('.')) continue;
    const file = join(dir, name);
    const resource = JSON.parse(readFileSync(file, 'utf8')) as Conformance;
    addEntry(source, resource, keepContent ? undefined : file);
  }
  return source;
}

const core = bundleSource('base', CORE_FILES);
const base = bundleSource('base', BASE_FILES);
let coreIndexed = false;

function content(entry: Entry): Conformance {
  entry.resource ??= JSON.parse(readFileSync(entry.file as string, 'utf8')) as Conformance;
  return entry.resource;
}

/** Resolves a canonical, honouring a `|version` pin, most specific source first. */
function resolve(ref: string, scope: Source[]): Entry | undefined {
  const [url = '', version] = ref.split('|');
  const coreEntry = core.defs.get(url);
  if (coreEntry) return coreEntry;
  const found = scope.flatMap((s) => s.defs.get(url) ?? []);
  return (version ? found.find((e) => e.version === version) : undefined) ?? found[0];
}

/**
 * Selects the profiles the config lists, closes over what they depend on,
 * checks it, and parses each profile with Medplum. Each IG resolves references
 * against itself, then its own dependencies, then base R4, as it was published.
 */
export function loadProfiles(options: LoadProfilesOptions): LoadProfilesResult {
  const sources = gather(options);
  const errors = [...sources.errors];
  const closure = new Closure(sources.all);
  const selected: Entry[] = [];
  const { urls, wildcard, missing } = expand(options, sources.packages);
  errors.push(...missing);
  for (const url of urls) {
    const entry = resolve(url, sources.everything);
    if (!entry) {
      errors.push({ code: 'profile-not-found', url, message: `No source provides ${url}.` });
      continue;
    }
    selected.push(entry);
    closure.structure(url, sources.scopeFor(entry.source), url);
  }
  errors.push(...closure.errors);
  if (errors.length > 0) return result(false, [], closure, errors);
  const parsed = parse(closure, selected, wildcard);
  closure.warnings.push(...parsed.skipped);
  return result(parsed.errors.length === 0, parsed.profiles, closure, parsed.errors);
}

const ALL_PROFILES = /^(.+)\/\*$/;

/**
 * Expands each `name/*` to the IG's resource profiles, sorted by URL, and
 * drops repeats. `wildcard` holds the URLs only a wildcard selected.
 */
function expand(options: LoadProfilesOptions, packages: Map<string, { source: Source }>) {
  const urls: string[] = [];
  const explicit = new Set<string>();
  const wildcard = new Set<string>();
  const missing: LoadIssue<LoadErrorCode>[] = [];
  for (const profile of options.profiles) {
    const name = ALL_PROFILES.exec(profile)?.[1];
    if (!name) {
      explicit.add(profile);
      urls.push(profile);
      continue;
    }
    const ig = options.igs.find((id) => id.slice(0, id.lastIndexOf('@')) === name);
    const pkg = ig ? packages.get(ig) : undefined;
    if (!pkg) {
      missing.push({
        code: 'profile-not-found',
        url: profile,
        message: `${profile} names ${name}, which was not fetched.`,
      });
      continue;
    }
    const found = [...pkg.source.defs.values()]
      .filter((e) => {
        const sd = content(e) as StructureDefinition;
        return (
          sd.resourceType === 'StructureDefinition' &&
          sd.kind === 'resource' &&
          sd.derivation === 'constraint'
        );
      })
      .map((e) => e.url)
      .sort();
    for (const url of found) {
      wildcard.add(url);
      urls.push(url);
    }
  }
  for (const url of explicit) wildcard.delete(url);
  return { urls: [...new Set(urls)], wildcard, missing };
}

/** Indexes base R4, the packages and the local folder, and works out each IG's scope. */
function gather(options: LoadProfilesOptions) {
  const errors: LoadIssue<LoadErrorCode>[] = [];
  const local = options.local ? folderSource('local', options.local, true) : undefined;
  const packages = new Map(
    options.packages.map((p) => [
      `${p.name}@${p.version}`,
      {
        source: folderSource(`${p.name}@${p.version}`, join(p.dir, 'package'), false),
        dependencies: dependenciesOf(p.dir),
      },
    ]),
  );
  const packageSources = [...packages.values()].map((p) => p.source);
  for (const entry of local?.defs.values() ?? []) {
    const owner = [core, base, ...packageSources].find((s) => s.defs.has(entry.url));
    if (owner) {
      errors.push({
        code: 'duplicate-definition',
        url: entry.url,
        message: `The local folder redefines ${entry.url}, which ${owner.id === 'base' ? 'base R4' : owner.id} defines.`,
      });
    }
  }

  const localFirst = local ? [local] : [];
  const scopeOf = (root: string): Source[] => {
    const pkg = packages.get(root);
    const deps = (pkg?.dependencies ?? []).flatMap((d) => packages.get(d)?.source ?? []);
    return [...localFirst, ...(pkg ? [pkg.source] : []), ...deps, base];
  };
  // A profile from the local folder or base R4 sees every IG, in config order.
  const everything = [
    ...localFirst,
    ...options.igs.flatMap((ig) => scopeOf(ig).filter((s) => s !== local && s !== base)),
    ...packageSources,
    base,
  ];
  const scopeFor = (source: string): Source[] => {
    if (options.igs.includes(source)) return scopeOf(source);
    const root = options.igs.find((ig) => packages.get(ig)?.dependencies.includes(source));
    return root ? scopeOf(root) : everything;
  };
  return {
    errors,
    packages,
    everything,
    scopeFor,
    all: [base, ...localFirst, ...packageSources],
  };
}

/** Registers every profile, parent and extension with Medplum, then parses the selected ones. */
/**
 * Registers every profile, parent and extension with Medplum, then parses the
 * selected ones. A profile only a wildcard selected is skipped with a warning
 * when Medplum cannot parse it, so one such profile does not block its IG.
 */
function parse(closure: Closure, selected: Entry[], wildcard: Set<string>) {
  const errors: LoadIssue<LoadErrorCode>[] = [];
  const skipped: LoadIssue<LoadWarningCode>[] = [];
  registerCore();
  for (const url of closure.deep) {
    try {
      loadDataType(closure.definitions.get(url)?.resource as StructureDefinition);
    } catch (err) {
      const message = `Medplum cannot parse ${url}: ${err instanceof Error ? err.message : String(err)}`;
      if (wildcard.has(url)) skipped.push({ code: 'unparseable-skipped', url, message });
      else errors.push({ code: 'unparseable', url, message });
    }
  }
  const profiles: LoadedProfile[] = [];
  for (const entry of selected) {
    const sd = content(entry) as StructureDefinition;
    if ([...errors, ...skipped].some((e) => e.url === sd.url)) continue;
    profiles.push({ url: sd.url, source: entry.source, sd, schema: parseStructureDefinition(sd) });
  }
  return { profiles, errors, skipped };
}

function result(
  ok: boolean,
  profiles: LoadedProfile[],
  closure: Closure,
  errors: LoadIssue<LoadErrorCode>[],
): LoadProfilesResult {
  return {
    ok,
    profiles,
    definitions: closure.definitions,
    unresolved: closure.unresolved,
    warnings: closure.warnings,
    errors,
  };
}

function checkStructure(sd: StructureDefinition): LoadIssue<LoadErrorCode> | undefined {
  if (!sd.snapshot?.element?.length) {
    return { code: 'no-snapshot', url: sd.url, message: `${sd.url} has no snapshot.` };
  }
  if (sd.fhirVersion && !sd.fhirVersion.startsWith('4.0')) {
    return {
      code: 'not-r4',
      url: sd.url,
      message: `${sd.url} is for FHIR ${sd.fhirVersion}, not R4.`,
    };
  }
  return undefined;
}

function registerCore(): void {
  if (coreIndexed) return;
  for (const file of CORE_FILES) indexStructureDefinitionBundle(readJson(file) as Bundle);
  coreIndexed = true;
}

function dependenciesOf(dir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(dir, 'package', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return Object.entries(manifest.dependencies ?? {}).map(([name, version]) => `${name}@${version}`);
}

/** Walks what the selected profiles depend on, collecting it by canonical URL. */
class Closure {
  readonly definitions = new Map<string, { resource: Conformance; source: string }>();
  readonly unresolved: { url: string; from: string }[] = [];
  readonly warnings: LoadIssue<LoadWarningCode>[] = [];
  readonly errors: LoadIssue<LoadErrorCode>[] = [];
  /** StructureDefinitions walked in full, as opposed to reference targets. */
  readonly deep = new Set<string>();
  private readonly visited = new Set<string>();
  private readonly sources: Map<string, Source>;

  constructor(sources: Source[]) {
    this.sources = new Map(sources.map((s) => [s.id, s]));
  }

  /** A definition's own references resolve in its own source first, as it was published. */
  private own(entry: Entry, scope: Source[]): Source[] {
    const home = this.sources.get(entry.source);
    return home ? [home, ...scope.filter((s) => s !== home)] : scope;
  }

  /** A profile, parent or extension: checked, and walked in full. */
  structure(ref: string, scope: Source[], from: string): void {
    const entry = this.find(ref, scope, from, 'sd');
    if (!entry || core.defs.has(entry.url)) return;
    const sd = content(entry) as StructureDefinition;
    const issue = checkStructure(sd);
    if (issue) {
      this.errors.push(issue);
      return;
    }
    const own = this.own(entry, scope);
    this.deep.add(sd.url);
    if (sd.baseDefinition) {
      if (entry.source === 'local') this.pinnedBase(sd, sd.baseDefinition, own);
      this.structure(sd.baseDefinition, own, sd.url);
    }
    for (const element of sd.snapshot?.element ?? []) this.element(element, own, sd.url);
  }

  /**
   * A local profile built on a parent version the config does not provide
   * inherits the provided version's rules instead (design 05).
   */
  private pinnedBase(sd: StructureDefinition, base: string, scope: Source[]): void {
    const pinned = base.split('|')[1];
    const parent = pinned ? resolve(base, scope) : undefined;
    if (!parent?.version || parent.version === pinned) return;
    this.warnings.push({
      code: 'base-version-mismatch',
      url: sd.url,
      message: `${sd.url} was built on ${base}, but the config provides version ${parent.version} from ${parent.source}, so it inherits that version's rules. Select the version it was built on in igs, or rebuild it.`,
    });
  }

  private element(element: ElementDefinition, scope: Source[], from: string): void {
    for (const type of element.type ?? []) {
      for (const profile of type.profile ?? []) this.structure(profile, scope, from);
      // Only a target's resource type matters, so it is not walked.
      for (const target of type.targetProfile ?? []) this.find(target, scope, from, 'target');
    }
    // Extensible bindings on a code are typed too, as suggestions (design 01, decision 3).
    const binding = element.binding;
    const typed =
      binding?.strength === 'required' ||
      (binding?.strength === 'extensible' && element.type?.some((t) => t.code === 'code'));
    if (typed && binding?.valueSet) this.valueSet(binding.valueSet, scope, from);
  }

  private valueSet(ref: string, scope: Source[], from: string): void {
    const entry = this.find(ref, scope, from, 'vs');
    if (!entry) return;
    const vs = content(entry) as ValueSet;
    const own = this.own(entry, scope);
    for (const include of [...(vs.compose?.include ?? []), ...(vs.compose?.exclude ?? [])]) {
      for (const nested of include.valueSet ?? []) this.valueSet(nested, own, vs.url ?? from);
      if (!include.system) continue;
      const cs = this.find(include.system, own, vs.url ?? from, 'cs');
      if (cs && (content(cs) as CodeSystem).content !== 'complete') {
        this.unlisted(include.system, vs.url ?? from);
      }
    }
  }

  private unlisted(url: string, from: string): void {
    if (!this.unresolved.some((u) => u.url === url)) this.unresolved.push({ url, from });
  }

  /** Resolves and records a reference; undefined when it was already walked or is missing. */
  private find(
    ref: string,
    scope: Source[],
    from: string,
    kind: 'sd' | 'target' | 'vs' | 'cs',
  ): Entry | undefined {
    const entry = resolve(ref, scope);
    if (!entry) {
      if (kind === 'vs' || kind === 'cs') {
        this.unlisted(ref.split('|')[0] as string, from);
      } else {
        this.errors.push({
          code: 'unresolved-reference',
          url: ref.split('|')[0],
          message: `${from} references ${ref}, which no source provides.`,
        });
      }
      return undefined;
    }
    const known = this.definitions.get(entry.url);
    if (known && known.source !== entry.source) {
      if (!this.warnings.some((w) => w.url === entry.url)) {
        this.warnings.push({
          code: 'version-conflict',
          url: entry.url,
          message: `${entry.url} resolves to ${known.source} in one place and ${entry.source} in another; only one definition per URL is kept, so ${known.source}'s is used.`,
        });
      }
      return undefined;
    }
    const key = `${kind === 'target' ? 'target' : 'walk'}:${entry.url}`;
    if (this.visited.has(key) || (kind === 'target' && this.visited.has(`walk:${entry.url}`))) {
      return undefined;
    }
    this.visited.add(key);
    if (!known) this.definitions.set(entry.url, { resource: content(entry), source: entry.source });
    return entry;
  }
}
