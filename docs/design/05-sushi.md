# Design 05: SUSHI in `generate`

**Status: proposed** on 2026-10-03, for v0.5. Builds the spec's user story 9:
"As an engineer writing FSH, I want `plumb generate` to run SUSHI for me, so
that one command covers FSH too." Project config as code moves to
[design 06](06-project-config.md) and v0.6.

## Job

A project that writes its profiles in FSH runs two commands, in order, and
must remember both:

```bash
sushi . --snapshot     # FSH → StructureDefinition JSON in fsh-generated/
npx plumb generate     # that JSON → types
```

Forget the first and `generate` types the profiles as they were. Forget
`--snapshot` and the load fails, because Plumb reads snapshots. `generate`
runs SUSHI itself when the config names a SUSHI project:

```ts
export default defineConfig({
  igs: ['hl7.fhir.us.core@9.0.0'],
  profiles: ['https://example.org/fhir/StructureDefinition/my-patient'],
  fsh: '.', // the folder holding sushi-config.yaml
  out: './src/fhir/generated',
});
```

```text
plumb generate
✔ sushi     12 profiles, 3 value sets (2 warnings)   6.8s
✔ packages  1 cached, 0 fetched   4ms
✔ load      4 profiles   1.1s
✔ emit      4 types, 6 slices, 1 code list   5ms
✔ routes    4 rows for 2 types   1ms
✔ write     7 written, 0 removed, 0 unchanged → src/fhir/generated   2ms
Done in 8.0s
```

## How others do it

- **Tools that drive another tool use the project's copy,** so the project
  pins its version: `typescript-eslint` takes the project's `typescript` as a
  peer, `drizzle-kit` resolves the project's own database driver, and Prisma's
  CLI warns when `@prisma/client` differs from its version. None bundles the
  tool it drives.
- **SUSHI's own CLI** is `sushi build [path] --snapshot -o <out>`, exits with
  its error count, and writes to `fsh-generated/` by default. The HL7 IG
  Publisher runs it the same way, as a separate process.
- **Generated output committed and checked:** Plumb already commits its
  generated types and checks them with `generate --check`, as
  openapi-typescript and GraphQL Codegen do. SUSHI's output is generated
  output of the same kind.

## Decisions

### `fsh` names the SUSHI project, and replaces `local`

`fsh` is the folder holding `sushi-config.yaml`. Plumb then reads
`<fsh>/fsh-generated/resources` as it reads `local` today. Setting both `fsh`
and `local` is a config error: one folder of local profiles, one way to make
it.

### The project's own SUSHI, not a dependency

Plumb resolves `fsh-sushi` from the project (`createRequire` at the project
root, then its `bin`) and runs it with Node as a child process. It adds no
dependency: SUSHI and its tree are large, the repository's rule is to earn
every dependency, and a team pins the SUSHI version its FSH was written for.

- **Not installed:** a config error (exit 2) that says
  `npm install --save-dev fsh-sushi`.
- **Older than 3.0:** a config error naming the version found. SUSHI 3 is the
  FSH 3.0 release, and its `build` command and `-o` flag are what Plumb calls.

### SUSHI's step is reported like any other

`generate` runs `sushi build <fsh> --snapshot` and reads its output:

- **Its errors stop `generate`** (exit 1), and the report holds SUSHI's own
  error lines, with their FSH file and line, as Plumb's other steps hold
  theirs. Its warnings are counted on the step's line and listed under it, as
  `generate` lists its other warnings; `--quiet` drops them.
- **SUSHI's full log is not printed,** so the output stays one line per step.
  `--json` carries the errors and warnings as data.
- **It runs first,** before `packages`, so a profile edit is always typed from
  the FSH as it is now.

### SUSHI's output is committed

`fsh-generated/` is committed with the FSH, as Plumb's own test profiles
commit theirs, and for the same reason the types are: a profile change is a
reviewable diff of the JSON the server will hold.

It also keeps the other commands fast and offline. `push`, `validate` and
`validateProfiled` read the committed JSON and never run SUSHI: `push` loads
into Medplum exactly what was reviewed, and a test that calls
`validateProfiled` does not wait seven seconds for a build.

### `generate --check` rebuilds into a temporary folder

`--check` runs SUSHI with `-o` into a temporary folder, never touching the
project, and fails when either the committed `fsh-generated/resources` or the
committed types differ from what the FSH builds. So CI catches FSH edited
without rebuilding, as it catches types not regenerated. It needs SUSHI and
the package cache in CI, which `generate --check` already needs for packages.

### SUSHI fetches its own dependencies

SUSHI downloads `hl7.fhir.r4.core` and the dependencies in
`sushi-config.yaml` into the shared `~/.fhir/packages` cache, the same cache
Plumb uses. Plumb does not fetch them for it in v0.5:

- SUSHI's downloads are not hash-checked or locked in `plumb.lock`, as the
  packages Plumb loads are. The JSON it produces is committed and reviewed,
  which is what reaches the server.
- **A version mismatch is caught at load:** a profile built against US Core
  6.1.0 whose base the config resolves from 9.0.0 differs in what it
  inherits. `load` warns when a local profile's `baseDefinition` names a
  version (`|6.1.0`) other than the one the config selects.

## Commands stay plain functions

`buildFsh(project, { out })` runs SUSHI and returns its counts, errors and
warnings; `generate` calls it before `packages` when the config has `fsh`, and
the CLI only prints.

## Testing

- **Builds and types in one command:** an FSH project in a temporary folder
  (Plumb's own test profiles, copied), `generate` with `fsh` produces the
  same types as today's `local` workflow.
- **An FSH error stops `generate`,** with SUSHI's file and line in the
  report, and writes nothing.
- **Not installed and too old** are config errors, with stub resolution.
- **`--check`** fails after an FSH edit without a rebuild, passes after one,
  and leaves the project's `fsh-generated` untouched.
- **`fsh` and `local` together** is a config error.
- **The version mismatch warning** on a local profile whose base names
  another version.
- **The e2e quickstart** gets an FSH variant: install `fsh-sushi`, write one
  profile in FSH, `generate`, `--check`.

The tests that build need the FHIR registry for SUSHI's own dependencies on a
cold cache; CI's package cache already holds `hl7.fhir.r4.core`, and the
nightly registry run covers the cold path.

## Proposed issues (v0.5 milestone)

1. **Config:** `fsh` in `plumb.config.ts`, exclusive with `local`, with named
   errors.
2. **`buildFsh` and the `sushi` step:** resolve the project's SUSHI, run it,
   report its errors and warnings.
3. **`generate --check`** rebuilds into a temporary folder and compares
   `fsh-generated` as well as the types.
4. **The base-version warning** at load.
5. **Docs:** the README's FSH section and the e2e FSH variant; design 05
   becomes implemented.

## Later (not in this design)

- **Plumb fetching SUSHI's dependencies** through its own verified, locked
  fetch, so a build never downloads unchecked packages.
- **A watch mode** that rebuilds on an FSH save.
- **Instances:** SUSHI also builds example instances, which could become test
  fixtures for `validateProfiled`.

## Open questions

- **SUSHI's `sushi-config.yaml` dependencies and Plumb's `igs`** say the same
  thing twice. Deriving one from the other needs a YAML parser, or the
  ImplementationGuide SUSHI writes, which `FSHOnly` projects do not have.
