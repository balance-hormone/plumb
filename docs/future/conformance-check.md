# Idea: Conformance Check

**Status: parked.** An idea for a later tool, not a commitment. Plumb's first
deliverable is profile types ([`../spec.md`](../spec.md)). This note keeps the
design sketch and research so the idea can be picked up without starting over.

## Problem

Medplum validates on write and never re-checks stored data. Loading a stricter
profile version silently arms a failure in the next write of every stored
record that does not meet it, and nothing says how many there are. Some
failures are silent altogether: an unknown profile URL, a `url|version` stamp
and an empty `meta.profile: []` all validate against nothing. A team with live,
loose data cannot see the size of the problem before it acts.

## Sketch

- **`check --env <env>`** reads the live project and writes nothing. Per
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

The first sketch validated offline, on the machine running `check`. That pulls
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
