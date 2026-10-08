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

> **Status: 0.x.** Plumb works end to end, and its API may still change between
> minor releases. Its npm package is `plumb-fhir`, and its command is `plumb`.

## Quickstart

**1. Install** Plumb as a dev dependency, next to the Medplum packages it
narrows (5.1.0 or later):

```bash
npm install --save-dev plumb-fhir
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
syntax such as `enum`, relative imports without `.ts`, `tsconfig` path aliases
and packages that export TypeScript source are not available in it. When the
project has `tsx` installed, Plumb loads with it whatever Node cannot, and
all of these work: a workspace can import its access policies from the
package that defines them.

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
`--json` prints the full report, and `--quiet` prints only problems. Each
code a report can hold, its exit code and its fix are in
[`docs/errors.md`](docs/errors.md).

A fresh runner fetches the IG packages first (about 390 MB for US Core 9.0.0
and its dependencies), so cache the shared package cache, keyed on
`plumb.lock`. The key changes only when a package does, and every run still
checks each cached package against the lock's hashes. In GitHub Actions:

```yaml
- uses: actions/cache@v6
  with:
    path: ~/.fhir/packages
    key: fhir-packages-${{ hashFiles('plumb.lock') }}
- run: npx plumb generate --check
```

## Your own profiles in FSH

Name the folder holding `sushi-config.yaml` in `fsh`, and `generate` runs
SUSHI first, then types what it built. Plumb uses the project's own SUSHI, so
install the version your FSH is written for:

```bash
npm install --save-dev fsh-sushi
```

```ts
export default defineConfig({
  igs: ['hl7.fhir.us.core@9.0.0'],
  profiles: ['https://example.org/fhir/StructureDefinition/my-patient'],
  fsh: '.',
  out: './src/fhir/generated',
});
```

```text
✔ sushi     1 StructureDefinitions, 0 ValueSets   6.8s
```

- **Commit `fsh-generated/resources/`** with the FSH. It is the JSON `push`
  loads into Medplum, and `validateProfiled` reads it without running SUSHI.
  SUSHI's own `fsh-index.txt` and `data/` are bookkeeping no command reads:
  gitignore them. Marking the generated folders `linguist-generated` in
  `.gitattributes` collapses them in review diffs.
- **`generate --check` in CI** rebuilds the FSH into a temporary folder and
  fails when the committed `fsh-generated/` or the types differ from it.
- **SUSHI's errors stop `generate`**, with their FSH file and line. Its
  warnings are listed under the `sushi` step.
- **Keep the versions in step:** `generate` warns when `sushi-config.yaml`
  depends on a package at a version `igs` does not select, and when a
  profile's pinned parent version differs from the one `igs` provides.

`fsh` replaces `local`: set one or the other.

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
- **`stampProfiled(resource, options?)`** returns the copy `createProfiled`
  would write, stamped and not written, for the writes it cannot make: a
  conditional create, an upsert, a batch or transaction entry. It takes the
  same options and throws the same `RoutingError`:

  ```ts
  await medplum.createResourceIfNoneExist(
    stampProfiled(coverage, { profile: USCoreCoverageProfileUrl }),
    `identifier=${system}|${value}`,
  );
  ```

- **Moving an edit path to `updateProfiled` stamps records that were
  unstamped**, so the server starts holding them to the profile: an edit of a
  stored record that does not meet it is refused from then on. Run
  `plumb validate` and fix what fails before moving edit paths.

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
  default. `push` writes the same `defaultProfile` to the server (see
  [Configure the project](#configure-the-project)), so the stamps
  `createProfiled` writes and the defaults the server applies come from one
  place.

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

## Find code that goes around Plumb

The profiled reads and writes only help where they are called. `plumb check`
reads your code the way the compiler does and reports every `MedplumClient`
read or write of a profiled type that does not go through them, including a
write whose type is only inferred:

```ts
export default defineConfig({
  // …igs, profiles, out
  check: {
    tsconfig: ['apps/web/tsconfig.json'],
    baseline: './plumb-check-baseline.json',
    ignore: ['**/*.test.ts', '**/*.stories.tsx'],
  },
});
```

```bash
npx plumb check
```

```text
plumb check
✖ check     2 new, 248 in the baseline, in 2767 files   6.2s
    apps/web/src/lib/goals/goal.ts:41:10  readResource Goal  → readProfiled
    apps/web/src/lib/coverage/save.ts:90:5  createResource Coverage  → createProfiled, updateProfiled or stampProfiled
Failed in 6.2s
```

- **What it reports:** `readResource`, `searchResources`, `searchOne`,
  `searchResourcePages`, `createResource`, `updateResource`, `upsertResource`
  and `createResourceIfNoneExist` on a `MedplumClient` (or a class deriving
  from it), for a type every resource of which a selected profile holds: one
  with a profile that routes on no keys, or a `defaultProfile`. A type whose
  profiles are keyed on content (one code of Observation) is not reported, and
  neither is `string` or `ResourceType`.
- **A stamped write passes,** through a variable too: `stampProfiled` returns
  its resource branded, and `check` reads the brand from the type.
- **A deliberate exception** takes a comment with a reason on the line before:
  `// plumb-check: the backfill reads unstamped records to stamp them`.
