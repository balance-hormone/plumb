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
  the DCO sign-off and release steps, in
  [`../CONTRIBUTING.md`](../CONTRIBUTING.md). 0.6.0 is the first published
  release.
- **Roadmap:** v0.2 is the conformance check
  ([design 02](design/02-conformance-check.md)), v0.3 routing and
  `createProfiled` ([design 03](design/03-routing-and-create.md)), v0.4
  typed reads ([design 04](design/04-typed-reads.md)), v0.5 SUSHI in
  `generate` ([design 05](design/05-sushi.md)), v0.6 project config as
  code ([design 06](design/06-project-config.md)), which extends v0.2's
  `push`.
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
- **v0.5:** `fsh` in the config names a SUSHI project in place of `local`
  (#87). `generate` runs the project's own `fsh-sushi`, resolved from the
  project root and required to be 3 or later, with `--snapshot`, as a first
  `sushi` step (#88); SUSHI's errors stop it with their FSH file and line,
  and SUSHI missing or too old exits 2. Offline tests run a stub SUSHI; a CI
  test builds Plumb's own FSH fixtures with the real one and matches the
  committed StructureDefinitions byte for byte, which caught that `-o` names
  the folder that gets `fsh-generated/`. `generate --check` rebuilds into a
  temporary folder and compares `fsh-generated/resources` file by file as
  well as the types (#89). The `sushi` step warns when `sushi-config.yaml`
  and `igs` select different versions of a package, and `load` warns when a
  local profile's pinned parent version is not the one the config provides
  (#90). The README's FSH section uses `fsh`, and an e2e FSH variant installs
  `fsh-sushi`, generates, type-checks, passes `--check`, and fails it after
  an FSH edit without a rebuild (#91). **v0.5 is complete.**
- **v0.6:** `project` in the config (#97) declares settings, secrets,
  AccessPolicies in Medplum's own shape, default access policies and clients,
  by key, with an environment's `settings` merged over the project's. Named
  errors cover an unknown policy key, duplicate names, a setting that is not
  a string, boolean or number, and any super-admin field; `lockdownWarnings`
  flags a writable `*` entry, an admin client with no policy, and a policy
  other than push's own that writes StructureDefinition.
  `push` runs a `project` step once the profile gate has passed (#98):
  `planProject` and `applyProject` find each policy by a `meta.tag` with the
  config key as code, update it in place, leave an untagged one alone unless
  `--adopt`, and delete a removed key's only with `--prune`. Every lookup
  keeps the target project's own resources, since a linked project's tagged
  policy is not this one's to write; real-server tests link a project to
  show it. The login's copy of the Project leaves out `link` and `features`,
  so the plan reads the Project itself.
  Clients (#99) are created through the admin endpoint, then tagged and given
  their membership's policy and `admin`; the plan holds only their ids, so no
  client secret can reach it or `--json`. A client can name a policy the same
  push creates.
  The Project's own fields (#100), settings, secrets, `defaultProfile` and
  `defaultAccessPolicies`, are written in one read-merge-write update after
  the profiles load. A setting's type follows its value; an `{ env }` secret
  is planned by its variable and read only when written, and a `true` one
  must exist. Real-server tests show an unstamped write validated against,
  and stamped with, the configured default. The checker's identifier now
  shares the tag system, the package's npm URL.
  `push --check` (#101) plans without the checker or the gate and exits 1
  when `push` would write anything; a real-server test turns it red with a
  hand edit. The README configures a project, catches drift nightly, and
  gives the lockdown recipe (#102). **v0.6 is complete.**
- **After v0.6:** 0.6.1 and 0.6.2 fixed what the first adoption found
  (installed-CLI paths, the checker on Medplum's `awslambda` runtime, generated
  code that needed the DOM lib); 0.7.0 added `stampProfiled` for conditional
  creates, upserts and batches.
- **v0.8:** `plumb check` ([design 07](design/07-check.md)) finds raw
  `MedplumClient` access to fully profiled types by inferred type, against a
  committed baseline; `stampProfiled`'s result is branded so a stamped write
  passes. On the first adopter it compiled 2,767 files in about 6 seconds.
- **v0.9:** the config loads with the project's tsx when installed, so a
  workspace config can import sibling packages' TypeScript and use path
  aliases (#114); `--env-file` on `validate` and `push` (#120). `validate`
  counts records, not checks, on each type's line (#121); it and `push`'s
  gate read only resources carrying a selected stamp, counting the rest by
  query, with `--full` for the old full pass and progress on long runs
  (#127); and `--unstamped` forecasts what would fail once unstamped records
  are stamped, routed as the generated `route` does (#123).
- **v0.10:** nothing upstream turns a repository into a configured test
  project (#140), so design 08 is built as written. `plumb-fhir/test` exports
  `startServer` and `stopServer` (#141): Medplum, Postgres and Redis in
  Docker, at the installed `@medplum/core`'s release or `test.server`, with
  the compose file piped to Compose so ESM and CJS need no path to it. A
  running server is reused and left running. The `test` config block is typed
  and checked, and Plumb's own server tests start the server this way.
  `createTestProject` (#142) makes a project as the test server's super
  admin, with `test.strictMode` and `test.features`, runs the unchanged
  `push` into it with `test.settings` merged over `project.settings`, and
  loads the `test.seed` Bundles in order, naming a refused file and entry.
  The checker it pushes is the one Plumb ships, so CI's server job builds
  first.
  `connectAs` (#143) logs in to a test project as its admin client, as a
  client the config declares, or as a new client whose membership has one of
  the config's AccessPolicies, with its parameters. It finds each key by the
  tag `push` gives what it manages, so it needs no config, and an unknown key
  throws `unknown-client` or `unknown-policy`.
  `plumb-fhir/vitest` (#144) is a `globalSetup` that starts the server, makes
  one project per run from `plumb.config.ts` and hands it to `testProject()`
  through an environment variable, so `plumb-fhir/test` depends on no test
  runner. Without Docker it fails in CI and warns locally. Plumb's own
  harness starts its server and makes its projects with the same functions;
  its push tests still need projects nothing was pushed into.
  The README tests against a real server (#145). **v0.10 is complete.**
- **v0.11:** `push` plans the ValueSets and CodeSystems the selected
  profiles bind with the profiles, CodeSystems first, so a project with
  `validate-terminology` resolves every binding instead of refusing writes
  with `ValueSet <url> not found` (#154). A CodeSystem shipped without its
  codes is listed and left to Medplum. That project feature also stops
  Medplum's own bot creation, so `push` cannot install the checker there (see
  the research notes).
  `content` in the config lists reference content files (#155), and
  `generate` checks them offline before emitting anything: one Questionnaire,
  CodeSystem, ValueSet or Organization per file, keyed by URL or `id`, valid
  against base R4 and any selected profile it claims, with named errors that
  say why a SearchParameter or Subscription is not content.
  `push` gains a `content` step after the profiles and before `project`
  (#156): CodeSystems, ValueSets, Questionnaires, then Organizations, each
  found by Plumb's tag with its URL or key as code, tagged on write, updated
  in place and flagged when changed without a version bump; `--adopt` takes
  over an untagged match, and `--prune` retires (`status: retired`,
  `active: false`) rather than deletes. `--check` counts content drift. The
  checker is now found in the target project only: a linked project's
  checker made `push` fail.
  `generate` writes a file per Questionnaire in `content` (#157):
  `<Name>Answers`, each answerable `linkId` to its answer's type, with choice
  codes as a literal union when its options or `answerValueSet` list them
  offline; `<name>Answers(response)`, which reads a response through nested
  items and refuses one to another Questionnaire; `<Name>LinkId` and
  `<Name>Url`. Content ValueSets and CodeSystems join the loaded terminology,
  so bindings list them too. `readAnswers` is written into `_plumb.ts` only
  when there is a Questionnaire, so no project gets an unused export.
  The README covers reference content (#158). **v0.11 is complete.**
- **Direction:** the repository is the source of truth for everything in a
  Medplum project except patient data, in five layers: schema and config
  (built), then reference content, behaviour and data over time. Next, in
  order: behaviour as code,
  data migrations, input validation through Medplum's own validator (in place
  of generated Zod schemas). See [`spec.md`](spec.md), Direction and Roadmap.
- Ideas not yet designed are notes in [`future/`](future/); operation
  contracts and data migrations are next.
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
  - [05: SUSHI in `generate`](design/05-sushi.md) (implemented in v0.5): one
    command builds FSH and types it
  - [06: project config as code](design/06-project-config.md) (implemented
    in v0.6): `push` converges settings, default profiles, access policies and
    clients
  - [07: `plumb check`](design/07-check.md) (implemented in v0.8): raw
    access found by type, against a baseline
  - [08: test environments](design/08-test-environments.md) (implemented in v0.10): a
    real Medplum and a project with the config pushed, for a project's own
    tests
  - [09: reference content as code](design/09-reference-content.md) (implemented
    in v0.11): Questionnaires, terminology and Organizations through `push`,
    and typed Questionnaire answers
- [`future/`](future/): ideas not yet designed, each with its sketch and
  research.
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
