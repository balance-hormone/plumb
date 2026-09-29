# Plumb

Make [Medplum](https://www.medplum.com)'s own types profile-aware.

Plumb reads a Medplum project's FHIR profiles (US Core, IPS, or the project's
own) and generates TypeScript types that narrow `@medplum/fhirtypes` to what
each profile requires. A missing required field becomes a compile error instead
of a 400 from the server, and the types still work with every Medplum SDK call
and React component.

```ts
const p: USCorePatient = { resourceType: 'Patient', name: [{ family: 'Doe' }] };
//    ^ compile error: 'identifier' and 'gender' are required
```

A plumb line is the weighted string a builder hangs to find true vertical. A
project is *plumb* when its data is true to its profiles.

> **Status: pre-release, private.** Nothing is implemented or published yet. The
> design is in [`docs/spec.md`](docs/spec.md).

## Package

[`plumb`](packages/plumb) is a single dev dependency: the `plumb` CLI (`pull`,
`generate`, `generate --check`) and `validateProfiled` for tests. The code it
generates is committed to your repository and carries its own helpers, so your
app takes no runtime dependency on Plumb.

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
