# Data Migrations: Prior Art

How other tools fix stored data when its shape changes, and what that means
for Plumb's [data migrations](../future/data-migrations.md). Surveyed
2026-10-06, before design 11.

**Sources.** Medplum, `@sanity/migrate`, HAPI FHIR and Shopify's
`maintenance_tasks` were read from their source or README. Drizzle, Prisma,
Atlas, Mongock, Payload, Strapi and Elasticsearch come from search results,
mirrors and prior knowledge, since their documentation sites were not
reachable; check a detail against the primary source before a design rests
on it.

## The problem

In SQL the database owns the schema and refuses data that breaks it. In
Medplum, profiles are the schema, and stored data is never re-checked: each
record meets only the profiles that applied when it was written. Stored data
goes stale when:

1. **a profile tightens:** a new required element, a narrower binding, a new
   slice. Each old record fails its next write, usually as a user's save.
   `push`'s gate refuses the load, and nothing does the backfill;
2. **routing changes:** a new `routes` row, profile or `defaultProfile`.
   Stored records keep the old stamp, or none, so typed reads refuse them;
3. **a project adopts late:** loose data, then profiles and strict mode.
   `validate --unstamped` forecasts the failures; nothing repairs them;
4. **the app refactors:** an extension moves URL, a code system is renamed, an
   identifier system changes, with no profile change at all;
5. **content versions:** a new Questionnaire version, with responses stored
   against the old one.

Teams write a script per fix, each re-solving selection, paging, safe
re-runs, dry runs, concurrent edits, running once per environment and
recording what ran.

What differs from SQL:

- **No transaction at scale.** A batch cannot wrap thousands of writes, so a
  half-applied migration is normal and must resume.
- **Every write validates** against the profiles loaded at that moment, so
  order matters: backfill, then tighten.
- **Live writes continue** during a run.
- **Patient data** should stay in Medplum, as `validate`'s checker keeps it.
- **History is kept:** every write is a new version.
- **Several environments** each converge, as with `push`.

## Schema migration tools

**Drizzle Kit.** `generate` diffs the TypeScript schema against the last
snapshot and writes `drizzle/NNNN_tag.sql`, with `meta/_journal.json`;
`migrate` applies pending files, recorded in `__drizzle_migrations(id, hash,
created_at)`; `push` diffs the live database and keeps no ledger, so mixing
the two drifts. Data changes are hand-written SQL in a `generate --custom`
file: no batching, no dry run. Sequential numbers collide across branches.

**Prisma Migrate.** `migrate dev` generates and applies in development,
`migrate deploy` applies in production, `migrate status` reports, `migrate
resolve` marks a migration applied or rolled back by hand. `_prisma_migrations`
records a SHA-256 checksum per migration, so an edited applied migration is
caught, and a failed one blocks `deploy` until resolved. `migrate dev`
replays history into a throwaway shadow database to detect drift. Folders are
timestamped. Prisma emits DDL only; for data it documents **expand and
contract**: add the new field, write both, backfill with a separate script,
read the new field, drop the old. Prisma does not track that script.

**Rails and `data_migrate`.** `schema_migrations(version)` holds timestamps.
`data_migrate` keeps data migrations in `db/data/` with their own table and
interleaves them with schema migrations by version. They run inside deploy,
unbatched, in one transaction.

**Django.** `RunPython(forwards, reverse_code)` inside a migration, using the
*historical* model (`apps.get_model`) so old migrations keep running after the
model changes. A dependency graph, not a numbered chain: two leaves is an
error until `makemigrations --merge`. `--plan` previews, `--fake` records
without running.

**Flyway and Liquibase.** A history table with a checksum per script;
`validate` fails when an applied script changed or went missing. Flyway's
**repeatable** `R__` scripts rerun whenever their checksum changes;
`baseline` adopts an existing database at a version. Liquibase adds
preconditions (`onFail=MARK_RAN`), contexts per environment, `update-sql` as
a dry run, `changelog-sync` to record without running, and a lock row that a
crash leaves stuck until `release-locks`.

**Atlas.** Declarative (`schema apply`) and versioned modes. `atlas.sum`
hashes the migration directory, so two branches adding a file conflict in
git, not in production. `migrate lint` flags **data-dependent changes**
(adding NOT NULL or UNIQUE, narrowing a type) as ones that "might fail
depending on data in the database", alongside destructive changes.

**strong_migrations.** Refuses unsafe operations during `db:migrate` and
prints the safe multi-step recipe; `safety_assured` overrides. Backfills run
outside the schema change's transaction, in batches with a pause between.

## Backfill runners

**Shopify `maintenance_tasks`,** the closest shape. A task declares a
`collection` (a relation, array or CSV), `process(record)` and an optional
`count`, with typed parameters. Each run is a row: status (enqueued, running,
paused, interrupted, cancelled, succeeded, errored), a cursor, tick counts,
the error and the arguments. Runs resume from the cursor after a deploy or
timeout, throttle on a condition, pause and cancel from a UI or CLI, and one
run per task is active at a time. `process` must be idempotent; there is no
built-in dry run. Guidance: schema changes stay in migrations, tasks are for
backfills, and task code is deleted once it has run everywhere.

**Medplum's own data migrations** (`packages/server/src/migrations/`).
`PostDeployMigration` has `prepareJobData` and `run(repo, job, data)`,
returning `finished`, `interrupted` or `ineligible`. A `DatabaseMigration` row
holds the data version; each run is an **`AsyncJob` resource** (`type:
data-migration`) whose `output` carries the cursor, so a job resumes.
`data-version-manifest.json` gives each version a `requiredBefore`, and the
server refuses to start past it until the migration has run. A serializable
check refuses a second migration job while one is in progress. Reindex
migrations select by resource type, a search filter and `maxResourceVersion`,
in batches of 500. They run in a server worker, need a super admin, and have
no dry run or rollback.

