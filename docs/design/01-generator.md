# Design 01: Profile Compiler and Type Generator

**Status: proposed.** Four decisions below are open and need the maintainer's
call before implementation starts. Everything else is the working default.

Spec: [`../spec.md`](../spec.md) (Inputs, The intermediate representation,
Generated types). Prototype: [`../research/prototype.md`](../research/prototype.md).

## Job

Take implementation guide (IG) packages and a project's own profiles, and emit
TypeScript types that are true to each profile and still usable anywhere a
`@medplum/fhirtypes` type is expected.

## Pipeline

```text
plumb.config.ts
  → resolve   IG packages from plumb.lock, plus local FSH / JSON
  → compile   SUSHI on local FSH (optional peer)
  → load      snapshots only; fail on any profile without one
  → IR        one normalized model per profile
  → emit      types, URL constants, IR sidecars, agent summaries
              (routing and Zod reuse the same IR later)
```

### Inputs

- **IG packages** are named in config (`hl7.fhir.us.core@9.0.0`), fetched by
  `plumb pull` from the FHIR package registry, pinned in `plumb.lock` with an
  integrity hash.
- **Local profiles** are FSH (compiled by SUSHI) or StructureDefinition JSON.
- **Only the profiles a project uses are compiled**, plus their dependency
  closure: parent profiles, referenced extensions, and value sets behind
  required bindings. Never a whole IG.
- **A snapshot is mandatory.** Registry packages and SUSHI both provide one. A
  local JSON profile without a snapshot is an error, not something Plumb
  repairs; snapshot generation is a hard problem (`fhir-snapshot-generator`
  exists if that ever changes), and a snapshot-less profile breaks Medplum
  anyway.

### The intermediate representation

Per profile: URL, version, name, base type, parent profile, and for each element
its path, cardinality, allowed types, binding, fixed or pattern value, slicing
and slices, and attached invariants. Every emitter reads only the IR, which is
what keeps types, routing and Zod schemas from disagreeing. The IR is also
written as a JSON sidecar per profile so `validateProfiled`, routing and the
agent summaries never re-parse snapshots.

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
| Invariant (FHIRPath) | Doc comment only; enforced by the server and `validateProfiled` |
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
  committed, one module per profile plus an index, importing small helpers
  (`Require`, slice builders) from `plumb`. The Drizzle model: a profile change
  is a reviewable diff, and `check` fails CI when output is stale.
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

- **Contract tables** per test profile: each fixture states whether it compiles
  (`@ts-expect-error` for the negative rows) and whether it passes
  `validateProfiled`.
- **Golden tests**: generated output for a fixed set of US Core and IPS profiles
  matches committed files.
- Test profiles come only from published IGs and Plumb's own synthetic
  profiles. [`../research/us-core-9-routing.md`](../research/us-core-9-routing.md)
  lists the required elements that make good negative fixtures.
