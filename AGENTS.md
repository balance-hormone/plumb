# Plumb: Agent Guide

Plumb is a standalone, open-source-bound toolkit for **any** Medplum project.
Read [`docs/spec.md`](docs/spec.md) before changing behaviour.

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
- **Match Medplum's conventions** (npm workspaces, Turborepo, esbuild dual
  ESM/CJS output, Vitest, Apache-2.0), so Plumb can be adopted upstream.
- **Commands are plain functions** that take a client and return a report; the
  CLI only prints and sets the exit code.
- `import type` for type-only imports. No `as any`. Comments explain why, not
  what.

## Work tracking

Tasks live in **GitHub Issues** on this repository, grouped on the project board
and by milestone. Reference the issue in the PR body (`Closes #N`). Use
conventional commits for commit and PR titles (`feat(plumb-kit): …`).

## Commands

```bash
npm run build       # turbo: every package
npm run typecheck
npm test
npm run lint        # biome check
npm run lint:fix
```
