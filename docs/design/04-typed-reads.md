# Design 04: Typed Reads

**Status: accepted** on 2026-10-02. Builds the spec's "Typed reads" (user
story 11), tracked in the v0.4 milestone. Read
[design 03](03-routing-and-create.md) first: typed reads check the stamp
`createProfiled` writes, and reuse its `ProfileUrl`, `ProfileTypes` and
routing parents.

## Job

Every Medplum read returns base R4. `medplum.readResource('Patient', id)` is a
`Patient`, so a component that needs a US Core Patient casts, and the cast
claims a name and a birth date that nothing checked. v0.1 types what an app
writes, v0.2 checks what is stored, v0.3 stamps writes. Reads are the one edge
still typed as base R4.

Plumb returns the profile type from a read only after checking the resource
holds what that type promises:

```ts
import { readProfiled, searchProfiled, USCorePatientProfileUrl } from './fhir/generated/index.js';

const patient = await readProfiled(medplum, USCorePatientProfileUrl, id);
patient.birthDate; // string, not string | undefined

const bps = await searchProfiled(medplum, USCoreBloodPressureProfileUrl, { patient: `Patient/${id}` });
```

## Why the stamp is not enough

The spec's version of this feature asserts the stamp and trusts it. Medplum's
source says a stamped record can still be missing what its profile requires,
in four ways:

