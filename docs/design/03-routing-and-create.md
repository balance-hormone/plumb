# Design 03: Routing and `createProfiled`

**Status: implemented in v0.3.** Builds the spec's "Routing and `create`" (user story 10).
Read the [US Core 9.0.0 routing](../research/us-core-9-routing.md) research
first: it is the evidence for which routes generate and which need config.

## Job

Medplum validates a resource against the profiles in its `meta.profile`, and
nothing else. When `meta.profile` is absent it applies the project's
`defaultProfile` for the type, one list per type. So a heart rate, a lab result
and a smoking status written without a stamp are all held to the same
Observation default, or to nothing, and a heart rate stamped by hand as
`us-core-heart-rate` silently loses the default, because a stamp replaces it
([research](../research/medplum-server-behaviour.md#projectdefaultprofile)).

Plumb picks the profile from the resource's content and stamps it:

```ts
import { createProfiled } from './fhir/generated/index.js';

const hr = await createProfiled(medplum, {
  resourceType: 'Observation',
  status: 'final',
  category: [USCoreHeartRate.vsCat({})],
  code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
  // …
});
hr.meta?.profile; // ['…/us-core-heart-rate']
```

## How others do it

- **FHIR servers do not route.** HAPI, AWS HealthLake and Azure Health Data
  Services validate only the profiles a resource declares in `meta.profile`;
  none selects a profile from content. Medplum's `defaultProfile` is per type.
  So routing belongs in the writer, which is where Plumb's generated code is.
- **Zod's `discriminatedUnion`** picks a schema by the value of one key, and
  refuses a value no option claims. Routing is the same with FHIR's keys: a
  code, a category, the fixed and pattern values a profile pins.
- **ORM single-table inheritance** (Prisma's and Drizzle's recipes, Rails' STI)
  picks the subclass from a discriminator column, and the most derived class
  wins. Plumb's profiles form the same tree: every US Core vital sign is also a
  `us-core-vital-signs`, and the more specific profile wins.

## Where it lives: generated into `out`

`generate` writes the routing table and the functions that use it next to the
types, as it already writes `_plumb.ts`'s helpers. Apps take no runtime
dependency on Plumb, and the table is reviewed in the same diff as the profile
change that moved it.

The generated index exports three functions:

- **`route(resource)`** is pure and offline: it returns the URL of the profile
  the resource's content selects, `undefined` when no selected profile
  constrains its type, or throws a `RoutingError` naming the candidates. It
  needs no client, so a test can assert a route directly.
- **`createProfiled(medplum, resource, options?)`** routes, stamps and calls
  `medplum.createResource`. It never mutates the caller's object.
- **`updateProfiled(medplum, resource, options?)`** routes again from the new
  content, restamps, and calls `medplum.updateResource`.

The names match `validateProfiled`. They take a `ProfiledClient`, the two
methods of `MedplumClient` they call, declared in the generated code: a
`MedplumClient` is one, and the generated files need no `@medplum/core`
declarations (which need Node's types) to compile. A refusal rejects the
promise before anything is written.

## The routing rows

Each selected profile gets one row per resource type:

```ts
// _routes.ts (generated)
export const routes = {
  Observation: [
    {
      profile: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-heart-rate',
      parents: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-vital-signs'],
      keys: [
        ['category', { coding: [{ system: '…/observation-category', code: 'vital-signs' }] }],
        ['code', { coding: [{ system: 'http://loinc.org', code: '8867-4' }] }],
      ],
    },
    // …
  ],
} as const;
```

- **Keys are generated from the profile:** each fixed or pattern value on a
  first-level element, and each required slice's discriminator values (US
  Core's `category:VSCat`). Matching uses `_plumb.ts`'s existing `matches`,
  which already has FHIR's pattern semantics, so a resource with extra codings
  still matches.
- **`parents`** is the profile's `baseDefinition` chain, as far as it runs
  through selected profiles.
- **A profile with no keys matches every resource of its type.** That is right
  for a type with one profile (`us-core-patient`), and the ambiguity check
  below catches it where it is not.

### Config rows, for profiles keyed on a value set

Some profiles select by value-set membership, not a pinned value: smoking
status's code is bound to a VSAC value set Plumb cannot expand offline. Those
get a row in config, added to the generated keys:

```ts
export default defineConfig({
  // …igs, profiles, out as today
  routes: {
    'http://hl7.org/fhir/us/core/StructureDefinition/us-core-smokingstatus': {
      code: [{ system: 'http://loinc.org', code: '72166-2' }],
    },
    // Never routed: chosen only with { profile }.
    'http://hl7.org/fhir/us/core/StructureDefinition/us-core-adi-documentreference': false,
  },
});
```

- A row maps a first-level element to the codings (or, for a `code`, the
  strings) that select the profile. The resource matches when the element
  holds any of them.
- **`false` takes a profile out of routing,** for profiles that differ by
  intent, not content. Its type keeps its routing rows, so a type whose
  profiles are all `false` makes `route` refuse rather than return
  `undefined`.
- A row for a profile that is not selected is a config error, as today.

### Most specific wins

`route` keeps every row whose keys all match, then drops any match that is a
parent of another match. One left: it wins. None, or several unrelated: it
throws.

### Ambiguity is found at generate time

`generate` checks each pair of unrelated profiles on a type: when their keys
do not conflict on any element, one resource could match both, and `generate`
warns, naming both profiles and suggesting a `routes` row:

```text
⚠ routes    us-core-smokingstatus and us-core-observation-occupation can both match
            an Observation; add a `routes` row to tell them apart
```

It is a warning, not an error, because `route` still refuses at run time
rather than guess. `generate --check` reports it too.

## The stamp

```ts
defineConfig({
  defaultProfile: {
    Observation: ['https://example.org/fhir/StructureDefinition/org-observation'],
  },
});
```

- **`createProfiled` stamps the defaults plus the routed profile,** because a
  stamp replaces Medplum's `defaultProfile`, and the defaults would otherwise
  stop applying to exactly the records routing touched. A default that is a
  parent of the routed profile is left out: the child already holds its rules.
- **`defaultProfile` in `plumb.config.ts`** has the shape of Medplum's
  `Project.defaultProfile`, so the later `push` of
  [project config as code](../future/project-config-as-code.md) sets the
  server's defaults from the same field. Until then, keeping the two in step
  is the project's job, and the docs say so.
- **Bare URLs only.** Medplum matches bare URLs, so a `url|version` stamp
  validates nothing ([prior art](../research/prior-art.md)).
- **When no selected profile constrains the type,** `createProfiled` leaves
  `meta.profile` absent, so the server applies its own default as it would
  for `createResource`.

## When nothing matches

`route` refuses, and says what would select each candidate:

```text
RoutingError: no profile matches this Observation.
  us-core-heart-rate      needs category vital-signs, code http://loinc.org|8867-4
  us-core-smokingstatus   needs category social-history, code http://loinc.org|72166-2
  …
Pass { profile } to choose one, or { profile: false } to write it unprofiled.
```

- **`{ profile: SomeProfileUrl }`** skips routing and stamps that profile (plus
  the defaults). The option is typed as the union of selected profile URLs,
  and with it the call returns that profile's type.
- **`{ profile: false }`** writes the resource with no Plumb stamp, on purpose.
  The server's default then applies.
- It does not fall back to the parent or the default: a guess would store a
  lab result held to the wrong rules, and silently is the failure this feature
  exists to stop.

## Updates re-route

A code can be corrected after a write, and the record should then be held to
the profile its content now selects. So `updateProfiled` routes the new
content and replaces the stamps Plumb manages (selected profile URLs and the
configured defaults), keeping any other URL in `meta.profile`. It refuses on
no match, as `createProfiled` does, with the same options.

## Types

```ts
function route(resource: Resource): ProfileUrl | undefined;
function createProfiled<T extends Resource>(medplum: MedplumClient, resource: T): Promise<T>;
function createProfiled<U extends ProfileUrl>(
  medplum: MedplumClient,
  resource: ProfileTypes[U],
  options: { profile: U },
): Promise<ProfileTypes[U]>;
```

`ProfileUrl` and `ProfileTypes` are generated alongside the index: the union
of selected profile URLs, and a map from each to its type.

## Testing

- **Routing is tested offline** against US Core 9.0.0's own examples: an
  example's `meta.profile` is its expected route, a source independent of the
  generator. Each must route to the profile it claims, or to one more specific.
- **Contract tables for routing** on Plumb's synthetic profiles: a parent and
  child, two siblings that conflict, two that do not (the warning), a
  value-set-keyed profile with a config row, and `false`.
- **Against a real Medplum server** (the Docker server from
  [design 02](02-conformance-check.md)): `createProfiled` stores the defaults
  plus the routed profile and the server validates against both; a resource
  refused by routing never reaches the server; `updateProfiled` restamps and
  keeps foreign URLs; `{ profile: false }` gets the server's default.
- **Generated output** joins the goldens: `_routes.ts` for the US Core and IPS
  profiles already there.

## Later (not in this design)

- **A lint rule** flagging `medplum.createResource` on a routed type, so writes
  go through `createProfiled`. `validate` already counts unstamped resources
  after the fact; a lint rule would add a plugin to maintain.
- **Expanding listable value sets into rows** instead of config rows.
- **Typed reads**, which return the profile type and assert the stamp that
  `createProfiled` writes.

## Open questions

- **Keys below the first level** (a `component` code, an extension): none of
  US Core's routes need them; whether any published IG does.
- **Absence as a key:** the spec allows it (US Core Coverage's `us-core-15`),
  but no route needs it yet.
- **Batch and transaction bundles:** whether to route each entry of a bundle
  passed to `executeBatch`, or leave bundles to `route` directly.
