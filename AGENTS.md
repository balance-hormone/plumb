# Plumb: Agent Guide

Plumb makes Medplum's own types profile-aware, for **any** Medplum project. It
is one dev-only package; other tools are parked in [`docs/future/`](docs/future/).
Read [`docs/README.md`](docs/README.md) first: it says where the project stands and what is next. Read [`docs/spec.md`](docs/spec.md) before changing behaviour, and the feature's note in [`docs/design/`](docs/design/) before building it.

## Rules

- **Agnostic, always.** No organization's profiles, data model, identifiers or
  migrations appear in this repository: not in code, tests, fixtures, docs or
  examples. Test profiles come from published implementation guides (US Core,
  IPS) or Plumb's own synthetic test profiles.
- **Synthetic data only.** Never commit real patient data or anything that
  looks like it.
- **Built on Medplum, not around it.** Use `@medplum/core`'s validator and
  `@medplum/fhirtypes`; never generate a parallel base R4 tree or a second
  validator.
- **Every server claim is tested against a real Medplum server.** The mock
  client enforces neither profiles, defaults, strict mode nor access policies.
- **Match Medplum at the boundary, stay lean inside.** What a consumer installs
  and what could move upstream matches Medplum: dual ESM/CJS output with
  per-format types, Medplum's published Node range, `@medplum/*` as peers,
  Vitest, Apache-2.0 with SPDX headers, and source that compiles under
  `strict` and `erasableSyntaxOnly`. Build tooling, lint and formatting are
  ours to keep simple. See Principles in [`docs/spec.md`](docs/spec.md).
- **Earn every dependency.** Generated code carries its own helpers, so apps
  take no runtime dependency on Plumb. Prefer a Node built-in, and justify any
  new dependency in its PR.
- **Commands are plain functions** that take their inputs and return a report;
  the CLI only prints and sets the exit code.
- `import type` for type-only imports. No `as any`. Comments explain why, not
  what.

## Keeping the code small

- Search for an existing helper before writing one. Change existing code before
  adding new code.
- No new files, packages, dependencies, abstractions or config options unless
  the issue calls for them.
- No speculative error handling, fallbacks or "just in case" branches: handle
  the failures the spec names.
- Delete the code you replace. The smallest correct diff wins.
- Bug fixes and new logic start with a failing test, then the implementation.
- For a non-trivial change, list the files you will touch and why before coding.

## Work tracking

Tasks live in **GitHub Issues** on this repository, grouped on the project board
and by milestone. Reference the issue in the PR body (`Closes #N`). Use
conventional commits for commit and PR titles (`feat(plumb): …`).

## Commands

```bash
npm run build       # esbuild + tsc declarations
npm run typecheck
npm test            # vitest
npm run lint        # biome check, plus the SPDX header check
npm run lint:fix    # biome check --write
npm run knip        # unused files, exports and dependencies
npm run check       # everything CI runs except build
```
