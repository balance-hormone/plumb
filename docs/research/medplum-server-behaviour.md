# Medplum Server Behaviour

What Medplum's server actually does with profiles, defaults, strict mode and
access policies. Every claim here was read from the server source
(`medplum/medplum`, `packages/server`, releases 5.1.41–5.1.42 and `main` on
2026-09-28) unless marked **inferred**. Line numbers drift; the function names
are the stable reference.

Plumb's design depends on each of these, so each one is a candidate for a test
against a real Medplum server in CI.

## Validation

- **Validation runs in Node, before the insert.** Resource bodies are stored as
  `content TEXT`; Postgres never sees a profile. A real `CHECK` constraint was
  considered and rejected: deleted rows store `''`, every reindex rewrites
  `content` (so one bad row would block Medplum's post-deploy reindexes), and
  it would be a second hand-kept copy of the profile.
- **With `Project.strictMode` off**, profile failures are logged as "Strict
  validation would fail" and the write succeeds.
- **An unknown profile URL** in `meta.profile` logs a warning and passes.
- **A versioned `url|version` stamp** matches no loaded profile and also passes
  (**inferred** from the lookup by bare URL).
- **Loading or changing a StructureDefinition** only clears a five-minute
  profile cache. Nothing re-checks stored resources. A stricter version arms a
  failure in the next write of every stored record that does not meet it.
- **The newest loaded version of a bare URL wins.** Loading a version is what
  switches its rules on for every resource already stamped with that URL.
- **Strict mode is project-wide.** Per-type strictness is an open Medplum
  request.
- **Deleting a StructureDefinition stops validation for it immediately.**
  Stored resources keep their `meta.profile` and go unchecked. There is nothing
  to undo in the data.

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
- **Project-admin-only types:** Cron, Package, PackageRelease,
  PackageInstallation, Project, ProjectMembership, User, UserSecurityRequest
  (`core/src/access.ts`). A `*` policy entry never covers them. For a
  non-admin, every policy entry for them is stripped, so a non-admin can
  neither read nor write them whatever the policy says.
- **ClientApplication, Bot, Subscription, AccessPolicy, OperationDefinition and
  StructureDefinition are ordinary types**, governed purely by AccessPolicy. A
  `*` entry matches them.
- **SearchParameter and StructureDefinition** are added read-only by default
  only when no policy entry names them explicitly; a `*` entry does not count.
- **A membership with no AccessPolicy** falls back to legacy
  `{ resourceType: '*' }`: full access to everything except the admin-only
  types.

### The lockdown recipe these facts imply

- People: `admin: false`, and a policy listing the configuration types
  explicitly as read-only (a `*` entry would otherwise make them writable),
  with ClientApplication `secret` and `retiringSecret` hidden.
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

The OperationDefinition's `code`, `resource`, `system`, `type` and `instance`
decide which URLs invoke it. `plumb-operations` generates this resource from a
contract.

## `@medplum/core` validator (5.1.41)

```ts
indexStructureDefinitionBundle(bundle: StructureDefinition[] | Bundle): void;
validateResource(resource: Resource, options?: ValidatorOptions): OperationOutcomeIssue[];
```

`validateResource` returns the issues rather than throwing (earlier versions
threw an `OperationOutcomeError`). Base R4 definitions come from
`@medplum/definitions` (`fhir/r4/profiles-types.json`,
`fhir/r4/profiles-resources.json`) and must be indexed before a profile is.

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
