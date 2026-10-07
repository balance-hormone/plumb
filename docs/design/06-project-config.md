# Design 06: Project Config as Code

**Status: implemented** in v0.6 (accepted on 2026-10-03, after
[design 05](05-sushi.md)'s SUSHI integration in v0.5). Picks up the parked
[project config as code](../future/project-config-as-code.md) idea, and the
"`defaultProfile`, and the rest of project config, through `push`" stage that
[design 02](02-conformance-check.md) left for later. Read design 02 first:
this extends its `push`, its environments and its checker's identifier.

## Job

A Medplum project's configuration is set by hand in the console: its settings,
its default profiles, its access policies, its client applications. None of it
is reviewed, and none of it can be rebuilt in a second environment. Plumb
already writes one part of a project, its profiles, through a gated `push`.
v0.3 added a `defaultProfile` to the config that `createProfiled` stamps, and
the README says to "keep the two in step by hand": the server's
`defaultProfile` is the half Plumb does not write.

`push` converges the rest of what a project admin can write, from the same
committed config:

```text
plumb push --env prod
✔ checker    plumb-checker 0.5.0 unchanged   90ms
✔ plan       load us-core-patient 9.0.0 (+3 dependencies)
✔ validate   0 of 1,204 stored resources would fail
✔ profiles   1 loaded
✔ project    plan: 2 to create, 1 to update, 0 to remove
    + AccessPolicy  clinician
    + client        ci-deploy (AccessPolicy ci-deploy)
    ~ Project       defaultProfile Observation: [] → [org-observation]
    ! policy        clinician has a writable * entry (see the lockdown recipe)
✔ project    applied 3 changes   410ms
Done in 6.1s
```

## The marketplace, checked first

The idea note asked to check Medplum's marketplace before building a rival
(`medplum/medplum#9406`). As of Medplum 5.2.1 (October 2026):

- **What has landed** is `POST /PackageRelease/:id/$install`
  (`fhir/operations/packageinstall.ts`): it reads a stored Bundle, runs it as a
  batch through the caller's repository, and records a
  `PackageInstallation` with a status. It needs a project admin.
- **What has not** is everything that makes a config converge: the manifest
  format, the configuration Questionnaire, setup bots, re-run idempotency and
  migrations. #9406 ("Stage 2 `$install` hook + idempotency") is still an open
  issue, last active in June 2026, and depends on two unfinished spikes.
- **An install is a one-shot batch,** with no plan, no diff against what the
  project holds, and no removal. It is a way to ship a package, not to keep a
  project in step with a file.

So `push` writes plain FHIR, as it already does for profiles. Two things keep
the door open: everything `push` creates is found again by a tag, never by an
id, so a later switch to installing through `$install` can adopt what is
there; and the plan is a plain list of FHIR writes, which is what a package
Bundle is.

## What is declared

Only what a project admin can write, and only what a second environment needs
to be rebuilt:

| Config | Medplum | Who can write it |
| --- | --- | --- |
| `project.settings` | `Project.setting` | project admin |
| `project.secrets` | `Project.secret` | project admin |
| `defaultProfile` (v0.3's) | `Project.defaultProfile` | project admin |
| `project.accessPolicies` | `AccessPolicy` | AccessPolicy-governed |
| `project.defaultAccessPolicies` | `Project.defaultAccessPolicies` | project admin |
| `project.clients` | `ClientApplication` + `ProjectMembership` | admin (`admin/projects/:id/client`) |

Not declared, and why:

- **`strictMode`, `features`, `link`, `systemSetting`:** only a super admin can
  write them; a project admin's write is silently restored
  ([research](../research/medplum-server-behaviour.md#project-fields-and-who-can-write-them)).
  `push` reads `strictMode` and `features` from `GET /auth/me` and reports them
  in the plan (`strictMode is off; ask a super admin`), as `validate` already
  reports strict mode. A break-glass super-admin credential is a later stage.
- **Secret values in the config:** the config is committed. A secret's value
  comes from an environment variable, as an environment's credentials already
  do (see [Secrets](#secrets)).
- **People** (Users, invites): who works in a project is not configuration.
- **Bots** other than Plumb's checker: Medplum's CLI already deploys bots and
  their code. Declaring their registrations is a later stage.
- **Creating the project:** an environment names a project that exists. `push`
  never creates one.

## Config

```ts
export default defineConfig({
  // …igs, profiles, out, routes, defaultProfile as today
  project: {
    settings: { supportEmail: 'support@example.org', maxUploadMb: 25, betaForms: false },
    secrets: {
      PAYMENT_API_KEY: { env: 'PAYMENT_API_KEY' }, // set from CI's environment
      LEGACY_SFTP_KEY: true, // must exist; set by hand
    },
    accessPolicies: {
      clinician: {
        resource: [
          { resourceType: 'Patient' },
          { resourceType: 'Observation' },
          { resourceType: 'StructureDefinition', readonly: true },
        ],
      },
      'ci-deploy': { resource: [{ resourceType: 'StructureDefinition' }, { resourceType: 'Bot' }] },
    },
    defaultAccessPolicies: [{ profileType: 'Practitioner', accessPolicy: 'clinician' }],
    clients: {
      'ci-deploy': { accessPolicy: 'ci-deploy', admin: true },
    },
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

- **Keys, not ids.** Policies and clients are named by a key unique in the
  config; references between them use the key. Ids differ per environment and
  never appear in the config.
- **An AccessPolicy is written as Medplum's own shape,** less `id`, `meta` and
  `name` (the key, unless given). `defineConfig` types it with
  `@medplum/fhirtypes`' `AccessPolicyResource`, so the editor checks it.
- **A setting's type follows its value:** a string is `valueString`, a
  boolean `valueBoolean`, a whole number `valueInteger` and any other number
  `valueDecimal`, the four types `ProjectSetting` holds. The plan prints the
  type, so a decimal that should be an integer shows in review. An explicit
  form waits for someone who needs it.
- **Per-environment settings** merge over `project.settings`, the one thing
  that commonly differs between environments (a URL, a support address).
  Nothing else is per-environment: two environments that need different
  policies are two configs.
- **`defaultProfile` is v0.3's,** unchanged. `push` now writes it, so the
  stamps `createProfiled` writes and the defaults the server applies come from
  one place.

## Secrets

A secret is declared by name, with where its value comes from:

- **`{ env: 'NAME' }`:** `push` reads the value from that environment
  variable in CI, sets `Project.secret` when it differs, and fails when the
  variable is unset. It compares the value without printing it: the plan says
  `~ secret PAYMENT_API_KEY (value changed)`, and neither the plan, `--json`
  nor an error message ever holds a value.
- **`true`:** the secret must exist and is set by hand, in the console. The
  plan fails when it is missing and never changes it.
- A secret in the project but not in the config is left alone, even under
  `--prune`: a `ProjectSetting` has no tag, so Plumb cannot tell one it set
  from one set by hand.

This is the pattern Plumb already uses for an environment's client
credentials, and the one Auth0's Deploy CLI uses for values it must not commit
(keyword replacement from environment variables).

## Found again by a tag

Plumb finds what it manages by a `meta.tag` with Plumb's system and the
config key as code (`https://www.npmjs.com/package/plumb-fhir|clinician`),
searched with `_tag`. Not by name, which a person can change in the console,
and not by an identifier: AccessPolicy and ClientApplication have none.

- **One system for everything Plumb owns:** the tag system and the checker
  bot's identifier become one constant, the package's npm URL. Today the
  checker's identifier is the repository's GitHub URL, which names the
  organization and moves if the repository does; the package name already has
  to stay stable. Kubernetes asks the same of label prefixes (a domain the
  owner controls), and FHIR of code systems. The change is cheap now: the
  package is unpublished, and only test projects hold a checker. If the
  project gets a domain of its own before v0.6 ships, the constant moves there
  instead.

- **A tagged resource is Plumb's.** It is updated to match the config, and
  listed for removal when its key leaves the config.
- **An untagged resource is never touched,** even one whose name matches a key.
  The plan names it (`untagged-access-policy`: `AccessPolicy "clinician"
  exists untagged; adopt it with --adopt`), and `--adopt` tags it and then converges it, so an existing
  project can come under `push` without recreating its clients.
- **Two resources with one tag** stop the push (`shadowed-<type>`, such as
  `shadowed-client-application`), as two StructureDefinitions for one URL do:
  Plumb will not guess which is meant. A blocked plan is `{ code, message }`
  in every planner, exits 1, and `--check` counts it as blocked (#229).
- **Only the target project's own resources.** A project can read what its
  linked projects hold, but linking is a super-admin field and a linked
  project's resources are not this one's to write. Every lookup, tagged or by
  name for `--adopt`, keeps only results whose `meta.project` is the target
  project, so a linked project's tagged policy is neither planned nor counted
  as a second resource with that tag. The plan reports the links once
  (`linked projects: 2, not managed`), as it reports `strictMode`.

## The plan

`push` gains a `project` step after `profiles`, in dependency order:

1. **AccessPolicies**, which the others reference.
2. **Clients:** a new one through `POST admin/projects/:id/client` with its
   `meta.tag` and `accessPolicy`, which creates its membership too
   (`admin/client.ts`); an existing one by updating its ClientApplication and
   its membership's `accessPolicy` and `admin`.
3. **Project fields:** `setting`, `defaultProfile` and
   `defaultAccessPolicies`, read, merged and written in one update. The fields
   `push` does not manage are left as read. `defaultProfile` goes last, after
   the profiles it names are loaded, so the server never defaults a write to a
   profile it does not hold.

- **Each change is a line:** `+` create, `~` update (naming the fields that
  differ), `-` remove. An unchanged project is an empty plan, so a second push
  writes nothing.
- **`--dry-run` stops after the plan,** as it stops before loading profiles
  today. `push` keeps applying by default: it already does for profiles, and a
  second, opposite flag would make `push` mean two things.
- **Removal needs `--prune`.** A tagged policy or client no longer in the
  config is listed, and deleted only with `--prune`: deleting the policy a
  person's membership uses locks that person out.
- **A secret value is never printed,** in the plan, `--json` or an error.
- **A client's secret is never printed or stored.** A created client's id is
  printed; its secret is read in the console, or rotated there, and kept in
  whatever secrets store the project uses.
- **The gate still comes first.** If the profile gate refuses, nothing in the
  project step is written either.

## Drift

`plumb push --env prod --check` plans and exits 1 when the plan is not empty,
writing nothing, as `generate --check` does for generated files. CI runs it on
a schedule to catch a change made by hand in the console, and the plan says
what changed.

## The lockdown recipe

The README gets the recipe from the idea note: people get `admin: false` and a
policy with no writable `*` entry; configuration types (ClientApplication, Bot,
Subscription, OperationDefinition, StructureDefinition, SearchParameter,
AccessPolicy) are read-only or absent; the CI client gets `admin: true` and an
explicit policy, because an admin with no policy has full access. The plan
warns, without refusing, where the config breaks it:

- a policy with a `*` entry that is not `readonly`, because entries are a
  union and it re-opens every type;
- a client with `admin: true` and no `accessPolicy`;
- a policy that writes StructureDefinition, other than the client `push`
  itself runs as, because that bypasses the profile gate.

## Conventions this follows

| Decision | Follows | Instead of |
| --- | --- | --- |
| `push` applies; `--dry-run` stops at the plan | `prisma db push`, `drizzle-kit push`, `kubectl apply`, and v0.2's `push` | Terraform's `plan`/`apply` and Pulumi's `preview`/`up`, which are separate verbs with an interactive prompt that CI skips (`-auto-approve`, `--yes`) |
| Found by a tag; untagged needs `--adopt` | Kubernetes' `app.kubernetes.io/managed-by` label; Helm 3 refusing objects without its ownership metadata; Terraform and Pulumi's explicit `import` | Matching by name, as Auth0's Deploy CLI does, which a rename in the console breaks |
| `--check` exits 1 on drift | `kubectl diff`, `terraform plan -detailed-exitcode`, `prisma migrate diff --exit-code`, and Plumb's own `generate --check` | A separate `drift` command |
| Removal only with `--prune` | `kubectl apply --prune`; Auth0's `AUTH0_ALLOW_DELETE`, `false` by default | Terraform deleting by default, which it can do safely only because it keeps a state file |
| Secret values from environment variables | Auth0's keyword replacement; Plumb's own environment credentials | Values in the committed config, or names only |
| Setting types from the value | Terraform and Auth0's JSON config, which infer types from literals | Strings only (Pulumi config), which `ProjectSetting`'s typed values do not fit |
| Super-admin fields reported, not written | Terraform's separate provider configurations for separate credentials (a later stage here) | One credential that can do everything |
| One owned URL for tags and identifiers | Kubernetes' domain-prefixed label keys; FHIR's persistent system URIs | A URL that moves with the repository |

## Commands stay plain functions

`planProject(config, environment, client)` returns the plan, and
`applyProject(plan, client)` writes it; `push` composes them after the profile
steps, and `--check` stops at the plan. The CLI only prints. The plan is data
(each change's kind, type, key and differing fields), which `--json` prints.

## Testing

Against the Docker Medplum server, in a project of its own per test file:

- **Converges:** a push from an empty project creates the policies, clients
  and Project fields; a second push plans nothing and writes nothing.
- **Updates in place:** changing a policy, a client's `admin`, a setting or a
  `defaultProfile` row updates the tagged resource; its id is unchanged.
- **Untagged is untouched:** a same-named untagged policy survives a push, and
  `--adopt` tags and converges it.
- **Linked projects are not managed:** a tagged policy in a linked project is
  neither planned nor touched, and the plan reports the link. Linking needs a
  super admin, so this runs where the test server's admin can link projects,
  and otherwise as a unit test with a stub client.
- **Removal:** a key removed from the config is planned, kept without
  `--prune`, and deleted with it.
- **Drift:** an edit made by hand turns `--check` red, naming the field.
- **`defaultProfile` takes effect:** after a push, an unstamped write is
  validated against, and stamped with, the configured default.
- **A created client works:** it logs in, and its membership has the
  configured policy and `admin`.
- **A super-admin field is reported, never written:** a config cannot declare
  `strictMode`, and the plan reports the live value.
- **Secrets:** an `{ env }` secret is set, then left alone while its value is
  unchanged; a missing `true` secret fails the plan; no plan, `--json` output
  or error holds a value.
- **Setting types:** a string, boolean, whole number and decimal each store as
  their `ProjectSetting` type.

Unit tests cover the config checks (unknown policy key, duplicate keys, a
`*` entry warning) and the plan diff, with a stub client.

## Proposed issues (v0.6 milestone)

1. **Config:** `project` and per-environment `settings` in `plumb.config.ts`,
   typed and checked, with named errors.
2. **Plan and apply AccessPolicies,** found by tag, with `--dry-run`,
   `--prune` and `--adopt`, and the real-server server tests.
3. **Clients:** create through the admin endpoint, converge the membership.
4. **Project fields:** `setting`, secrets, `defaultProfile`,
   `defaultAccessPolicies`; report `strictMode` and `features`. The tag
   system and the checker's identifier move to one constant.
5. **`push --check`** for drift, and a nightly example in the README.
6. **Docs:** the README's project section and the lockdown recipe; design 06
   becomes implemented.

## Later (not in this design)

- **A super-admin credential** for `strictMode` and `features`, planned as its
  own section and applied only when that credential is configured.
- **Bot registrations** (the Bot and its membership, not its code).
- **Installing through `PackageRelease/$install`** once the marketplace's
  manifest and idempotency land.
- **Secret values** read from a secrets store rather than CI's environment.
- **Linked projects:** a client or default access policy naming a policy a
  linked project holds, by a key that project's config owns.
