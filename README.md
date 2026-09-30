# Plumb

Make [Medplum](https://www.medplum.com)'s own types profile-aware.

Plumb reads a Medplum project's FHIR profiles (US Core, IPS, or the project's
own) and generates TypeScript types that narrow `@medplum/fhirtypes` to what
each profile requires. A missing required field becomes a compile error instead
of a 400 from the server, and the types still work with every Medplum SDK call
and React component.

```ts
const p: USCorePatient = { resourceType: 'Patient', name: [{ family: 'Doe' }] };
//    ^ compile error: property 'identifier' is missing
```

A plumb line is the weighted string a builder hangs to find true vertical. A
project is *plumb* when its data is true to its profiles.

> **Status: pre-release.** Plumb works end to end but is not published yet, and
> its npm name is still to be chosen (`plumb` is taken). To try it, build it and
> install the tarball, as in the quickstart below.

## Quickstart

**1. Install** Plumb as a dev dependency, next to the Medplum packages it
narrows (5.1.0 or later):

```bash
npm install --save-dev ./plumb-0.0.0.tgz   # from `npm pack` in this repository
npm install @medplum/core @medplum/definitions @medplum/fhirtypes
```

**2. Configure** `plumb.config.ts` in the project root:

```ts
import { defineConfig } from 'plumb';

export default defineConfig({
  igs: ['hl7.fhir.us.core@9.0.0'],
  profiles: [
    'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient',
    'http://hl7.org/fhir/us/core/StructureDefinition/us-core-blood-pressure',
    // or every profile in an IG: 'hl7.fhir.us.core/*'
  ],
  out: './src/fhir/generated',
});
```

- `igs` are FHIR packages by exact version, fetched from the FHIR package
  registry (`packages.fhir.org`), never npm, into the shared cache
  `~/.fhir/packages`.
- `profiles` are canonical URLs, or `name/*` for every resource profile in an
  IG `igs` lists.
- `local` (optional) is a folder of your own StructureDefinition JSON.
- `out` is the folder Plumb generates into. Plumb owns it: it removes files for
  profiles you no longer list, and refuses to touch a folder holding files it
  did not write.

The config is loaded by Node itself, which strips the types, so TypeScript-only
syntax such as `enum`, relative imports without `.ts`, and `tsconfig` path
aliases are not available in it.

**3. Generate:**

```bash
npx plumb generate
```

```text
plumb generate
✔ packages  0 cached, 7 fetched   10.2s
✔ load      2 profiles   1.2s
✔ emit      2 types, 16 slices, 0 code lists   4ms
✔ write     4 written, 0 removed, 0 unchanged → src/fhir/generated   1ms
Done in 11.4s
```

The first run fetches each IG and the dependencies it declares; after that,
`generate` is offline. Commit `plumb.lock`, which pins each package's version
and hash, and the generated folder: generated code is reviewed like any other.

**4. Use the types.** Each profile gets a type, a `…ProfileUrl` constant, and,
for its slices, builders and readers:

```ts
import { createReference } from '@medplum/core';
import {
  USCoreBloodPressure,
  USCoreBloodPressureProfileUrl,
  type USCorePatient,
} from './fhir/generated/index.js';

const patient: USCorePatient = {
  resourceType: 'Patient',
  identifier: [{ system: 'http://example.org/mrn', value: '12345' }],
  name: [{ family: 'Doe', given: ['Pat'] }],
};

const mmHg = (value: number) =>
  ({ value, unit: 'mm[Hg]', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' }) as const;

const bp: USCoreBloodPressure = {
  resourceType: 'Observation',
  meta: { profile: [USCoreBloodPressureProfileUrl] },
  status: 'final',
  category: [USCoreBloodPressure.vsCat({})],
  code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }] },
  subject: createReference(patient),
  effectiveDateTime: '2026-01-01T09:00:00Z',
  component: [
    USCoreBloodPressure.systolic({ valueQuantity: mmHg(120) }),
    USCoreBloodPressure.diastolic({ valueQuantity: mmHg(80) }),
  ],
};

USCoreBloodPressure.getSystolic(bp)?.valueQuantity?.value; // 120
```

A generated type is assignable wherever its base type is, so it works with
`medplum.createResource()` and Medplum's React components as it is.

**5. Validate in tests.** Types cannot say everything: a missing required
slice, a `CodeableConcept`'s binding, an invariant. `validateProfiled` runs
Medplum's own validator against the profile, offline:

