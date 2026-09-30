# Plumb docs

## Where things stand

- Plumb is scoped to one deliverable: **profile-aware types for Medplum**.
  v0.1 is implemented: `plumb generate`, `plumb generate --check` and
  `validateProfiled`.
- **v0.1's design** is in [`design/01-generator.md`](design/01-generator.md):
  full-depth narrowing, plain arrays with typed slice helpers, literal unions
  for bindings listable offline, and committed output one file per profile.
  The bullets below record how each piece landed, in build order.
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
  skipping Provenance with a warning.
- **Emitter core:** transform, print and write turn each profile into a file
  that narrows `@medplum/fhirtypes`: required paths at every depth, `max: 0`,
  choices, fixed and pattern values, narrowed backbone elements, reference
  targets, and doc comments for what the types cannot check. The harness now
  compiles every fixture against generated types.
- **Slices:** a type per slice (an extension slice from its extension
  profile), a union for closed slicing, a tuple for ordered slicing, and
  builders and readers (`USCoreBloodPressure.systolic(...)`,
  `getSystolic(bp)`) that fill in and match discriminator values. Open
  slicing, which every extension slicing is, keeps a plain array.
- **Bindings:** value sets are listed offline from the loaded packages. A
  required binding on a `code` or `Coding` becomes a literal union, an
  extensible one on a `code` suggests its codes, and a `CodeableConcept`'s
  codes are exported as a constant. The harness has no expected failures
  left.
- **`generate`:** one plain function runs the pipeline (packages, load, emit,
  then write, or with `--check` a byte-for-byte comparison that writes
  nothing to the project), reporting each step as it finishes. The CLI's
  output format is agreed in the spec.
- **`validateProfiled`:** `await validateProfiled(resource, ProfileUrl)` runs
  Medplum's validator against a selected profile, offline, loading the
  project's config, lock and cached packages once; its verdict matches a
  direct `validateResource` call on every fixture.
- **CLI:** `plumb generate [--check] [--config <path>] [--json] [--quiet]`
  prints a line per step and a total, as the spec's Output section says, and
  exits 0, 1 for problems found, or 2 for usage and config errors. A test
  runs the built `dist/esm/cli.mjs`.
- **Goldens and compatibility:** committed output for four US Core and two
  IPS profiles, compared byte for byte; CI type-checks it under TypeScript
  5.0 and the project's, with `NodeNext` and `bundler`, and runs the tests on
  `@medplum/*` 5.1.0. IPS showed Medplum's parser flattens slices inside
  slices (IPS Composition), so such slicing now gets no slice types and a
  warning.
- **README:** a quickstart from install to a passing `--check`, the FSH
  workflow, supported versions, and the known limits. It was followed by hand
  against the real registry (US Core Patient and Blood Pressure), and a CI
  test walks it against a packed tarball. **v0.1 is complete.**
- **After v0.1:** CI caches the FHIR package cache instead of fetching lazily
  (#39); `bindings.maxCodes` configures the value-set size limit (#40); each
  extension a profile slices in is generated once, in its own file (#41); a
  nightly workflow runs the README's own code and IPS 2.0.1 against the real
  FHIR registry, opening an issue when it fails (#42). The npm package is
  `plumb-fhir` (`plumb` was taken); its command stays `plumb`.
- **Release prep:** version 0.1.0, a changelog, and a contributing guide with
  the DCO sign-off and release steps. The package stays `private` until the
  copyright holder signs off; publishing is then the steps in
  [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
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
