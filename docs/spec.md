# Plumb: Profile-Aware Types for Medplum

**Make Medplum's own types profile-aware.** Plumb reads a project's FHIR
profiles and generates TypeScript types that narrow `@medplum/fhirtypes` to
what each profile requires, so a missing required field is a compile error
rather than a 400 from the server.

A plumb line is the weighted string a builder hangs to find true vertical. A
project is *plumb* when its data is true to its profiles.

This spec is deliberately agnostic. It names no organization's profiles, data
model or migration. An adopter's own work lives in its own repository and
consumes Plumb the way any Medplum project would.

Plumb began as a wider toolkit. The other tools it sketched are parked as idea
notes in [`future/`](future/): a [conformance check](future/conformance-check.md),
[project config as code](future/project-config-as-code.md),
[data migrations](future/data-migrations.md) and
[operation contracts](future/operation-contracts.md). They are not part of
this spec.

## Problem Statement

- **The types describe base R4, not the project.** `@medplum/fhirtypes` is
  generated from the base specification, where almost every element is
  optional. A project that requires a birth date on every Patient still reads
  `patient.birthDate` as `string | undefined`, so application code fills with
  `?.` and `?? ""` that hide missing data instead of preventing it.
- **Profile rules get re-implemented by hand.** A required field is enforced by
  a form, a use-case guard, an import mapper and the server, each written
  separately, each able to drift.
- **Validation happens last.** A non-conforming write surfaces as a 400 when
  someone is using the app, or halfway through a bulk import, never in the
  editor.

## Why Plumb exists

Several tools generate TypeScript from FHIR profiles (see
[prior art](research/prior-art.md)). Each generates its **own** base R4 types,
and none produces types that narrow Medplum's. A Medplum app reads and writes
through `@medplum/core`, `@medplum/react` and `@medplum/fhirtypes`, so a second
set of FHIR types means casting at every boundary, which is the problem Plumb
exists to remove. Medplum's own generator builds `@medplum/fhirtypes` from the
base definitions only.

## Goals

1. **Types that tell the truth.** A generated type states what its profile
   guarantees. A missing required field is a compile error.
2. **Medplum's types, narrowed.** Every generated type is assignable wherever
   the `@medplum/fhirtypes` type is expected, so it works with every Medplum SDK
   call and React component, with no casts.
3. **Validation where it is cheapest.** Types first, tests second, the server
   last.
