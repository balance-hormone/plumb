# Design 01: Profile Compiler and Type Generator

**Status: accepted.** The four emission decisions were settled on 2026-09-29
(below). Implementation can start.

Spec: [`../spec.md`](../spec.md) (Inputs, Parsing, Generated types).
Prototype: [`../research/prototype.md`](../research/prototype.md).
Prior art: [`../research/prior-art.md`](../research/prior-art.md).

## Job

Take implementation guide (IG) packages and a project's own profiles, and emit
TypeScript types that are true to each profile and still usable anywhere a
`@medplum/fhirtypes` type is expected.

## Pipeline

```text
plumb.config.ts
  → resolve   IG packages from plumb.lock, plus local StructureDefinition JSON
  → load      snapshots only; fail on any profile without one
  → parse     @medplum/core's parseStructureDefinition() → InternalTypeSchema
  → emit      one module per profile, an index, the helpers the modules use,
              and a …ProfileUrl constant per profile
              (routing, Zod and agent summaries reuse the same parse later)
```

### Inputs

- **IG packages** are named in config (`hl7.fhir.us.core@9.0.0`), fetched by
  `plumb pull` from the FHIR package registry, pinned in `plumb.lock` with an
  integrity hash.
- **Local profiles** are StructureDefinition JSON. FSH authors run
  `sushi . --snapshot` (Medplum's documented workflow) and point Plumb at
  `fsh-generated/resources`. Running SUSHI from Plumb comes later.
- **Only the profiles a project uses are compiled**, plus their dependency
  closure: parent profiles, referenced extensions, and value sets behind
  required bindings. Never a whole IG.
- **A snapshot is mandatory.** Registry packages and SUSHI both provide one. A
  local JSON profile without a snapshot is an error, not something Plumb
  repairs; snapshot generation is a hard problem (`fhir-snapshot-generator`
  exists if that ever changes), and a snapshot-less profile breaks Medplum
  anyway.

### The intermediate representation is Medplum's

Plumb writes no snapshot parser. `@medplum/core`'s `parseStructureDefinition()`
returns an `InternalTypeSchema` per profile: URL, version, name, base type and,
for each element, its path, `min` and `max`, types, `binding`, `fixed` and
`pattern` values, `constraints`, and `slicing` with each slice's own elements.
It is the parse Medplum's validator and `<ResourceForm>` use, so the types
cannot disagree with the validator about cardinality, slices or fixed values.
Every emitter, now and later, reads only this.

It is marked `@experimental`, so its shape can change between Medplum
releases. The golden tests catch that, and the supported `@medplum/core` range
is declared.

`@medplum/generator`'s `fhirtypes` script (`packages/generator/src/index.ts`)
is the nearest model for the emitter: it walks the same `InternalTypeSchema` to
write `@medplum/fhirtypes`, turning `min > 0` into a required field, expanding
choice types, and emitting literal unions for enumerable required bindings. It
reads only the base definitions and has no notion of narrowing, which is what
Plumb adds.

## Emission rules

| FHIR feature | TypeScript |
|---|---|
| Required element (`min ≥ 1`) | Non-optional field, via `Require<>` |
| Required nested element | Non-optional inside its parent, at any depth (decision 1) |
| `max: 0` (prohibited) | `?: never` |
| Choice type narrowed to one type | Only that property, e.g. `valueQuantity` |
| Required choice with several types | "Exactly one of": a union where each branch sets one and forbids the rest |
| Fixed value (`fixedCode`, `fixedUri`) | A literal type |
| Pattern value (`patternCodeableConcept`) | Must include that coding; the rest stays open |
| Required binding | A literal union where the value set can be listed offline, otherwise `string` (decision 3) |
| Slice | A typed shape per slice and generated helpers; the array stays plain (decision 2) |
| Extension slice (by URL) | A named, typed extension with helpers, like any other slice |
| Invariant (FHIRPath) | Doc comment only; enforced by the server (in strict mode) and `validateProfiled`, except below `error` severity and the four Medplum skips |
| Must Support | Doc comment only; never changes optionality |
| Child profile (BMI → vital signs) | Child type is assignable to the parent type |

**Everything narrows `@medplum/fhirtypes`** (`Omit<Patient, …> & {…}`), so a
generated type works in every Medplum SDK call and React component with no
casts. The generator never emits a parallel base R4 tree.

**Anything the types cannot enforce is written in the doc comment,** with a
note that `validateProfiled` checks it: required slices, required bindings on
`CodeableConcept`, invariants and value sets that cannot be expanded offline.

## Decisions

### 1. Depth of required-field narrowing: full depth

Narrow along every path of required elements, not only the top level. US Core
Patient requires `identifier`, and inside each identifier `system` and `value`,
so `identifier: [{}]` must not compile:

```ts
type USCorePatient = Omit<Patient, 'identifier' | 'name' | 'gender'> & {
  identifier: Require<Identifier, 'system' | 'value'>[];
  name: HumanName[];
  gender: 'male' | 'female' | 'other' | 'unknown';
};
```

`Require<>` composes and only required paths are touched, so types stay
readable. One-level narrowing (the prototype) was rejected: it misses nested
rules such as `identifier.system`, `telecom.value` and `component.code`, which
are common in IGs.

### 2. Slices: plain arrays, typed slices, helpers

TypeScript can say "the first entry is a systolic reading" but not "the array
contains a systolic reading somewhere", in any order. Every generator surveyed
makes the same trade (see [prior art](../research/prior-art.md)):
json-schema-to-typescript and openapi-typescript ignore JSON Schema's
`contains` and keep plain arrays; `@atomic-ehr/codegen` and fhir-dsl generate
slice accessors and check presence at runtime. Plumb follows them:

- **Arrays stay plain arrays,** so `.map()`, spreading and API data work.
- **Each slice gets a typed shape** (`USCoreBloodPressureSystolic`) and
  **generated helpers** that build an entry with its fixed discriminator values
  filled in, and read one back:

  ```ts
  component: [
    USCoreBloodPressure.systolic({ valueQuantity: q(120) }),
    USCoreBloodPressure.diastolic({ valueQuantity: q(80) }),
  ],
  USCoreBloodPressure.getSystolic(bp); // typed read
  ```

- **A missing required slice is caught by `validateProfiled`,** not the
  compiler, and the type's doc comment says so.
- **Ordered slicing (`ordered: true`) becomes a tuple,** because there order is
  part of the FHIR rule, as openapi-typescript does for `prefixItems`.
- **Closed slicing (`rules: closed`) makes the element type a union of the
  slice shapes,** so an entry that matches no slice fails to compile.

Rejected:

- **Leading tuple positions for unordered slices** (the prototype):
  order-sensitive when the server is not, factorial in the number of required
  slices, and incompatible with arrays built by `.map()`.
- **A branded array only a builder can produce:** compile-time presence, but
  every write must go through the builder, spreading and `.map()` lose the
  brand, server data never has it, and no surveyed tool does it. It remains a
  possible opt-in later, built on the same helpers.

### 3. Bindings: literal unions where they are honest

| Case | Generated type |
|---|---|
| Required binding, value set listable offline, on a `code` or `Coding` | A literal union of the codes |
| Required binding on a `CodeableConcept` | The base type, plus exported code constants; checked by `validateProfiled` |
| Required binding whose value set cannot be listed offline (filters, VSAC) | `string`, with the value set URL in the doc comment |
| More than about 100 codes (configurable) | `string`, with the value set URL in the doc comment |
| Extensible binding on a `code` | `'a' \| 'b' \| (string & {})`: autocomplete without rejecting other codes |
| Preferred or example | The base type |

A `CodeableConcept`'s required binding means "at least one coding from the
set", the same "contains" rule as a slice, so it is checked in tests.

Expansion follows `@medplum/generator`'s `getValueSetValues`
(`packages/generator/src/valuesets.ts`), which is offline too: explicit
`include.concept` lists and every code of an included code system, walking
nested concepts, from the ValueSets and CodeSystems in the loaded packages.
Rule-based includes are not expanded.

Rejected for v0.1: expanding through a Medplum server's `ValueSet/$expand` at
generate time. It would make `generate` need a server, credentials and
network, and make its output depend on what that server has loaded. If
rule-based value sets turn out to matter, an opt-in step can expand them once
and save the result next to `plumb.lock`, keeping `generate` offline.

### 4. Where generated code lives: committed, one file per profile

```text
src/fhir/generated/            ← `out` in plumb.config.ts
├── index.ts                   re-exports every type, URL constant and helper
├── _plumb.ts                  shared helpers: Require<>, slice utilities
├── USCorePatient.ts           the type, its …ProfileUrl constant, its helpers
├── USCoreBloodPressure.ts
└── …                          one file per profile
```

- **Committed to the project's repository** (Principle 2), as openapi-typescript
  output, Supabase's generated types and Prisma's newer generator are. Rejected:
  `node_modules` (invisible in review, regenerated on install, unverifiable),
  and gitignored output generated at build time (reviewers cannot see type
  changes, and every clone and CI job needs a generate step first).
- **One file per profile, plus an index,** so a profile change touches one file.
  Apps import from the index.
- **`.ts`, not `.d.ts`,** because the slice and code helpers are small runtime
  functions. The app's own build compiles them.
- **The only import is types from `@medplum/fhirtypes`,** so apps take no
  runtime dependency on Plumb.
- **Relative imports carry `.js` suffixes** (`./USCorePatient.js`), which work
  under `NodeNext`, `bundler` and older module settings alike.
- **Plumb owns the folder:** `generate` removes files for profiles no longer
  listed, and refuses to run if the folder holds a file without a Plumb header.
- **`out` is required,** with no hidden default.
- A single file for everything (openapi-typescript's layout) was rejected:
  with dozens of profiles it becomes one large file with noisy diffs.

## Defaults (change only with a reason)

- Type names come from the profile's `name` (`USCorePatientProfile` becomes
  `USCorePatient`).
- Every generated file has a header ("generated by Plumb, do not edit") with the
  profile URL, its version and the source package's hash, so staleness is
  detected exactly.
- Output is deterministic: stable ordering, no timestamps. The docs suggest
  excluding the folder from project linters.
- Each profile also gets a `…ProfileUrl` constant.

## Testing (from the spec's Testing Decisions)

- **Contract tables** per test profile: each fixture states whether it compiles
  (`@ts-expect-error` for the negative rows) and whether it passes
  `validateProfiled`. Cover nested required fields, each slice rule (unordered,
  ordered, closed) and each binding case.
- **Golden tests**: generated output for a fixed set of US Core and IPS profiles
  matches committed files.
- **Compatibility**: generated output type-checks under the oldest supported
  TypeScript and under both `NodeNext` and `bundler` module resolution.
- **No Medplum server.** `validateProfiled` promises Medplum's validator at the
  installed version, not the server's verdict, so v0.1 needs no server tests.
- Test profiles come only from published IGs and Plumb's own synthetic
  profiles. [`../research/us-core-9-routing.md`](../research/us-core-9-routing.md)
  lists the required elements that make good negative fixtures.
