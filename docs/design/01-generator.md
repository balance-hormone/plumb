# Design 01: Profile Compiler and Type Generator

**Status: proposed.** Four decisions below are open and need the maintainer's
call before implementation starts. Everything else is the working default.

Spec: [`../spec.md`](../spec.md) (Inputs, Parsing, Generated types).
Prototype: [`../research/prototype.md`](../research/prototype.md).

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
| Required nested element | Non-optional inside its parent (depth: decision 1) |
| `max: 0` (prohibited) | `?: never` |
| Choice type narrowed to one type | Only that property, e.g. `valueQuantity` |
| Required choice with several types | "Exactly one of": a union where each branch sets one and forbids the rest |
| Fixed value (`fixedCode`, `fixedUri`) | A literal type |
| Pattern value (`patternCodeableConcept`) | Must include that coding; the rest stays open |
| Required binding to an enumerable value set | A literal union of codes (decision 3) |
| Fixed-value slice | A named type per slice (representation: decision 2) |
| Extension slice (by URL) | A named, typed extension, plus a getter and setter |
| Invariant (FHIRPath) | Doc comment only; enforced by the server (in strict mode) and `validateProfiled`, except below `error` severity and the four Medplum skips |
| Must Support | Doc comment only; never changes optionality |
| Child profile (BMI → vital signs) | Child type is assignable to the parent type |

**Everything narrows `@medplum/fhirtypes`** (`Omit<Patient, …> & {…}`), so a
generated type works in every Medplum SDK call and React component with no
casts. The generator never emits a parallel base R4 tree.

## Open decisions

### 1. Depth of required-field narrowing

- **Recommended: full depth.** Narrow along every path of required elements;
  `Require<>` composes, and only required paths are touched, so types stay
  readable.
- Alternative: one level (the prototype). Simpler, but misses rules such as
  "every `component` needs a `code`".

### 2. Representation of required slices

TypeScript can say "an array whose first entry is a phone" but not "an array
containing a phone somewhere".

- **Recommended: both a type and a builder.** The type means "at least one
  phone, anywhere", enforced by a branded array that only a generated builder
  produces: `telecom: USCorePatient.telecom({ phone: [...], rest: [...] })`.
  Reads go through typed slice getters. This removes the prototype's worst gap
  (arrays built with `.map()` failing to type-check).
- Alternative: leading tuple positions (the prototype). Pure types, no helper,
  but order-sensitive and fragile.

### 3. Required bindings

- **Recommended: offline expansion where enumerable.** Expand a value set when
  its codes can be listed from the loaded packages (explicit concepts, or whole
  local CodeSystems) and emit a literal union. Otherwise (VSAC and other
  intensional value sets) emit `string`, with the value set URL in the doc
  comment.
- Alternative: expand through a live Medplum `$expand` at generate time. More
  complete, but `generate` would then need a server, breaking offline,
  deterministic builds.

### 4. Where generated code lives

- **Recommended: in the project's repo**, for example `src/fhir/generated/`,
  committed, one module per profile plus an index and a helpers module
  (`Require`, slice builders) emitted alongside them, so the app never imports
  Plumb at runtime. The Drizzle model: a profile change is a reviewable diff,
  and `plumb generate --check` fails CI when output is stale.
- Alternative: into `node_modules` (the Prisma client model). Nothing to
  commit, but invisible in review and regenerated on every install.

## Defaults (change only with a reason)

- Type names come from the profile's `name` (`USCorePatientProfile` becomes
  `USCorePatient`).
- Every generated file has a header with the profile URL, its version and the
  source package's hash, so staleness is detected exactly.
- Output is deterministic: stable ordering, no timestamps.
- Each profile also gets a `…ProfileUrl` constant.

## Testing (from the spec's Testing Decisions)

- **No Medplum server.** `validateProfiled` promises Medplum's validator at the
  installed version, not the server's verdict, so v0.1 needs no server tests.

- **Contract tables** per test profile: each fixture states whether it compiles
  (`@ts-expect-error` for the negative rows) and whether it passes
  `validateProfiled`.
- **Golden tests**: generated output for a fixed set of US Core and IPS profiles
  matches committed files.
- Test profiles come only from published IGs and Plumb's own synthetic
  profiles. [`../research/us-core-9-routing.md`](../research/us-core-9-routing.md)
  lists the required elements that make good negative fixtures.
