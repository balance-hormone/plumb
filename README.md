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

> **Status: pre-release.** Plumb works end to end but is not published yet. Its
> npm package will be `plumb-fhir`, and its command is `plumb`. To try it now,
> build it and install the tarball, as in the quickstart below.

## Quickstart

**1. Install** Plumb as a dev dependency, next to the Medplum packages it
narrows (5.1.0 or later):

```bash
npm install --save-dev ./plumb-fhir-0.1.0.tgz   # from `npm pack` in this repository
npm install @medplum/core @medplum/definitions @medplum/fhirtypes
```

**2. Configure** `plumb.config.ts` in the project root:

```ts
import { defineConfig } from 'plumb-fhir';

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
- `bindings.maxCodes` (optional, 100 by default): a required binding whose
  value set has more codes keeps its base type instead of a literal union.
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
✔ routes    2 rows for 2 types   1ms
✔ write     5 written, 0 removed, 0 unchanged → src/fhir/generated   1ms
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
import { validateProfiled } from 'plumb-fhir';

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

## Write each resource to its profile

Medplum validates a resource against the profiles in its `meta.profile`, and
nothing else. Without a stamp it applies the project's `defaultProfile` for
the type, one list per type, so a heart rate, a lab result and a smoking
status written unstamped are all held to the same Observation default. And a
stamp replaces the default: an Observation stamped by hand as a heart rate
silently loses it.

`generate` writes a routing table and the functions that use it, so each
write is held to the profile its content selects:

```ts
import { createProfiled, route } from './fhir/generated/index.js';

route(bp); // 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-blood-pressure'
const saved = await createProfiled(medplum, bp); // stamped, then medplum.createResource
```

- **`route(resource)`** is pure and offline, for tests. It keeps every
  profile whose keys the resource matches, prefers a child over its parent,
  and returns the one left; `undefined` when no selected profile constrains
  the type. It never guesses: no match, or several unrelated ones, throws a
  `RoutingError` that says what would select each candidate:

  ```text
  RoutingError: no profile matches this Observation.
    us-core-heart-rate      needs category http://terminology.hl7.org/CodeSystem/observation-category|vital-signs, code http://loinc.org|8867-4
    us-core-smokingstatus   needs category http://terminology.hl7.org/CodeSystem/observation-category|social-history, code http://loinc.org|72166-2
  Pass { profile } to choose one, or { profile: false } to write it unprofiled.
  ```

- **`createProfiled(medplum, resource)`** routes, stamps the type's
  `defaultProfile` plus the routed profile, and calls `createResource`. It
  never changes the object passed, and a refusal rejects before anything is
  written. **`updateProfiled`** routes the new content and replaces the
  stamps Plumb manages, keeping any other URL in `meta.profile`.
- **`{ profile: SomeProfileUrl }`** skips routing; the resource and the
  result are typed as that profile. **`{ profile: false }`** writes no Plumb
  stamp, so the server's own default applies.
- They take any client with `createResource` and `updateResource`, such as
  a `MedplumClient`, so the generated code needs nothing from Plumb at run
  time.

**Keys come from each profile:** every fixed or pattern value on a required
first-level element (a pinned `code`), and every required slice's
discriminator values (US Core's `vital-signs` category). They are in
`_routes.ts`, reviewed with the profile change that moved them. A profile
keyed on value-set membership needs a row in the config, and so does one
whose keys overlap another's:

```ts
export default defineConfig({
  // …igs, profiles, out
  routes: {
    'http://hl7.org/fhir/us/core/StructureDefinition/us-core-smokingstatus': {
      code: [{ system: 'http://loinc.org', code: '72166-2' }],
    },
    // Never routed: chosen only with { profile }.
    'http://hl7.org/fhir/us/core/StructureDefinition/us-core-adi-documentreference': false,
  },
  defaultProfile: {
    Observation: ['https://example.org/fhir/StructureDefinition/org-observation'],
  },
});
```

- A row maps a first-level element to the codings (or, for a `code`
  element, the strings) that select the profile; the resource matches when
  the element holds any of them. `false` takes a profile out of routing.
- `generate`'s `routes` step warns for each pair of unrelated profiles one
  resource could match, naming both, so a missing row shows up before a
  write fails.
- **`defaultProfile`** has the shape of Medplum's `Project.defaultProfile`.
  `createProfiled` stamps it alongside the routed profile, less any default
  the routed profile derives from, since a stamp replaces the server's
  default. Plumb does not set the server's `defaultProfile` yet: keep the
  two in step by hand.

## Read each resource as its profile

Every Medplum read returns base R4, and a cast to the profile type claims what
nothing checked. A stamp is not proof either: a record written while the
project was loose, before the profile tightened, or read through an
AccessPolicy that hides a field can carry the stamp and still lack what its
type requires. `generate` writes reads that check before they type:

```ts
import {
  readProfiled,
  searchProfiled,
  USCoreBloodPressureProfileUrl,
  USCorePatientProfileUrl,
} from './fhir/generated/index.js';

const patient = await readProfiled(medplum, USCorePatientProfileUrl, id);
patient.name; // HumanName[], not HumanName[] | undefined

