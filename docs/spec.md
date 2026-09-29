# Plumb: Profile-Driven Type Safety for Medplum

Plumb makes a Medplum project's FHIR profiles the single source of truth for
the shape of its data. A profile is declared once and becomes three things: the
StructureDefinition the server enforces, the TypeScript types the editor
enforces, and the schemas tests and forms enforce. Plumb then keeps the server
honest to what the repo declares, and lets a project tighten its rules without
breaking the records it already holds.

A plumb line is the weighted string a builder hangs to find true vertical. A
project is *plumb* when every stored record is true to its profile.

This spec is deliberately agnostic. It names no organization's profiles, data
model or migration. The first adopter's own work (its profiles, its routing
rows, its import) lives in a separate adoption project that consumes Plumb the
way any other Medplum project would.

## Problem Statement

Medplum gives a project a FHIR R4 server, a validator, profiles, a typed SDK and
bots. What it does not give a project is a way to make those agree with each
other and with the code.

- **The types describe base R4, not the project.** `@medplum/fhirtypes` is
  generated from the base specification, where almost every element is
  optional. A project that requires a birth date on every Patient still reads
  `patient.birthDate` as `string | undefined`, so application code fills with
  `?.` and `?? ""` that hide missing data instead of preventing it.
- **Profile rules get re-implemented by hand.** A required field is enforced by
  a form schema, a use-case guard, an import mapper and the server, each
  written separately, each able to drift.
- **Validation happens last.** A non-conforming write surfaces as a 400 at the
  moment someone is using the app, or halfway through a bulk import, never in
  the editor.
- **`defaultProfile` covers one profile per resource type.** Many implementation
  guides (IGs) have several profiles per type, chosen by content: US Core has
  a separate profile for heart rate, lab results and smoking status, all of
  them `Observation`. A project either validates every Observation against the
  loosest profile or hand-stamps `meta.profile` in every writer.
- **Loading a profile is a one-way door with no preview.** Medplum validates on
  write, not on load, and never re-checks stored data. Loading a stricter
  profile version silently arms a failure in the next write of every stored
  record that does not meet it. Nothing says how many there are before it
  happens.
- **Some failures are silent.** An unknown profile URL, a versioned
  `url|version` stamp, or an empty `meta.profile: []` all pass validation
  against nothing. With `strictMode` off, only the base R4 JSON schema is
  enforced: profile failures are logged and the write succeeds. Even in strict
  mode, a profile's `Reference(X)` narrowing and its non-error constraints are
  never checked.
- **Project configuration is console state.** `strictMode`, features, default
  profiles, access policies and client applications are usually set by hand,
  cannot be reviewed, and cannot be reproduced in a second environment.
- **Bot operations are untyped at the boundary.** A caller invokes an operation
  by string name and casts the response. The bot and the caller deploy
  separately and can disagree without anyone noticing.

Every one of these costs almost nothing to fix before a project holds real data
and a great deal after. Most projects discover them after.

## Goals

1. **One source of truth for shape.** A rule is declared once, in a profile,
   and the server, the editor, tests and forms all enforce it.
2. **Types that tell the truth.** A read returns what the profile guarantees.
   A missing required field is a compile error.
3. **Validation where it is cheapest.** Types first, tests second, a
   pre-deploy check third, the server last.
4. **Safe to tighten, safe to adopt late.** A project with live, loose data can
   see exactly what a rule would break, migrate it, and reach strict without an
   outage.
5. **Configuration as code.** Profiles, defaults, project settings, clients and
   access policies are declared in the repo and converged on every run.
