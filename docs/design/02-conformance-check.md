# Design 02: Conformance Check

**Status: proposed.** Picks up the parked [conformance check](../future/conformance-check.md)
idea. Read that note's "In SQL terms" section first: this design builds its
stages 1 and 2.

## Job

Medplum validates on write and never re-checks stored data, so tightening a
profile or turning strict mode on silently arms a failure in the next write of
every stored record that does not meet it. Plumb gives Medplum what Postgres
gives a schema: **check, backfill, then tighten**, and tightening refused while
stored data would fail.

Two commands:

- **`plumb validate --env <env>`** reports, per profile, how many stored
  resources would fail and why. It changes no clinical or configuration data
  (the server records each bot run as an `AsyncJob`, as it does for any async
  operation).
- **`plumb push --env <env>`** loads profiles into the project, refusing while
  `validate` finds failures, then re-checks. It is the first slice of the
  `push` that [project config as code](../future/project-config-as-code.md)
  later extends.

## How the tools this follows do it

Drizzle's `drizzle-kit push` runs `select count(*) from <table>` before adding
a required column and warns "which contains N items" (`pgPushUtils.ts`).
Prisma's schema engine counts rows and stops with "There are N rows in this
table, it is not possible to execute this step" (`unexecutable_step_check.rs`).
Postgres scans the table inside `ALTER TABLE … ADD CONSTRAINT`, or in
`VALIDATE CONSTRAINT` after `NOT VALID`. In each, the question goes to where
the data lives and only the answer comes back, and the check is part of the
command that changes the schema. Plumb follows both points.

## Where validation runs: inside the project, as a bot

Medplum cannot run "validate these stored resources" as a query, but it runs
code server-side. So the check is a bot:

```text
plumb validate --env prod
  │  POST Bot/$execute  (Prefer: respond-async)
  │    input: the profiles to check against, resource type, cursor
  ▼
Plumb's checker bot (inside the project)
  │  reads one page of resources, validates each with @medplum/core
  │  returns counts, failure reasons, failing ids, next cursor
  ▼
AsyncJob → plumb polls, then starts the next page until the cursor ends
```

- **Patient data never leaves Medplum.** The bot returns counts, grouped
  failure reasons (element path and message) and the ids of failing records.
- **The profiles are input, not what the project has loaded,** so `validate`
  answers "what would fail if we loaded this?", the question to ask before
  tightening, and `push` can ask it about the versions it is about to load.
- **It validates with `@medplum/core`**, the validator the server and
  `validateProfiled` use, at the version bundled into the bot. `push` rebuilds
  the bot with the project's installed `@medplum/core`; the docs advise keeping
  it in step with the server, as they already do for `validateProfiled`.
- **Chunked and resumable.** A bot run has a time limit (the Bot `timeout`;
  Lambda's ceiling is 15 minutes), so each run checks one page and returns a
  cursor. The CLI drives the pages and can resume from the last cursor after an
  interruption.
- **One path for every environment.** Prisma and Drizzle behave the same in
  development and production; so does Plumb. There is no local mode that pulls
  resources onto the machine running the command.
- **Reading is the bot's only power.** Its ProjectMembership gets an
  AccessPolicy that reads the checked types and writes nothing.
- **`validate` never installs the bot.** If the checker is missing or older
  than the CLI, `validate` stops with exit 2 and says to run `plumb push`, so
  `validate` stays read-only.

## What `validate` checks

For each resource type a selected profile constrains, every stored resource of
that type, page by page:

1. **Against the profiles it is stamped with:** a resource whose `meta.profile`
   names a selected profile is validated against the version in
   `plumb.config.ts`, which is what the server will enforce once that version
   is loaded.
2. **Silent stamps**, which today validate against nothing: an unknown profile
   URL, a `url|version` stamp (Medplum matches bare URLs only), and an empty
   `meta.profile: []` (which also skips `defaultProfile`).
3. **Unstamped resources** are counted, not validated: which profile they
   should carry is routing's job ([design 03](03-routing-and-create.md),
   planned).

And, from the CLI, which reads no clinical data:

4. **Profile shadowing:** more than one StructureDefinition for a selected URL
   in the project or a linked project. Medplum picks "newest" by sorting
   `version` as text, so `1.9.0` beats `1.10.0`.
5. **Strict mode**, read from `GET /auth/me`, which returns
   `project.strictMode` to any member.

## The report

```text
plumb validate --env prod
✔ connect   https://api.example.com (strict mode off)   180ms
✔ checker   plumb-checker 0.2.0 installed   40ms
✖ validate  2 of 3 profiles would fail   4m 12s
    us-core-patient          12,400 checked, 300 fail
      Patient.identifier: minimum required = 1, but only found 0   (300)
    us-core-blood-pressure   50,112 checked, 1,204 fail
      Observation.component:diastolic: minimum required = 1   (1,204)
    us-core-condition-...    8,003 checked, 0 fail
    silent stamps            40 (unknown profile URL), 3 (url|version)
    unstamped Observations   2,310
Failing ids: .plumb/validate-prod.json (gitignored)
Failed in 4m 13s
```

