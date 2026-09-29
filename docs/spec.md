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
- Talking to a Medplum server. Plumb v0.1 is entirely offline.
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
  local: './fsh-generated/resources', // optional: the project's own profiles, as JSON
  out: './src/fhir/generated',
});
```

```text
plumb pull                fetch the IG packages and their dependencies; write plumb.lock
plumb generate            emit the types into `out`, to be committed
plumb generate --check    in CI: fail on stale output or a profile without a snapshot
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
  → pull     IG packages from packages.fhir.org, pinned in plumb.lock
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
3. As an engineer, I want `plumb generate` to be the one command that brings the generated types up to date.
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

### Inputs

- **IG packages** come only from the FHIR package registry (`packages.fhir.org`,
  npm-compatible tarballs), declared by name and exact version. `plumb pull`
  resolves their dependencies, caches them in `.plumb/` (gitignored) and writes
  `plumb.lock` with each package's integrity hash. `generate` never fetches, so
  it is deterministic and offline.
- **Never through npm.** Several official FHIR package names on the public npm
  registry, including `hl7.fhir.r4.core` and `hl7.fhir.us.core`, are npm
  security placeholders after malicious uploads. Installing IGs with npm is a
  dependency-confusion risk.
- **Local profiles are StructureDefinition JSON.** Projects that author in FSH
  follow Medplum's documented workflow: `sushi . --snapshot`, then point
  `local` at `fsh-generated/resources`. Running SUSHI from Plumb is a later
  release (story 9); it needs an answer for SUSHI's own package cache next to
  `plumb.lock`.
- **Snapshots are required.** Registry packages ship with them and SUSHI
  produces them. A profile without one is an error, not something Plumb
  repairs.
- **Base R4** comes from `@medplum/definitions`, the same definitions
  `@medplum/fhirtypes` is generated from.
- **FHIR R4 only**, matching Medplum.

### Parsing: Medplum's, not Plumb's

- Plumb does not write a snapshot parser. `@medplum/core`'s
  `parseStructureDefinition()` turns a StructureDefinition into an
  `InternalTypeSchema`: each element's cardinality, types, binding, fixed and
  pattern values, constraints, and slicing with each slice's own elements.
- It is the same parse Medplum's validator and `<ResourceForm>` use, so the
  generated types cannot disagree with the validator about cardinality, slices
  or fixed values.
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
  server's verdict. A server on a newer Medplum release, terminology checks
  against value sets that cannot be expanded offline, and which loaded profile
  version the server picks can all differ. The docs advise keeping `@medplum/*`
  in step with the server.

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

All fixtures are synthetic, and all profiles under test come from published IGs
(US Core, IPS) or Plumb's own test profiles, written in FSH with SUSHI's output
committed.

1. **Profile contract tables.** For each test profile, a table of fixtures, each
   stating whether it compiles against the generated type and whether it
   passes `validateProfiled`. "Does not compile" rows use `@ts-expect-error`,
   so a type regression fails `tsc`.
2. **Generator golden tests.** For a fixed set of IG profiles, the generated
   output matches committed files.
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
- **Repository layout** follows Principle 4: one package under npm workspaces,
  no build orchestrator; one esbuild script emitting the library as
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
