# Design 07: `plumb check`, raw access found by type

**Status: implemented** in v0.8 (accepted on 2026-10-05). Builds on [design 03](03-routing-and-create.md)'s
writes and [design 04](04-typed-reads.md)'s reads: it finds the code that goes
around them.

## Job

`createProfiled`, `stampProfiled`, `readProfiled` and `searchProfiled` only
help where they are called. A project that adopts them has hundreds of call
sites written before, and every new one is a chance to write
`medplum.readResource('Patient', id)` again. Review does not hold that line,
and a text search cannot: a write whose resource type is inferred from a
variable has no `'Patient'` in it to find. The first adopter's regex guard for
Patient creates reported success for a year while the intake path created
charts it could not see, for exactly that reason.

`plumb check` reads the project the way the compiler does, and reports every
`MedplumClient` read or write of a type a selected profile constrains that does
not go through Plumb:

```text
plumb check
✖ check     3 new, 161 in the baseline, in 2614 files   6.2s
    src/lib/goals/goal.ts:41:10  readResource Goal  → readProfiled
    src/hooks/patients/use-chart.ts:18:22  searchResources Patient  → searchProfiled
    src/lib/coverage/save.ts:90:5  createResource Coverage  → createProfiled, updateProfiled or stampProfiled
Failed in 6.2s
```

## What it reports

A call to one of these methods on a value whose type is `MedplumClient`, or a
class deriving from it (`MockClient`), for a type every resource of which a
selected profile holds: one with a profile that routes on no keys, or a
`defaultProfile`. A profile keyed on content (one code of Observation) holds
only some resources of its type, so raw access to the type is not wrong. The
first adopter's run showed why: selecting one Observation profile would
otherwise have reported every vital sign.

| Method | Resource type taken from | Use instead |
|---|---|---|
| `readResource`, `searchResources`, `searchOne`, `searchResourcePages` | the first argument's literal type | `readProfiled`, `searchProfiled` |
| `createResource`, `updateResource`, `upsertResource`, `createResourceIfNoneExist` | the first argument's `resourceType` property type | `createProfiled`, `updateProfiled`, or `stampProfiled` |

Types come from the checker, so `createResource(buildGoal(values))` is a Goal
write even though no `'Goal'` appears. A union (`'Patient' | 'Practitioner'`)
is reported when any member is profiled; `string` and `ResourceType` are not
(nothing is known), and a type no selected profile constrains is not.

**A stamped write is not reported.** `stampProfiled` returns its resource
typed `T & Stamped`, where `Stamped` is an optional property keyed by a unique
symbol declared in `_routes.ts`. It changes nothing a caller can see or assign,
and it survives a variable: `const s = stampProfiled(c); medplum.upsertResource(s)`
is a stamped write. `check` looks for that property on the argument's type.

**Out of scope for now:** `readReference` (its type is a `Reference<T>`
generic), `executeBatch` entries, `patchResource` (a patch keeps the stamp it
finds), and `readHistory` (design 04: history is not offered typed).

## Not every finding is a bug

Some raw access is deliberate: a migration that writes unstamped records the
profile would refuse, a sweep that reads records precisely because they are
unstamped. A comment on the line before says so, with a reason:

```ts
// plumb-check: the backfill reads unstamped records to stamp them
const all = await medplum.searchResources('Goal', query);
```

A suppression without a reason is itself reported.

## The baseline

A project adopting `check` starts with a backlog it cannot clear in one
change. The baseline is a committed JSON file listing, per file, method and
resource type, how many findings there are. `check` fails only when a count
grows or a new key appears, so new raw access is refused from the first day
and the backlog shrinks file by file. Line numbers are left out, so an edit
that moves a call does not churn the file.

```bash
npx plumb check --update-baseline   # after a migration removes findings
```

`--update-baseline` rewrites the file from what it finds. It refuses to grow a
count unless `--allow-growth` is given, so the ratchet only turns one way in
review.

## Config

```ts
export default defineConfig({
  // …
  check: {
    tsconfig: ['apps/web/tsconfig.json', 'packages/jobs/tsconfig.json'],
    baseline: './plumb-check-baseline.json',
    ignore: ['**/*.test.ts', '**/*.stories.tsx'],
  },
});
```

`tsconfig` is one or more projects, each compiled once; a file in two is
checked once. The generated folder (`out`) is never checked. Paths in the
output and the baseline, and `ignore` globs (Node's `path.matchesGlob`), are
relative to the deepest folder holding the config and every tsconfig: a
monorepo keeps its config in one package and checks code in others, and the
baseline's keys must not depend on where the command runs.

## TypeScript

`check` uses the project's own `typescript`, resolved from the config's folder,
so it reads types as the project's compiler does. It needs the compiler API,
which TypeScript 5.x and 6.x provide and TypeScript 7's native package does
not; on 7 it stops with exit 2 and says so. When TypeScript 7 ships a stable
programmatic API, `check` moves to it.

Plumb's own tests compile fixture projects with a dev-only TypeScript 5.9
alias, since Plumb itself builds with 7.

## Output and exit codes

As `generate`: a line per step, findings under the `check` step as
`file:line:col  method Type  → replacement`, `--json` for the full report.
Exit 0 when nothing is new, 1 when something is, 2 for usage and config
errors and a TypeScript without the API.

## Testing

- A fixture project in `test/fixtures/check/` with `@medplum/core` types:
  reads and writes by literal, by inferred builder type, by union, by
  `ResourceType`; a `MockClient` receiver; a stamped write through a variable;
  suppressions with and without a reason; a file under `out`.
- The baseline: a new key fails, a grown count fails, a shrunk count passes
  and is reported, `--update-baseline` refuses growth without the flag.
- The CLI: the step lines, `--json`, and exit 2 on TypeScript 7.

## Proposed issues (v0.8 milestone)

1. `Stamped` brand on `stampProfiled`'s return type, in the generated code.
2. `check` config and the analyzer, as a plain `checkProject` function.
3. The baseline and `--update-baseline`.
4. The CLI command, README section and changelog.
