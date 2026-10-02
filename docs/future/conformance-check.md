# Idea: Conformance Check

**Status: stages 1 and 2 built in v0.2,** by
[design 02](../design/02-conformance-check.md). This note keeps the design
sketch and research for the stages still parked.

## Problem

Medplum validates on write and never re-checks stored data. Loading a stricter
profile version silently arms a failure in the next write of every stored
record that does not meet it, and nothing says how many there are. Some
failures are silent altogether: an unknown profile URL, a `url|version` stamp
and an empty `meta.profile: []` all validate against nothing. A team with live,
loose data cannot see the size of the problem before it acts.

## In SQL terms

Profiles are to a Medplum project what the schema is to a Postgres database,
and Plumb's pieces line up with a TypeScript stack's (Prisma or Drizzle on
Postgres):

| Postgres, with Prisma or Drizzle | Medplum, with Plumb |
|---|---|
| The schema: what a row must look like | FHIR profiles: what a resource must look like |
| `prisma generate`: a typed client | `plumb generate`: typed resources |
| Zod at the edge; Postgres checking each insert | `validateProfiled`; Medplum validating each write |
| A migration that tightens the schema (`ALTER TABLE … SET NOT NULL`) | Loading a stricter profile, or turning strict mode on |
| **Postgres checks existing rows and refuses the migration** if any break it | **Nothing checks stored resources.** Each non-conforming one fails its next write |
| Drizzle's or Prisma's warning: "this table has 42 rows" | `plumb validate`: how many stored resources would fail, and why |
| A backfill before the migration | A data migration ([data migrations](data-migrations.md)) |
| `ADD CONSTRAINT … NOT VALID`, then `VALIDATE CONSTRAINT` | Load the profile, then re-check at once for writes in between |

The goal is the SQL workflow: **check, backfill, then tighten**, where
tightening is refused while stored data would fail it. One difference shapes
the design. Postgres owns its gate: the database itself refuses the
`ALTER TABLE`. Medplum has no gate: any project admin can load a
StructureDefinition or turn strict mode on from the console or the API. So
Plumb's gate holds only if:

1. **tightening goes through Plumb,** a command that runs `validate` first and
   refuses while it fails;
2. **the bypass is closed,** with an AccessPolicy that lets only Plumb's
   deploying identity write StructureDefinitions and project settings (the
   lockdown recipe in [Medplum server behaviour](../research/medplum-server-behaviour.md));
3. **the race is covered,** by re-checking straight after loading.

A hard gate can stall a team whose production already holds thousands of old
failures, so **the baseline** lets it tighten now: the gate accepts the known
failures it lists, refuses any new one, and the list may shrink but never grow,
as a lint baseline does.

The staged path:

| Stage | What it gives |
|---|---|
| 1. `validate` | A report, safe against production at any time |
| 2. The gate | Loading a profile or turning strict mode on is refused while `validate` fails, or fails beyond the baseline, and re-checked afterwards |
| 3. Lockdown | Only Plumb changes profiles and strict mode, so the gate cannot be bypassed |
| 4. Baseline | Adopt the gate before every old record is fixed, without accepting new failures |

**Open when picked up:** whether the gate is a small command of this tool (a
gated `load` of profiles and strict mode) or part of [project config as
code](project-config-as-code.md) (`push`), and where validation runs (below).

**The command is `plumb validate`.** Postgres's `VALIDATE CONSTRAINT` is the
same job, checking the rows already stored, and it pairs with
`validateProfiled` (one resource against everything stored). It is not
`check`: `generate --check` already means "the generated types are current",
and `drizzle-kit check` checks migration files.

## Sketch

- **`validate --env <env>`** reads the live project and writes nothing. Per
  profile it reports how many stored resources would fail and why, as counts
  and reasons. Resource ids go only to a local, gitignored file.
- **Silent stamps:** an unloaded profile URL, a `url|version` stamp, an empty
  `meta.profile`.
- **Profile shadowing:** more than one StructureDefinition for a canonical URL
  in the project, or one in a linked project. Medplum resolves a bare URL by
  sorting `version` as text, so `1.9.0` beats `1.10.0`.
- **Strict mode detection** through `GET /auth/me`, which returns
  `project.strictMode` to any member.
- **The load gate:** never load a profile version while stored resources fail
  it, and re-check straight after loading (Postgres's `ADD CONSTRAINT … NOT
  VALID`, then `VALIDATE CONSTRAINT`). It needs a writer, so it ties to
  [project config as code](project-config-as-code.md).
- **A baseline** (`plumb.baseline.json`, committed) of known failures that may
  shrink but never grow, the lint-baseline ratchet, so a team can load
  profiles before every old record is fixed without accepting new failures.
- **Adopting late,** documented as safe steps: check production, migrate what a
  transform can fix ([data migrations](data-migrations.md)), record the
  baseline, load the profiles, turn strict mode on.

## Where validation runs

The first sketch validated offline, on the machine running `validate`. That pulls
every stored resource, which is patient data, onto a laptop or CI runner. A
bot running inside the project could validate there and return only counts and
reasons, so patient data never leaves Medplum. It could ship as a Medplum
marketplace package. This is the first question to settle if the idea is
picked up.

## Testing

This tool makes claims about the server, so it brings back the real-server
tests Plumb's first deliverable does not need: Medplum in Docker, fixtures
checked against `POST /:type/$validate` (which always validates strictly), and
a version matrix across supported Medplum releases.

## User stories carried over

1. Report, per profile and environment, how many stored resources would fail
   and why.
2. Refuse to load a profile version while stored resources would fail it.
3. Re-check straight after a load, to catch writes in between.
4. Fail on stamps that validate nothing.
5. Report whether strict mode is on in each environment.
6. Run against production with no changes to it.
7. A committed baseline that may shrink but never grow.
8. A documented path from "no profiles" to "strict".

## Ties to other pieces

- Reuses the profile loading and Medplum's parsed profiles from Plumb's first
  deliverable.
- The load gate needs a writer: [project config as code](project-config-as-code.md).
- Adopting late needs [data migrations](data-migrations.md).

## Research

- [Medplum server behaviour](../research/medplum-server-behaviour.md): strict
  mode, `defaultProfile`, profile lookup and cache, `$validate`, the
  marketplace.
