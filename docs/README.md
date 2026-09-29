# Plumb docs

## Where things stand

- Plumb is scoped to one deliverable: **profile-aware types for Medplum**. The
  spec is drafted and nothing is implemented; the one package is an empty shell
  that builds, lints and passes CI.
- **Next: v0.1**, the profile type generator: `plumb pull`, `plumb generate`,
  `plumb generate --check` and `validateProfiled`, all offline. Its design is
  in [`design/01-generator.md`](design/01-generator.md), with **four open
  decisions** (narrowing depth, slice representation, binding expansion, output
  location) waiting on the maintainer.
- **Before building:** open a Medplum issue proposing profile types upstream
  (see Upstream in the spec), settle the four decisions, then turn the design
  into GitHub issues.
- Later releases of the same tool: SUSHI integration, routing and `create`,
  typed reads, Zod schemas, agent summaries.
- Other tools are parked as idea notes in [`future/`](future/).
- Work is tracked in GitHub Issues on this repository. None exist yet.

## Contents

- [`spec.md`](spec.md): what Plumb is, its goals, principles and design
  decisions.
- [`design/`](design/): one design note per feature, written before it is built.
  - [01: profile compiler and type generator](design/01-generator.md)
- [`future/`](future/): parked ideas, each with its design sketch and research.
  - [Conformance check](future/conformance-check.md): how many stored records a
    profile would fail, the load gate, the baseline, adopting late.
  - [Project config as code](future/project-config-as-code.md): `push`,
    converged settings, the lockdown recipe.
  - [Data migrations](future/data-migrations.md): `defineMigration` and a ledger
    in the project.
  - [Operation contracts](future/operation-contracts.md): typed callers and
    handlers for bot-backed operations.
- [`research/`](research/): the evidence behind the spec and the ideas.
  - [Medplum server behaviour](research/medplum-server-behaviour.md): validation,
    `defaultProfile`, strict mode, project fields, AccessPolicy and admin, bots,
    custom operations, the generator, the marketplace, read from Medplum's
    source.
  - [US Core 9.0.0 routing](research/us-core-9-routing.md): which profiles pin
    a routing key, which key on a value set, and the required elements that
    most often fail real data.
  - [Prior art](research/prior-art.md): existing profile type generators and
    why none fits Medplum, plus what Plumb borrows from Drizzle, Prisma and
    others.
  - [Prototype](research/prototype.md): the FSH → types → validator proof of
    concept and the gaps it found.
