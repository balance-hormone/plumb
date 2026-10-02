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
- **Roadmap:** v0.2 is the conformance check
  ([design 02](design/02-conformance-check.md)), v0.3 routing and
  `createProfiled` ([design 03](design/03-routing-and-create.md)), v0.4
  typed reads ([design 04](design/04-typed-reads.md)). Next:
  [project config as code](future/project-config-as-code.md), which extends
  v0.2's `push`. Later: SUSHI integration, Zod schemas, agent
  summaries.
- **v0.2:** the server tests in [`../test/server`](../test/server/)
  start Medplum, Postgres and Redis in Docker and give each run a strict
  project with an admin CI client and synthetic data. CI runs them on Node 22
  and 24, and on Medplum 5.1.0 (#51). `environments` in the config name a
  project and the variables holding its client credentials, and `connect`
  logs in and reports strict mode (#52); `--env` arrives with `validate`.
  The checker bot (#53) validates one page of stored resources inside the
  project, bundled into `dist/checker.cjs` with Plumb's `@medplum/core`, and
  takes the definitions gzipped, as input. Its verdicts match
  `validateProfiled` on every contract fixture and US Core example, run as
  Medplum's vmcontext runtime runs it, and a real-server test runs it through
  `Bot/$execute` as an async job. Medplum's sandbox lacks the `WebSocket`
  global `@medplum/core` reads on load, so the bundle carries a stand-in.
  `plumb push --env <env>` does push's first step (#54): it loads the
  selected profiles, connects, and installs or updates the checker, a Bot
  found again by a Plumb identifier, created through the admin endpoint so
  its membership gets an AccessPolicy that reads the checked types and
  StructureDefinition and writes nothing. The deployed filename carries the
  version and a hash of the bundle, so an unchanged checker is not
  redeployed. Real-server tests show a second push changes nothing and,
  acting as the bot's membership, that it can read but not write.
  `plumb validate --env <env>` (#55) stops with exit 2 unless the installed
  checker is this Plumb's build, then drives it one page per async job,
  saving counts, reasons, failing ids and the cursor to a gitignored
  `.plumb/validate-<env>.json` after each page, so `--resume` continues an
  interrupted run. From the CLI it counts each type's stored resources, to
  tell "nothing readable" from "nothing stored", sorts stamps naming
  profiles the project lacks into the silent ones, and flags shadowed
  profile URLs. Failing ids never reach the terminal or `--json`.
  `plumb push` now runs design 02's whole first slice (#56): after the
  checker, it plans the selected profiles and the definitions they depend
  on against what the project holds, updating the one StructureDefinition
  held for a URL rather than adding a second that would shadow it, and
  flagging content changed without a version bump; refuses on a shadowed
  URL; runs the checker against the planned versions and loads nothing
  while anything stored would fail (`--dry-run` stops there); loads; and
  re-checks at once. Real-server tests cover the refusal, the fix, the
  edit without a bump, a failing write between the gate and loading, and
  that a project admin's write to `strictMode` changes nothing.
  The README walks a project from an environment to a gated push (#57),
  and the nightly registry run loads its environment config. **v0.2 is
  complete.**
- **v0.3:** `routes` and `defaultProfile` in the config (#58), with
  named errors for a malformed row or default, a `url|version` URL, a row for
  a profile that is not selected, and an element that is not first-level on
  the profile's type, the last two checked once `generate` has loaded the
  profiles.
  `generate` now writes `_routes.ts` (#59): per resource type, a row per
  selected profile with its selected parents and the keys that select it,
  from each required first-level fixed or pattern value, each required
  slice's discriminator values, and the config's `routes` row. A `routes`
  step warns for each pair of unrelated profiles whose keys conflict on no
  element. The goldens include it.
  `_routes.ts` also holds the generated `route(resource)`, `RoutingError`,
  `ProfileUrl` and `ProfileTypes`, exported from the index (#60). Tests
  import the generated file itself: routing contract tables on the synthetic
  profiles, and every one of US Core 9.0.0's 224 profiled examples routes to
  the profile it claims or a more specific one, given the `routes` config a
  US Core project writes (in `test/harness/routes.test.ts`).
  `createProfiled` and `updateProfiled` (#61) route, stamp the type's
  `defaultProfile` (less any the routed profile derives from) plus the
  routed profile, and write through any client with `createResource` and
  `updateResource`, so the generated code needs no `@medplum/core`
  declarations; a `MedplumClient` fits. An update replaces only the URLs
  Plumb manages. Real-server tests show the server enforcing the defaults
  and the routed profile, a refused resource never written, foreign URLs
  kept on update, and `{ profile: false }` falling back to the project's own
  default.
  The README shows routing, `createProfiled`, `routes` rows and
  `defaultProfile` (#62), and the e2e quickstart calls the generated `route`
  and `createProfiled` from the packed tarball. **v0.3 is complete.**
- **v0.4:** `generate` writes `_reads.ts` (#70): per selected profile, the
  paths its type requires beyond `@medplum/fhirtypes`, read from the type
  itself, and `missing` in `_plumb.ts` checks a resource against them. On
  every contract fixture it agrees with `compiles`: each one that compiles
  passes, and each that tsc reports missing a profile-required element fails.
  `isProfiled`, `asProfiled`, `pickProfiled` and `ProfileReadError` (#71) are
  generated beside it: a stamp matches its bare URL or a selected child's, a
  `url|version` stamp does not, and `passed` stays out of serialization. Every
  US Core 9.0.0 example, stamped as Plumb writes it, is the profile it
  declares and each of that profile's parents. A choice's `Reference` now
  keeps the base's targets (IPS Composition's `relatesTo.target[x]`).
  `readProfiled` and `searchProfiled` (#72) read through any client with
  `readResource`, `readReference` and `searchResources`; the search adds
  `_profile` and refuses subsets and includes before any request.
  Real-server tests show a loose project's stamped record missing a field, a
  field an AccessPolicy hides, `defaultProfile`'s stamp, `_profile` with one
  URL and several, and a failing search's `passed`.
  The README shows the reads, recovering `passed`, pairing `_profile` with a
  selective filter, and why a stamp proves conformance only once `validate`
  passes (#73); the e2e quickstart reads its write back with `isProfiled`.
  **v0.4 is complete.**
- Other tools are parked as idea notes in [`future/`](future/).
- Work is tracked in GitHub Issues on this repository, one milestone per
  release.

## Contents

- [`spec.md`](spec.md): what Plumb is, its goals, principles and design
  decisions.
- [`design/`](design/): one design note per feature, written before it is built.
  - [01: profile compiler and type generator](design/01-generator.md)
  - [02: conformance check](design/02-conformance-check.md)
    (implemented in v0.2):
    `plumb validate` inside the project as a bot, and a gated `plumb push`
  - [03: routing and `createProfiled`](design/03-routing-and-create.md)
    (implemented in v0.3): the profile a resource's content selects, stamped
    on write
  - [04: typed reads](design/04-typed-reads.md) (implemented in v0.4): reads and
    searches that return the profile type, checking the stamp and what the
    type requires
- [`future/`](future/): parked ideas, each with its design sketch and research.
  - [Conformance check](future/conformance-check.md): the later stages, the
    baseline and adopting late; stages 1 and 2 are design 02.
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
