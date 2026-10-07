# Changelog

## Unreleased

- **push** refuses a contract whose code a linked project's
  OperationDefinition already has, even one Plumb tagged there, as
  `shadowed-operation`, instead of creating a second one Medplum might run
  in its place.

## 0.15.0 (2026-10-07)

Hardening: an audit of the whole design, with each fix proven by a failing
test first, against a real Medplum where the server is involved. The
checker changes, so the next `push` redeploys it, and `validate` waits for
that push.

- **push** plans only the project's own definitions: the server's base
  terminology is skipped, and a copy in a linked project is refused, never
  updated (#235). Every read it plans from pages through all results (#243).
  The gate checks every resource profile push loads, a selected profile's
  parents included (#250), survives a `dependsOn` cycle and names restamp
  migrations (#237). Updating a policy, client, content resource or
  Subscription keeps the server copy's `meta` (a hand-set `security` or
  `account`), and a tag the file and server both carry is listed once
  (#230). A content file's `meta.profile`, `tag` or `security` that the
  server copy lacks is a change, and `--check` reports it; the gate reads
  only what was updated before it began, by the server's clock (#228).
- **validate** reads only what was updated before the run began, by the
  server's clock, so a record updated mid-run is not counted twice; a
  resumed run keeps its start (#228).
- **check** fails when the profiles do not load, so `--update-baseline`
  cannot wipe the baseline (#236).
- **migrate:** a run's start is the server's time, not the CLI's (#238); a
  module edited mid-pass is refused as `migration-edited`, and `--local`
  reloads it (#239); bot, ledger and endpoint lookups see only the project's
  own resources, not a linked project's (#240); the lease belongs to a run
  (#248); the hash covers imported helpers and line endings, and the bot
  refuses a stale bundle (#247); a page stopped by the rate limit keeps
  what it wrote in the counts (#249); the CLI's own requests wait out a 429,
  the lease lasts thirty minutes, and Ctrl-C pauses during a quota wait,
  where a second Ctrl-C no longer kills the run; a first run whose create
  Postgres aborts as racing another's is `migration-running` (#227). A JSON
  Patch path without a leading `/` is refused, and an array's `length` is
  not an element (#228).
- **generate:** output sorts by code point, not the machine's locale (#242);
  bindings on choice elements keep their path (#244); slice types never
  share a name with another generated type (#245); ordered slicing is a
  tuple only where positions are fixed, and typed reads check the tuple's
  length (#246). A malformed `plumb.lock`, a missing `local` folder and a
  file in it that is not JSON are named errors (`invalid-lock`,
  `local-not-found`, `invalid-local-json`); a partial cache folder is
  replaced; `fsh` accepts `sushi-config.yml` (#226). Typed answers read a
  linkId such as `constructor` or `__proto__` as any other (#228). Doc
  comments leave out base R4's invariants by key, the same for package and
  SUSHI profiles, so a base profile's (`vs-1`) are listed and `obs-6` is not;
  they also list what the server will not enforce: warnings and `Reference`
  target profiles (#234).
- **Exit codes** come from one table by error code, the same in every
  command and step: a failed write (`apply-failed`, `bots-failed`, …) exits
  1; every config-shaped code (`invalid-bot`, `invalid-content`, …) and
  `registry-error` exit 2; `check` exits 1 when the profiles do not load. A
  blocked plan is `{ code, message }` in all five planners
  (`shadowed-<kind>`, `untagged-<kind>`, and `shadowed-content` at last),
  exits 1, and leaves `push --check` its drift line (#229).
- **Before 1.0 (breaking):** every error code is catalogued with its
  command, exit code and fix in [`docs/errors.md`](docs/errors.md), which a
  test holds to the source and the exit-code table. Every `--json` report
  has one step shape, `{ name, ms, summary, warnings, failed?, counts? }`:
  `generate`'s steps gain `summary` and `failed`, `check` reports its step,
  and `migrate status` reports each migration only in `migrations`, under
  one `status` step. `plumb-fhir/test`'s `createTestProject().push` and
  `migrate()` return `{ ok, errors, steps }` instead of push's and migrate's
  internal results, and both take a `LoadedConfig`, the branded config
  `loadConfig` returns, now exported. The published declarations are only
  those the entry points reach. The spec names `plumb-fhir`, its library and
  `generate`'s `sushi` step (#232).
- **operations:** callable Standard Schemas (ArkType), `Parameters` outputs,
  and a named error for an instance call without an id (#241); an instance
  operation's input must be its resource, which is all Medplum hands the
  bot (#251).
- **Internal:** the generated runtime (`_plumb.ts`, `_routes.ts`'s routing
  and writes, `_reads.ts`, `_operations.ts`, `_migrations.ts`, `_restamp.ts`)
  is real source under `src/emit/runtime/`, typechecked, linted and
  unit-tested, and embedded as text at build; output is unchanged. The
  checker routes with the generated `matches` and `route` themselves, and
  agrees with them on every US Core example (#231).

## 0.14.0 (2026-10-06)

Data migrations ([design 11](docs/design/11-data-migrations.md)).

- **`migrations` in the config:** `defineMigration` modules with a pure
  `transform` that returns JSON Patch, or `undefined` when a record needs
  nothing; `synthetic: true` on an environment; `plumb migrate new <name>`
  scaffolds a dated module. `invalid-migration` is checked offline: a reused
  or undated id, an unknown `dependsOn` or a cycle, an unknown type, a
  search parameter Medplum does not index (#189).
- **`generate` writes `_migrations.ts` and `_migrator.ts`:**
  `handleMigrations`, a migration bot's handler, reads a page, transforms,
  forecasts the changed records with Plumb's checker against the selected
  profiles, and with `write` PUTs each with `If-Match`, rereading once on a
  412. Only counts, reasons and versions come back (#190).
- **`plumb migrate --env`** drives the bot a page at a time as async jobs:
  a dry run unless `--write`, a ledger `Basic` per migration in the project,
  a ten-minute lease (`migration-running`), resume after Ctrl-C or a crash,
  and a minute's wait over the write quota. `migrator-not-current` until
  `push` deploys this build (#191).
- **`plumb migrate status`** exits 1 when anything is pending, running,
  paused, errored or edited since applied; migrations run after their
  `dependsOn`, then by id; `--rerun <id>` runs an applied one again;
  `migration-edited` and `unmet-dependency` stop a `--write` (#192).
- **`push`'s gate names the pending migrations** on each failing type (#195).
- **`--local`** runs the generated runner in the CLI's process on an
  environment marked `synthetic`, and `not-synthetic` anywhere else;
  `plumb-fhir/test` exports `migrate(project, config, options)` (#193).
- **`restamp: true`** adds `plumb-restamp-<Type>` for each type with routing
  rows: the stamps `updateProfiled` would set, other URLs kept, run again
  whenever `_routes.ts` changes (#194).
- **Works with Medplum 5.1.0,** which ignores `If-Match` on a PATCH: the
  runner patches in memory and writes with PUT (#190).

## 0.13.0 (2026-10-06)

Behaviour as code ([design 10](docs/design/10-behaviour.md)), whose two
milestones, v0.12.0 and v0.13.0, ship together: 0.12.0 was not published
on its own.

Bots and triggers (v0.12.0).

- **`bots` and `subscriptions` in the config,** by key, checked offline:
  `invalid-bot` for an unknown policy or secret, a public webhook without a
  policy, or a schedule Medplum would ignore; `invalid-subscription` for
  criteria Medplum's matcher can never fire on, a FHIRPath that does not
  parse, or a malformed header (#168).
- **`push` converges bots** in a `bots` step after `project`: found by
  identifier, created through the admin endpoint with their membership and
  policy, converged field by field, and deployed only when the bundle's hash
  changes. `--adopt` takes over a bot by name; `--prune` clears a removed
  bot's schedule and never deletes it. Webhook URLs are printed, and missing
  `bots` or `cron` features stop the push before anything is written (#169).
- **Access to bots by key:** a policy entry
  `{ resourceType: 'Bot', bots: ['<key>'] }` is written as criteria on the
  bots' identifiers, the same in every environment (#170).
- **`push` converges Subscriptions** in a last `subscriptions` step: found by
  tag, delivering to a bot by key or to an `https` URL, with secret and
  header values read from the environment and never kept in the plan. One
  Medplum turned off is turned back on; `--prune` turns a removed one off
  (#171).
- **Test projects run the declared bots,** each on vmcontext, from its
  `test.bots` build when one is named, with `cron` on when a bot has a
  schedule (#172).

Operations and typed handlers (v0.13.0).

- **Operation contracts:** with `operations` in the config, `generate`
  writes `defineOperation`, `callOperation`, `handleOperation` and
  `OperationError`. Each side is a resource type, a selected profile or any
  Standard Schema value, checked at run time on both ends (#174).
- **`push` writes each contract's OperationDefinition** in an `operations`
  step, naming the bot by its id in each environment, with
  `invalid-operation` checked before anything is written and
  `shadowed-operation` for one Plumb did not write (#175).
- **Typed bot handlers:** `defineBot('<key>', handler)` types `event.input`
  by the bot's Subscriptions, schedule and webhook, and `event.secrets` by
  its declared keys (#176).
- **Works with Medplum 5.1.0,** which maps a bot's return through the
  OperationDefinition's out parameters rather than passing `Parameters`
  through (#174).

## 0.11.0 (2026-10-06)

Reference content as code ([design 09](docs/design/09-reference-content.md)).

- **`content` in the config** lists Questionnaire, CodeSystem, ValueSet and
  Organization files. `generate` and `push` check them offline first, with
  named errors (`invalid-content`, `duplicate-content`, `content-refused`)
  that say why a SearchParameter or Subscription is not content (#155).
- **`push` converges content** in a `content` step after the profiles:
  found by Plumb's tag, by URL or an Organization's key, updated in place,
  flagged when changed without a version bump, taken over from an untagged
  copy with `--adopt`, and retired, never deleted, with `--prune`.
  `--check` counts content drift (#156).
- **`push` loads the terminology the selected profiles bind** with them, so a
  project with `validate-terminology` no longer refuses writes with
  `ValueSet <url> not found` (#154).
- **`generate` types Questionnaire answers:** `<Name>Answers`,
  `<name>Answers(response)`, `<Name>LinkId` and `<Name>Url` for each
  Questionnaire in `content`, with choice codes as literal unions (#157).
- **Fixed:** `push` and `validate` found a linked project's checker bot and
  failed; the test server allows a test run's many logins (#156).

## 0.10.0 (2026-10-06)

Test environments ([design 08](docs/design/08-test-environments.md)): a
project's own tests run against a real Medplum, with its config pushed.

- **`plumb-fhir/vitest`** is a Vitest `globalSetup`: it starts Medplum,
  Postgres and Redis in Docker, makes one strict project per run, runs
  `push` into it with the project's own config, and loads the seed. A server
  already running is reused and left running (#141, #142, #144).
- **`plumb-fhir/test`** exports `testProject()`, the run's project, and
  `connectAs`, which logs in as the project's admin client, a client from
  `project.clients`, or a new client whose membership has one of the
  config's AccessPolicies, with its parameters (#143, #144). For other
  runners it exports `startServer`, `createTestProject` and `stopServer`.
- **`test` in the config** sets the server release (the installed
  `@medplum/core`'s by default), `strictMode`, `features`, settings merged
  over `project.settings`, and the seed Bundles. A seed entry the server
  refuses fails the setup by file and entry (#141, #142).
- **The README tests against a real server:** when to keep `MockClient`,
  the Vitest setup, AccessPolicies tested by acting as them, seed data, and
  the Docker requirement (#145).

## 0.9.0 (2026-10-05)

Faster and more useful `validate`, and config and credentials that fit a
monorepo. The checker changes, so the next `push` redeploys it.

- **`validate` counts records on each type's line**, not profile checks: a
  record stamped with a profile and its parent was counted twice, so a type
  could read `334 of 334 read, all 340 passed`. It now reads `all 331
  stamped passed`, and each profile's line still counts its checks (#121).
- **`--env-file <path>`** on `validate` and `push` reads credentials and
  secrets from a dotenv file, as Node's `--env-file` does: repeatable, later
  files win, and a variable already set wins over every file. Node refuses
  `--env-file` in `NODE_OPTIONS` and cannot run a package manager's shell
  shim, so this was the only short way (#120).
- **A config Node cannot load loads with the project's tsx** when it has one
  installed, so in a workspace `plumb.config.ts` can import a sibling package
  that exports TypeScript source, and use `tsconfig` path aliases and `enum`.
  Node still loads every config it can, so tsx is never loaded for one that
  worked before. Without tsx, importing TypeScript from `node_modules` is now
  a named `unsupported-syntax` error suggesting tsx (#114).
- **`validate` and `push`'s gate read only resources with a selected stamp**
  (`_profile=<selected URLs>`), and count the rest by query, so one narrow
  profile on a large type no longer reads the whole table: selecting one
  Observation profile read every stored Observation, 100 per async job.
  Resources stamped only with other profiles are counted together; `plumb
  validate --full` reads everything to break them down into silent stamps
  and profiles not selected, as every run did before. A type of more than one
  page prints its progress (#127).
- **`plumb validate --unstamped`** forecasts what would fail once unstamped
  resources are stamped: the checker routes each one with the config's
  routing rows, as the generated `route` does, and checks it against what
  `createProfiled` would stamp. Resources routing to no profile, or to
  several, are counted by reason. The forecast is reported beside the
  results and never fails the run (#123).

## 0.8.0 (2026-10-05)

- **`plumb check`** reports every `MedplumClient` read or write of a type a
  selected profile fully holds that goes around `readProfiled`,
  `searchProfiled`, `createProfiled`, `updateProfiled` or `stampProfiled`,
  by the types the compiler infers, so an inferred write is found as surely as
  a literal one. A committed baseline lets a project adopt it with a backlog:
  only new or grown findings fail. `// plumb-check: <reason>` marks a
  deliberate exception. It needs the project's TypeScript 5 or 6 (design 07).
- **`stampProfiled` returns its resource branded** (`T & Stamped`, an optional
  unique-symbol property), which `check` reads to accept a stamped write
  through a variable. Callers see no difference.
- `check` in the config: `tsconfig`, `baseline` and `ignore`.
## 0.7.0 (2026-10-05)

- **`stampProfiled(resource, options?)`** returns the copy `createProfiled`
  would write, routed and stamped, without writing it: for conditional
  creates, upserts and batch or transaction entries. It takes the same
  options, is typed the same way, and throws the same `RoutingError` (#124).
- The README says `updateProfiled` stamps a record that was unstamped, so
  edits of stored records that fail the profile start being refused; and to
  commit `fsh-generated/resources/` but gitignore SUSHI's index files (#125).

## 0.6.2 (2026-10-05)

`validate` and `push` from an installed Plumb, and on Medplum's `awslambda`
bot runtime, where the checker now has its first verified run.

- **The installed CLI finds its own package.** It stopped at
  `dist/esm/package.json`, so `validate` and `push` failed reading
  `dist/esm/dist/checker.cjs`, and `--version` printed `undefined` (#117,
  #118). `./package.json` is exported.
- **On the `awslambda` runtime, a page waits while the checker's function is
  not ready** (`Pending` after an install, an update in progress after a
  redeploy), for up to a minute, instead of failing the first gate (#119).

## 0.6.1 (2026-10-05)

Fixes from the first adoption of 0.6.0 in a Medplum monorepo. Regenerate to
pick them up: `plumb generate --check` reports the generated files as stale.

- **Doc comments** are no longer cut at an abbreviation or inside
  parentheses: US Core's `telecom` read `A contact detail (e.g.` (#111).
- **The generated reads compile without the DOM lib or `@types/node`.**
  `searchProfiled` takes a string, a record, or any list of pairs (a
  `URLSearchParams` is one) and passes `searchResources` plain pairs, so
  `ProfiledReader.searchResources` now takes `string[][]`; a `MedplumClient`
  still fits (#112).
- **Generated files export only what the index or a sibling uses**, so
  unused-export tools such as knip report nothing in them: `routes`,
  `required` and `WithId` are no longer exported (#113).
- `npm pkg fix` on `bin`, and the README's cache action at v6 (#115).

## 0.6.0 (2026-10-05)

The first published release; it includes everything in 0.1.0 to 0.5.0, which were not published.

Project config as code: `push` converges what a project admin can write.

- **`project`** in the config declares settings, secrets, AccessPolicies,
  default access policies and clients, typed with `@medplum/fhirtypes`. An
  environment's `settings` merge over `project.settings`. An unknown policy
  key, duplicate names, a setting that is not a string, boolean or number,
  and a super-admin field (`strictMode`, `features`, `link`,
  `systemSetting`) are config errors.
- **`push` runs a `project` step** once the profile gate has passed. It plans
  each AccessPolicy and client by a `meta.tag` with its config key, updates
  it in place, and writes the Project's settings, secrets, `defaultProfile`
  and `defaultAccessPolicies` in one update. A second push with no config
  change writes nothing.
- **`--adopt`** tags and converges an untagged policy or client with a key's
  name; without it, one stops the plan. **`--prune`** deletes a tagged one
  whose key left the config.
- **Secrets** come from environment variables (`{ env }`) or must already
  exist (`true`); no plan, `--json` output or error holds a value. A created
  client's id is printed, never its secret.
- **`push --check`** plans without installing or writing anything, and exits
  1 when `push` would change something, naming what drifted.
- **Lockdown warnings:** a writable `*` entry, an admin client with no
  policy, and a policy other than push's own that writes
  StructureDefinition.
- `strictMode` and `features` are reported, never written. A linked
  project's resources are never planned.
- **Breaking:** the checker bot's identifier system is now
  `https://www.npmjs.com/package/plumb-fhir`, as is Plumb's tag system, so a
  checker installed by 0.5 is installed again.

## 0.5.0 (not published)

SUSHI in `generate`: one command builds FSH and types it.

- **`fsh`** in the config names the folder holding `sushi-config.yaml`, in
  place of `local`. Setting both is a config error, as is a folder with no
  `sushi-config.yaml`.
- **`generate` runs the project's own SUSHI** (`fsh-sushi` 3 or later) with
  `--snapshot`, as a first `sushi` step. Its errors stop `generate`, with
  their FSH file and line; its warnings are listed under the step. SUSHI
  missing or too old exits 2, naming the install command.
- **`generate --check`** rebuilds the FSH into a temporary folder and fails
  when the committed `fsh-generated/resources` differs from it, file by file,
  as well as when the types do. The project is not touched.
- **Version warnings:** the `sushi` step warns when `sushi-config.yaml`
  depends on a package at a version `igs` does not select, and `load` warns
  (`base-version-mismatch`) when a local profile's pinned parent version
  differs from the one the config provides.

## 0.4.0 (not published)

Typed reads: reads that return the profile type once its content is checked.

- **`_reads.ts`**, generated into `out`, lists the paths each selected
  profile's type requires beyond `@medplum/fhirtypes`, for the presence check
  typed reads run.
- **`isProfiled`, `asProfiled` and `pickProfiled`**, generated into `out`,
  check a resource's stamp and what its type requires, offline, and narrow it
  to the profile type; a failure throws a **`ProfileReadError`** naming the
  records and paths, with the records that passed in a non-enumerable
  `passed`.
- **`readProfiled` and `searchProfiled`** read from Medplum and return the
  profile type once checked. The search filters on `_profile` (the profile and
  any selected child), refuses `_elements`, `_fields`, `_summary`, `_include`
  and `_revinclude` before any request, and fails as a whole when one result
  does, with the rest in `passed`.
- A choice narrowed to `Reference` keeps the base element's targets instead of
  widening them to any resource.

## 0.3.0 (not published)

Routing: each write held to the profile its content selects.

- **`route(resource)`**, generated into `out`, returns the selected profile a
  resource's content selects, preferring a child over its parent, and throws
  a `RoutingError` naming what would select each candidate rather than
  guess.
- **`createProfiled` and `updateProfiled`** route, stamp the type's
  `defaultProfile` plus the routed profile, and write; `{ profile }` chooses
  one, typed, and `{ profile: false }` writes no stamp.
- **`routes`** in the config adds rows for profiles keyed on a value set, or
  `false` to take one out; **`defaultProfile`** names the defaults stamped
  with each write. `generate` warns for profiles one resource could match.

## 0.2.0 (not published)

The conformance check: what stored data would fail a profile, before it loads.

- **`environments`** in `plumb.config.ts` name a Medplum project and the
  environment variables holding its client credentials.
- **`plumb validate --env <env>`** counts, per profile, the stored resources
  that would fail and why, with Plumb's checker bot inside the project, so
  patient data never leaves Medplum. It reports unstamped resources, silent
  stamps, shadowed profiles, and readable against stored counts; failing ids
  go only to a gitignored file. `--resume` continues an interrupted run.
- **`plumb push --env <env>`** installs the checker, then loads the selected
  profiles and their dependencies, refusing while any stored resource would
  fail them, and re-checks once they are loaded. `--dry-run` stops after the
  gate. Strict mode is reported, never set.

## 0.1.0 (not published)

The first release: profile-aware types for Medplum.

- **`plumb generate`** fetches the IG packages `plumb.config.ts` names from
  the FHIR package registry into `~/.fhir/packages`, locks each one's version
  and hash in `plumb.lock`, and generates a TypeScript file per profile that
  narrows `@medplum/fhirtypes`: required fields at every depth, prohibited
  fields, choice types, fixed and pattern values, reference targets, slices
  with typed builders and readers, extension types shared across profiles,
  and literal unions for required bindings whose value sets can be listed
  offline.
- **`plumb generate --check`** compares with the committed output byte for
  byte, writes nothing to the project, and names the cause of each
  difference; for CI.
- **`validateProfiled`** runs Medplum's validator against a selected profile,
  offline, for tests.
- Profiles by canonical URL, or `name/*` for every resource profile in an IG;
  local StructureDefinition JSON, such as SUSHI's output; `bindings.maxCodes`.
- Supports `@medplum/*` 5.1.0 and later, TypeScript 5.0 and later, and Node
  `^22.18.0 || >=24.2.0`.

See the README's known limits for what the types leave to `validateProfiled`
and the server.