4. **Agnostic to the data model.** Any IG (US Core, IPS, CARIN, Da Vinci, a
   project's own) and any set of local profiles. Plumb's own tests use only
   published IGs and synthetic data.
5. **Small.** One dev-only package, a few hundred lines on top of Medplum's own
   profile parser and validator.

## Non-goals

- A second base R4 type tree, or a second validator.
- A query builder, ORM or client. The Medplum SDK is already typed.
- Talking to a Medplum server. Plumb v0.1's only network use is fetching
  missing IG packages from the FHIR package registry.
- FHIR versions other than R4, and FHIR servers other than Medplum.
- Any organization's profiles.

## Principles

These decide the questions the rest of the spec does not answer.

1. **If you know FHIR and Medplum, you know Plumb.** Plumb adds no concepts
   Medplum already has a word for. Its types extend `@medplum/fhirtypes`, its
   profile parser and validator are Medplum's, and a resource looks the same
   with or without Plumb. This is Drizzle's advantage over Prisma: nothing
   sits between a developer and the thing they already know.
2. **Generated code is readable, committed code.** Plumb must generate
   (TypeScript cannot read a profile's JSON), so the output is a reviewable
   diff in the project's repository, never a hidden client in `node_modules`.
3. **Earn every dependency.**
   - Plumb is a dev dependency only. Generated code is self-contained: it
     carries its own small helpers, so an app takes no runtime dependency on
     Plumb at all.
   - Plumb prefers Node built-ins: `util.parseArgs` for the CLI, Node's
     built-in type stripping to load `plumb.config.ts`, `fetch` and `zlib`
     for IG packages. Each dependency it does take is justified in writing.
   - Nothing published has install scripts or native binaries.
   Healthcare teams pass security reviews and keep SBOMs; "no runtime
   dependencies, built only on Medplum" is worth defending.
4. **Match Medplum at the boundary, stay lean inside.** Anything a consumer
   installs, or that could move upstream, matches Medplum:
   - dual ESM/CJS output with a type declaration per format, `sideEffects:
     false`, and Medplum's published Node range;
   - `@medplum/*` as peer dependencies;
   - source that compiles under `strict` and `erasableSyntaxOnly` (no enums,
     namespaces or parameter properties), tests in Vitest;
   - Apache-2.0, a `NOTICE`, an SPDX header on every source file, and a DCO.

   Inside the repository Plumb picks the simplest modern tool: TypeScript 7,
   `NodeNext`, Biome, one shared esbuild script, current tool versions with a
   lockfile. None of that leaves the repository, and Medplum would rebuild
   ported code with its own tooling anyway.
5. **Compatibility is tested where it lives.** The real risk is the types Plumb
   generates, not its build. CI type-checks generated output under the oldest
   supported TypeScript and under a Medplum-style `tsconfig`.
6. **Readable output.** Published and generated code is not minified, so a
   stack trace or a type error leads somewhere a person can read.

## Solution

**One dev-only package, `plumb`,** with a CLI and one library function.

```ts
// plumb.config.ts
export default defineConfig({
  igs: ['hl7.fhir.us.core@9.0.0'],
  profiles: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient'],
  // or 'hl7.fhir.us.core/*' for every US Core profile
  local: './fsh-generated/resources', // optional: the project's own profiles, as JSON
  out: './src/fhir/generated',
});
```

```text
plumb generate            fetch any missing IG packages, then emit the types into `out`
plumb generate --check    in CI: write nothing to the project; fail on stale output,
                          a lockfile mismatch or a profile without a snapshot
```

```ts
import type { USCorePatient } from './fhir/generated';

const p: USCorePatient = { resourceType: 'Patient', name: [{ family: 'Doe' }] };
//    ^ compile error: 'identifier' and 'gender' are required

// In tests: Medplum's own validator, offline
expect(validateProfiled(p, 'us-core-patient').ok).toBe(true);
```

**The pipeline:**

```text
plumb.config.ts
  → fetch    missing IG packages from packages.fhir.org into ~/.fhir/packages,
             verified against plumb.lock
  → load     base R4 from @medplum/definitions, the pinned IGs, local JSON
  → select   the listed profiles and their dependency closure; never a whole IG
  → parse    @medplum/core's parseStructureDefinition() → InternalTypeSchema
  → emit     one module per profile, an index and the helpers the modules use
```

The detailed design, including the four emission decisions, is
[design 01](design/01-generator.md).

## User Stories

**v0.1**

1. As an engineer, I want to depend on a published IG by name and version, so that adopting US Core or IPS is a line in a config file.
2. As an engineer, I want to bring my own profiles as StructureDefinition JSON, including SUSHI's output from FSH, so that Plumb does not dictate how I author profiles.
3. As an engineer, I want `plumb generate` to be the one command that fetches what it needs and brings the generated types up to date.
4. As an engineer, I want generated output committed and checked for staleness in CI, so that a profile change is a reviewable diff and never ships without its types.
5. As an engineer, I want required elements, nested required elements, choice types, required bindings and fixed-value slices expressed in the types, so that a non-conforming resource fails to compile.
6. As an engineer, I want each generated type's doc comment to list the rules the type cannot express, and the rules the server will not enforce, so that I know what is checked where.
7. As an engineer, I want the generated types to narrow `@medplum/fhirtypes`, so that they work with every Medplum SDK method and component unchanged.
8. As an engineer, I want `validateProfiled` in tests, backed by Medplum's own validator at the version I have installed, so that tests catch what the types cannot.

**Later releases of the same tool**

9. As an engineer writing FSH, I want `plumb generate` to run SUSHI for me, so that one command covers FSH too.
10. As an engineer, I want resources routed to the profile their content selects, and `create` to stamp it, so that a heart rate, a lab result and a smoking status are each held to their real profile.
11. As an engineer, I want read and search helpers that return the profile type and assert the profile stamp, so that a component receives a conforming resource, not base R4.
12. As an engineer, I want a Zod schema generated from a profile, with `pick`, `partial` and override helpers, so that a form enforces the same required fields the server does.
13. As an agent, I want a generated summary per profile (required fields, bindings, slices, invariants), so that I can write a conforming resource on the first try.

## Implementation Decisions

### Commands

Named after the tools developers already know:

- **`plumb generate`,** as in `prisma generate`, `drizzle-kit generate`,
  GraphQL Codegen and openapi-typescript.
- **`--check`,** as in openapi-typescript's `--check` ("check that the
  generated types are up-to-date") and GraphQL Codegen's `--check`.
- **No `pull`.** In Drizzle Kit and Prisma (`prisma db pull`), *pull* means
  reading a live database into code, which is not what fetching packages is.
  `generate` fetches missing packages itself, as `sushi build` does, and the
  name stays free for its conventional meaning.

### Config

- **`plumb.config.ts`** in the working directory, or the path given by
  `--config`, as `vite.config.ts`, `vitest.config.ts` and `drizzle.config.ts`
  are. `defineConfig()` gives autocomplete and type errors while editing.
- **Loaded by Node itself** (built-in type stripping, Node 22.18+), with a plain
  `import()`: no loader dependency. Its limits get clear error messages:
  TypeScript-only syntax such as `enum`, relative imports without a `.ts`
  extension, and `tsconfig` path aliases, none of which Node resolves.
- **Checked with plain code** when loaded: unknown keys, a missing `out`, a
  malformed IG name or version, and a profile URL no package provides are each
  a named error.
- **`profiles` lists canonical URLs, or `name/*` for a whole IG:** every
  resource profile in a package `igs` lists (`kind: resource`,
  `derivation: constraint`). The version stays in `igs`, and a wildcard naming
  a package `igs` does not list is a named error. It never reaches the
  package's extensions, data-type profiles or logical models, which are pulled
  in only as dependencies, nor into the packages it depends on.

### Inputs

- **IG packages** come only from the FHIR package registry (`packages.fhir.org`,
  npm-compatible tarballs), declared by name and exact version. `generate`
  fetches any that are missing, with the dependencies each IG declares, into
  the shared FHIR package cache (`~/.fhir/packages`), which SUSHI, Firely
  Terminal and the IG Publisher also use. Only an IG's own dependencies are
  fetched, not theirs: for US Core 9.0.0 that is 7 R4 packages, where the full
  tree is 15, among them example packages, R5 packages and three versions of
  one package. Anything a profile needs beyond them is the loader's "a
  reference nothing provides" error. It records each package's version and
  integrity hash (SHA-256 over the extracted files, leaving out the indexes
  other tools regenerate) in `plumb.lock` (committed) and verifies every
  package against it, so a cached copy another tool wrote is still checked. A
  package enters the lock only after it matches the registry's tarball, so a
  copy already in the cache is checked against the registry once. Once packages are cached,
  `generate` is offline and deterministic. `--check` writes nothing to the
  project: it may fill the package cache (so it works on a fresh CI runner),
  but it fails if the lockfile is missing, disagrees with the config, or does
  not match a package's hash.
- **Base R4 is Medplum's, never downloaded.** `hl7.fhir.r4.core`, which every IG
  depends on, is skipped: base R4 comes from `@medplum/definitions`, the same
  definitions `@medplum/fhirtypes` is generated from.
- **Never through npm.** Several official FHIR package names on the public npm
  registry, including `hl7.fhir.r4.core` and `hl7.fhir.us.core`, are npm
  security placeholders after malicious uploads. Installing IGs with npm is a
  dependency-confusion risk.
- **Local profiles are StructureDefinition JSON.** Projects that author in FSH
  follow Medplum's documented workflow: `sushi . --snapshot`, then point
  `local` at `fsh-generated/resources`. Running SUSHI from Plumb is a later
  release (story 9).
- **Snapshots are required.** Registry packages ship with them and SUSHI
  produces them. A profile without one is an error, not something Plumb
  repairs.
- **FHIR R4 only**, matching Medplum.

### Loading and selection

The loader turns packages on disk into the parsed profiles every later step
reads:

1. **Gather:** base R4 from `@medplum/definitions`, every package pinned in
   `plumb.lock`, and the `local` folder, indexed by canonical URL.
2. **Select** the profiles the config lists, expanding each `name/*` to its
   package's resource profiles. A profile Medplum cannot parse is an error when
   listed by URL, and skipped with a warning in the report when reached by a
   wildcard, so one unparseable profile does not block the rest of an IG.
3. **Close over their dependencies:** the parent chain (US Core Blood Pressure →
   US Core Vital Signs → Observation), the extensions and profiled types they
   use, the profiles their references target (for the target's resource type
   only), and the value sets behind their required bindings with the value sets
   and code systems those include. A dependency never pulls in a whole IG.
4. **Resolve** each reference most specific first: the `local` folder, the
   referring definition's own package, then its IG, the IG's dependencies in
   declared order, and base R4; a `|version` pin wins when a source has that
   version. That is how each IG was published, and a canonical URL is defined
   more than once in practice: US Core 9.0.0 and its dependencies define 2,029
   URLs that base R4 also defines, mostly newer terminology and extensions.
   Base R4's resource and type definitions always come from Medplum, so the
   types narrow exactly what `@medplum/fhirtypes` describes. When one URL
   resolves to different definitions in different places, the first is kept
   and the report warns.
5. **Check,** each failure a named error: a profile URL no source provides; a
   profile without a snapshot; a profile, parent, extension or reference target
   nothing provides; the `local` folder redefining a URL a package or base R4
   defines; a definition that is not FHIR R4; a profile Medplum cannot parse.
   A value set or code system nothing provides, or a code system shipped
   without its concepts (SNOMED CT in base R4), is not an error: it is listed
   as unresolved, and a binding to it is widened (design 01, decision 3).
6. **Parse** with Medplum (next section).

### Parsing: Medplum's, not Plumb's

- Plumb does not write a snapshot parser. `@medplum/core`'s
  `parseStructureDefinition()` turns a StructureDefinition into an
  `InternalTypeSchema`: each element's cardinality, types, binding, fixed and
  pattern values, constraints, and slicing with each slice's own elements.
- It is the same parse Medplum's validator and `<ResourceForm>` use, so the
  generated types cannot disagree with the validator about cardinality, slices
  or fixed values.
- A profile it cannot parse is a named error, because Medplum's validator
  cannot use it either. US Core 9.0.0's Provenance is one
  ([research](research/medplum-server-behaviour.md#what-it-checks-run-against-us-core-900)).
- It is marked `@experimental`. Plumb declares a supported `@medplum/core`
  range, and its golden tests catch a change in shape.

### Generated types

- **Narrow `@medplum/fhirtypes`**, never a parallel base tree. A profile type is
  `Omit<Base, narrowed fields> & { narrowed fields }`, so it is assignable
  wherever the base type is expected.
- **What narrows** is settled in [design 01](design/01-generator.md):
  - required fields at every depth, not only the top level;
  - slices keep plain arrays, with a typed shape and generated build and read
    helpers per slice; a missing required slice is caught by
    `validateProfiled`; ordered slicing becomes a tuple and closed slicing a
    union of slice shapes;
  - required bindings become literal unions where the value set can be listed
    offline and the field is a `code` or `Coding`, and `string` otherwise;
  - output is committed, one `.ts` file per profile plus an index and a helpers
    file, in the folder `out` names.
- **Self-contained output.** Generated modules carry the helpers they need (the
  `Require<>` type, slice builders), so the app never imports Plumb.
- **The doc comment lists what the server will not enforce,** so nobody
  mistakes documentation for a rule: constraints below `error` severity, the
  invariants Medplum skips (`ele-1`, `dom-3`, `org-1`, `sdf-19`), and
  `Reference` target profiles, which Medplum does not check against IG
  profiles.
- **Primitive extensions are not typed,** because `@medplum/fhirtypes` does not
  model them: there is no `_gender` on `Patient`. FHIR lets a required primitive
  be present only as a `_field` extension (US Core's data-absent-reason);
  Plumb's types follow Medplum's and do not allow it, the docs say so, and the
  test matrix records what the validator does with it.
- Borrowed from `@atomic-ehr/codegen`: named extension accessors, slice
  accessors that set the discriminator, and must-support gaps as warnings.

### `generate --check`

Regenerates in memory and compares with the committed output, byte for byte.
It fails on a difference, and on any selected profile without a snapshot.
Every generated file's header carries the profile URL, version and source
package hash, so a difference points at its cause.

### `validateProfiled`

- Indexes the base definitions and the selected profiles, then calls
  `@medplum/core`'s `validateResource`. That function throws on any
  error-severity issue and returns only warnings; `validateProfiled` returns
  both as one report.
- **What it promises:** the verdict of Medplum's own validator, at the
  `@medplum/core` version the project has installed. It does not promise the
  server's verdict. A server on a newer Medplum release, terminology, and which
  loaded profile version the server picks can all differ. Medplum's validator
  checks no terminology binding, so `validateProfiled` does not either; a server
  with the `validate-terminology` feature can reject a code it accepts. The
  docs advise keeping `@medplum/*` in step with the server.
- **Where Medplum's validator is wrong, so is `validateProfiled`.** It never
  matches an extension slice, so a profile with a required extension fails
  every resource, and it does not check a slice's contents, narrowed choice
  types or rules through a `contentReference`. Design 01 lists each gap; the
  docs name them, and fixing them belongs upstream, not in a second
  validator.

## Later releases of the same tool

These reuse the same parsed profiles and are specified when they are picked up.

- **Routing and `create`.** Generated routing rows wherever a profile pins a
  fixed or pattern value on its key (a LOINC code, a category), config rows
  where it keys on value-set membership, the most specific profile winning.
  `create` stamps the default plus the routed profile, because a stamp
  suppresses Medplum's `defaultProfile`. This is Plumb's first runtime code,
  and so its first runtime package.
- **Typed reads.** A read or search helper per profile that returns the profile
  type, asserts the stamp, and refuses `_elements`, `_summary` and `_history`.
  A stamp proves a record passed its profile only if it was written while the
  project was strict.
- **Zod schemas** from the same parse, for forms and input edges. A passing
  parse means the input looks right, not that the server will accept it.
- **Agent summaries,** one short Markdown file per profile next to the
  generated code.

## Testing Decisions

A good test asserts what a developer sees: whether a resource compiles against
a type, and what the validator says about it. Never how the generator walks a
schema.

**Tests check what should happen, not what Plumb does.** Every expected result
comes from a source independent of the generator: Medplum's validator called
directly, HL7's published examples (US Core ships 230, under CC0-1.0), or the
profile's own rules, written down before the code. Each fixture records
whether it conforms to the profile's rules, compiles, and validates; "compiles"
and "validates" each agree with "conforms" except in gaps listed in advance in
[design 01](design/01-generator.md). The fixtures and the harness are built
first, and the generator is built until they pass.

All fixture resources are synthetic, and all profiles under test come from
published IGs (US Core, IPS) or Plumb's own test profiles, written in FSH with
SUSHI's output committed. SUSHI is a dev dependency for editing those test
profiles only. US Core is CC0-1.0, so its files may be committed as fixtures;
confirm the license of any other IG first.

1. **Profile contract tables.** For each test profile, a table of fixtures, each
   stating whether it compiles against the generated type and whether it
   passes `validateProfiled`. "Does not compile" rows use `@ts-expect-error`,
   so a type regression fails `tsc`. The fixtures follow a **coverage matrix**
   (in [design 01](design/01-generator.md)): every kind of field and rule the
   generator handles gets a happy path and its edge cases, and the tables are
   written before the code that makes them pass.
2. **Generator golden tests.** For a fixed set of IG profiles, the generated
   output matches committed files. They detect change, not correctness, so
   each is reviewed against its profile before it is committed.
3. **Compatibility.** Generated output type-checks under the oldest supported
   TypeScript and under a Medplum-style `tsconfig`.
4. **No Medplum server in v0.1.** v0.1 makes no claim about the server. The
   real-server tests return with the
   [conformance check](future/conformance-check.md), which does.

## Out of Scope

- Everything in [`future/`](future/) until it is picked up.
- A query builder, an ORM, or Medplum GraphQL code generation.
- FHIR R4B and R5.
- Slice discriminators other than fixed values; type-level non-empty arrays.
- Any organization's profiles.

## Further Notes

### Medplum facts this depends on

Read from Medplum's source (`main` at `10ee734f4`, unchanged from v5.1.42 for
every file cited). Evidence and the rest of the server's behaviour are in
[`research/medplum-server-behaviour.md`](research/medplum-server-behaviour.md).

- `parseStructureDefinition()` and `InternalTypeSchema` are exported from
  `@medplum/core` and marked `@experimental`.
- `validateResource` throws on any error-severity issue and returns only
  warnings.
- Even in strict mode, constraints below `error` severity, four skipped
  invariants and IG `Reference` target profiles are not enforced.
- `@medplum/generator` builds `@medplum/fhirtypes` from the base definitions
  only, and is not published.

### Inspiration

| Borrowed | From | Why |
|---|---|---|
| `generate` from a declared schema | Prisma | TypeScript cannot infer types from HL7's JSON |
| Generated code committed and reviewed, a dev-only kit | Drizzle | A profile change is a reviewable diff; nothing hidden ships |
| One config file | Drizzle | One place for IGs, profiles and output |
| Extension and slice accessors, must-support warnings | `@atomic-ehr/codegen` | Proven ergonomics for profile types |

### Distribution

- **A standalone repository**, separate from any adopter's code, so nothing
  adopter-shaped can leak into Plumb's code or tests.
- **Private until v0.1 works end to end on US Core.** It goes public after
  sign-off from the copyright holder, with the npm name chosen and Medplum's
  contribution requirement (a DCO) copied.
- **Apache-2.0 with a `NOTICE` file**, matching Medplum, so the code can move
  upstream by transfer rather than extraction.
- **Repository layout** follows Principle 4: a single package at the
  repository root (no workspaces, no build orchestrator), with sources in
  `src/` and tests next to them; one esbuild script emitting the library as
  `dist/esm/index.mjs` and `dist/cjs/index.cjs` (with `tsc` declarations and a
  type marker per format) and the CLI as `dist/esm/cli.mjs`; Vitest; Biome with
  an SPDX header check; knip; TypeScript 7 with `NodeNext`, targeting ES2024.
  `@medplum/core`,
  `@medplum/definitions` and `@medplum/fhirtypes` are peer dependencies with a
  declared supported range.
- **Versioning**: Changesets, `0.x` until the API settles. Releases publish from
  CI only, with npm provenance.
- **Work tracking**: GitHub Issues, a project board and one milestone per
  release. Commits and PR titles follow conventional commits.

### Upstream

Profile types are a natural fit for Medplum itself: it already has the
definitions, the parser, the validator and a type generator, and in 2023 its
maintainers said the generator could do the heavy lifting (Medplum discussion
#2006). Plumb is built as a standalone tool, in source that ports cleanly, so
it can be offered upstream later. No proposal is made now. When one is,
it starts as an issue: Medplum closes pull requests from contributors it has
not yet vouched for unless they link a maintainer-labelled issue.

### Open decisions

- **The npm name.** `plumb` is taken on npm; a scope or a new name is needed
  before the first publish.
- **The copyright line** in `NOTICE` and the SPDX headers, confirmed by the
  copyright holder.
- **Supported versions**: the oldest `@medplum/core` and TypeScript Plumb
  supports.