```ts
import { validateProfiled } from 'plumb';

test('the blood pressure conforms', async () => {
  const report = await validateProfiled(bp, USCoreBloodPressureProfileUrl);
  expect(report.errors).toEqual([]);
});
```

It returns `{ ok, errors, warnings }` and promises the verdict of Medplum's
validator at your installed `@medplum/core` version, not a server's.

**6. Check in CI** that the committed types are up to date:

```bash
npx plumb generate --check
```

It regenerates in memory, compares byte for byte, and writes nothing to the
project. It exits 0 when everything is current, 1 when it finds a problem (a
stale, missing or extra file, or a lockfile that disagrees with the config),
and 2 for a usage or config error, and names the cause of each difference.
`--json` prints the full report, and `--quiet` prints only problems.

A fresh runner fetches the IG packages first (about 390 MB for US Core 9.0.0
and its dependencies), so cache the shared package cache, keyed on
`plumb.lock`. The key changes only when a package does, and every run still
checks each cached package against the lock's hashes. In GitHub Actions:

```yaml
- uses: actions/cache@v4
  with:
    path: ~/.fhir/packages
    key: fhir-packages-${{ hashFiles('plumb.lock') }}
- run: npx plumb generate --check
```

## Your own profiles in FSH

Plumb reads StructureDefinition JSON with snapshots. For profiles written in
FSH, follow Medplum's workflow: build them with SUSHI, then point `local` at
its output:

```bash
sushi . --snapshot
```

```ts
export default defineConfig({
  igs: ['hl7.fhir.us.core@9.0.0'],
  profiles: ['https://example.org/fhir/StructureDefinition/my-patient'],
  local: './fsh-generated/resources',
  out: './src/fhir/generated',
});
```

## Keep `@medplum/*` in step with your server

The types and `validateProfiled` use the `@medplum/*` packages you install.
A server on a different Medplum release can validate differently, so keep the
packages on the same release as the server. Plumb supports `@medplum/*` 5.1.0
and later, TypeScript 5.0 and later (`NodeNext` or `bundler` resolution), and
Node `^22.18.0 || >=24.2.0`, the same range as Medplum. `@medplum/core`'s own
type declarations need `@types/node`, or `skipLibCheck`, as Medplum's own
projects set.

## Known limits

The types say what TypeScript can say; `validateProfiled` and the server check
the rest. Each generated type's doc comment lists the rules it cannot check.

- **Missing or repeated required slices**, and `CodeableConcept` bindings, are
  caught by `validateProfiled` and the server, not the editor. Arrays stay
  plain arrays, so a slice entry built by hand is not checked against its
  slice; use the generated builders.
- **Extensions are open.** Every extension slicing is open, so a known
  extension with the wrong shape (a `valueString` where a `valueCode` is
  required) compiles unless it is built with its helper.
- **Reference strings are not narrowed.** A `Reference<Patient>` field accepts
  `{ reference: 'Group/1' }`, so that `createReference()` results stay
  assignable without a cast. Medplum's validator only warns on the wrong type.
- **Value sets that cannot be listed offline** (rules, VSAC and other
  terminology servers, SNOMED CT) or that have more than 100 codes keep the
  field's base type; the doc comment names the value set. Only a server with
  `validate-terminology` checks them.
- **`_field` primitive extensions** (`_birthDate` with a data-absent-reason)
  are not typed: `@medplum/fhirtypes` has no `_field` properties.
- **What Medplum's parser cannot read, Plumb cannot either.** Profiles with a
  `profile` slicing discriminator (IPS Bundle and DiagnosticReport) and US Core
  Provenance cannot be parsed; `name/*` skips them with a warning. Slices
  inside slices (IPS Composition) are parsed inconsistently, so that slicing
  gets no slice types, and a warning.
- **`validateProfiled` inherits Medplum's validator:** it checks no
  terminology binding, never matches an extension slice (so a profile that
  requires an extension fails every resource), and does not check slice
  contents, `closed` or `ordered` slicing, narrowed choice types, or rules
  reached through a `contentReference`. See
  [`docs/design/01-generator.md`](docs/design/01-generator.md), Testing.

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
npm run lint
```

Requires Node `^22.18.0 || >=24.2.0` and npm 11. The design is in
[`docs/spec.md`](docs/spec.md); where the project stands is in
[`docs/README.md`](docs/README.md).

## License

[Apache-2.0](LICENSE.txt). See [`NOTICE`](NOTICE).
