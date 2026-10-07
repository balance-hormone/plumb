# Design 11: Data Migrations

**Status: implemented** in v0.14 (#189 to #196). Accepted on 2026-10-06.
The second item on the
[spec's roadmap](../spec.md#roadmap). It supersedes the
[data migrations](../future/data-migrations.md) sketch; the
[prior art](../research/migrations-prior-art.md) is the survey behind it.

As built, these details differ from or add to the text below:

- **Writes are PUT, not PATCH.** Medplum 5.1.0 applies a PATCH whatever its
  `If-Match` says, so the runner patches in memory and PUTs the record with
  `If-Match`, which every release honours (#190).
- **Over the write quota, a page waits a minute** and runs again, up to ten
  times, rather than reading the reset time from the 429's extension (#191).
- **A run's start is the server's time,** not the CLI's: when its ledger
  entry was saved, or for a dry run the server's `Date` header, so a skewed
  clock neither skips records nor reads a pass's own writes again (#212).
- **A new ledger entry is a conditional create** (`If-None-Exist` on its
  tag), so two first runs cannot both make one; later writes use `If-Match`
  (#191).
- **More named errors:** `migrator-missing`, the bot is not deployed;
  `migration-paused`, Ctrl-C stopped a `--write` after a page;
  `unknown-migration`, an id on the command line no module declares;
  `no-migrations`, `migrate status` with no `migrations` in the config
  (#191, #192).
- **`--local` answers the forecast in process,** with the checker's handler,
  so it needs no deployed checker either (#193).
- **Restamps are one migration per type,** `plumb-restamp-<Type>`, generated
  into `_restamp.ts`, hashed by `_routes.ts`, and marked repeatable: a
  changed hash makes them pending again, never `migration-edited` (#194).

Builds on [design 02](02-conformance-check.md)'s checker and `validate`, whose
page loop, cursor and in-project validation it reuses, on
[design 10](10-behaviour.md)'s bots, which deploy the migration code, and on
[design 08](08-test-environments.md)'s test projects. Read design 02 and
design 10 first.

## Job

Profiles are a Medplum project's schema, and stored data is never re-checked
against them: each record meets the profiles that applied when it was
written. Stored data goes stale when a profile tightens, when routing or a
default profile changes the stamp a record should carry, when a project with
loose data adopts profiles, and when the app moves data to a new shape (an
extension's URL, a code system, an identifier system).

`push`'s gate already refuses to load a profile that stored data would fail,
and `validate` says how many records and why. Nothing fixes them. Teams write
a script per fix, and each one re-solves the same things, some wrongly:
selecting the records, paging, re-running safely after a crash, a dry run,
not overwriting a concurrent edit, running once per environment, and
recording what ran. Those scripts also read patient data onto a laptop or a
CI runner, which `validate` was built to avoid.

The same four steps as every layer: **declare** a migration in the
repository, **generate** a typed runner, **converge** each environment with
`plumb migrate`, and **verify** with `validate`. Together with `push` this is
SQL's **check, backfill, then tighten**:

```text
plumb validate --env prod            # 312 Patients fail us-core-patient: birthDate missing
plumb migrate --env prod             # dry run: 312 to change, 312 would then pass
plumb migrate --env prod --write     # backfill, resumable
plumb push --env prod                # the gate passes; the stricter profile loads
```

```ts
// src/migrations/20261006-patient-birthdate.ts
import { defineMigration } from '../fhir/generated/index.js';

export default defineMigration({
  id: '20261006-patient-birthdate',
  resourceType: 'Patient',
  search: { 'birthdate:missing': 'true' }, // narrows what is read; optional
  transform(patient) {                    // pure; undefined means "already done"
    if (patient.birthDate) return undefined;
    return [{ op: 'add', path: '/birthDate', value: unknownBirthDate(patient) }];
  },
});
```

```text
plumb migrate --env prod
✔ migrator       current (migrator-3c07…)
✔ 20261006-patient-birthdate   dry run: 312 read, 312 to change, 0 unchanged
    forecast: 312 would pass the selected profiles, 0 would still fail
✔ plumb-restamp-Patient  dry run: 4,120 read, 18 to restamp, 4,102 unchanged
Done in 41.2s (dry run; --write to apply)
```

## Checked first

Each claim below was read from Medplum's source (`main` at `427004db6`) and
shapes a rule in this design. Each is to be pinned by a real-server test
(Testing, below), and is recorded in the
[research notes](../research/medplum-server-behaviour.md) with the first
issue.

- **`If-Match` guards an update on every release, a PATCH only on later
  ones.** On `main` the router reads `If-Match: W/"<versionId>"` for update,
  patch and their conditional forms, and the repository answers 412 when the
  stored version differs. Medplum 5.1.0 ignores it on a PATCH and applies the
  patch (found by the server tests on 5.1.0), so the runner patches in memory
  and writes the whole record with PUT and `If-Match`, which every release
  honours. `MedplumClient.updateResource` passes headers through its options.
  JSON Patch's `test` op works too, but a failed `test` is a plain 400,
  indistinguishable from a validation failure.
- **A write validates its result** against base R4 and every profile in its
  `meta.profile`, as a create or update does: refused under strict mode,
  logged only without it. A profile the server has not loaded is skipped. A
  patch may change `meta.profile`; one that removes it gets the project's
  `defaultProfile` added back.
- **An unchanged write is not a version.** The repository compares the new
  content with the stored one, ignoring `versionId` and `lastUpdated`, and
  returns the stored resource. The runner skips such writes anyway, since each
  costs quota.
- **Cursor paging is `_lastUpdated` ascending only.** Cursor links are issued
  for one sort rule, `_lastUpdated` ascending, with `_count` of 20 or more;
  `_count` above 1,000 is clamped without a word. A record written during the
  scan gets a new `lastUpdated` and would come round again at the end, so a
  run reads only records last updated before it started.
- **Search results keep `meta`**, `versionId` included, even with
  `_elements` or `_summary`, so each record is written against the version
  read.
- **Writes are rate-limited per membership:** a write costs 100 points and
  the default limit is 50,000 a minute, about 500 writes a minute, set per
  user or per project by a super admin. Over it is a 429 with the reset time
  in an extension; there is no `Retry-After`.
- **Bot runs are bounded.** vmcontext defaults to 10 seconds, uncapped, and
  its timeout bounds only synchronous work; Lambda defaults to 10 and refuses
  more than 900. `Bot/$execute` with `Prefer: respond-async` writes an
  `AsyncJob` in the project through the caller's access, and the bot's return
  lands in its `output`.
- **Conditional writes are serializable.** `If-None-Exist` searches and
  creates in one serializable transaction, and an update with `If-Match` is
  checked inside one, so two runs racing for the same ledger record cannot
  both win.
- **`$validate` checks against the profiles the project has loaded.** A
  migration runs before `push` loads the stricter profile, so `$validate`
  cannot forecast against it. Plumb's checker already validates against the
  selected profiles from definitions in its input, so the migration bot asks
  it, inside the project.

## What is declared

| Declared | Where | Found again by |
| --- | --- | --- |
| A migration | a module the config lists, `defineMigration` | its `id` |
| The migrator | a key in `bots`, built from the generated runner | the bot's identifier (design 10) |
| A run | written by `plumb migrate` | a `Basic` with Plumb's tag, the migration's `id` as code |

Not declared, and why:

- **Order across migrations.** Most data fixes are independent, and the order
  that matters is against profiles, which the gate enforces. A migration that
  needs another names it in `dependsOn`.
- **A `down`.** No transaction spans thousands of resources, so a run that
  stops halfway is resumed, not rolled back. Each run records the versions it
  wrote, so a later restore is possible (Later, below).
- **Schema changes.** Profiles stay declarative and go through `push`;
  migrations never load a profile and `push` never writes patient data.

## Config

```ts
export default defineConfig({
  // …igs, profiles, out, project, content, bots as today
  bots: {
    migrator: {
      file: './dist/bots/migrator.cjs', // built by the project from the generated runner
      runtime: 'awslambda',
      timeout: 300,
      policy: 'migrator',               // reads and writes the migrated types
    },
  },
  migrations: {
    bot: 'migrator',
    modules: ['./src/migrations/*.ts'],
    restamp: true,                      // the built-in restamp migration
  },
  environments: {
    dev: { baseUrl: 'http://localhost:8103/', clientId: { env: 'DEV_ID' },
           clientSecret: { env: 'DEV_SECRET' }, synthetic: true },
    prod: { /* … */ },
  },
});
```

- **`modules` lists migration modules,** loaded as the config and operation
  contracts are, with the project's tsx when installed. Each default export
  made by `defineMigration` is a migration.
- **An `id` starts with a date** (`YYYYMMDD-name`), so two branches adding a
  migration never collide on a number, and ids sort in the order they were
  written. `plumb migrate new <name>` scaffolds one.
- **`bot` names a key of `bots`.** The bot's bundle is the project's own: a
  one-line entry, `export { handler } from './fhir/generated/_migrator.js'`,
  built as its other bots are. `generate` writes `_migrator.ts`, importing
  each module `modules` lists, so a new module makes the output stale until
  it is generated. The runner needs nothing from `@medplum/core` at run time:
  it carries its own JSON Patch, since 5.1.0's `@medplum/core` has none, and
  leaves validation to the checker. Its policy grants the checker by key,
  `{ resourceType: 'Bot', bots: ['checker'] }`, which a policy may name
  although `bots` does not declare it.
- **`synthetic: true`** marks an environment that holds no real patient data,
  where the runner may also run in the CLI's own process (Running locally,
  below). A test project is synthetic. The flag names the property that
  matters rather than an environment's name.

### `defineMigration`

```ts
defineMigration<T extends ResourceType>({
  id: string,
  resourceType: T,
  search?: Record<string, string>,  // FHIR search parameters, ANDed; a modifier goes in the key
  transform: (resource: ResourceOf<T>) => JsonPatch | undefined,
  dependsOn?: string[],
  description?: string,
})
```

- **`transform` is pure** and returns RFC 6902 operations, or `undefined` when
  the record needs nothing. Re-running a migration over finished records is
  then a no-op, which is what makes a run safe to resume and to repeat.
- **The resource is typed** by `@medplum/fhirtypes`, not a profile type: the
  record is stale, so a profile type would claim what it lacks. A transform
  that wants the profile's type narrows with the generated `isProfiled`.
- **`search` only narrows.** The runner adds `_lastUpdated`, `_sort` and
  `_count`; `transform` decides per record. A search that over-selects costs
  reads, never wrong writes.
- **Tested without a server:** a transform is a function, so a project tests
  it on fixtures, as Sanity's migrations are tested: records in, patches out.

### Checked offline, before anything is written

`invalid-migration`, naming the module and export: an `id` used twice or not
starting with a date; a `dependsOn` naming no migration, or a cycle; an
unknown `resourceType`; a `search` parameter Medplum does not index for the
type, checked with `@medplum/core`'s parser as Subscription criteria are; a
`bot` that is not a key of `bots`; a module that exports no migration.

## The runner

`generate` writes `_migrations.ts` when the config has `migrations`: the
migrations it lists, bound to `handleMigrations`, the bot's handler. It runs
one page per call:

1. **Read** a page of `resourceType` with the migration's `search`,
   `_lastUpdated=lt<run start>`, `_sort=_lastUpdated` and the cursor.
2. **Transform** each record. `undefined` counts as unchanged.
3. **Apply** the patch in memory. A patch that fails to apply is a failure
   for that record, never a write.
4. **Forecast** (dry run and write alike): send the page's changed records,
   as patched, to Plumb's checker with `Bot/$execute`, which validates them
   against the selected profiles they are stamped with, from the definitions
   in the input, passed through unopened. The records go from bot to bot
   inside Medplum, never to the CLI.
5. **Write** (with `--write` only): PUT the patched record with `If-Match`
   on the version read. A 412 means the record changed since it was read: read it again and
   transform once more; a second 412 counts it as a conflict, left for the
   next run. A 400 counts it as failed, with Medplum's reason.
6. **Return** counts (read, changed, unchanged, conflict, failed, would pass,
   would fail), reasons, the next cursor, and the `id` and new `versionId` of
   each record written. No resource content leaves the bot.

The returned ids and versions stay in the run's `AsyncJob`, in the project;
the CLI keeps counts and the cursor, and never prints an id.

A page is 100 records by default (`--page-size`, at most 1,000), small enough
for vmcontext's and Lambda's default timeouts. On a 429 the CLI waits for the
reset the response names, then runs the page again; pages are idempotent, so a
page that half-wrote is safe to repeat.

### Restamping

`restamp: true` adds a migration Plumb provides, `plumb-restamp-<Type>`, for
each type with routing rows, generated into `_restamp.ts`: it runs the generated `route` over each record and
sets the Plumb-managed URLs in `meta.profile`, the type's `defaultProfile`
less any the routed profile derives from, plus the routed profile, as
`updateProfiled` stamps them. Other URLs are kept; an unroutable record is
unchanged and counted. Its ledger records a hash of `_routes.ts`, so a
change to `routes` or the selected profiles makes it pending again, as
Flyway reruns a repeatable migration whose checksum changed.

## The ledger

Each migration has one `Basic` per project, found by Plumb's tag with its
`id` as code, written by the CLI's client, never the bot:

- **status:** `running`, `paused`, `errored` or `applied`; no record is
  pending;
- **the module's SHA-256,** and the git commit when known;
- **the run's start,** its cursor, its pages, its counts and its last error;
- **a lease:** the time a running run last wrote, so a run whose CLI died is
  taken over once the lease is ten minutes old.

The state is one JSON extension on the `Basic`, so the entry stays one small
resource however many pages a pass takes. The ids and versions each page
wrote stay in that page's `AsyncJob`, in the project, not in the ledger.
Ctrl-C during `--write` stops after the current page and leaves the
migration `paused`. A pass that ends with records failed or conflicted is
`errored` with no cursor, so the next `--write` makes a fresh pass, which
changes only what the transform still finds.

A run takes the lease by updating the `Basic` with `If-Match`; the loser of a
race gets a 412 and stops with `migration-running`. A `paused` or `errored`
run resumes from its cursor and its start time. An `applied` migration is not
run again; `--rerun <id>` starts a fresh pass over it, which changes only
what its transform still finds.

The ledger is bookkeeping about the project, not a fact about a patient, and
it lives where the data lives: a store outside Medplum could disagree with
the records it describes. `Basic` needs no special access, and its history
keeps every past state.

## Commands

| Command | What it does |
| --- | --- |
| `plumb migrate new <name>` | Scaffolds `<date>-<name>.ts` in the first `modules` folder |
| `plumb migrate --env <env>` | Dry run of every pending migration: counts and the forecast |
| `plumb migrate --env <env> --write` | Applies them in `id` order, after their `dependsOn`, resuming any paused |
| `plumb migrate --env <env> <id>…` | The same, for the named migrations only |
| `plumb migrate status --env <env>` | Each migration: pending, running, paused, errored, applied, or edited since applied |

- **Dry run by default:** nothing is written without `--write`, the ledger
  included.
- **The migrator must be current:** `migrate` stops with exit 2 unless the
  deployed bot's code hash matches its file, as `validate` requires the
  checker; `push` deploys it.
- **`status` exits 1** when anything is pending, running, paused, errored or
  edited, so a nightly job catches an environment that missed a migration, as
  `push --check` catches drift.
- **Finished migrations can be deleted.** Once `status` says a migration is
  applied in every environment, its module can go; its `Basic` stays, and
  `status` lists it as applied with no module.

`migrateEnvironment` and `migrationStatus` return reports and the CLI only
prints, as every command does.

### Running locally

On a `synthetic` environment, `--local` runs the same generated runner in the
CLI's process instead of the bot, against the same ledger. It needs no `bots`
feature and no deploy, which suits a developer's own project and CI. On any
other environment `--local` stops with `not-synthetic`, before reading
anything. A test project ([design 08](08-test-environments.md)) runs
migrations the same way: `plumb-fhir/test` exports `migrate(project, config, options)`,
so a project's tests seed stale records, migrate, and assert what `validate`
then says.

## With `push`

The two stay separate: `push` converges config and never writes patient data,
and `migrate` writes data and never loads a profile. When `push`'s gate
refuses, its output lists the pending migrations on each failing type, so the
next command is in front of the developer:

```text
✖ gate       312 stored Patients would fail us-core-patient
    pending: 20261006-patient-birthdate (Patient)
    Refusing to load: run plumb migrate --env prod, or see plumb validate --env prod.
```

The order for a tightening is expand, migrate, contract: ship the app writing
the new shape, migrate the old records, then `push` the stricter profile. A
record the app writes in the old shape after the run started is not read by
it; the gate catches it, and `--rerun` fixes it.

## Errors

Named, as config and push errors are: `invalid-migration` (above);
`not-synthetic`, `--local` on an environment not marked synthetic;
`migrator-not-current`, the deployed bot is not this build; `migration-running`,
another run holds the lease; `migration-edited`, a module whose hash differs
from the one its `applied` run recorded, reported by `status` and refused by
`--write` unless `--rerun`; `unmet-dependency`, a `dependsOn` not applied in
this environment; `bots-disabled`, from design 10.

## Testing

Against the Docker Medplum server, in a test project per file:

- **Medplum's behaviour,** each claim in Checked first: a PUT with a stale
  `If-Match` is a 412; a PUT validates against `meta.profile` under strict
  mode; an unchanged PUT writes no version; a cursor scan by
  `_lastUpdated` sees a record written mid-scan again; a second `If-Match`
  update of the ledger loses.
- **A migration converges:** a dry run writes nothing, ledger included; a
  `--write` run fixes every seeded record and `validate` then passes; a
  second run changes nothing and writes no version.
- **Resume:** a run stopped after its first page resumes from its cursor, and
  a run whose lease expired is taken over.
- **Concurrency:** a record edited between the read and the write is read
  again, not overwritten; two runs started together leave one
  `migration-running`.
- **The forecast** matches what `validate` reports after the write, on the
  contract fixtures.
- **Restamping** sets the stamps `updateProfiled` would, keeps foreign URLs,
  and becomes pending again when a `routes` row changes.
- **Local:** `--local` on a test project matches the bot's counts; on an
  unmarked environment it is `not-synthetic`.
- **No patient data out:** the CLI's report and `--json` hold counts and
  reasons, never a resource or an id.

Offline: each `invalid-migration` case; the runner's page logic as a pure
function over fixture records (patch, forecast, the counts); `transform`'s
types reject a wrong patch target in the harness's `tsc` run.

## Proposed issues

**v0.14: data migrations** (#189 to #196, after issue 1)

1. **Research and spec:** the prior art, the findings above in the research
   notes, and this design on the roadmap. (Lands with this note.)
2. **Config:** `migrations`, `defineMigration`, module loading, `synthetic`,
   the offline checks, and `plumb migrate new`.
3. **Generate:** `_migrations.ts` and `handleMigrations`: read, transform,
   forecast, write with `If-Match`, return counts.
4. **Migrate:** `plumb migrate --env`, driving the bot a page at a time, with
   the ledger, the lease, `--write`, resume and 429 back-off.
5. **Status:** `plumb migrate status`, `dependsOn`, `--rerun`,
   `migration-edited` and its exit code.
6. **Local:** `--local` on synthetic environments, and `migrate` in
   `plumb-fhir/test`.
7. **Restamp:** the built-in `plumb-restamp-<Type>` migrations.
8. **Push:** the gate names the pending migrations on each failing type.
9. **Docs:** a README section, the changelog, and this design marked
   implemented.

## Later (not in this design)

- **Restore:** put back the versions a run wrote, from its `AsyncJob`s, where
  the record's current version is still the one the run wrote.
- **Scaffold on tighten:** `generate` notices a path a profile newly requires
  and scaffolds a migration selecting the records missing it.
- **Marketplace migrations,** once Medplum's package manifest and its
  `$upgrade` runner merge.
- **Questionnaire versions:** moving stored responses to a new version of a
  content Questionnaire, once a project asks for it.