const bps = await searchProfiled(medplum, USCoreBloodPressureProfileUrl, {
  patient: `Patient/${id}`,
});
```

- **The stamp:** `meta.profile` must hold the profile's URL, or a selected
  profile deriving from it (a heart rate is a vital sign). A `url|version`
  stamp does not count: Medplum validated nothing against it.
- **What the type requires:** every path the type makes required beyond
  `@medplum/fhirtypes` is present, from a table in `_reads.ts` generated with
  the types. Values, bindings and slices stay the validator's job.
- **`readProfiled(medplum, profile, idOrReference)`** reads by id or by
  `Reference` and rejects with a `ProfileReadError` when either check fails.
- **`searchProfiled(medplum, profile, query)`** adds `_profile` to the query,
  so only stamped records come back, and returns them typed. It refuses
  `_elements`, `_fields`, `_summary`, `_include` and `_revinclude` before any
  request: a subset is not the profile's type, and included resources are
  other types. Pair it with a selective filter (`patient`, `subject`) on
  large tables: a profile URL is common, so `_profile` alone narrows little.
- **`isProfiled`, `asProfiled` and `pickProfiled`** run the same checks
  offline, for a resource from anywhere else: a subscription, a bot's input,
  a Bundle's entries. `pickProfiled` keeps the stamped ones in a mixed list.
- They take any client with `readResource`, `readReference` and
  `searchResources`, such as a `MedplumClient`.

**One failing record fails a search, and the error carries the rest.**
Dropping it would hide a blood pressure from a chart without saying so; a
caller that can show the others recovers them without a second request:

```ts
import { ProfileReadError, type USCoreBloodPressure } from './fhir/generated/index.js';

let bps: USCoreBloodPressure[];
try {
  bps = await searchProfiled(medplum, USCoreBloodPressureProfileUrl, { patient });
} catch (err) {
  if (!ProfileReadError.is(err, USCoreBloodPressureProfileUrl) || err.reason !== 'missing') {
    throw err;
  }
  bps = err.passed; // typed
  showNotice(`${err.failed.length} records could not be shown`);
}
```

```text
ProfileReadError: Patient/123 is not a us-core-patient.
  missing  Patient.name
Stamped records lack required data when written while the project was loose,
when an AccessPolicy hides the field, or when the profile tightened since.
See `plumb validate --env <env>`.
```

The error names records and paths, never values, and `passed` is not
enumerable, so loggers and error trackers that copy an error leave the
clinical data out. `reason` is `'unstamped'`, `'missing'` or `'refused'`.

**A stamp proves conformance only once `plumb validate` passes.** The read
checks presence on every call; `validate` (below) is what proves every stored
record meets its profile, values and all, and is how to find each record a
read would refuse. History is not offered typed: an old version may predate
its stamp, so read it with `medplum.readHistory` and `asProfiled` it if you
must.

## Check stored data, then load profiles

Medplum validates a resource when it is written, and never again. Tightening a
profile, or turning strict mode on, therefore arms a failure in the next write
of every stored record that does not meet it. Plumb checks first, as a database
migration tool does before it adds a constraint: `plumb validate` counts what
would fail, and `plumb push` loads profiles only while nothing would.

**1. Name the environment** in `plumb.config.ts`. The config is committed, so
it names the environment variables that hold the credentials, never the
values:

```ts
import { defineConfig } from 'plumb-fhir';

export default defineConfig({
  igs: ['hl7.fhir.us.core@9.0.0'],
  profiles: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient'],
  out: './src/fhir/generated',
  environments: {
    prod: {
      baseUrl: 'https://api.medplum.com/',
      clientId: { env: 'MEDPLUM_PROD_CLIENT_ID' },
      clientSecret: { env: 'MEDPLUM_PROD_CLIENT_SECRET' },
    },
  },
});
```

**2. Give Plumb a client.** Create a ClientApplication in the project for CI,
and make its project membership an admin: `push` creates Plumb's checker bot
through Medplum's admin endpoint, reads bot memberships, and writes Bot,
AccessPolicy and StructureDefinition resources. If the membership has an
AccessPolicy, it must allow those writes. The project needs bots enabled; on a
self-hosted server, `push` creates the bot on the server's default bot
runtime (`defaultBotRuntimeVersion`).

**3. Install the checker** with a first `plumb push --env prod --dry-run`
(below), then check what is stored:

```bash
npx plumb validate --env prod
```

```text
plumb validate --env prod
✔ load      1 profiles of Patient   1.9s
✔ connect   https://api.medplum.com/ (strict mode off)   320ms
✔ checker   plumb-checker 0.4.0 installed   60ms
✔ profiles  1 selected, none shadowed   80ms
✖ validate  1 of 1 profiles would fail   38.4s
    Patient: 12400 of 12400 read, 300 of 12360 fail; 40 unstamped; silent stamps: 3 url|version
      us-core-patient   12360 checked, 300 failures
        Patient.identifier: Missing required property   (300)