- **The baseline** is a committed count per file, method and type. `check`
  fails only when a count grows or a new one appears, so new raw access is
  refused at once while the backlog shrinks. `--update-baseline` records
  fixes; it refuses growth unless `--allow-growth` is given.
- **Paths** in the output, the baseline and `ignore` are relative to the
  deepest folder holding the config and every tsconfig, so a monorepo's config
  in one package checks code in another.
- **TypeScript:** `check` compiles with your project's own `typescript`, which
  needs its compiler API: TypeScript 5 or 6. TypeScript 7's native package has
  none yet, and `check` exits 2 on it.

Exit codes: 0 when nothing is new, 1 when something is (or the baseline would
grow, or the profiles do not load), 2 for usage, config and set-up errors.

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

Set the variables in the shell, or keep them in a gitignored dotenv file and
pass it with `--env-file .env` (repeatable; later files win, and a variable
already set wins over every file).

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
✔ checker   plumb-checker 0.6.0 installed   60ms
✔ profiles  1 selected, none shadowed   80ms
✖ validate  1 of 1 profiles would fail   38.4s
    Patient: 12400 of 12400 read, 300 of 12357 stamped fail; 40 unstamped; 3 stamped only with profiles not selected (--full breaks them down)
      us-core-patient   12357 checked, 300 failures
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
  with** (`meta.profile`). The bot reads only resources carrying a selected
  stamp, so one narrow profile on a large type reads only what carries it.
  The rest are counted by query: resources with no stamp, and those stamped
  only with other profiles.
- **`--full` reads every resource** of each type to break those other stamps
  down: silent stamps, which today validate against nothing (a profile URL
  the project does not hold, or a `url|version` stamp, since Medplum matches
  bare URLs only), and stamps of profiles the project holds but the config
  does not select. Run it when the report counts any.
- **`--unstamped` forecasts what stamping would break.** Before moving
  writes to `createProfiled` or backfilling stamps, `plumb validate --env prod
  --unstamped` also reads each unstamped resource, routes it as the generated
  `route` does, and checks it against what `createProfiled` would stamp. The
  report adds `if stamped: 40 of 2,295 routed would fail; 12 route to no
  profile` under each type, with the reasons. It is a forecast: the exit
  code still reflects stamped data only. Defaults the config does not select
  have no definition to check against, so only selected profiles are checked.
- **Empty is never ambiguous.** Each type reports how many resources the bot
  read against how many exist, so "all passed", "none carries a selected
  profile", "none stored" and "0 of N readable" (an AccessPolicy that hides
  them) read differently.
- **A type counts records; a profile counts checks.** A record stamped with a
  profile and its parent is checked against each, so it appears once on the
  type's line (`all 331 stamped passed`) and once under each profile.
- **Shadowed profiles** fail the check: more than one StructureDefinition for
  a selected URL, of which Medplum enforces the one whose version sorts last
  as text, so `1.9.0` beats `1.10.0`.
- **Failing ids go to `.plumb/validate-<env>.json`**, never to the terminal,
  CI logs or `--json`. The `.plumb` folder ignores itself in git.
- **Large projects:** the bot checks one page per run, as an async job, and
  the file saves each page; `--resume` continues an interrupted run from its
  last page. A type of more than one page prints its progress
  (`Observation: 4,300 of 45,213 read`).
- **Exit codes:** 0 when nothing fails; 1 when something would fail, a type
  could not be read, or a profile is shadowed; 2 for usage, config and
  connection errors, and when the checker is missing or from another Plumb
  release (run `plumb push` to install it). `validate` never installs or
  changes anything.

