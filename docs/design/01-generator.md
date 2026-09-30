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
  → fetch     missing IG packages into ~/.fhir/packages, verified against plumb.lock
  → resolve   the pinned IGs, plus local StructureDefinition JSON
  → load      snapshots only; fail on any profile without one
  → parse     @medplum/core's parseStructureDefinition() → InternalTypeSchema
  → emit      one module per profile, an index, the helpers the modules use,
              and a …ProfileUrl constant per profile
              (routing, Zod and agent summaries reuse the same parse later)
```

### Inputs

- **IG packages** are named in config (`hl7.fhir.us.core@9.0.0`), fetched by
  `plumb generate` from the FHIR package registry into the shared FHIR package
  cache, and pinned in `plumb.lock` with an integrity hash. `hl7.fhir.r4.core`
  is skipped: base R4 comes from `@medplum/definitions`.
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

**Anything the types cannot enforce is written in the doc comment,** with who
checks it. `validateProfiled` checks required slices and invariants. No
offline check covers terminology: Medplum's validator checks no binding, so
required bindings on a `CodeableConcept` and value sets that cannot be expanded
offline are checked only by a server with the `validate-terminology` feature
([research](../research/medplum-server-behaviour.md#what-it-checks-run-against-us-core-900)).

## Decisions

### 1. Depth of required-field narrowing: full depth

Narrow along every path of required elements, not only the top level. US Core
Patient requires `identifier`, and inside each identifier `system` and `value`,
so `identifier: [{}]` must not compile:

```ts
type USCorePatient = Omit<Patient, 'identifier' | 'name'> & {
  identifier: Require<Identifier, 'system' | 'value'>[];
  name: HumanName[];
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
| Required binding on a `CodeableConcept` | The base type, plus exported code constants; not checked offline (see below) |
| Required binding whose value set cannot be listed offline (filters, VSAC) | `string`, with the value set URL in the doc comment |
| More than about 100 codes (configurable) | `string`, with the value set URL in the doc comment |
| Extensible binding on a `code` | `'a' \| 'b' \| (string & {})`: autocomplete without rejecting other codes |
| Preferred or example | The base type |

A `CodeableConcept`'s required binding means "at least one coding from the
set", the same "contains" rule as a slice, which a type cannot say. Unlike a
slice, Medplum's validator does not check it either: it checks no binding, and
leaves terminology to the server's `validate-terminology` feature. So on a
`code` or `Coding`, the literal union is the only offline check there is.

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

## Emitter architecture

The emitter is a compiler back end: it transforms one tree into another and
prints the result. It follows json-schema-to-typescript's staged pipeline
(parse → normalize → optimize → generate, each a separate module):

```text
InternalTypeSchema  →  transform  →  type model  →  print  →  .ts files
(Medplum's parse)      (the rules      (a small tree of      (text only; reuses
                        above and       TypeScript types:     @medplum/core's
                        the decisions)  object, union,        FileBuilder)
                                        literal, array,
                                        tuple, reference)
```

- **Transform** holds every FHIR rule: narrowing, choice types, fixed values,
  slices, bindings. It is a pure function from a parsed profile to a type
  model, tested by asserting on the model, not on text.
- **Print** holds every formatting rule: indentation, ordering, doc comments,
  headers, import suffixes. It is a pure function from the model to text,
  tested on its own.
- **Reuse, not rebuild:** `FileBuilder`, `buildTypeName` and `wordWrap` are
  exported from `@medplum/core` and are what `@medplum/generator` uses, so
  names and layout stay consistent with `@medplum/fhirtypes` and no dependency
  is added.

Rejected:

- **Building strings directly** (`@medplum/generator`'s approach): the least
  code, but FHIR logic and formatting tangle, and neither can be tested alone.
- **TypeScript's compiler API** (`ts.factory` and its printer, as
  openapi-typescript does): guaranteed-valid syntax, but it makes `typescript`
  a runtime dependency, and TypeScript 7's native compiler has no JavaScript
  API.

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

Tests check what **should** happen, not what Plumb happens to do. Every
expected result comes from a source independent of the generator:

1. **Medplum's validator, called directly.** "Should this resource be valid?"
   is answered by `@medplum/core`'s `validateResource`, not by Plumb's
   `validateProfiled` wrapper, so the harness needs none of Plumb's code.
2. **HL7's published examples.** US Core 9.0.0 ships 230 example resources
   (CC0-1.0). Every one must compile against its generated type and pass the
   validator.
3. **The profile's own rules, read by a person.** For each synthetic fixture,
   "compiles" or "does not compile" is written from the profile's text
   ("`birthDate` is 1..1") before any generator code exists. Generated output
   is never used to decide an expected result.

- **Contract tables** per test profile: each fixture states whether it compiles
  (`@ts-expect-error` for the negative rows) and whether it validates. Written
  first, following the coverage matrix below.
- **Compiles and validates must agree,** except in cases listed in advance.
  "Validates" means `validateResource` reports no `error` issue; warnings do
  not count. The cases, from what Medplum's validator was found to check
  ([research](../research/medplum-server-behaviour.md#what-it-checks-run-against-us-core-900)):
  - *compiles, does not validate:* a required slice missing or repeated past
    its `max`, and an invariant;
  - *does not compile, validates:* a code outside a required binding on a
    `code` or `Coding` (the validator checks no binding), a `Reference` to a
    resource type the profile excludes (unchecked for IG target profiles, a
    warning otherwise), an extension whose contents break the extension's own
    profile (the validator checks extensions against the base type), and a
    required primitive present only as a `_field` extension;
  - *compiles and validates, though the profile forbids it:* a
    `CodeableConcept` with no coding from its required value set, and a code
    from a value set that cannot be expanded offline. Neither side can check
    these offline.

  Types that reject what the validator accepts, or accept what it rejects
  outside that list, are bugs. The list changes only by a reviewed edit to
  this document.
- **Golden tests**: generated output for a fixed set of US Core and IPS profiles
  matches committed files. They detect change, not correctness, so each golden
  file is reviewed against its profile before it is committed.
- **Compatibility**: generated output type-checks under the oldest supported
  TypeScript and under both `NodeNext` and `bundler` module resolution.
- **No Medplum server.** `validateProfiled` promises Medplum's validator at the
  installed version, not the server's verdict, so v0.1 needs no server tests.
- Test profiles come only from published IGs and Plumb's own synthetic
  profiles. [`../research/us-core-9-routing.md`](../research/us-core-9-routing.md)
  lists the required elements that make good negative fixtures.

### Coverage matrix

Every row gets at least one fixture that should compile and validate, and one
edge case that should not (or that records a known limit).

| Area | Cases |
|---|---|
| Cardinality | 0..1, 1..1, 0..\*, 1..\*; `max: 0`; a profile tightening `0..*` to `0..1` (still a JSON array) |
| Nesting | required fields inside complex types and backbone elements, at several depths |
| Primitive types | the TypeScript mapping of every FHIR primitive (string, boolean, integer, decimal, date, dateTime, instant, time, code, uri, url, canonical, id, oid, uuid, markdown, base64Binary, positiveInt, unsignedInt) |
| Choice types | narrowed to one type; several types, optional; required "exactly one of" |
| Fixed and pattern values | on a primitive, a `Coding` and a `CodeableConcept` |
| Bindings | each of the six cases in decision 3, including a value set that cannot be expanded offline and one over the size limit |
| Slices | unordered, ordered, open, closed; required and optional; extension slices; slices with nested required fields |
| Extensions | simple and complex (nested), required and optional |
| References | target-type narrowing (`Reference<Patient>`); IG target profiles the server does not enforce |
| Inheritance | a child profile assignable to its parent (BMI → vital signs); several profiles on one base type |
| Recursion | an element that refers back to itself (`Questionnaire.item.item`) |
| Naming | two profiles whose type names would collide |
| Primitive extensions | a required primitive present only as `_field` with a data-absent-reason: record what the validator does; the types do not allow it |
| Whole resources | all 230 of US Core 9.0.0's published examples, plus synthetic Patient, Blood Pressure, lab result and Condition fixtures |
