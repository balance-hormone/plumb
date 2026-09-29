# Medplum Server Behaviour

What Medplum's server actually does with profiles, defaults, strict mode and
access policies. Every claim here was read from the server source
(`medplum/medplum`, `packages/server` and `packages/core`, releases
5.1.41–5.1.42 and `main` on 2026-09-28, re-checked against `main` at
`10ee734f4` on 2026-09-29, where every file cited is unchanged from v5.1.42)
unless marked **inferred**. Line numbers drift; the function names
are the stable reference.

Plumb's design depends on each of these, so each one is a candidate for a test
against a real Medplum server in CI.

## Validation

- **Validation runs in Node, before the insert.** Resource bodies are stored as
  `content TEXT`; Postgres never sees a profile. A real `CHECK` constraint was
  considered and rejected: deleted rows store `''`, every reindex rewrites
  `content` (so one bad row would block Medplum's post-deploy reindexes), and
  it would be a second hand-kept copy of the profile.
- **With `Project.strictMode` off, only the base R4 JSON schema is enforced**
  (`validation.ts`, `validateRepositoryResource`): unknown resource types,
  wrong property types, unknown properties, missing base-required properties
  and nulls still fail the write. Everything else (base StructureDefinition
  cardinality and invariants, every profile, terminology) runs, and on failure
  is only logged as "Strict validation would fail". The write succeeds.
- **New projects start strict.** `$init` creates a project with
  `strictMode: true` (`projectinit.ts`). Loose projects are older ones, or ones
  someone switched off.
- **Even in strict mode, some rules are never enforced** (`core`,
  `typeschema/validation.ts`):
  - a constraint whose severity is not `error` is skipped entirely, not even
    warned;
  - the invariants `ele-1`, `dom-3`, `org-1` and `sdf-19` are skipped;
  - a `Reference` whose `targetProfile` is an IG profile (US Core Patient,
    say) is not checked at all; one whose target is a base or Medplum type
    only warns on a mismatch.
  So a profile's `Reference(X)` narrowing is documentation, not a rule.
- **An unknown profile URL** in `meta.profile` logs "Unknown profile
  referenced" and passes.
- **A versioned `url|version` stamp** matches no loaded profile and also passes.
  The lookup is an exact match on `url` and nothing splits off `|version`.
- **Creating or updating a StructureDefinition** clears its entry in a Redis
  profile cache (five-minute TTL, keyed by project and URL). Nothing re-checks
  stored resources. A stricter version arms a failure in the next write of
  every stored record that does not meet it.
- **"Newest" is a text sort on `version`, then `date`** (`loadProfile`, whose
  own comment says it "approximates version resolution"). `version` is a token
  column, sorted alphabetically, so `1.9.0` is newer than `1.10.0`. With more
  than one StructureDefinition per URL in a project, the one that validates is
  not reliably the one intended. Loading a version is what switches its rules
  on for every resource already stamped with that URL.
- **The lookup spans linked projects.** A profile is found in the caller's
  project, in any linked project that exports StructureDefinition (or exports
  nothing), and in Medplum's base R4 project (`repo.ts`, `accesspolicy.ts`).
  The cache prefers the caller's own project; the database search does not.
- **Strict mode is project-wide.** There is no per-type setting.
- **Deleting a StructureDefinition does not clear the cache.** A cached copy
  keeps validating for up to five minutes, then validation for that URL stops.
  Stored resources keep their `meta.profile` and go unchecked.
- **`POST /:resourceType/$validate` always validates strictly**, whatever
  `strictMode` says, against the profiles loaded in the project. The body is
  the raw resource (not `Parameters`), and `defaultProfile` is not applied, so
  the resource must carry its `meta.profile`.
- **Writes through the system repository get no default profile**: it has no
  current project (`repo.ts`), so for example a ClientApplication created by
  `POST /admin/projects/:id/client` is never defaulted.

## `Project.defaultProfile`

From `repo.ts`, `checkResourcePermissions`:

```ts
if (!resource.meta?.profile) {
  const defaultProfiles = this.currentProject()?.defaultProfile?.find(
    (o) => o.resourceType === resourceType
  )?.profile;
  if (defaultProfiles?.length) {
    resource.meta = { ...resource.meta, profile: defaultProfiles };
  }
}
```

- **Applies only when `meta.profile` is absent.** An empty array `[]` is truthy,
  so a resource written with `meta.profile: []` skips the default and is
  validated against nothing. Plumb's `check` must flag this, and it is a
  candidate upstream fix.
- **Writes the default's URLs into the stored resource.** A record validated
  under its default carries the stamp afterwards, which is what lets typed
  reads assert a stamp even on records no helper wrote.
- **Uses the first entry per resource type**, and every profile in that entry's
  list must pass.
- **A stamp replaces the default entirely.** A writer that stamps a specific
  profile must also stamp the floor it wants, or the default's rules no longer
  apply to that record.

## Project fields and who can write them

- **Project admins can PUT or PATCH their own Project** through plain FHIR,
  under a policy the server injects (`accesspolicy.ts`,
  `applyProjectAdminAccessPolicy`) with:
  - `readonlyFields: ['features', 'link', 'systemSetting']`
  - `hiddenFields: ['superAdmin', 'systemSecret', 'strictMode']`
- **Readonly and hidden fields are silently restored** from the stored version
  on write (`repo.ts`, `restoreReadonlyFields`). An admin write that sets
  `strictMode` or `features` succeeds and changes nothing.
- So **`strictMode`, `features`, `link` and `systemSetting` are super-admin
  only**. `defaultProfile`, `setting`, `secret`, `site` and
  `defaultAccessPolicies` are writable by a project admin.
- **`GET /auth/me` returns `project.strictMode` and `project.features` to any
  authenticated member** (`auth/me.ts`), even though reading `Project` hides
  `strictMode` from admins. This is how a tool can confirm strict mode without
  super-admin rights.
- The admin endpoints `POST /admin/projects/:id/settings`, `/secrets` and
  `/sites` go through the same rules.

## AccessPolicy and project admin

- **`admin: true` does not bypass an AccessPolicy.** `getRepoForLogin` builds
  the repository with the membership's own policy; `supportsInteraction` and
  `canPerformInteraction` special-case only super admin. The docstring on
  `reconcileDefaultAccessPolicy` says it outright: "The `admin` flag does not
  bypass the access policy."
- **But three admin powers sit outside the policy:**
  - `POST /admin/projects/:id/client` creates a ClientApplication through the
    **system** repository (`admin/client.ts`), so an admin whose policy makes
    ClientApplication read-only can still create one (**inferred** from the
    system-repo write);
  - admins can edit any ProjectMembership, including granting `admin` or
    swapping `accessPolicy`;
  - the `X-Medplum-On-Behalf-Of` header lets an admin act as any membership in
    the project, under that membership's policy.
- **Protected types** (DomainConfiguration, Enterprise, JsonWebKey, Login) are
  reachable only by super admin or the system (`core/src/access.ts`).
- **Project-admin-only types:** Cron, Package, PackageRelease,
  PackageInstallation, Project, ProjectMembership, User, UserSecurityRequest
  (`core/src/access.ts`). A `*` policy entry never covers them. For a
  non-admin, every policy entry for them is stripped, so a non-admin can
  neither read nor write them whatever the policy says.
- **ClientApplication, Bot, Subscription, AccessPolicy, OperationDefinition and
  StructureDefinition are ordinary types**, governed purely by AccessPolicy. A
  `*` entry matches them.
- **Policy entries are a union.** An interaction is allowed if *any* entry
  allows it (`accessPolicySupportsInteraction`, `.some`). A read-only entry for
  StructureDefinition therefore does not restrict a `*` entry that allows
  writes: the `*` entry still matches and the write succeeds.
- **Field rules come from the first matching entry** (`satisfiedAccessPolicy`,
  `.find`), so entry order decides which `hiddenFields` and `readonlyFields`
  apply.
- **SearchParameter and StructureDefinition** are added read-only by default
  only when no policy entry names them explicitly; a `*` entry does not count.
- **A membership with no AccessPolicy** falls back to legacy
  `{ resourceType: '*' }`: full access to everything except the admin-only
  types.

### The lockdown recipe these facts imply

- People: `admin: false`, and a policy with **no writable `*` entry**. Because
  entries are a union, the only way to keep configuration types read-only is
  to never grant them write: list the clinical types people may write
  explicitly, and give the configuration types (ClientApplication, Bot,
  Subscription, OperationDefinition, StructureDefinition, SearchParameter,
  AccessPolicy) read-only entries, or none. A `*` entry, if present, must be
  `readonly: true`. ClientApplication `secret` and `retiringSecret` are hidden,
  in the first entry that matches ClientApplication.
- The CI client: `admin: true` and an explicit policy granting write on the
  configuration types only.
- Super admin: the break-glass, and the only way to change `strictMode` and
  `features`.
- Any person who keeps `admin: true` has CI-level power.

## Bots

- A bot runs as its own ProjectMembership unless `runAsUser` is set, in which
  case it runs as the caller (`bots/utils.ts`). Its session goes through
  `getRepoForLogin` like a person's, so the admin and policy rules above apply
  to bots too.
- `Bot/$init` requires an admin membership; `$deploy` needs only a
  policy-checked Bot read and update.
- **Public webhooks address the bot's ProjectMembership id**, not the Bot id:
  `https://<api>/webhook/<membership id>`. Recreating a project gives every bot
  a new membership id, so every vendor pointing at a webhook must be re-pointed.
  That makes "rebuild the project" far more expensive than it looks, and is why
  Plumb converges an existing project rather than assuming a fresh one.

## Custom FHIR operations

An OperationDefinition routes an operation to a bot through this extension:

```json
{
  "url": "https://medplum.com/fhir/StructureDefinition/operationDefinition-implementation",
  "valueReference": { "reference": "Bot/<bot id>" }
}
```

- **Operations are found by `code` alone** (`operations/custom.ts`). `resource`,
  `system` and `type` are ignored, so `/Patient/$send` and `/$send` reach the
  same bot, and two OperationDefinitions with the same code resolve
  arbitrarily. Codes must be unique within a project.
- **Custom operations run only when no built-in route matches**
  (`routes.ts`), so a custom code can never override a built-in operation.
- **`instance: true`** only decides the input: for `/Patient/123/$op` the bot
  receives the stored Patient, and the POST body is dropped.
- **Otherwise the bot receives the raw POST body, or the query object for
  GET.** There is no `Parameters` unwrapping and no validation against the
  OperationDefinition's `in` parameters.
- **Output:** a returned `Parameters` passes straight through. Anything else is
  mapped to the `out` parameters with min/max checks, and a single `return`
  parameter is returned bare.

The parked [operation contracts](../future/operation-contracts.md) idea
generates the OperationDefinition from a contract, and the contract's runtime
parse would be the only input validation there is.

## `@medplum/core` validator (5.1.42)

```ts
indexStructureDefinitionBundle(bundle: StructureDefinition[] | Bundle): void;
validateResource(resource: Resource, options?: ValidatorOptions): OperationOutcomeIssue[];
// ValidatorOptions: { profile?, collect?, base64BinaryMaxBytes? }
```

`validateResource` **throws** an `OperationOutcomeError` carrying every issue
when any issue has severity `error`, and otherwise returns the warnings. A
caller that wants a report catches the error and reads its outcome. It works
offline; Medplum's own generator uses it that way. Base R4 definitions come from
`@medplum/definitions` (`fhir/r4/profiles-types.json`,
`fhir/r4/profiles-resources.json`) and must be indexed before a profile is.

## Other server features that touch Plumb's plans

- **`$clone`, `$expunge` and `$reindex`** are unrelated admin operations: copy a
  project, permanently delete resources, rebuild search indexes. None
  re-validates stored data.

### The marketplace (in progress)

Package, PackageRelease and PackageInstallation are the resources behind
Medplum's marketplace. A Package is, in Medplum's docs, "a set of automated
actions" such as a subscription or a workflow.

- **On `main`** (since March 2026, `2fabadfab`): the three resource types and a
  basic `PackageRelease/$install`. A project admin installs a release, which is
  a FHIR Bundle stored in a Binary, applied to the project as a batch and
  recorded as a PackageInstallation (`operations/packageinstall.ts`).
- **On unmerged branches** (June to September 2026, `medplum/medplum#9406`,
  branches `oleg-marketplace-*`):
  - a catalog in a publisher project, visible to customer projects through
    `Project.link` and exports;
  - a Stage 2 install that validates configuration against a bundled
    Questionnaire, runs a setup bot, links the project to the publisher's
    implementation project, and can be re-run as its own recovery;
  - `@medplum/package-types`, with a `defineManifest()` manifest, validators
    and a manifest-to-Bundle compiler, and `medplum package validate | build |
    publish` in the CLI (dry-run unless `--apply`).
- **A manifest declares** a type (`bot-integration`, `reference-data` or
  `mixed`), implementation bots hosted once in a shared publisher project,
  consumer-side linked, webhook and proxy bots, client applications,
  operations (`code`, `parameter`, `delegatesTo`, with the wire shapes they
  accept: `parameters` or `plain-json`), data bundles, a configuration
  Questionnaire, a `postInstall` hook and migrations.

What it means for Plumb:

- **Plumb as a whole is not a marketplace package.** A package installs into a
  project; Plumb's generator, CLI, types and checks live in a developer's
  repository and in npm.
- **Three parts could be:** profile packs as `reference-data` packages
  (profiles, value sets, defaults and routing rows); an in-project conformance
  bot for `check`; and marketplace operation entries generated from
  operation contracts (all parked in [`../future/`](../future/)).
- **It overlaps with `push` and `migrate`.** Idempotent installs, migrations
  and a typed manifest are the same idea as Plumb's project state as code,
  applied to installable packages. Plumb should not build a rival; it tracks
  the work and aligns once it merges.
- **It is not stable.** The Stage 2 work is unmerged, the manifest will likely
  change, and whether anyone but Medplum can publish to the catalog is not
  settled.
- **`@medplum/cli`** covers login, connection profiles, projects, bots, bulk
  data, REST verbs, HL7, agents and DICOMweb. It has no config-as-code,
  migration or profile type generation, so Plumb does not overlap it.
- **`@medplum/generator`** is Medplum's internal build script, not a published
  tool. Its `fhirtypes` script (`packages/generator/src/index.ts`) indexes the
  base definitions, walks each `InternalTypeSchema` and writes one `.d.ts` per
  type into `packages/fhirtypes/dist`: `min > 0` becomes a required field,
  choice types expand to one property per type, enumerable required bindings
  become literal unions, and `Reference` takes its target type from
  `targetProfile`. It reads only base definitions and has no notion of
  narrowing, so nothing upstream generates profile types.
- **`parseStructureDefinition()`** is exported from `@medplum/core`
  (`typeschema/types.ts`, marked `@experimental`). It returns an
  `InternalTypeSchema`: per element `min`, `max`, types, `binding`, `fixed`,
  `pattern`, `constraints` and `slicing` (discriminators and each slice's own
  elements). The validator uses it, and so do `@medplum/react`'s
  `ResourceForm`, `ResourceTable` and `ReferenceInput`.
- **Other project context:** `checkReferencesOnWrite`, and the
  `validate-terminology` feature, which turns on binding checks.

## Contributing upstream

- Medplum requires a **DCO** (`Signed-off-by` on every commit), not a CLA.
- **PRs from contributors not yet vouched for are closed automatically**
  unless they link a maintainer-labelled issue (`.github/VOUCHED.td`,
  `vouch-check-*.yml`). Upstream proposals start as issues.

## Operational lessons

- **A quiet conformance check can mean "nothing was readable".** An
  over-restrictive AccessPolicy produces the same empty result as a healthy
  empty project. A conformance report must distinguish "all N passed", "N read
  and none carries a profile" and "nothing was checked".
- **A profile edit without a version bump reaches no environment** if loading
  compares versions. Bump `version` whenever constraints change.
- **Load profiles before loading data.** In an empty project nothing can fail,
  so the load is free; after data lands, every tightening needs a
  check-and-migrate cycle.

## Survey: does anyone re-check stored data?

No FHIR server or document store surveyed re-checks stored data when a schema
tightens: HAPI, Smile CDR, Firely, Azure Health Data Services, Google Cloud
Healthcare, Aidbox, MongoDB, CouchDB, Firestore. The recurring pattern is
report, fix, then enforce. In Postgres terms, loading a profile is
`ADD CONSTRAINT … NOT VALID` and Plumb's `check` is `VALIDATE CONSTRAINT`.