Failing ids: .plumb/validate-prod.json (gitignored)
Failed in 40.8s
```

- **Validation runs inside the project**, in Plumb's checker bot, with the
  `@medplum/core` release Plumb was built with. Patient data never leaves
  Medplum: only counts, reasons and the ids of failing records come back. The
  bot's own AccessPolicy reads the checked resource types and
  StructureDefinition, and writes nothing.
- **Against the versions in `plumb.config.ts`,** not what the project has
  loaded: it answers "what would fail if we loaded these?"
- **Each resource is checked against the selected profiles it is stamped
  with** (`meta.profile`). Resources with no stamp are counted, not checked.
  Silent stamps, which today validate against nothing, are counted too: a
  profile URL the project does not hold, a `url|version` stamp (Medplum
  matches bare URLs only) and an empty `meta.profile`.
- **Empty is never ambiguous.** Each type reports how many resources the bot
  read against how many exist, so "all passed", "none carries a selected
  profile", "none stored" and "0 of N readable" (an AccessPolicy that hides
  them) read differently.
- **Shadowed profiles** fail the check: more than one StructureDefinition for
  a selected URL, of which Medplum enforces the one whose version sorts last
  as text, so `1.9.0` beats `1.10.0`.
- **Failing ids go to `.plumb/validate-<env>.json`**, never to the terminal,
  CI logs or `--json`. The `.plumb` folder ignores itself in git.
- **Large projects:** the bot checks one page per run, as an async job, and
  the file saves each page; `--resume` continues an interrupted run from its
  last page.
- **Exit codes:** 0 when nothing fails; 1 when something would fail, a type
  could not be read, or a profile is shadowed; 2 for usage, config and
  connection errors, and when the checker is missing or from another Plumb
  release (run `plumb push` to install it). `validate` never installs or
  changes anything.

**4. Fix or migrate** the failing records, and validate again until nothing
fails.

**5. Load the profiles:**

```bash
npx plumb push --env prod
```

```text
plumb push --env prod
✔ load      1 profiles of Patient   1.9s
✔ connect   https://api.medplum.com/ (strict mode off)   320ms
✔ checker   plumb-checker 0.4.0 unchanged   90ms
✔ plan      load us-core-patient 9.0.0 (+7 dependencies)   210ms
✔ gate      nothing stored would fail   36.1s
✔ apply     8 created, 0 updated   1.4s
✔ recheck   nothing stored fails   35.7s
    Strict mode is off, and only a super admin can turn it on; every stamped resource checked passes its profiles.
Done in 76.4s
```

- **checker** installs or updates the checker bot and its AccessPolicy, and
  redeploys it only when Plumb's version or the bundle changes.
- **plan** compares the selected profiles, and the extensions and parents
  they depend on, with what the project holds. A URL the project already
  holds is updated in place, never added again (that would shadow it). A
  StructureDefinition whose content changed without a version bump is
  flagged, and a URL already shadowed stops the push. Base R4 is the server's
  own and is never written.
- **gate** runs the checker against the planned versions. If any stored
  resource would fail, `push` refuses and loads nothing. `--dry-run` stops
  here, so it is a safe way to install the checker and preview a push.
- **apply** creates or updates the StructureDefinitions.
- **recheck** checks again at once, to catch a failing write made between the
  gate and loading. A failure there fails the push (exit 1), and the profiles
  stay loaded, as Postgres keeps a `NOT VALID` constraint.

Exit codes are `validate`'s, and `--json` and `--quiet` work as for `generate`.

**6. Turn strict mode on.** Plumb reports strict mode, and never sets it: only
a super admin can, so on hosted Medplum ask Medplum's team, and on a
self-hosted server its operator. With strict mode off, the server accepts a
resource that fails a profile it names; a clean `push` re-check says the
stored data is ready.

In CI, run `push` where the deploy runs, with the secrets as environment
variables:

```yaml
- run: npx plumb push --env prod
  env:
    MEDPLUM_PROD_CLIENT_ID: ${{ secrets.MEDPLUM_PROD_CLIENT_ID }}
    MEDPLUM_PROD_CLIENT_SECRET: ${{ secrets.MEDPLUM_PROD_CLIENT_SECRET }}
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
  terminology servers, SNOMED CT) or that have more than `bindings.maxCodes`
  codes (100 by default) keep the field's base type; the doc comment names the
  value set. Only a server with `validate-terminology` checks them.
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

- **Unstamped resources are counted, not checked.** `validate` does not
  route them; `createProfiled` stamps new writes.
- **Routing keys are first-level elements,** and a key is a value that must
  be present: absence (US Core Coverage's `us-core-15`) cannot select a
  profile. Bundles passed to `executeBatch` are not routed; route each entry
  with `route`.
- **Typed reads check presence, not values.** A stamped record whose code no
  longer matches its profile reads typed; `validate` finds it.
  `searchProfiled` reads one page, as `searchResources` does.
- **Plumb never sets strict mode** or `defaultProfile`; a super admin turns
  strict mode on.
- **Nothing yet stops another writer** loading StructureDefinitions around
  `push`, and every failure blocks it: a baseline of accepted failures and
  the AccessPolicy lockdown come later.
- **The checker is tested on Medplum's `vmcontext` bot runtime.** Hosted
  Medplum runs bots on AWS Lambda, which the tests cannot run.

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
