# Plumb docs

- [`spec.md`](spec.md): what Plumb is, its goals, packages and design decisions.
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