**4. Fix or [migrate](#migrate-stored-data)** the failing records, and
validate again until nothing fails.

**5. Load the profiles:**

```bash
npx plumb push --env prod
```

```text
plumb push --env prod
✔ load      1 profiles of Patient   1.9s
✔ connect   https://api.medplum.com/ (strict mode off)   320ms
✔ checker   plumb-checker 0.6.0 unchanged   90ms
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
  flagged, and a URL already shadowed, or held only by a linked project,
  stops the push. What the server itself holds, such as the terminology in
  Medplum's base project, is left to it. The ValueSets and
  CodeSystems the profiles bind are planned with them, CodeSystems first, so
  a project with Medplum's `validate-terminology` feature can resolve every
  binding; a CodeSystem a package ships without its codes (SNOMED CT, LOINC)
  is listed and left to Medplum. Base R4 is the server's own and is never
  written.
- **gate** runs the checker against the planned versions. If any stored
  resource would fail, `push` refuses and loads nothing. `--dry-run` stops
  here, so it is a safe way to install the checker and preview a push.
- **apply** creates or updates the definitions, terminology first.
- **recheck** checks again at once, to catch a failing write made between the
  gate and loading. A failure there fails the push (exit 1), and the profiles
  stay loaded, as Postgres keeps a `NOT VALID` constraint.

Exit codes are `validate`'s: a write that fails, or a plan blocked by an
untagged or shadowed resource, exits 1. `--json` and `--quiet` work as for
`generate`.

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

## Migrate stored data

`validate` says which stored records a stricter profile would refuse; a
migration fixes them, inside the project. Together with `push` this is a
database's **check, backfill, then tighten**:

```bash
npx plumb validate --env prod          # 312 Patients fail us-core-patient: birthDate missing
npx plumb migrate --env prod           # dry run: 312 to change, and a forecast
npx plumb migrate --env prod --write   # the backfill, resumable
npx plumb push --env prod              # the gate passes; the stricter profile loads
```

**Declare a migration** in a module the config lists. `plumb migrate new
patient-birthdate` scaffolds `<date>-patient-birthdate.ts` in the first
`modules` folder:

```ts
// src/migrations/20261006-patient-birthdate.ts
import { defineMigration } from '../fhir/generated/index.js';

export default defineMigration({
  id: '20261006-patient-birthdate',
  resourceType: 'Patient',
  search: { 'birthdate:missing': 'true' }, // narrows what is read; optional
  transform(patient) {
    if (patient.birthDate) return undefined; // nothing to do
    return [{ op: 'add', path: '/birthDate', value: '1900-01-01' }];
  },
});
```

- **`transform` is pure:** it returns JSON Patch operations, or `undefined`
  when the record needs nothing, so a run is safe to repeat and to resume. A
  transform is a function, so test it on fixtures with no server: records in,
  patches out.
- **The resource is typed** by `@medplum/fhirtypes`, not a profile type: the
  record is stale, so a profile type would claim what it lacks.
- **`search` only narrows** what is read; the runner adds `_lastUpdated`,
  `_sort` and `_count`, and reads only records last updated before the run
  started.
- **An `id` starts with a date,** so branches never collide on a number.
  `dependsOn: ['<id>']` runs a migration after another; otherwise they run by
  `id`. A bad id, a cycle, an unknown type or a search parameter Medplum does
  not index is `invalid-migration`, before anything is read.

**Deploy the migrator.** Migrations run a page at a time in a bot of the
project's own, so patient data never leaves Medplum. `generate` writes
`_migrator.ts`, importing each module, and the bot's entry is one line:

```ts
// src/bots/migrator.ts, built as the project's other bots are
export { handler } from '../fhir/generated/_migrator.js';
```

```ts
// in plumb.config.ts
bots: {
  migrator: { file: './dist/bots/migrator.cjs', runtime: 'awslambda', timeout: 300, policy: 'migrator' },
},
migrations: {
  bot: 'migrator',
  modules: ['./src/migrations/*.ts'],
  restamp: true, // optional: Plumb's restamp migrations, below
},
```

The `migrator` policy reads and writes the migrated types, and grants Plumb's
checker by key, `{ resourceType: 'Bot', bots: ['checker'] }`, which forecasts
each page. `push` deploys the bot; a new module makes `generate --check`
stale until it is generated and the bot rebuilt.

**Run it.** A dry run is the default and writes nothing, the ledger
included:

```text
plumb migrate --env prod
✔ load        1 profiles of Patient   1.9s
✔ connect     https://api.medplum.com/   320ms
✔ migrations  1 of 1 chosen   40ms
✔ checker     plumb-checker 0.16.0 installed   60ms
✔ migrator    migrator current (migrator-3c07…)   70ms
✔ 20261006-patient-birthdate  dry run: 312 read, 312 to change, 0 unchanged   9.8s
    forecast: 312 would pass the selected profiles, 0 would still fail
Done in 12.6s
```

- **The forecast** validates each changed record, as patched, against the
  selected profiles it is stamped with, in the checker: it answers "would
  these pass once the stricter profile loads?"
- **`--write`** PUTs each record with `If-Match` on the version read. A record
  edited in between is read and transformed again; a second clash counts as a
  conflict, left for the next run. A record the server refuses counts as
  failed, with its reason. Only counts and reasons come back, never a record
  or an id.
- **Pages** are 100 records (`--page-size`, 20 to 1,000), each an async job,
  short enough for the bot's timeout. Over the project's write quota, a page
  waits a minute and runs again.
- **Ctrl-C** stops after the current page, and the next `--write` resumes
  from its cursor. `plumb migrate --env prod <id>…` runs only those.
- **The migrator must be this build:** `migrator-not-current` (exit 2) until
  `push` deploys it, as `validate` requires the checker.

**The ledger** is one `Basic` per migration in the project, found by Plumb's
tag: its status (`running`, `paused`, `errored` or `applied`), the module's
hash, the git commit, the counts, and a lease, so two runs never race
(`migration-running`) and a run whose CLI died is taken over after ten
minutes. An applied migration is not run again. One whose module changed
since is `migration-edited`; `--rerun <id>` runs it again, changing only what
its transform still finds.

**Watch every environment** with `plumb migrate status`, which exits 1 when
anything is pending, running, paused, errored or edited, so a nightly job
catches an environment that missed a migration:

```text
plumb migrate status --env prod
✔ migrations  2 declared
✔ connect     https://api.medplum.com/
✖ status      1 applied, 1 pending
    20261006-patient-birthdate: applied at 3c07a1e, 312 changed
    20261020-coverage-payor: pending
```

Once a migration is applied in every environment, its module can go; its
ledger entry stays, and `status` lists it with "(no module)".

**Restamping.** With `restamp: true`, `generate` also writes
`plumb-restamp-<Type>` for each type with routing rows. Each sets the stamps
`updateProfiled` would, keeps any other URL in `meta.profile`, and leaves a
record that routes to no single profile alone. They run again whenever
`_routes.ts` changes, so a new routing row or profile restamps what is
stored.

**`push` names what is pending.** The two stay separate: `push` never writes
patient data, and `migrate` never loads a profile. When the gate refuses, it
lists the pending migrations on each failing type:

```text
✖ gate      312 stored Patients would fail us-core-patient
    pending: 20261006-patient-birthdate (Patient)
    Refusing to load: run plumb migrate --env prod --write, or see plumb validate --env prod.
```

The order for a tightening is **expand, migrate, contract:** ship the app
writing the new shape, migrate the old records, then `push` the stricter
profile. A record the app writes in the old shape after a run started is not
read by it; the gate catches it, and `--rerun` fixes it.

**Locally and in tests.** On an environment marked `synthetic: true` (no real
patient data), `--local` runs the same generated runner in the CLI's process,
with no bot and no deploy; anywhere else it is `not-synthetic`, before
anything is read. A project's tests do the same against a
[test project](#test-against-a-real-server):

```ts
import { loadConfig } from 'plumb-fhir';
import { connectAs, migrate, testProject } from 'plumb-fhir/test';
import { expect, test } from 'vitest';

// test.seed holds Patients with no birthDate, stamped with no profile that requires one.
test('the birthdate migration backfills every patient', async () => {
  const loaded = await loadConfig({ cwd: process.cwd() });
  if (!loaded.ok) throw new Error('plumb.config.ts did not load');
  const result = await migrate(testProject(), loaded.config, { lockPath: 'plumb.lock', write: true });
  expect(result.ok).toBe(true);
  const medplum = await connectAs(testProject());
  expect(await medplum.searchResources('Patient', { 'birthdate:missing': 'true' })).toEqual([]);
});
```

## Configure the project

`push` also converges the rest of what a project admin can write, from the
same config: settings, secrets, default profiles, AccessPolicies, default
access policies and client applications. None of it is set by hand in the
console any more, so it is reviewed, and a second environment is rebuilt from
the same file.

```ts
import { defineConfig } from 'plumb-fhir';

export default defineConfig({
  igs: ['hl7.fhir.us.core@9.0.0'],
  profiles: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient'],
  out: './src/fhir/generated',
  // Stamped by createProfiled, and now written to Project.defaultProfile too.
  defaultProfile: {
    Patient: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient'],
  },
  project: {
    settings: { supportEmail: 'support@example.org', maxUploadMb: 25 },
    secrets: {
      LAB_API_KEY: { env: 'LAB_API_KEY' }, // set from CI's environment
      SFTP_KEY: true, // must exist; set by hand in the console
    },
    accessPolicies: {
      clinician: {
        resource: [
          { resourceType: 'Patient' },
          { resourceType: 'Observation' },
          { resourceType: 'StructureDefinition', readonly: true },
        ],
      },
      lab: {
        resource: [{ resourceType: 'Observation' }, { resourceType: 'Patient', readonly: true }],
      },
    },
    defaultAccessPolicies: [{ profileType: 'Practitioner', accessPolicy: 'clinician' }],
    clients: { 'lab-integration': { accessPolicy: 'lab' } },
  },
  environments: {
    prod: {
      baseUrl: 'https://api.medplum.com/',
      clientId: { env: 'MEDPLUM_PROD_CLIENT_ID' },
      clientSecret: { env: 'MEDPLUM_PROD_CLIENT_SECRET' },
      settings: { supportEmail: 'support@example.com' },
    },
  },
});
```

- **Keys, not ids.** Policies and clients are named by a key, and a client or
  default access policy names its policy by key. Ids differ per environment
  and never appear in the config.
- **An AccessPolicy is Medplum's own shape,** less `id` and `meta`, typed from
  `@medplum/fhirtypes`; its `name` is the key unless given.
- **A setting's type follows its value:** a string is `valueString`, a boolean
  `valueBoolean`, a whole number `valueInteger`, any other number
  `valueDecimal`. An environment's `settings` merge over `project.settings`.
- **Secrets never sit in the config.** `{ env: 'NAME' }` reads the value from
  that variable and sets the secret when it differs; `true` means the secret
  must already exist, and `push` never changes it. No plan, `--json` output
  or error ever holds a secret's value.
- **Only a project admin's fields.** `strictMode`, `features`, `link` and
  `systemSetting` are a super admin's: declaring one is a config error, and
  `push` reports `strictMode` and `features` instead.

`push` runs a `project` step once the profile gate has passed, and prints its
plan, then what it wrote:

```text
plumb push --env prod
✔ load      1 profiles of Patient   1.9s
✔ connect   https://api.medplum.com/ (strict mode on)   320ms
✔ checker   plumb-checker 0.6.0 unchanged   90ms
✔ plan      8 up to date, nothing to load   180ms
✔ project   plan: 3 to create, 1 to update, 0 to remove   240ms
    + AccessPolicy  clinician
    + AccessPolicy  lab
    + ClientApplication  lab-integration
    ~ Project  setting supportEmail (valueString), setting maxUploadMb (valueInteger), secret LAB_API_KEY (value changed), defaultProfile Patient, defaultAccessPolicies Practitioner
    strictMode on, features: bots
✔ project   applied 4 changes   410ms
    ClientApplication lab-integration created: 8c1f2b4e-5a6d-4e7f-9a0b-1c2d3e4f5a6b
Done in 3.2s
```

- **Found again by a tag,** never by name or id. Each AccessPolicy and client
  Plumb manages carries a `meta.tag` with system
  `https://www.npmjs.com/package/plumb-fhir` and its key as code. A second
  push with no config change plans nothing and writes nothing.
- **Untagged is untouched.** A policy or client made by hand with a key's name
  stops the plan, naming it; `--adopt` tags it and converges it in place, so
  an existing project comes under `push` without recreating its clients.
- **Removal needs `--prune`.** A tagged policy or client whose key left the
  config is listed, and deleted only with `--prune`, a client with its
  membership. Settings and secrets the config does not name are left alone,
  even with `--prune`: they carry no tag.
- **A client's secret is never printed or stored.** A created client's id is
  printed; read its secret in the console, and keep it in your secrets store.
- **Only this project's own resources.** A linked project's policies are never
  planned, even when they carry Plumb's tag; the plan reports the links.
- **The Project is one update.** Settings, secrets, `defaultProfile` and
  `defaultAccessPolicies` are read, merged and written together, after the
  profiles they name are loaded. Fields `push` does not manage stay as read.
- `--dry-run` stops after the plan.

In CI, pass the variables the secrets name as well:

```yaml
- run: npx plumb push --env prod
  env:
    MEDPLUM_PROD_CLIENT_ID: ${{ secrets.MEDPLUM_PROD_CLIENT_ID }}
    MEDPLUM_PROD_CLIENT_SECRET: ${{ secrets.MEDPLUM_PROD_CLIENT_SECRET }}
    LAB_API_KEY: ${{ secrets.LAB_API_KEY }}
```

### Catch drift

A change made by hand in the console is drift. `push --check` plans as `push`
does, with the same `--prune`, but installs nothing and writes nothing, and
exits 1 when `push` would change anything, naming what drifted:

```text
plumb push --env prod --check
✔ load      1 profiles of Patient   1.9s
✔ connect   https://api.medplum.com/ (strict mode on)   320ms
✔ plan      8 up to date, nothing to load   180ms
✔ project   plan: 0 to create, 1 to update, 0 to remove   240ms
    ~ AccessPolicy  clinician (resource)
    strictMode on, features: bots
✖ check     drift: 1 project change   0ms
    Run plumb push --env prod to converge.
Failed in 2.6s
```

Run it on a schedule:

```yaml
name: Drift
on:
  schedule:
    - cron: '17 6 * * *'
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - run: npm ci
      - run: npx plumb push --env prod --check
        env:
          MEDPLUM_PROD_CLIENT_ID: ${{ secrets.MEDPLUM_PROD_CLIENT_ID }}
          MEDPLUM_PROD_CLIENT_SECRET: ${{ secrets.MEDPLUM_PROD_CLIENT_SECRET }}
          LAB_API_KEY: ${{ secrets.LAB_API_KEY }}
```

### Lock the project down

An AccessPolicy's entries are a union: an interaction is allowed if any entry
allows it, so a read-only entry does not restrict a writable `*` entry. And
`admin: true` does not bypass a policy, but a membership with no policy has
full access. So:

- **People** get `admin: false`, and a policy with no writable `*` entry. List
  the clinical types they may write; give the configuration types
  (ClientApplication, Bot, Subscription, OperationDefinition,
  StructureDefinition, SearchParameter, AccessPolicy) read-only entries, or
  none.
- **The CI client** `push` runs as gets `admin: true` and an explicit policy
  that writes the configuration types.
- **A super admin** is the break-glass, and the only way to change
  `strictMode` and `features`.

`push` warns, without refusing, where the config departs from this:

- a policy with a `*` entry that is not read-only;
- a client with `admin: true` and no `accessPolicy`;
- a policy other than the one `push` runs under that writes
  StructureDefinition, since that bypasses the profile gate.

## Reference content

A project depends on content that is neither a profile nor patient data: the
Questionnaires its forms render, the CodeSystems and ValueSets its codes come
from, the Organizations its resources point at. List the files, one FHIR
resource each, in `content`, and `push` converges every environment on them:

```ts
// in plumb.config.ts
content: ['./fhir/content/*.json', './fsh/fsh-generated/resources/Questionnaire-*.json'],
```

```text
✔ content   plan: 3 to create, 1 to update, 0 to retire
    + CodeSystem    http://example.org/fhir/CodeSystem/visit-reason
    + ValueSet      http://example.org/fhir/ValueSet/visit-reason
    + Questionnaire http://example.org/fhir/Questionnaire/intake
    ~ Organization  main-clinic (address)
✔ content   applied 4 changes
```

- **What counts:** Questionnaire, CodeSystem, ValueSet and Organization. A
  FSH project points at the instances SUSHI writes, never its whole output,
  which holds examples. Patient data is not content; seed data for tests is
  `test.seed`. Medplum ignores a project's own SearchParameters, so a file of
  one is refused, and Subscriptions wait for the bots they trigger.
- **Checked before anything is written:** `generate` and `push` refuse a file
  that is not one of the four, has no `url` (or, for an Organization, no
  `id`), shares one with another file, or fails Medplum's validator against
  base R4 or a selected profile it claims in `meta.profile`.
- **Found again by a tag,** as policies are: a Questionnaire, CodeSystem or
  ValueSet by its `url`, an Organization by its file `id`, which is its key
  and never its server id. Each is written as the file states it and updated
  in place; a change under the same `version` is flagged. One the project
  already holds untagged stops the push until `--adopt` takes it over.
- **Removal retires, with `--prune`:** a canonical resource becomes
  `retired` and an Organization inactive, so responses and references keep
  resolving. Nothing is deleted.
- **`push --check`** reports content drift with the rest.

The ValueSets and CodeSystems the selected profiles bind are loaded with the
profiles, whether or not they are in `content`, so a project with Medplum's
`validate-terminology` feature resolves every binding. That feature also
stops Medplum creating bots, so `push` cannot install its checker in such a
project until Medplum fixes it.

Each Questionnaire in `content` gets a generated file. A response is never
checked against its Questionnaire on the server, so these types are the only
check its shape gets:

```ts
import { intakeAnswers, type IntakeLinkId } from './fhir/generated/index.js';

const answers = intakeAnswers(response); // throws for a response to another Questionnaire
answers.reason?.code; // 'new' | 'follow-up', from the item's answer options
answers['weight-kg']; // number | undefined
answers.allergies; // string[] | undefined: a repeating item
answers['wieght-kg']; // compile error
```

A choice's codes are a literal union when its answer options, or an
`answerValueSet` from the packages, `local` or `content`, list them offline
within `bindings.maxCodes`; otherwise it is any `Coding`. Every answer may be
missing.

## Bots and Subscriptions

A project's behaviour is its bots and what triggers them. Declare both by
key, and `push` creates, configures and deploys them in every environment;
no server id ever appears in the repository.

```ts
// in plumb.config.ts
project: {
  secrets: { SMS_API_KEY: { env: 'SMS_API_KEY' } },
  accessPolicies: {
    'reminder-sender': { resource: [{ resourceType: 'Appointment', readonly: true }] },
    'intake-writer': { resource: [{ resourceType: 'QuestionnaireResponse' }] },
    // Who may run a bot, by its key: the same policy in every environment.
    'front-desk': { resource: [{ resourceType: 'Bot', bots: ['send-reminder'] }] },
  },
},
bots: {
  'send-reminder': {
    file: './dist/bots/send-reminder.cjs', // built by the project
    timeout: 30,                           // seconds; 10 by default
    policy: 'reminder-sender',             // the bot's own access
    secrets: ['SMS_API_KEY'],
    cron: '0 14 * * *',
  },
  'intake-webhook': {
    file: './dist/bots/intake-webhook.cjs',
    policy: 'intake-writer',
    publicWebhook: true,
    rawBody: true,
  },
},
subscriptions: {
  'new-appointment': {
    criteria: 'Appointment?status=booked',
    interactions: ['create'],
    bot: 'send-reminder',
  },
  'lab-result': {
    criteria: 'DiagnosticReport?status=final',
    url: 'https://hooks.example.org/lab',
    secret: { env: 'LAB_HOOK_SECRET' },          // signs each delivery as X-Signature
    headers: { Authorization: { env: 'LAB_HOOK_TOKEN' } },
  },
},
```

```text
✔ bots           plan: 1 to create, 0 to update, 2 to deploy, 0 to disconnect
    + Bot  send-reminder  awslambda, policy reminder-sender
    ~ Bot  intake-webhook (code changed (a91f… → 3c07…))
    webhook  intake-webhook  https://api.example.org/webhook/7d1e…
✔ bots           applied 2 changes
✔ subscriptions  plan: 1 to create, 1 to update, 0 to turn off
    + Subscription  new-appointment  Appointment?status=booked → Bot send-reminder
    ~ Subscription  lab-result (criteria changed)
✔ subscriptions  applied 2 changes
```

- **Checked before anything is written:** an unknown policy, secret or bot
  key; a `publicWebhook` without a `policy`, which Medplum would answer with a
  403; a schedule Medplum would silently ignore; criteria Medplum's matcher
  can never fire on (chained parameters, `_has`, a project's own
  SearchParameters, number, quantity and composite parameters, and modifiers
  it reads as equality); a FHIRPath that does not parse; and a bundle that is
  missing or, for `vmcontext`, is not CommonJS assigning `exports.handler`.
- **Bots are found by identifier** (Plumb's system and the key), created
  through Medplum's admin endpoint so each gets its membership and policy,
  and converged field by field. The bundle deploys only when its hash
  differs from the one in the deployed filename, so an unchanged bot never
  publishes a new Lambda version. Each public webhook's URL is printed for
  the environment; vendors point at it, so it never changes.
- **Subscriptions are found by tag,** so a changed criteria updates one in
  place. A bot's is addressed by the bot's id in this environment. Secret and
  header values are read from their variables when written and never kept in
  the plan; Medplum cuts a header value at its first `:`, so one holding a
  `:` stops the push. One Medplum turned off after failed deliveries is
  reported and turned back on.
- **Removal is gentle:** `--prune` clears a removed bot's schedule and turns
  a removed Subscription off. A bot is never deleted, since that would break
  every webhook pointing at it.
- **Scoped to some environments:** `environments: ['dev']` on a bot keeps
  it, and the operations it implements, out of every other environment, so
  a bot still being built never runs on a schedule or answers a webhook in
  production. A Subscription takes its bot's scope unless it names a
  narrower one. Each push and `--check` lists what it left out in a `scope`
  step; one an environment already holds is treated as removed. A test
  project runs every bot, and the migrations bot has no scope.
- **Existing bots and Subscriptions** the project made by hand are adopted
  with `--adopt`: a bot by its name, keeping its id, membership and webhook
  URL; a Subscription by its criteria and endpoint. Until then, `push` names
  them and stops.
- **Features only a super admin can turn on:** the project needs `bots`, and
  `cron` when a bot has a schedule. `push` checks both before writing
  anything (`bots-disabled`, `cron-disabled`).
- **`push --check`** reports bots and Subscriptions edited in the console,
  and code deployed by hand, as drift.

A bot that throws when a Subscription runs it counts as delivered in
Medplum: it is not retried, and the Subscription stays on. Check the bot's
AuditEvents, not the Subscription's status.

## Operations and typed bots

A custom operation is a contract: its code, the bot that implements it, and
what goes in and comes out. Each side is a resource type, a selected profile,
or any [Standard Schema](https://standardschema.dev) value (Zod, Valibot,
ArkType and others implement it), so Plumb adds no schema library. List the
modules that hold contracts in `operations`, and `generate` writes
`defineOperation`, `callOperation` and `handleOperation` into the generated
folder, so neither an app nor a bot takes a runtime dependency on Plumb.

```ts
// src/operations/send-message.ts
import { z } from 'zod';
import { defineOperation } from '../fhir/generated/index.js';

export const sendMessage = defineOperation({
  code: 'send-message',
  level: 'type',
  resource: 'Communication',
  bot: 'messenger',                                  // a key in bots
  input: z.object({ to: z.string(), text: z.string().min(1) }),
  output: 'Communication',                           // or a selected profile's URL
});
```

```ts
// in plumb.config.ts
operations: ['./src/operations/*.ts'],
```

The caller and the bot share the contract. Both check at run time, so a
malformed message is refused before it is sent, and a handler that returns the
wrong thing fails in the bot:

```ts
// in the app
const sent = await callOperation(medplum, sendMessage, { to: 'Patient/1', text: 'Hi' });
//    ^? Communication

// the bot's bundle
export const handler = handleOperation(sendMessage, async (medplum: MedplumClient, input) => {
  // input: { to: string; text: string }; the return must be a Communication
  return medplum.createResource({ resourceType: 'Communication', status: 'completed' });
});
```

- **A JSON side is checked by its schema,** a resource type by
  `resourceType`, a profile by the generated `asProfiled`: its stamp and what
  its type requires. Full validation stays Medplum's, on write.
- **A failed check is an `OperationError`** carrying an OperationOutcome with
  each issue and its path (`input.text: Required`). In a bot, Medplum answers
  it with a 400, which `callOperation` throws as an `OperationError` too.
- **`push` writes the OperationDefinition** for each contract, in an
  `operations` step between `bots` and `subscriptions`: its code, level and
  resource, its `return` or `result` out parameter, and this environment's
  `Bot/<id>`, so no file holds an id. It is found again by Plumb's tag;
  `--prune` deletes a removed one, since Medplum ignores `status`.
- **Checked before anything is written:** a code used twice or one Medplum
  already has, a bot `bots` lacks, a type or instance operation without its
  resource, and a profile that is not selected (`invalid-operation`). An
  OperationDefinition with the same code that Plumb did not write in the
  project, or any in a project it links, even one Plumb wrote there, stops
  the push (`shadowed-operation`): Medplum would run either.

```text
✔ operations     plan: 1 to create, 0 to update, 0 to delete
    + OperationDefinition  $send-message → Bot messenger
✔ operations     applied 1 change
```

Contract modules load as the config does: with Node's type stripping, so a
relative import needs its `.ts` extension, or with the project's tsx when it
is installed.

### Typed bot handlers

With `bots` in the config, `generate` writes `defineBot`, whose `event` is
typed by what the bot's triggers send it and the secrets it declares:

```ts
import { defineBot } from '../fhir/generated/index.js';

export const handler = defineBot('send-reminder', async (medplum, event) => {
  if (event.input.resourceType === 'Appointment') {
    // from the new-appointment Subscription
  } else {
    // event.input is the Bot: the schedule ran it
  }
  const key = event.secrets.SMS_API_KEY.valueString; // only declared secrets
});
```

| Trigger | `event.input` |
| --- | --- |
| A Subscription on `Appointment?…` | `Appointment`, or `{ deletedResource: Appointment }` when it includes `delete` |
| A schedule | `Bot` |
| A webhook | `string` with `rawBody`, otherwise `unknown`: the body is the bot's to check |
| An operation | the contract's input, through `handleOperation` |

## Test against a real server

`MockClient` keeps everything in memory and enforces none of what
`plumb.config.ts` declares: no profile, no `defaultProfile`, no strict mode,
no AccessPolicy. Keep it for unit tests. For the claims only a server can
check, a test environment gives each test run a real Medplum, in Docker,
with a project `push` has converged from the same config.

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { globalSetup: ['plumb-fhir/vitest'] },
});
```

The global setup starts Medplum, Postgres and Redis, makes one strict
project for the run, pushes the config into it (profiles, then `project`),
and loads the seed data. A server already running is reused and left
running; one it started is removed at the end of the run. Tests reach the
project with `testProject()`, and log in to it with `connectAs`:

```ts
import { connectAs, testProject } from 'plumb-fhir/test';
import { expect, test } from 'vitest';

