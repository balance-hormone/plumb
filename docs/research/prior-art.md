# Prior Art

What Plumb borrows, what it evaluated and set aside, and why. The spec's
Inspiration table summarises this; the detail lives here. Sections marked
*(parked)* inform the idea notes in [`../future/`](../future/), not Plumb's
first deliverable.

## Profile type generators (surveyed 2026-09-29)

The question: does a tool already turn FHIR profiles into TypeScript types that
a Medplum app can use? Several generate profile types; none narrows
`@medplum/fhirtypes`. Evaluated from each project's documentation and
repository activity, not by running it against US Core.

| Tool | What it generates | Compile-time narrowing | Builds on Medplum's types | State |
|---|---|---|---|---|
| fhir-dsl (`awbx/fhir-dsl`, MIT) | Its own base types with branded primitives, profile types, a typed query client, validators, FHIRPath, SMART, an MCP server | Yes: profile-required fields are non-optional, slices and extensions typed | No: standalone base types and its own client | One author; created April 2026, no pushes since May 2026; ~15 stars, ~23 downloads a week |
| `@atomic-ehr/codegen` (Health Samurai, MIT) | Its own base R4 types plus a wrapper class per profile: fixed values filled, slice and extension setters, `validate()` | No: required fields are checked at runtime | No: generates its own base tree | Active; ~4,760 downloads a week; still `0.0.x` |
| `fhir-schema/fhir-schema-codegen` | Predecessor of `@atomic-ehr/codegen` | No | No | Archived |
| `FHIR/fhir-codegen` (MIT) | C#, TypeScript and other languages from FHIR packages | Base-oriented; profile support limited | No | Mature and active |
| `@medplum/generator` | `@medplum/fhirtypes` | No: base definitions only | It is Medplum's types | Internal to Medplum; not published |

**The gap is narrow and real.** A Medplum app reads and writes through
`@medplum/core`, `@medplum/react` and `@medplum/fhirtypes`. A generator with its
own base types gives the app a second set of FHIR types, and a cast at every
boundary; fhir-dsl's branded primitives make a Medplum `string` date need a
cast even where the shapes agree. Plumb's reason to exist is one sentence: make
Medplum's own types profile-aware.

**Medplum has considered it.** In discussion #2006 (May 2023) Medplum's
maintainers said their generator could do the heavy lifting for profile types
and named packaging and publishing as the hurdle. Profile validation shipped;
profile types did not.

**What Plumb reuses instead of rebuilding:** `@medplum/core`'s
`parseStructureDefinition()` (Medplum's parsed profile model, `InternalTypeSchema`)
and its validator. See [Medplum server behaviour](medplum-server-behaviour.md).

### Borrowed from `@atomic-ehr/codegen`

- named extension accessors;
- slice accessors that set the discriminator for you;
- must-support gaps reported as warnings;
- one zero-dependency helpers file;
- a `create` that fills fixed values without mutating the caller's object.

## Drizzle

- **Package split:** `drizzle-orm` (runtime), `drizzle-kit` (CLI, migrations),
  `drizzle-zod` (schemas). Plumb starts as the kit alone: one dev-only package
  whose generated code carries its own helpers, routing and `createProfiled`
  included. A Zod package arrives only with Zod schemas.
- **Generated code in the repo:** Drizzle Kit writes reviewable files; Plumb
  commits its generated types the same way.
- **Migrations** *(parked)*: numbered files and a journal in the repo, an applied-state
  ledger in the database, a hash per file. The repo knows what should have run;
  only the database knows what did. Plumb keeps the ledger in the Medplum
  project it describes for the same reason.
- **One config file** every command reads (`drizzle.config.ts`).
- **Not copied:** one transaction around all pending migrations. Medplum
  transaction bundles do not scale to thousands of resources, so Plumb uses
  idempotent transforms (`null` means already done) instead.
- **`drizzle-zod`** is the model for a later Zod release: insert and select
  schemas with refinements, derived from the same source as the types.

## Prisma

- **`prisma generate`** from a declared schema. TypeScript cannot infer types
  from HL7's JSON, so generation is the only way to get profile types.
- **Split between CLI (`prisma`) and client (`@prisma/client`).**

## tRPC and the T3 stack *(parked)*

- **One contract, inferred on both sides.** A server change breaks the caller at
  compile time. The parked operation contracts idea applies this to bot-backed
  FHIR operations.
- **Not copied:** a tRPC server. Medplum bots stay the only server runtime, and
  contracts ride Medplum's OperationDefinitions.
- **Validate once at the edge, then trust.** Plumb's typed reads assert the
  profile stamp at the read edge; Zod guards input edges.
- **T3 Env:** validate configuration at build time, so a misconfiguration fails
  the build and not the first request.

## Terraform *(parked)*

- **Plan, then apply; converge on every run.** `plumb push` shows a plan and
  applies only with `--write`, and a second run with no config change is an
  empty plan.

## Medplum itself

- **`@medplum/fhirtypes`** is generated from Medplum's own definitions. Plumb's
  types extend it rather than replacing it, and the generator is the most
  natural candidate for adoption upstream.
- **`@medplum/core`'s `parseStructureDefinition()`** is Plumb's intermediate
  representation, and `@medplum/generator`'s `fhirtypes` script is the model
  for its emitter.
- **`@medplum/cli`** already deploys bot code *(parked: project config as code)*.

## FSH and SUSHI

FHIR Shorthand turns a profile rule into a few readable lines instead of
hand-written slicing JSON, and SUSHI compiles it to StructureDefinitions with
snapshots. Medplum's profiles guide recommends FSH for authoring and documents
the workflow `sushi . --snapshot`, then uploading the JSON from
`fsh-generated/`. Plumb reads that JSON, so FSH projects are served from v0.1
without Plumb depending on SUSHI (3.20: 23 dependencies, ~2.6 MB unpacked).
Running SUSHI from `plumb generate` is a later convenience; it needs an answer
for SUSHI's own package cache (`~/.fhir`) next to `plumb.lock`.

## FHIR packages and npm

FHIR packages are npm-compatible tarballs, but they live on `packages.fhir.org`,
not the public npm registry. On npm, `hl7.fhir.r4.core` and `hl7.fhir.us.core`
are `0.0.1-security` placeholders held by npm, which npm puts in place after
removing a malicious package, and other FHIR package names are held by
individuals. Installing IGs through npm is therefore a dependency-confusion
risk, which is why `plumb pull` fetches only from the FHIR registry.

## Considered and rejected *(parked)*

- **A Postgres `CHECK` constraint on resource content.** See
  [medplum-server-behaviour](medplum-server-behaviour.md#validation): deleted
  rows store `''`, reindexes rewrite every row, and it would duplicate the
  profile by hand.
- **A pre-commit bot that stamps profiles server-side.** Possible with Medplum's
  pre-commit subscriptions, but it adds latency to every write and hides the
  routing decision from the code. Plumb keeps routing in `createProfiled`,
  backed by `validate`'s count of unstamped resources, and would only
  reconsider if `validate` kept finding strays in practice.
- **Version-pinned stamps (`url|version`).** Medplum matches bare URLs, so a
  versioned stamp validates nothing. Plumb stamps bare URLs and relies on the
  load gate instead.