- **It was written while the project was loose.** With `strictMode` off the
  server only logs a profile failure and stores the record, stamp and all
  ([research](../research/medplum-server-behaviour.md#validation)).
- **The profile tightened after the write.** Loading a stricter version
  re-checks nothing that is stored. A bare-URL stamp names the profile, not the
  version the record passed.
- **An AccessPolicy hides a field.** `removeHiddenFields` (`repo.ts`) deletes
  each `hiddenFields` path from every read and search result, and adds no
  `SUBSETTED` tag. A policy that hides `Patient.birthDate` hands a reader a
  stamped US Core Patient with no birth date.
- **The read asked for a subset.** `_elements`, its Medplum alias `_fields`,
  and `_summary=true|text|data` all run `subsetResource` (`search.ts`), which
  keeps the stamp. Those, at least, add a `SUBSETTED` tag.

`plumb validate --env` (design 02) is what proves stored data conforms. But it
runs as a check, not on every read, and it cannot see an AccessPolicy that hides
fields from one reader. So a typed read checks two things: the stamp, and what
the type promises is present.

## How others do it

Read from each project's docs and source, October 2026.

- **Trusting the stamp is the common shortcut.** HAPI FHIR's
  `setDefaultTypeForProfile` picks a profile's class from `meta.profile` alone,
  and fhir-dsl's `search(type, profileUrl)` types its results as the profile
  without checking them unless `.validate()` is chained. Both type a record by
  its claim, which the four cases above show can be false.
- **`@atomic-ehr/codegen`'s `Profile.from(resource)`** is the nearest to
  `asProfiled`: it checks `meta.profile`, validates, and throws. It runs a full
  validator; Plumb checks only what the type claims, so it stays a few lines
  of generated code with no definitions to load.
- **A list with a bad item fails as a whole by default:** tRPC and ts-rest
  on a failed output schema, Zodios, Prisma on a stored enum value the schema
  does not know (users asking for the row to be skipped instead,
  prisma#24288), Zod's `z.array`, and fhir-dsl's `.validate()`.
- **Where partial results exist, they are opt-in and never silent.** Relay's
  `@catch` turns a failure into `{ ok: false, errors }` at the call site that
  asked, because "some components may be able to recover better from missing
  data than others". Firely's `DeserializationFailedException` carries the
  `PartialResult` with every error it collected. Rust's `serde_with::VecSkipError`
  skips bad elements and reports each one through an `InspectError` hook. Zod
  never added a skip mode, despite repeated requests.
- **No FHIR library's validator takes a Bundle.** HAPI
  (`BundleUtil.toListOfResourcesOfType`), Firely (`ByResourceType<T>`) and
  fhirclient.js flatten and filter by type first, and checks run per
  resource. fhir-dsl checks a search's matches and leaves its `_include`s
  alone.
- **Prisma's `select`** changes the return type to the fields selected. Plumb
  does not try to type a subset; it refuses one, because a profile type with
  holes is no longer the profile type.

## Where it lives: generated into `out`

The functions are generated next to `createProfiled`, as design 03 generates
routing, so apps still take no runtime dependency on Plumb. `MedplumClient`
stays a type-only import.

The generated index exports five functions:

- **`isProfiled(resource, profile)`** is pure and offline: a type guard that is
  true when the resource carries the stamp and holds every path the type
  requires. It is the check the others run, and the one to use on a single
  resource from anywhere else: a subscription, a bot's input.
- **`asProfiled(resource, profile)`** returns the resource as the profile type
  or throws a `ProfileReadError`.
- **`pickProfiled(resources, profile)`** is pure and offline too: it keeps the
  resources stamped with the profile, checks each, and returns them as the
  profile type, or throws when a stamped one fails. It is for a mixed list:
  a Bundle's entries, a page of `readPatientEverything`.
- **`readProfiled(medplum, profile, idOrReference)`** calls
  `medplum.readResource` (or `readReference`, given a `Reference`) and
  `asProfiled`.
- **`searchProfiled(medplum, profile, query?)`** adds the profile to the query,
  calls `medplum.searchResources` and runs `pickProfiled` on the results.

The names match `validateProfiled` and `createProfiled`. One function per kind
of read, keyed by the profile URL, keeps the index small; the spec's "a helper
per profile" is the same thing as one function typed by `ProfileUrl`.

## The stamp check

- **The stamp matches when `meta.profile` holds the profile's bare URL, or a
  selected profile whose parents include it.** A heart rate stamped
  `us-core-heart-rate` is a `us-core-vital-signs`. The parents are design 03's
  routing `parents`, so the two features share one table.
- **A `url|version` stamp does not match.** Medplum validated nothing against
  it, and `validate` already reports it as a silent stamp.
- **No stamp, no match.** A record written under `defaultProfile` carries the
  default's URLs, because the server writes them into the stored resource
  ([research](../research/medplum-server-behaviour.md#projectdefaultprofile)),
  so it reads typed without ever going through `createProfiled`.

## The presence check

`generate` writes, for each selected profile, the paths its type makes
required beyond `@medplum/fhirtypes`, into `_reads.ts`:

```ts
// _reads.ts (generated)
export const required = {
  'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient': [
    ['identifier'],
    ['identifier', 'system'],
    ['identifier', 'value'],
    ['name'],
    ['telecom', 'system'],
    ['telecom', 'value'],
  ],
  'http://hl7.org/fhir/us/core/StructureDefinition/us-core-blood-pressure': [
    ['category'],
    ['subject'],
    ['component'],
    ['effectiveDateTime', 'effectivePeriod'],
  ],
} as const;
```

- **The table comes from the same transform that emits the type,** so the two
  cannot drift: a path is in the table exactly when the type makes it
  required.
- **A row is a set of alternatives,** so a required choice (`effective[x]`)
  is met by any one of its narrowed types.
- **Nested paths apply to every entry present.** `telecom.system` requires a
  system on each telecom, and still allows none, as the type does.
- **Base R4's required elements are left out.** `@medplum/fhirtypes` already
  types them as present, and the server's base schema check enforces them even
  when the project is loose.
- **It checks presence, not values.** Fixed and pattern values, bindings and
  slices stay the validator's job. A missing element is what loose writes,
  hidden fields and subsets produce; a wrong code under a stamp is not.
- **It follows the type, not the validator.** A primitive the profile requires,
  present only as `_birthDate`, validates but does not compile (design 01 lists
  the case), and it fails the presence check too, because the type says
  `birthDate` is there.
- **Slicing and recursion follow the type too.** Closed slicing requires what
  every slice requires; ordered slicing requires each position's paths at that
  index (`name.0.family`); a backbone element that refers to itself repeats its
  paths at every depth (`item.item*.text`).

The walker is a few short functions in `_plumb.ts`, next to `matches`.

## Search

`searchProfiled` adds `_profile` to the query: the profile's URL alone, or,
when selected profiles have it as a parent, those URLs too, comma-separated.
Medplum stores `meta.profile` in a `_profile` `TEXT[]` column with a GIN
index on every resource table, so the search returns only stamped records and
the presence check rarely fails.

- **The filter is for correctness, not speed.** Filtering stamps in the client
  instead would shrink pages unpredictably: asking for 20 could return 3.
- **One URL where it can.** Medplum compiles one value to `@>` and several to
  `&&`, and its source keeps `@>` for one value because it "can lead to better
  query plans" (`sql.ts`).
- **A profile URL is a common value,** so `_profile` narrows little on its own.
  Postgres plans from the more selective filter a search usually also has
  (`patient`, `subject`) and checks `_profile` along the way. Medplum's
  known array-statistics problems (#7310, #7539) misestimate *rare* values,
  the opposite case. The docs advise pairing `_profile` with a selective
  filter on large tables.

It refuses, before any request:

- **`_elements`, `_fields` and `_summary`,** any value. Each returns a subset
  (`_summary=count` returns no resources at all).
- **`_include` and `_revinclude`.** Included resources come back in the same
  Bundle, and `searchResources` returns every entry's resource, so the array
  would hold other types. Read them with a plain search, or with
  `readProfiled` from a reference.

```text
ProfileReadError: searchProfiled(us-core-patient) refuses _elements: a subset
is not a us-core-patient. Use medplum.searchResources for a subset.
```

**One failing result fails the search, and the error carries the rest.**
Dropping a failing record would hide it from a list without saying so; for a
blood pressure in a chart, that is worse than an error. Failing with nothing
to show breaks the whole view over one record. So, as Firely does, the
`ProfileReadError` holds `passed`, the records that passed, typed, and
`failed`, each failing record's reference and missing paths:

```ts
let bps: USCoreBloodPressure[];
try {
  bps = await searchProfiled(medplum, USCoreBloodPressureProfileUrl, { patient });
} catch (err) {
  if (!ProfileReadError.is(err, USCoreBloodPressureProfileUrl) || err.reason !== 'missing') throw err;
  bps = err.passed;
  showNotice(`${err.failed.length} records could not be shown`);
}
```

The default stays safe, the caller who can recover does so without a second
request, and nothing disappears silently. It needs no option and no second
function. `validate` is still how to find every failing record.

## History is not offered

There is no `readHistoryProfiled` or `readVersionProfiled`. An old version may
predate its stamp, strict mode or the profile version now loaded, and a reader
of history wants what was stored, not what conforms. `asProfiled` is there for
a caller who wants to check one version anyway.

## The error

```text
ProfileReadError: Patient/123 is not a us-core-patient.
  missing  Patient.birthDate
Stamped records lack required data when written while the project was loose,
when an AccessPolicy hides the field, or when the profile tightened since.
See `plumb validate --env <env>`.
```

- **It names the record and the paths, never their values.** The message ends
  up in logs, and the values are clinical data.
- **`reason`** is `'unstamped'`, `'missing'` or `'refused'`, so a caller can
  tell an AccessPolicy problem from a data problem without parsing the message.
- **`failed`** lists each failing record's reference and missing paths.
- **`passed` is non-enumerable.** Error trackers and loggers copy an error's
  enumerable properties into their reports, so an enumerable `passed` would
  put clinical data in logs. `JSON.stringify`, spreads and those serializers
  skip it; `err.passed` still reads it.
- **`ProfileReadError.is(err, profile)`** narrows a caught error to the
  profile's, so `passed` is typed. It is empty from `asProfiled` and
  `readProfiled`.

## Types

```ts
function isProfiled<U extends ProfileUrl>(resource: Resource, profile: U): resource is ProfileTypes[U];
function asProfiled<U extends ProfileUrl>(resource: Resource, profile: U): ProfileTypes[U];
function pickProfiled<U extends ProfileUrl>(resources: readonly Resource[], profile: U): ProfileTypes[U][];
function readProfiled<U extends ProfileUrl>(
  medplum: MedplumClient,
  profile: U,
  idOrReference: string | Reference<ProfileTypes[U]>,
): Promise<WithId<ProfileTypes[U]>>;
function searchProfiled<U extends ProfileUrl>(
  medplum: MedplumClient,
  profile: U,
  query?: QueryTypes,
): Promise<WithId<ProfileTypes[U]>[]>;
```

`WithId` and `QueryTypes` are type-only imports from `@medplum/core`, as
`MedplumClient` already is.

```ts
class ProfileReadError<U extends ProfileUrl = ProfileUrl> extends Error {
  static is<U extends ProfileUrl>(err: unknown, profile: U): err is ProfileReadError<U>;
  readonly profile: U;
  readonly reason: 'unstamped' | 'missing' | 'refused';
  readonly failed: readonly { reference: string; missing: readonly string[] }[];
  readonly passed: readonly WithId<ProfileTypes[U]>[]; // non-enumerable
}
```

`pickProfiled` returns a typed array on TypeScript 5.0, where
`resources.filter((r) => isProfiled(r, url))` would stay `Resource[]`:
inferring a type predicate from an arrow function arrived in 5.5.

## Testing

- **The presence check agrees with `compiles`.** Every contract fixture that
  compiles against its profile passes `isProfiled` once stamped, and every one
  that fails to compile for a missing element fails it. The contract tables
  already record `compiles`, so this needs no new expectations.
- **US Core 9.0.0's examples** each pass `isProfiled` for the profile they
  declare, and for that profile's parents.
- **`pickProfiled` on a mixed list** of US Core examples keeps exactly the
  ones stamped with the profile or a child, and throws on a stamped one with a
  required element removed, with the others in `passed`.
- **The error keeps clinical data out of serialization:** `JSON.stringify`,
  `Object.keys` and a spread of a `ProfileReadError` hold no resource.
- **Against a real Medplum server** (design 02's Docker server), each claim in
  "Why the stamp is not enough" has a test:
  - a record stored while the project is loose, stamped but missing a required
    element, reads as `missing`;
  - an AccessPolicy with `hiddenFields` on a required element makes
    `readProfiled` fail for that reader and pass for an admin;
  - a record written under `defaultProfile` carries the stamp and reads typed;
  - `_profile` with one URL, and with comma-separated URLs, returns parent-
    and child-stamped records, and no unstamped ones;
  - a search with one failing record throws with the rest in `passed`;
  - a refused query makes no request.
- **Generated output** joins the goldens: `_reads.ts` for the US Core and IPS
  profiles already there.

## Later (not in this design)

- **Paged search** (`searchProfiledPages`, over `searchResourcePages`) for
  lists too big for one page.
- **`@medplum/react` hooks** (`useProfiledResource`, `useProfiledSearch`).
  They would add a type import from a package not every app has.
- **Checking fixed and pattern values on read,** if `validate` keeps finding
  stamped records whose code no longer matches their profile.
