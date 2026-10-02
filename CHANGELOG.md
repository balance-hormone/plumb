# Changelog

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
