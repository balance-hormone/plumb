# Plumb docs

## Where things stand

- Plumb is scoped to one deliverable: **profile-aware types for Medplum**. The
  spec is drafted and nothing is implemented; the one package is an empty shell
  that builds, lints and passes CI.
- **Next: v0.1**, the profile type generator: `plumb generate`,
  `plumb generate --check` and `validateProfiled`, offline once IG packages
  are cached. Its design is
  accepted in [`design/01-generator.md`](design/01-generator.md): full-depth
  narrowing, plain arrays with typed slice helpers, literal unions for
  bindings listable offline, and committed output one file per profile.
- **Build order:** tests first (fixtures with their expected results, then the
  harness), then config, package fetching, the loader and the emitter. The work
  is tracked in the v0.1 milestone on GitHub.
- **Fixtures, part 1:** US Core 9.0.0 and its 230 examples are in
  [`../test/fixtures`](../test/fixtures/), with their expected results. Running
  them through Medplum's validator showed it checks no terminology binding,
  reference target or extension contents; design 01's list of cases where
  "compiles" and "validates" may disagree now says so.
- **Fixtures, part 2:** Plumb's synthetic FSH profiles, one or two per
  coverage-matrix row, and contract tables for them and four US Core profiles:
  147 synthetic fixtures, each recording whether it conforms, compiles and
  validates. They showed Medplum's validator never matches an extension slice
  (so a required extension always fails), and does not check slice contents,
  `closed` or `ordered` slicing, narrowed choice types, or rules through a
  `contentReference`.
- **Harness:** [`../test/harness`](../test/harness/) runs every fixture:
  `validates` against `validateResource`, the gap rules, and `compiles`
  through one `tsc` run per suite. Compile rows for profiles in
  `expected-failures.json` run as expected failures until the generator emits
  their types; the list only shrinks.
- **Config:** `defineConfig` and `loadConfig` load `plumb.config.ts` with
  Node's type stripping and report each named error. `profiles` takes
  canonical URLs or `name/*` for a whole IG, which the loader will expand
  (#27).
- **Packages:** `fetchPackages` fetches each IG and the dependencies it
  declares from the FHIR registry into `~/.fhir/packages`, checks each
  download's SHA-1, and locks a SHA-256 of every package's files in
  `plumb.lock`.
- **Loader:** `loadProfiles` selects the configured profiles, closes over what
  they depend on, resolves each reference in its IG's own scope, and parses
  each profile with Medplum. It loads all 54 parseable US Core 9.0.0 resource
  profiles in about 2 seconds. `hl7.fhir.us.core/*` selects all of them,
  skipping Provenance with a warning. **Next:** the emitter (#14).
- Later releases of the same tool: SUSHI integration, routing and `create`,
  typed reads, Zod schemas, agent summaries.
- Other tools are parked as idea notes in [`future/`](future/).
- Work is tracked in GitHub Issues on this repository, under the v0.1
  milestone.

## Contents

- [`spec.md`](spec.md): what Plumb is, its goals, principles and design
  decisions.
- [`design/`](design/): one design note per feature, written before it is built.
  - [01: profile compiler and type generator](design/01-generator.md)
- [`future/`](future/): parked ideas, each with its design sketch and research.
  - [Conformance check](future/conformance-check.md): how many stored records a
    profile would fail, the load gate, the baseline, adopting late.
  - [Project config as code](future/project-config-as-code.md): `push`,
    converged settings, the lockdown recipe.
  - [Data migrations](future/data-migrations.md): `defineMigration` and a ledger
    in the project.
  - [Operation contracts](future/operation-contracts.md): typed callers and
    handlers for bot-backed operations.
- [`research/`](research/): the evidence behind the spec and the ideas.
  - [Medplum server behaviour](research/medplum-server-behaviour.md): validation,
    `defaultProfile`, strict mode, project fields, AccessPolicy and admin, bots,
    custom operations, the generator, the marketplace, read from Medplum's
    source.
  - [US Core 9.0.0 routing](research/us-core-9-routing.md): which profiles pin
    a routing key, which key on a value set, and the required elements that
    most often fail real data.
  - [Prior art](research/prior-art.md): existing profile type generators and
    why none fits Medplum, plus what Plumb borrows from Drizzle, Prisma and
    others.
  - [Prototype](research/prototype.md): the FSH → types → validator proof of
    concept and the gaps it found.
