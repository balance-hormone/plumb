# Changelog

## 0.5.0 (unreleased)

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

## 0.4.0 (unreleased)

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

## 0.3.0 (unreleased)

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

## 0.2.0 (unreleased)

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

## 0.1.0 (unreleased)

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