test('the front desk cannot read observations', async () => {
  const medplum = await connectAs(testProject(), { accessPolicy: 'front-desk' });
  await expect(medplum.searchResources('Observation')).rejects.toThrow(/forbidden/i);
});

// With a defaultProfile for Patient that requires birthDate.
test('a patient without a birth date is refused', async () => {
  const medplum = await connectAs(testProject());
  await expect(
    medplum.createResource({ resourceType: 'Patient', name: [{ family: 'Synthetic' }] }),
  ).rejects.toThrow(/birthDate/);
});
```

The project has the config's bots and Subscriptions too, so a test can
trigger a bot the way production does:

```ts
// With bots: { 'send-reminder': … } and subscriptions:
// { 'new-appointment': { criteria: 'Appointment?status=booked', bot: 'send-reminder' } }
test('a booked appointment runs send-reminder', async () => {
  const medplum = await connectAs(testProject());
  const appointment = await medplum.createResource({
    resourceType: 'Appointment',
    status: 'booked',
    participant: [{ status: 'accepted', actor: { display: 'Synthetic' } }],
  });
  const bot = await medplum.searchOne('Bot', { name: 'send-reminder' });
  const events = async () =>
    JSON.stringify(await medplum.searchResources('AuditEvent', { entity: `Bot/${bot?.id}` }));
  await expect.poll(events, { timeout: 15_000 }).toContain(appointment.id);
});
```

`connectAs(project)` logs in as the project's admin client;
`{ client: 'kiosk' }` as a client from `project.clients`; and
`{ accessPolicy: 'front-desk', parameters }` as a new client whose membership
has that policy, with its parameters (`{ patient: { reference: 'Patient/…' } }`
for a `%patient` policy). AccessPolicies are tested by acting as them. A key
the config does not declare throws `unknown-client` or `unknown-policy`.

What the test project has beyond what `push` writes goes in `test`:

```ts
// in plumb.config.ts
test: {
  server: '5.1.42',             // optional; the installed @medplum/core's release by default
  strictMode: true,             // the default; false rehearses a loose project
  features: ['bots'],           // the default, with 'cron' when a bot has a schedule
  settings: { intakeEnabled: true }, // merged over project.settings
  seed: ['./test/seed/*.json'], // transaction or batch Bundles, loaded in order
  bots: { 'send-reminder': { file: './dist/test/send-reminder.cjs' } }, // a test build
},
```

The test server's super admin sets `strictMode` and `features`, which
`project` cannot. Seed files load after the push, so a seed resource that
breaks its profile fails the setup, naming the file and the entry. Keep seed
data synthetic. Secrets resolve from the environment as `push` resolves them.

- **Docker** is the one requirement. Without it the setup fails in CI and,
  locally, warns, and `testProject()` throws. The first run pulls the images,
  about a minute; a project and its push take seconds.
- **Other runners** call the plain functions from their own global setup:
  `startServer`, `createTestProject` and `stopServer` from `plumb-fhir/test`.
  `createTestProject` and `migrate` take the config as `loadConfig` returns
  it (a `LoadedConfig`), and report a push or a run as `{ ok, errors, steps }`.
  `plumb-fhir/vitest` hands the project to the tests in the
  `PLUMB_TEST_PROJECT` environment variable, which `testProject()` reads.
- **Bots run on Medplum's `vmcontext` runtime** in the test server, whatever
  their `runtime`. Hosted Medplum runs them on AWS Lambda, so a test
  environment cannot show Lambda's differences. vmcontext runs CommonJS that
  assigns `exports.handler`, and its `require` reaches the server's own
  packages, so a bundle that leaves only `@medplum/*` external runs there;
  one built for a Lambda layer names a test build in `test.bots`.
- **The super admin exists only in the server Plumb starts,** so a test
  project is never made on any other server.

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
- **Plumb never sets strict mode** or `features`; a super admin does.
- **Content is the same in every environment,** and so is each field of a
  bot or Subscription where it is deployed. Two environments that need
  different Questionnaires or Organizations are two configs.
- **Every failure blocks `push`:** a baseline of accepted failures comes
  later. Another writer can still load StructureDefinitions around `push`
  unless the [lockdown](#lock-the-project-down) keeps them read-only.
- **A custom operation called by `GET` with a query string is not found**
  by Medplum, which reads the query as part of the code; `callOperation`
  always POSTs.
- **An instance operation's bot gets the stored resource,** not the body
  sent, so its input side is the resource's type.
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