- **It follows `generate`'s output rules** (spec, Output): a line per step,
  progress on stderr, `--json` for the full report on stdout, `--quiet`.
- **Exit codes as `generate`:** 0 when nothing fails, 1 when something would
  fail, 2 for usage, config or connection errors.
- **Failing ids go to a local, gitignored file,** never to the terminal or CI
  logs. Ids are not clinical data, but they are specific records; the
  terminal shows counts.
- **Three kinds of empty are told apart:** "all N passed", "N read and none
  carries a profile", and "nothing was readable". An over-strict AccessPolicy
  gives the same empty result as a healthy empty project, so the report says
  how many resources the bot could read against how many exist.

## `push`: the first slice

```text
plumb push --env prod
✔ checker   plumb-checker 0.2.0 → 0.3.0 updated   2.1s
✔ plan      load us-core-patient 9.0.0, us-core-blood-pressure 9.0.0 (+14 dependencies)
✖ validate  1,204 stored resources would fail us-core-blood-pressure 9.0.0
Refusing to load: fix or migrate them first, or see `plumb validate --env prod`.
```

1. **Install or update the checker bot** (a Bot with a Plumb identifier,
   deployed with `$deploy`). This is not a tightening change, so it is not
   gated. It needs a membership that can write Bot and AccessPolicy.
2. **Plan:** the StructureDefinitions of the selected profiles and their
   dependency closure, from the loader, compared with what the project holds.
   Unchanged profiles are skipped; a profile edited without a version bump is
   flagged, because comparing versions would otherwise miss it.
3. **The gate:** run `validate` against the planned versions. Any failure
   refuses the push, and nothing is written.
4. **Apply:** create or update the StructureDefinitions.
5. **Re-check at once,** against the now-loaded versions, to catch writes
   between steps 3 and 4 (the `VALIDATE CONSTRAINT` step). A failure here is
   reported as the push's result; the profiles stay loaded, as Postgres keeps a
   `NOT VALID` constraint.

`--dry-run` stops after step 3.

**Strict mode is reported, not set.** Only a super admin can change
`strictMode`: a project admin's write succeeds and changes nothing
([research](../research/medplum-server-behaviour.md#project-fields-and-who-can-write-them)).
So `push` never claims to turn it on. `validate` reports whether the project is
ready for it (every stored resource passes base R4 and its stamps), and turning
it on is done by a super admin: Medplum's team on hosted Medplum, or the
operator of a self-hosted server.

## Config and credentials

```ts
export default defineConfig({
  // …igs, profiles, out as today
  environments: {
    prod: {
      baseUrl: 'https://api.medplum.com/',
      clientId: { env: 'MEDPLUM_PROD_CLIENT_ID' },
      clientSecret: { env: 'MEDPLUM_PROD_CLIENT_SECRET' },
    },
  },
});
```

- **Secrets never live in the config,** which is committed: it names the
  environment variables that hold them.
- Client credentials, as CI uses, from a ClientApplication whose membership can
  install the bot and load profiles (the CI client in the lockdown recipe).

## Testing

This is Plumb's first tool that makes claims about the server, so it brings
the real-server tests the spec deferred:

- **Medplum in Docker** (server, Postgres, Redis) in CI, with a test project,
  a CI client and seeded synthetic resources.
- **Verdicts cross-checked** against the server's own `POST /:type/$validate`,
  which always validates strictly.
- **Each server claim here has a test:** the checker runs as an async job and
  pages; the bot's membership can read but not write; `push` refuses and
  writes nothing; the re-check catches a write made between gate and apply; a
  project admin cannot set `strictMode`; the three kinds of empty report.
- **A version matrix** across the supported Medplum releases.

## Later stages (not in this design)

- **The baseline** (`plumb.baseline.json`): known failures the gate accepts,
  which may shrink but never grow.
- **Lockdown:** the AccessPolicy recipe that stops anyone but Plumb's CI
  identity writing StructureDefinitions, so the gate cannot be bypassed.
- **`defaultProfile`**, and the rest of project config, through `push`.
- **Marketplace packaging** of the checker bot, once Medplum's marketplace
  lands.

## Open questions

- **Bot runtime:** `awslambda` on hosted Medplum and `vmcontext` on many
  self-hosted servers have different limits; the page size may need to adapt
  to the Bot `timeout`.
- **How the checker gets its own AccessPolicy:** created by `push` in step 1,
  or documented for an admin to create once.
- **Reason grouping:** Medplum's issue messages include array indexes
  (`component[2]`), which must be normalized to group well.
- **Large projects:** whether to run pages in parallel, and how the server's
  rate limits cap it.