**Medplum's marketplace manifest** (PR #10557, open). `migrations: [{
version, file }]`, each module exporting `up` and `down`; `$upgrade` walks
them in order and `$rollback` in reverse. The validator refuses a list that
is not strictly ascending. `medplum package publish` is a dry run unless
`--apply`. The `$upgrade` runner is not in the PR.

**HAPI FHIR `$hapi.fhir.bulk-patch`** (8.6.0). A FHIRPatch plus search URLs,
`batchSize`, and `dryRun` with `dryRunMode` `count` or `collectChanges`.
Runs as a server batch job; a chunk that fails as one transaction is retried
one resource at a time, so one bad record does not stop the rest. The report
counts changed, unchanged and failed. A retried chunk reruns from its start,
so patches must be idempotent. Before 8.6.1 a job could report success while
logging failures. `$hapi.fhir.bulk-patch-rewrite-history` edits past
versions in place.

**Smile CDR** applies repository validation rules on write and re-applies
changed rules with `$update-tokenization`; no tooling was found for
upgrading stored data to a new IG version.

## Document and content stores

**Sanity** (`@sanity/migrate`). `defineMigration({ title, documentTypes,
filter, migrate })`: `filter` is a GROQ expression, and `migrate` is a set of
visitors (`document`, `object`, `string`, ...) or an async generator, returning
patches built with `at(path, set | unset | setIfMissing | insert | inc)`.
**Dry run by default**; `--no-dry-run` writes. Documents stream from an export
into a local buffer; mutations batch up to 256 KB, six requests at a time. No
ledger and no lock: idempotency is the author's, taught as a filter that
excludes migrated documents and `setIfMissing`. Each transaction has a client
id so an unknown outcome can be looked up. Tests feed fixtures in and assert
on the mutations out. It runs on the client.

**Contentful** (`contentful-migration`). `transformEntries({ contentType,
from, to, transformEntryForLocale })` returns new values, or `undefined` to
skip. `deriveLinkedEntries` takes an `identityKey` so a re-run does not
duplicate. The CLI shows a plan and asks to confirm. No ledger; teams clone an
environment, migrate it, then point the `master` alias at it.

**migrate-mongo.** `up` and `down` per file; a `changelog` collection records
each file and, optionally, its SHA-256; a `changelog_lock` collection with a
TTL stops concurrent runs without sticking after a crash.

**Mongock, Payload and Strapi.** Mongock's change units have a rollback
method and a lock collection; Payload runs each migration in a transaction and
reverts the last batch; Strapi runs files once, in order, at startup.

**MongoDB schema versioning.** Each document carries a `schemaVersion`;
readers handle every version and upgrade lazily or in a background sweep.

**Elasticsearch.** `_reindex` copies into a new index, throttled and sliced,
then an alias swaps atomically; the old index is the rollback.

**DynamoDB.** A paged scan with conditional updates (`attribute_not_exists`,
or the version read), so a concurrent write is never overwritten and a re-run
is a no-op.

## What fits Medplum

| Idea | From | In Plumb |
|---|---|---|
| Dry run by default, a flag to write | Sanity, Medplum `publish --apply`, HAPI | `push`'s `--dry-run`, inverted |
| A transform returns a patch, or nothing when done | Sanity, Contentful, HAPI `noChange` | Typed paths from the generated types |
| Selection by search, confirmed per record | Sanity, HAPI, `maintenance_tasks` | A FHIR search, or "fails `validate`" |
| A resumable cursor, one run at a time | `maintenance_tasks`, Medplum `AsyncJob` | `validate` already saves a cursor |
| A ledger in the store, with a file hash | Medplum, migrate-mongo, Flyway, Prisma | A tagged resource in the project |
| Conditional writes per record | DynamoDB, HAPI's fallback | `If-Match` on the version read (to verify) |
| Verify afterwards; partial failure is not success | HAPI | `validate` after the run |
| Refuse a tightening the data would fail | Atlas lint, strong_migrations, Medplum `requiredBefore` | `push`'s gate, naming the migration that fixes it |
| Rerun when its inputs change | Flyway `R__` | Restamping when the routing changes |
| Mark applied by hand | Flyway `baseline`, Prisma `resolve`, Liquibase `changelog-sync` | For environments fixed by hand |
| Fixtures in, patches out | Sanity | Transforms tested without a server |
| Delete task code once run everywhere | `maintenance_tasks` | `status` says when |

## What does not fit

- **A transaction per migration, and `down`** (Prisma, Drizzle, Django,
  Payload, Mongock): no transaction spans thousands of resources. Recovery is
  resuming or a new forward migration; history makes a restore possible.
- **Shadow-database replay** (Prisma): migrations over patient data cannot be
  replayed into a scratch project. Config drift is `push --check`; data
  drift is `validate`.
- **One chain mixing schema and data** (`data_migrate`): profiles are
  declarative, with no file to slot a migration between. Gates (`validate`
  passes) order them instead.
- **Copy then swap** (Elasticsearch, Contentful): ids, references and history
  make copying a project impractical.
- **Pulling data to the client** (Sanity, teams' scripts): patient data leaves
  Medplum.
- **Server-internal jobs** (Medplum's own migrations, HAPI's batch jobs): they
  need a super admin or server code; Plumb is project-scoped and borrows their
  bookkeeping, not their mechanism. History is never rewritten.
- **Running at startup** (Strapi, Mongock): Plumb runs explicitly, per
  environment.
- **Upgrading lazily on read alone:** Medplum validates on write, so a stale
  record still fails its own update. At most it supplements a sweep.
