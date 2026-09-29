# Prior Art

What Plumb borrows, what it evaluated and set aside, and why. The spec's
Inspiration tables summarise this; the detail lives here.

## Drizzle

- **Package split:** `drizzle-orm` (runtime), `drizzle-kit` (CLI, migrations),
  `drizzle-zod` (schemas). Plumb copies the split exactly: the runtime ships to
  bots and must stay small; the compiler, validator definitions and migration
  runner never ship at all.
- **Migrations:** numbered files and a journal in the repo, an applied-state
  ledger in the database, a hash per file. The repo knows what should have run;
  only the database knows what did. Plumb keeps the ledger in the Medplum
  project it describes for the same reason.
- **One config file** every command reads (`drizzle.config.ts`).
- **Not copied:** one transaction around all pending migrations. Medplum
  transaction bundles do not scale to thousands of resources, so Plumb uses
  idempotent transforms (`null` means already done) instead.
- **`drizzle-zod`** is the model for `plumb-zod`: insert and select schemas
  with refinements, derived from the same source as the types.

## Prisma

- **`prisma generate`** from a declared schema. TypeScript cannot infer types
  from HL7's JSON, so generation is the only way to get profile types.
- **Split between CLI (`prisma`) and client (`@prisma/client`).**

## tRPC and the T3 stack

- **One contract, inferred on both sides.** A server change breaks the caller at
  compile time. `plumb-operations` applies this to bot-backed FHIR operations.
- **Not copied:** a tRPC server. Medplum bots stay the only server runtime, and
  contracts ride Medplum's OperationDefinitions.
- **Validate once at the edge, then trust.** Plumb's typed reads assert the
  profile stamp at the read edge; Zod guards input edges.
- **T3 Env:** validate configuration at build time, so a misconfiguration fails
  the build and not the first request.

## Terraform

- **Plan, then apply; converge on every run.** `plumb push` shows a plan and
  applies only with `--write`, and a second run with no config change is an
  empty plan.

## Medplum itself

- **`@medplum/fhirtypes`** is generated from Medplum's own definitions. Plumb's
  types extend it rather than replacing it, and the generator is the most
  natural candidate for adoption upstream.
- **`@medplum/cli`** already deploys bot code. Plumb registers bots and their
  memberships but leaves code deployment to the CLI.

## `@atomic-ehr/codegen` (evaluated, not adopted)

A FHIR TypeScript code generator. Set aside because it cannot build on
`@medplum/fhirtypes` (it generates its own base tree) and its runtime check is
shallow. Borrowed ideas:

- named extension accessors;
- slice accessors that set the discriminator for you;
- must-support gaps reported as warnings;
- one zero-dependency runtime helpers file;
- a `create` that fills fixed values without mutating the caller's object.

## FSH and SUSHI

FHIR Shorthand turns a profile rule into a few readable lines instead of
hand-written slicing JSON, and SUSHI compiles it to StructureDefinitions with
snapshots. Plumb accepts FSH (with SUSHI as an optional peer) or plain
StructureDefinition JSON, so it does not dictate how a project authors
profiles.

## Considered and rejected

- **A Postgres `CHECK` constraint on resource content.** See
  [medplum-server-behaviour](medplum-server-behaviour.md#validation): deleted
  rows store `''`, reindexes rewrite every row, and it would duplicate the
  profile by hand.
- **A pre-commit bot that stamps profiles server-side.** Possible with Medplum's
  pre-commit subscriptions, but it adds latency to every write and hides the
  routing decision from the code. Plumb keeps routing in `create`, backed by a
  lint rule and a `check` rule, and would only reconsider if `check` kept
  finding strays in practice.
- **Version-pinned stamps (`url|version`).** Medplum matches bare URLs, so a
  versioned stamp validates nothing. Plumb stamps bare URLs and relies on the
  load gate instead.
