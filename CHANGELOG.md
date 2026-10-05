# Changelog

## Unreleased

- **`validate` counts records on each type's line**, not profile checks: a
  record stamped with a profile and its parent was counted twice, so a type
  could read `334 of 334 read, all 340 passed`. It now reads `all 331
  stamped passed`, and each profile's line still counts its checks (#121).
  The checker reports the new counts, so `push` redeploys it.

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
