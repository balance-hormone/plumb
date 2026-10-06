# Idea: Data Migrations

**Status: picked up** by [design 11](../design/11-data-migrations.md),
proposed for v0.14. This sketch is kept for its history.

## Problem

Fixing thousands of stored FHIR records safely needs a dry run, safe re-runs
and a record of what ran. Without a shared shape, every migration
re-implements batching, idempotency and bookkeeping, and some get it wrong.

## Sketch

- **Numbered TypeScript files and a journal in the repo,** scaffolded by
  `plumb migrate new` and applied by `plumb migrate deploy`, as Prisma splits
  writing a migration (`migrate dev`) from applying it (`migrate deploy`).
- **`defineMigration({ name, resourceType, search, transform })`,** where
  `transform` returns a JSON Patch, or `null` for "already done", so re-runs
  skip finished records.
- **The ledger lives in the Medplum project it describes,** one record per
  migration: name, file sha256, status (`running`, `applied`, `failed`),
  counts, git sha and time. It is a `Basic` resource with a Plumb code:
  bookkeeping about the project, not a fact about any patient. `Provenance`
  targets resources and one migration touches thousands, and a store outside
  Medplum could disagree with the data it describes.
- **The runner fails closed:** it batches, dry-runs unless `--write`, refuses
  to start while a record is `running`, refuses to write when it cannot read
  the ledger, and flags a file whose hash changed after it ran.
- **No transaction around all pending migrations.** Medplum transaction bundles
  do not scale to thousands of resources, so idempotency (`null` means done)
  replaces it.

## Open questions

- The ledger's code system needs a canonical URL, which needs Plumb's
  canonical URL base (not yet chosen).
- Medplum's marketplace manifest also declares migrations; check how they run
  before designing a second runner.

## User stories carried over

1. Scaffold a numbered migration and a journal entry.
2. A migration declares only its resource type, search and transform.
3. A transform that returns `null` means "already done".
4. Dry run by default; refuse to start while a run is in progress; flag a
   migration edited after it ran.

## Ties to other pieces

- The [conformance check](conformance-check.md)'s adopting-late path uses it
  to fix what a transform can fix.
- Profile types could scaffold a migration when a field becomes required.
- A changed routing row (a later release of profile types) needs a migration
  that restamps stored records.
