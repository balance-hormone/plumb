# Plumb

Profile-driven type safety, validation and project state as code for
[Medplum](https://www.medplum.com).

A plumb line is the weighted string a builder hangs to find true vertical. A
Medplum project is *plumb* when every stored record is true to its FHIR profile.

Plumb makes a project's profiles the single source of truth for the shape of its
data. A profile is declared once and becomes the StructureDefinition the server
enforces, the TypeScript types the editor enforces, and the schemas tests and
forms enforce. Plumb then keeps the server honest to what the repo declares, and
lets a project tighten its rules without breaking the records it already holds.

> **Status: pre-release, private.** Nothing here is published yet. The design is
> in [`docs/spec.md`](docs/spec.md).

## Packages

| Package | Runs in | What it is |
|---|---|---|
| [`plumb`](packages/plumb) | apps, bots, scripts | Profile-typed resources, routing, `create`, typed reads |
| [`plumb-kit`](packages/plumb-kit) | dev and CI | The `plumb` CLI: `pull`, `generate`, `check`, `push`, `migrate` |
| [`plumb-zod`](packages/plumb-zod) | apps, input edges | Zod schemas generated from profiles, for forms |
| [`plumb-operations`](packages/plumb-operations) | apps, bots | Typed contracts for bot-backed FHIR operations |

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
npm run lint
```

Requires Node `^22.18.0 || >=24.2.0`, the same range as Medplum, and npm 11.

## License

[Apache-2.0](LICENSE.txt). See [`NOTICE`](NOTICE).