6. **Agnostic to the data model.** Any IG (US Core, IPS, CARIN, Da Vinci, a
   project's own), any set of local profiles. Plumb's own tests use only
   published IGs and synthetic data.
7. **Built on Medplum, not around it.** Medplum's validator, types, search,
   OperationDefinitions and bots. No parallel FHIR model, no second server.
   Anything Medplum should own is proposed upstream.
8. **Readable by agents.** Every rule is a compiler error or a failing check,
   and one generated file tells a reader everything a profile or an operation
   requires.

## Non-goals

- A query builder or ORM. The Medplum SDK is already typed; Plumb sits under it.
- Replacing Medplum's validator. Plumb's generated Zod schemas are for forms and
  input edges; the server's validator stays the final word.
- A server runtime. Bots remain the only server-side code.
- UI components. Plumb exposes typed errors; how an app renders them is the
  app's business.
- FHIR versions other than R4, and FHIR servers other than Medplum.
- Any organization's profiles, routing rows, migrations or imports.

## Principles

These decide the questions the rest of the spec does not answer.

1. **If you know FHIR and Medplum, you know Plumb.** Plumb adds no concepts
   Medplum already has a word for. Its types extend `@medplum/fhirtypes`, its
   validator is Medplum's, its transport is the Medplum client, and a stored
   record looks the same with or without Plumb. This is Drizzle's advantage
   over Prisma: nothing sits between a developer and the thing they already
   know.
2. **Generated code is readable, committed code.** Plumb must generate
   (TypeScript cannot read a profile's JSON), so the output is a reviewable
   diff in the project's repository, never a hidden client in `node_modules`.
3. **Earn every dependency.**
   - `plumb` has no runtime dependencies beyond its `@medplum/*` peers, and CI
     keeps its bundle size in check, because it ships inside bots.
   - `plumb-zod` and `plumb-operations` depend only on Zod (as a peer) and
     Medplum.
   - `plumb-kit` prefers Node built-ins: `util.parseArgs` for the CLI, Node's
     built-in type stripping to load `plumb.config.ts`, `fetch` and `zlib`
     for IG packages. Each dependency it does take is justified in writing.
     SUSHI stays an optional peer.
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
6. **Readable output.** Published code is not minified and has one entry point
   per package, so a stack trace leads somewhere a person can read.

## Solution

**Four packages, split by where they run and what is optional.** The split
follows Drizzle (`drizzle-orm`, `drizzle-kit`, `drizzle-zod`) and tRPC (server
and client packages around one contract), and matches Medplum's own
(`@medplum/core` at runtime, `@medplum/cli` in CI).

| Package | Runs in | Contains |
|---|---|---|
| `plumb` | apps, bots, scripts | Generated profile types, the routing table, `create` and `update`, typed reads, profile URL constants, the typed error classes. No heavy dependencies; bundles into a bot. |
| `plumb-kit` | dev and CI only | The `plumb` CLI, `defineConfig`, the generator, `validateProfiled` for tests, the migration runner, project state as code. Depends on `@medplum/definitions`; SUSHI is an optional peer. |
| `plumb-zod` | apps and input edges | Zod schemas generated from the same profiles, with `pick`, `partial` and override helpers for forms. Optional. |
| `plumb-operations` | apps and bots | Typed contracts for bot-backed FHIR operations: one definition, a typed caller, a typed handler, a generated OperationDefinition. Needs no profiles; uses Plumb's types when present. Optional. |

The npm scope is an open decision (see Further Notes). Package names are written
unscoped here.

**One config file, one intermediate representation.** `plumb.config.ts`
declares the IGs, the local profiles, the default profile per resource type, the
routing rows, the project state and the environments. The generator reads every
profile's snapshot into one intermediate representation (IR) and emits the
TypeScript types, the routing table, the read helpers and the Zod schemas from
it, so no two outputs can disagree.

**A workflow modelled on Drizzle Kit.**

```text
plumb pull       fetch the pinned IG packages; write the lockfile
plumb generate   compile local profiles, then emit types, routing, schemas
plumb check      what is wrong: in the repo, and (with --env) on the server
plumb push       make the server match the repo, as a reviewed plan
plumb migrate    apply pending data migrations; dry-run unless --write
```

## User Stories

**Profiles and types**

1. As an engineer, I want to declare a profile rule once, so that the server, the editor and the tests enforce the same rule.
2. As an engineer, I want to depend on a published IG by name and version, so that adopting US Core or IPS is a line in a config file.
3. As an engineer, I want to write local profiles in FSH, so that a rule is a few readable lines instead of hand-written slicing JSON.
4. As an engineer, I want to bring hand-written StructureDefinition JSON instead of FSH, so that Plumb does not dictate how I author profiles.
5. As an engineer, I want `plumb generate` to be the one command that brings every derived artifact up to date.
6. As an engineer, I want generated output committed and checked for staleness in CI, so that a profile change is a reviewable diff and never ships without its types.
7. As an engineer, I want required elements, nested required elements, choice types, required bindings and fixed-value slices expressed in the types, so that a non-conforming resource fails to compile.
8. As an engineer, I want each generated type's doc comment to list the invariants the type cannot express, so that I know what the server still checks.
9. As an engineer, I want the generated types to extend `@medplum/fhirtypes`, so that they work with every Medplum SDK method and component unchanged.
10. As an engineer, I want `validateProfiled` in tests, backed by Medplum's own validator, so that a passing test means a strict project would accept the write.

**Defaults and routing**

11. As an engineer, I want to declare a default profile per resource type, so that no write of that type goes unvalidated.
12. As an engineer, I want resources routed to the profile their content selects, so that a heart rate, a lab result and a smoking status are each held to their real profile.
13. As an engineer, I want routing rows generated from the values an IG's profiles pin, so that those rows cannot drift from the profiles.
14. As an engineer, I want to add routing rows by hand where a profile keys on a value set, so that routing covers the whole IG.
15. As an engineer, I want the most specific profile to win when profiles overlap, so that BMI is held to the BMI profile and not only to vital signs.
16. As an engineer, I want `create` to stamp the default and the routed profile, so that a stamped record never loses its floor.
17. As an engineer, I want an update that changes the routing key to restamp, so that a record's profile always matches what it is.
18. As an engineer, I want to choose per call site whether an unrouted key falls back to the default or is rejected, so that an interactive write never blocks while a bulk import fails closed.
19. As an engineer, I want a lint rule and a check rule for writes that bypass `create`, so that routing cannot be skipped quietly.

**Checks and gates**

20. As an engineer, I want `plumb check` to report, per profile and environment, how many stored resources would fail and why, so that I know what a change breaks before it breaks.
21. As an engineer, I want `push` to refuse to load a profile version while stored resources would fail it, so that loading never arms a failure in a record's next write.
22. As an engineer, I want `check` to re-run straight after a load, so that writes between the check and the load are caught.
23. As an engineer, I want `check` to fail on a stamp that validates nothing (an unloaded URL, a versioned URL, an empty `meta.profile`), so that silent passes are visible.
24. As an engineer, I want `check` to fail when live defaults, settings or policies differ from the config, so that drift is caught.
25. As an engineer, I want `check` to tell me whether strict mode is on in each environment, so that I never trust a gate the server is not enforcing.

**Adopting late**

26. As an engineer on a project with live data, I want to run `check` against production with no changes to it, so that I can see the size of the problem first.
27. As an engineer, I want a committed baseline of known failures that may shrink but never grow, so that I can load profiles before every old record is fixed without accepting new failures.
28. As an engineer, I want a documented path from "no profiles" to "strict", so that I can plan it as a sequence of safe steps.

**Typed reads**

29. As an engineer, I want read and search helpers that return the profile type, so that a component receives a conforming resource, not base R4.
30. As an engineer, I want those helpers to assert the profile stamp and throw a typed error when it is missing, so that an unvalidated record is caught at the edge instead of rendered as plausible data.
31. As an engineer, I want the helpers to refuse `_elements`, `_summary` and `_history`, so that partial or never-validated resources are never typed as complete.
32. As an engineer, I want a check rule for raw reads of profiled types, so that the typed helpers become the read path.

**Migrations**

33. As an engineer, I want `plumb migrate:new` to scaffold a numbered migration and a journal entry, so that every migration starts in one shape.
34. As an engineer, I want a migration to declare only its resource type, search and transform, so that dry-run, batching, idempotency and the ledger are never re-implemented.
35. As an engineer, I want a transform that returns `null` to mean "already done", so that re-runs skip finished records.
36. As an engineer, I want the runner to dry-run by default, to refuse to start while a run is in progress, and to flag a migration edited after it ran, so that migrations fail closed.

**Project state as code**

37. As an engineer, I want strict mode, features, settings, default profiles and default access policies declared and converged, so that none of them is console state.
38. As an engineer, I want client applications and access policies declared, so that a second environment can be built from the repo.
39. As an engineer, I want `push` to show a plan and apply only with `--write`, and a second run to change nothing, so that provisioning is reviewable and safe to repeat.
40. As an engineer, I want `push` to refuse to create a project the config does not already match, so that a mistyped run cannot fork production.
41. As an engineer, I want a documented lockdown recipe (people read-only, CI writes configuration, super admin as break-glass), so that the Medplum app stops being a way to change configuration.

**Forms and input edges**

42. As an engineer, I want a Zod schema generated from a profile, so that a form enforces the same required fields the server does.
43. As an engineer, I want `pick`, `partial` and override helpers on it, so that a form that edits part of a resource gets a schema for exactly that part.

**Operations**

44. As an engineer, I want one contract per bot-backed operation, so that its name, level, input and output live in one file.
45. As an engineer, I want the caller and the handler both typed from the contract and both parsing at runtime, so that a server change breaks the caller at compile time and version skew fails loudly.
46. As an engineer, I want the OperationDefinition generated from the contract, so that the FHIR-facing signature cannot drift from the code.

**Docs and agents**

47. As an agent, I want a generated summary per profile and per operation (required fields, bindings, invariants, routing keys), so that I can write a conforming resource or call on the first try.
48. As a developer, I want task guides for adding an IG, writing a local profile, adding a routing row, writing a migration, releasing a stricter profile, adopting on a live project and adding an operation.

## Implementation Decisions

### Inputs

- **IG packages** come from the FHIR package registry (`packages.fhir.org`,
  npm-compatible tarballs), declared by name and exact version. `plumb pull`
  resolves their dependencies and writes `plumb.lock` with each package's
  integrity hash. Nothing is fetched at generate time; generate and check are
  deterministic offline.
- **Local profiles** are FSH compiled by SUSHI, or StructureDefinition JSON.
  SUSHI is an optional peer dependency, needed only when FSH is present.
- **Only the StructureDefinitions a project uses are committed**, with the
  extensions and value sets they reference, so the repository does not carry
  whole IGs.
- **Snapshots are required.** Registry packages ship with them; SUSHI produces
  them. `check` fails on any committed or loaded profile without a snapshot,
  because a snapshot-less profile loaded into Medplum breaks validation for
  every resource that claims it.
- **FHIR R4 only**, matching Medplum.

### The intermediate representation

- One IR per profile, built from its snapshot, never its differential: each
  element's path, cardinality, types, binding, fixed or pattern value, slicing
  discriminator and slices, and the invariants that apply.
- Every emitter reads the IR: TypeScript types, the routing table, read helper
  signatures, Zod schemas and the agent summaries. A disagreement between two
  outputs is therefore a generator bug, testable in one place.

### Generated types

- **Extend `@medplum/fhirtypes`**, never generate a parallel base R4 tree. A
  profile type is `Omit<Base, narrowed fields> & { narrowed fields }`, so it is
  assignable wherever the base type is expected.
- Required top-level and one level of required nested elements become
  non-optional; choice types become "exactly one of"; required bindings become
  literal unions; fixed-value slices become named types; invariants go in the
  doc comment.
- **The doc comment also lists what the server will not enforce**, so nobody
  mistakes documentation for a rule: constraints below `error` severity, the
  invariants Medplum skips (`ele-1`, `dom-3`, `org-1`, `sdf-19`), and
  `Reference` target profiles, which Medplum does not check against IG
  profiles. Where TypeScript can express a target type, the generated type
  still narrows it; the server just will not back it up.
- Borrowed from `@atomic-ehr/codegen` (evaluated, not adopted, because it cannot
  build on `@medplum/fhirtypes`): named extension accessors, slice accessors
  that set the discriminator, must-support gaps as warnings, and a `create`
  that fills fixed values without mutating the caller's object.
- **Known limits, stated in the README:** a required slice must occupy the
  leading array positions to satisfy its tuple type; arrays built with `.map()`
  are typed as the base element; empty arrays compile; invariants are
  runtime-only.

### Defaults and routing

- **Defaults** map a resource type to one profile, written to
  `Project.defaultProfile`. Medplum applies a default only when a resource has
  no `meta.profile`, and writes the default's URLs into the stored
  `meta.profile` when it does, so a record validated under its default carries
  a stamp like any other (read from Medplum's server source: `repo.ts`,
  `checkResourcePermissions`). An empty `meta.profile: []` counts as present
  and skips the default.
- **Routing** covers types whose profile depends on content. One table, from
  two sources:
  - **generated rows** wherever a profile pins a fixed or pattern value on its
    key (a LOINC code, a category), so they cannot drift from the IG;
  - **config rows** where a profile keys on value-set membership, or where the
    project wants a specific answer. Each config row gets a generated contract
    test.
- **Keys** are declared per resource type (`code`, `category`, or an arbitrary
  path, including absence of an element). Where profiles overlap, the most
  specific wins; a child profile carries its parent's constraints.
- **`create` and `update`** stamp the default plus the routed profile, because
  a stamp suppresses the default and the floor would otherwise be lost. An
  update that changes the key restamps. The return type narrows by the key.
- **Unrouted keys** follow a per-call policy: `"default"` (stamp the default
  and report it) or `"reject"` (throw). Interactive writes use the first; bulk
  imports the second.
- **Backstops:** a lint rule (Biome or ESLint plugin, published with the kit)
  for raw creates of routed types outside the helper, and a `check` rule for
  stored resources whose key routes to a profile they do not carry.
- **A changed routing row ships with a migration** that restamps stored
  records, because a stored stamp persists.

### `check` and `push`

| Command | Reads | Writes |
|---|---|---|
| `check` (repo) | the config, generated output, committed profiles | nothing |
| `check --env <env>` | the above plus the live project | nothing |
| `push --env <env>` | the same | a plan; applies it only with `--write` |

- **Repo checks:** stale generated output; a profile without a snapshot; a
  default declared for a configuration type; a hand-written `meta.profile`
  outside the helpers; the lint findings above.
- **Server checks:** live defaults, settings and policies against the config;
  stamps that validate nothing (unloaded URL, `url|version`, empty array);
  routing strays; per-profile conformance of stored resources, computed
  offline with Medplum's validator against the local StructureDefinitions,
  reported as counts and reasons, with resource ids written only to a local,
  gitignored file. Offline, because the profiles that matter are the ones not
  loaded yet. The server's own `POST /:type/$validate`, which always
  validates strictly against loaded profiles, is what the server tests use to
  prove the offline answer matches the server's.
- **Profile shadowing:** more than one StructureDefinition for a canonical URL
  in the project, or one in a linked project that exports StructureDefinition,
  because Medplum's lookup would then pick between them (see the load gate).
- **Strict mode detection** reads `GET /auth/me`, which returns
  `project.strictMode` and `project.features` to any member (read from
  Medplum's source), not the log lines Medplum emits when it is off.
- **`push` is the only command that writes server configuration**, and it
  plans first: StructureDefinitions to add or update (dependencies first),
  defaults, settings, clients and policies. A second run with no config change
  is an empty plan.
- **One StructureDefinition per canonical URL.** Medplum picks the "newest"
  profile for a bare URL by sorting `version` as text, then `date`, so `1.9.0`
  beats `1.10.0`, and its lookup also reaches linked projects. Rather than rely
  on that, `push` keeps exactly one StructureDefinition per URL in the project
  and loads a new version by updating it in place; `check` fails on any
  duplicate or shadowing copy.
- **The load gate:** loading is what switches a rule on. `push` refuses to
  load a profile version while `check` reports stored resources that fail it,
  then re-runs `check` straight after the load. This is Postgres's `ADD
  CONSTRAINT … NOT VALID` followed by `VALIDATE CONSTRAINT`.
- **Every command is a plain function** that takes a client and returns a
  report; the CLI prints it and sets the exit code. This is what makes them
  testable against a mock client.

### Adopting late

The documented path for a project that already holds data:

1. `plumb check --env production` with profiles declared but not pushed. It
   writes nothing and reports what would fail.
2. Migrations fix what a transform can fix; a person fixes the rest.
3. **A baseline file** (`plumb.baseline.json`, committed) records the failures
   that remain, per profile and reason. `push` may load a profile while its
   stored failures are within the baseline, and never when they exceed it. The
   baseline may only shrink, which `check` enforces, the same ratchet pattern as
   a lint baseline.
4. `push --write` loads the profiles and defaults.
5. Strict mode goes on (super admin only, see below). From here, a failing
   write is a 400.

A project starting clean skips steps 2 and 3 and has an empty baseline.

### Project state as code

- **Declared:** `strictMode`, `features`, `setting`, `defaultProfile`,
  `defaultAccessPolicies`, client applications, access policies, and bot
  registrations (the Bot resource and its membership, not its code, which
  Medplum's CLI already deploys).
- **Converged on every run**, not only on create. Resources are matched by name
  or identifier, never by a hard-coded id. Created clients and bots have their
  ids written to an output file the project wires into its own secrets and
  infrastructure; Plumb does not manage secrets stores.
- **`push` refuses to create a project** whose declared name matches none,
  unless `--create` is passed.
- **Two credentials.** Read from Medplum's source: `strictMode`, `features`,
  `link` and `systemSetting` are writable only by a super admin; project
  admins can write `setting`, `defaultProfile` and the rest. `push` routes
  super-admin-only fields to a separately configured break-glass credential,
  and plans them as a separate section so they are never applied by accident.
- **The lockdown recipe**, documented and expressible in the config, also from
  Medplum's source:
  - project admin does **not** bypass an AccessPolicy, but it can create
    clients through the system repository, edit any ProjectMembership, and act
    on behalf of another membership;
  - policy entries are a **union**: an interaction is allowed if any entry
    allows it, so a read-only entry for a type does not restrict a `*` entry
    that allows writing it. Field rules (`hiddenFields`, `readonlyFields`)
    come from the **first** matching entry, so order matters;
  - so people get `admin: false` and a policy with **no writable `*` entry**:
    the clinical types they may write are listed explicitly, the
    configuration types (ClientApplication, Bot, Subscription,
    OperationDefinition, StructureDefinition, SearchParameter, AccessPolicy)
    are read-only or absent, and any `*` entry is `readonly: true`. `check`
    flags a people policy with a writable `*` entry;
  - the CI client gets `admin: true` **and** an explicit policy, because an
    admin with no policy falls back to full access;
  - super admin is the break-glass.

### Typed reads

- A generated helper per profiled type, taking a Medplum client and search
  parameters, returning the profile type.
- At runtime it asserts that every result carries the expected stamp, and
  nothing more. Full validation is `check`'s job; a stamp on a record written
  while strict proves it passed its profile at write time, and the load gate
  covers later versions.
- On a failed assertion it throws `PlumbProfileError` with the resource
  reference and the expected profile. It never falls back to the base type.
- It refuses `_elements`, `_summary` and `_history`.
- Framework adapters (TanStack Query options factories, Medplum React hooks)
  are optional thin wrappers, published later if wanted.

### Migrations

- Numbered TypeScript files and a journal in the repo;
  `defineMigration({ name, resourceType, search, transform })`, where
  `transform` returns a JSON Patch or `null` for already done.
- **The ledger lives in the Medplum project it describes**, one record per
  migration: name, file sha256, status (`running`, `applied`, `failed`),
  counts, git sha and time. It is a `Basic` resource with a Plumb code, because
  it is bookkeeping about the project and not a fact about any patient;
  `Provenance` targets resources and one migration touches thousands, and a
  store outside Medplum could disagree with the data it describes.
- The runner batches, dry-runs unless `--write`, refuses to start while a
  record is `running`, refuses to write when it cannot read the ledger, and
  flags a file whose hash changed after it ran.
- No transaction around all pending migrations: Medplum transaction bundles do
  not scale to thousands of resources, so idempotency (`null` means done)
  replaces it.
- `generate` scaffolds a migration when a field becomes required.

### `plumb-zod`

- Emitted from the same IR as the types: `createSchema(Profile, { pick,
  partial, overrides })`, in the spirit of `drizzle-zod`'s insert and select
  schemas.
- Covers cardinality, types, required bindings as enums, and fixed-value
  slices. Does not cover FHIRPath invariants or discriminators other than
  fixed values.
- **The README says it plainly:** a passing Zod parse means the input looks
  right, not that the server will accept it. It is for forms and input edges,
  never a substitute for the validator.

### `plumb-operations`

```ts
export const sendMessage = defineOperation({
  code: "send-message",
  resourceType: "Communication",
  level: "type",
  input: messageDraftSchema,
  output: sentMessageSchema,
});
```

- **Callers** use `callOperation(medplum, contract, input)`, which infers the
  output type and parses the response. **Handlers** use
  `handleOperation(contract, fn)`, which parses the input and type-checks the
  return.
- The transport is Medplum's: an OperationDefinition whose
  `https://medplum.com/fhir/StructureDefinition/operationDefinition-implementation`
  extension references the Bot. `plumb generate` emits the OperationDefinition
  from the contract and `push` loads it, so the signature cannot drift.
- **Medplum finds a custom operation by `code` alone**, ignoring `resource`,
  `system` and `type`, and runs it only when no built-in operation matches. So
  a contract's `code` must be unique in the project and must not collide with
  a built-in; `check` enforces both. `resourceType` and `level` shape the
  generated OperationDefinition and the typed caller's URL, not the routing.
- **The bot receives the raw POST body** (or, for `instance` operations, the
  stored resource), with no `Parameters` unwrapping and no validation against
  the OperationDefinition. The handler's parse of the contract's input is
  therefore the only input validation, which is why it is not optional.
- **Output:** a returned `Parameters` passes through; anything else is mapped to
  the `out` parameters, and a single `return` parameter comes back bare. The
  typed caller unwraps whichever shape the contract declares, so callers never
  see the envelope.
- Contracts import only Zod and FHIR types, so they stay small in a bot bundle.

### Agent-facing output

`generate` writes one short Markdown summary per profile and per operation next
to the generated code: required fields, bindings, slices, invariants, routing
keys, and an example that passes. A task guide per workflow ships with the kit.
Together these are what an agent reads before writing a resource, instead of
reading a snapshot.

### Data model

Plumb itself stores only four things in a Medplum project:

- **Profiles:** `StructureDefinition`, a core resource.
- **Defaults:** `Project.defaultProfile`, a core Medplum setting.
- **Stamps:** `meta.profile`, a core element.
- **The migration ledger:** `Basic`, with a Plumb code system, for the reasons
  above.

Routing rows and contracts are code, not FHIR data. Generated
OperationDefinitions are core resources.

## Testing Decisions

A good test asserts what a developer, the server or an agent sees: whether a
resource compiles against a type, whether a profile accepts it, what a command
reports, what state it leaves, what a caller receives. Never how the generator
walks a snapshot or how the runner batches.

All fixtures are synthetic, and all profiles under test come from published IGs
(US Core, IPS) or Plumb's own test profiles. No adopter's schema appears in
Plumb's repository.

1. **Profile contract tables.** For each test profile, a table of fixtures, each
   stating whether it compiles against the generated type and whether it
   passes `validateProfiled`. "Does not compile" rows use `@ts-expect-error`,
   so a type regression fails `tsc`. Every generated routing row gets a row
   here.
2. **Commands as functions**, against Medplum's `MockClient`: `check` findings
   and conformance counts, `push` plans and refusals, the baseline ratchet,
   `migrate` (dry run, `--write`, `null` skips, ledger states, the `running`
   lock, the hash check), project-state plans and idempotency, `create`
   stamping and restamping, typed-read assertions and refusals.
3. **Generator golden tests.** For a fixed set of IG profiles, the generated
   types, routing table and Zod schemas match committed output.
4. **Operations**, per contract: the handler's output passes the caller's parse,
   a bad input fails in the handler, a bad output fails in the caller, and the
   generated OperationDefinition matches committed JSON.
5. **Against a real Medplum server**, in Docker, in CI. The mock client enforces
   neither profiles, defaults, strict mode nor access policies, so the claims
   Plumb makes about the server (defaults applied and stamped, `[]` skipping
   validation, the load gate, the lockdown recipe) need a real server to prove.
   A version matrix covers the Medplum releases Plumb supports.

## Out of Scope

- A query builder, an ORM, or Medplum GraphQL code generation.
- FHIR R4B and R5.
- Slice discriminators other than fixed values; type-level non-empty arrays.
- Version-pinned profile stamps (`url|version`). Plumb stamps bare URLs and
  relies on the load gate.
- Secrets stores, infrastructure and deploy pipelines. Plumb writes the ids it
  creates to a file; wiring them elsewhere is the project's job.
- Bot code deployment, which the Medplum CLI already does.
- UI components and framework adapters beyond thin optional wrappers.
- Any organization's profiles, routing rows, migrations or imports.

## Further Notes

### What Medplum does and does not do (read from server source, 5.1.41–5.1.42)

Rechecked against `main` at `10ee734f4` (2026-09-29); every file cited is
unchanged from v5.1.42. Evidence is in
[`research/medplum-server-behaviour.md`](research/medplum-server-behaviour.md).

- Validation runs in Node before the insert; Postgres never sees a profile.
- With `strictMode` off, the base R4 JSON schema is still enforced; base
  cardinality, invariants, profiles and terminology are only logged. New
  projects start strict.
- Even in strict mode: constraints below `error` severity, four skipped
  invariants and IG `Reference` target profiles are not enforced.
- An unknown profile URL logs a warning and passes; `url|version` matches
  nothing and passes.
- `defaultProfile` applies only when `meta.profile` is absent (`[]` counts as
  present), writes its URLs into the stored resource, uses the first entry per
  type, and every listed profile must pass. System-repository writes get no
  default.
- The profile for a URL is the highest `version` sorted as text, then `date`,
  found across the project and its linked projects.
- Creating or updating a StructureDefinition clears a five-minute profile
  cache; deleting one does not. Nothing re-checks stored resources.
- `POST /:type/$validate` always validates strictly, whatever `strictMode` says.
- Strict mode is project-wide.
- `strictMode` and `features` are super-admin only; `GET /auth/me` exposes both
  to any member.
- AccessPolicy entries are a union; field rules come from the first match.
- Custom operations are routed by `code` alone, receive the raw request body,
  and are never validated against their OperationDefinition.
- `validateResource` in `@medplum/core` throws on any error-severity issue and
  returns only warnings.

These are what the server tests (Testing Decisions, 5) exist to keep true
across Medplum releases.

### Inspiration

| Borrowed | From | Why |
|---|---|---|
| Runtime package separate from a dev-only kit, plus an optional Zod package | Drizzle | The runtime ships to bots; the compiler and runner never should |
| A migrations journal in the repo and an applied-state ledger in the database | Drizzle | The repo knows what should have run; only the database knows what did |
| One config file every command reads | Drizzle | One place for IGs, defaults, routing, project state and environments |
| `generate` from a declared schema | Prisma | TypeScript cannot infer types from HL7's JSON |
| Plan, then apply; converge on every run | Terraform | Configuration changes are reviewed before they happen |
| One contract, inferred on both sides | tRPC | A server change breaks the caller at compile time |
| Validate at the edge, then trust | T3 | A stamp assertion at the read edge; Zod at input edges |
| Env and config validated at build | T3 Env | A misconfiguration fails the build, not the first request |

| Not borrowed | Why |
|---|---|
| One transaction around all pending migrations | Transaction bundles do not scale; idempotency replaces it |
| A query builder | The Medplum SDK is already typed |
| Zod as the validator of record | Medplum's validator enforces the real profile |
| A tRPC server | Bots stay the only server runtime; contracts ride OperationDefinitions |

### Reference material

- **Plumb's own research** in [`research/`](research/), which records the evidence below.
- **Medplum:** profiles and validation, `Project.defaultProfile` and project
  settings, access policies and project admin, custom FHIR operations via bots,
  the `@medplum/core` validator (`validateResource`,
  `indexStructureDefinitionBundle`), `@medplum/definitions`, and the server
  source (`packages/server/src/fhir/repo.ts`, `accesspolicy.ts`,
  `admin/*`), which is where every server claim in this spec was read.
- **FHIR:** the R4 StructureDefinition and snapshot model, FSH and SUSHI, the
  FHIR package registry and its npm-compatible format.
- **Drizzle:** `drizzle-orm`, `drizzle-kit` (config, journal, migrate, push),
  `drizzle-zod`.
- **Prisma:** schema and `generate`.
- **tRPC** and **T3 Env** for contracts and build-time validation.
- **`@atomic-ehr/codegen`**, as prior art for FHIR type generation.

### Distribution

- **A standalone repository**, `balance-hormone/plumb`, separate from any
  adopter's code, so nothing adopter-shaped can leak into Plumb's code or tests
  and adopters consume it the way any Medplum project would.
- **Private until the foundation works**: `generate` and `check` end to end on
  US Core. It goes public after sign-off from the copyright holder, with the npm
  scope chosen and Medplum's contribution requirement (a DCO) copied.
- **Apache-2.0 with a `NOTICE` file**, matching Medplum, so the code can move
  upstream by transfer rather than extraction.
- **Repository layout** follows Principle 4: npm workspaces (`packages/*`,
  `examples/*`) and Turborepo, as Medplum has; one shared esbuild script
  emitting `dist/esm/index.mjs` and `dist/cjs/index.cjs`, with `tsc`
  declarations copied into each and a `package.json` type marker per format;
  Vitest; Biome for lint and format, with a script that enforces SPDX headers;
  TypeScript 7 with `NodeNext`. `@medplum/core`, `@medplum/fhirtypes` and
  `@medplum/definitions` are peer dependencies with a declared supported range.
  An API report (api-extractor or similar) is added once the public API
  exists and the tool supports TypeScript 7.
- **Versioning**: Changesets, the four packages versioned together, `0.x` until
  the API settles. Releases publish from CI only, with npm provenance.
- **Work tracking**: GitHub Issues, a project board and one milestone per
  release. Commits and PR titles follow conventional commits.
- **While private**, nothing is published to npm; an adopter installs from the
  private repository. That exception ends with the first public release.
- **The repository can move.** A GitHub transfer keeps issues, pull requests
  and redirects, so a later neutral organization or an upstream home costs
  little. The npm scope is the sticky choice and is made once, before the first
  publish.

### Upstream

Plumb is built so that Medplum could adopt any part of it. The generator is
the most natural candidate, because Medplum already generates
`@medplum/fhirtypes` from its definitions. Two smaller upstream proposals follow
from the server reading: making an empty `meta.profile` apply the default, and
per-type strict mode. The source reading adds two more: version-aware profile
resolution (semantic rather than text order), and enforcing `Reference` target
profiles. Each is raised with Medplum as Plumb matures, not before, and always
as an issue first: Medplum automatically closes pull requests from
contributors it has not yet vouched for unless they link a maintainer-labelled
issue.

### Related Medplum work: the marketplace

Medplum is building a marketplace (evidence in
[`research/medplum-server-behaviour.md`](research/medplum-server-behaviour.md)):
Package, PackageRelease and PackageInstallation, and `PackageRelease/$install`
are on `main`; a catalog, configurable re-runnable installs, a
`defineManifest()` format and `medplum package` CLI commands are on unmerged
branches (`medplum/medplum#9406`). Plumb tracks it and does not build on it
until it merges.

- **Plumb is not a marketplace package.** Its generator, CLI, types and checks
  live in a developer's repository; a package is something installed into a
  project.
- **Two parts of Plumb could ship as packages later:** profile packs (a
  `reference-data` package of profiles, value sets, defaults and routing rows),
  and the in-project conformance bot below.
- **An in-project conformance bot is the likely answer to `check`'s data
  problem.** `check --env` as specified reads every stored resource onto the
  machine that runs it. A bot running inside the project could validate there
  and return only counts and reasons, so patient data never leaves Medplum.
- **`plumb-operations` should emit marketplace operation entries** from a
  contract rather than compete with them. The marketplace's operation entry
  (`code`, `parameter`, `delegatesTo`, accepted wire shapes) covers the same
  ground.
- **The manifest overlaps with `push` and `migrate`.** Once the work merges,
  Plumb raises alignment on the issue, which is also the route Medplum's
  contribution rules require.

### Open decisions

- **The npm scope**, chosen before the first public publish.
- **Supported Medplum versions**: the floor of the version matrix.
- **Lint integration**: a Biome plugin, an ESLint plugin, or a `check` rule only.
- **How `push` loads profiles**: plain FHIR writes (as specified), or through
  `PackageRelease/$install` once Medplum's marketplace settles.
- **Where `check --env` validates**: on the machine that runs it (as
  specified), or in the project through a conformance bot, so patient data
  never leaves Medplum.
- **The first adopter's work** lives in its own adoption project and is not
  specified here.
