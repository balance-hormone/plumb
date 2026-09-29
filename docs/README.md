# Plumb docs

## Where things stand

- The spec is drafted. Nothing is implemented; the four packages are empty
  shells that build, lint and pass CI, using Medplum's own repository tooling.
- **Next: feature #1, the profile compiler and type generator.** Its design is
  in [`design/01-generator.md`](design/01-generator.md), with **four open
  decisions** (narrowing depth, slice representation, binding expansion, output
  location) waiting on the maintainer. Settle those, then turn the design into
  GitHub issues and build.
- After #1, the order is: `validateProfiled`, then the CLI and config (`pull`,
  `generate`, `check`, `push`), then routing, typed reads, migrations, project
  state as code, `plumb-zod` and `plumb-operations`.
- Work is tracked in GitHub Issues on this repository. None exist yet.

## Contents


- [`spec.md`](spec.md): what Plumb is, its goals, packages and design decisions.
- [`design/`](design/): one design note per feature, written before it is built.
  - [01: profile compiler and type generator](design/01-generator.md)
- [`research/`](research/): the evidence behind the spec.
  - [Medplum server behaviour](research/medplum-server-behaviour.md): validation,
    `defaultProfile`, strict mode, project fields, AccessPolicy and admin, bots,
    custom operations, read from Medplum's server source.
  - [US Core 9.0.0 routing](research/us-core-9-routing.md): which profiles pin
    a routing key, which key on a value set, and the required elements that
    most often fail real data.
  - [Prior art](research/prior-art.md): what Plumb borrows from Drizzle,
    Prisma, tRPC, T3, Terraform and Medplum, and what it set aside.
  - [Prototype](research/prototype.md): the FSH → types → validator proof of
    concept and the gaps it found.
