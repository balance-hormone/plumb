# Design 05: Project Config as Code

**Status: proposed** on 2026-10-03. Picks up the parked
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
| `project.secrets` (names only) | `Project.secret` | project admin |
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
- **Secret values:** the config is committed. `project.secrets` lists the
  names the project needs, and the plan fails when one is missing; values are
  set in the console or by a deploy script.
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
    settings: { supportEmail: 'support@example.org' },
    secrets: ['PAYMENT_API_KEY'],
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
- **Per-environment settings** merge over `project.settings`, the one thing
  that commonly differs between environments (a URL, a support address).
  Nothing else is per-environment: two environments that need different
  policies are two configs.
- **`defaultProfile` is v0.3's,** unchanged. `push` now writes it, so the
  stamps `createProfiled` writes and the defaults the server applies come from
  one place.

## Found again by a tag

Plumb finds what it manages by a `meta.tag` with Plumb's system and the
config key as code (`https://github.com/balance-hormone/plumb|clinician`),
searched with `_tag`. Not by name, which a person can change in the console,
and not by an identifier: AccessPolicy and ClientApplication have none. The
checker bot keeps its identifier.

- **A tagged resource is Plumb's.** It is updated to match the config, and
  listed for removal when its key leaves the config.
- **An untagged resource is never touched,** even one whose name matches a key.
  The plan names it (`AccessPolicy "clinician" exists untagged; adopt it with
  --adopt`), and `--adopt` tags it and then converges it, so an existing
  project can come under `push` without recreating its clients.
- **Two resources with one tag** stop the push, as two StructureDefinitions for
  one URL do: Plumb will not guess which is meant.

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
- **Removal:** a key removed from the config is planned, kept without
  `--prune`, and deleted with it.
- **Drift:** an edit made by hand turns `--check` red, naming the field.
- **`defaultProfile` takes effect:** after a push, an unstamped write is
  validated against, and stamped with, the configured default.
- **A created client works:** it logs in, and its membership has the
  configured policy and `admin`.
- **A super-admin field is reported, never written:** a config cannot declare
  `strictMode`, and the plan reports the live value.
- **A missing secret name fails the plan,** and the plan never contains a
  secret value.

Unit tests cover the config checks (unknown policy key, duplicate keys, a
`*` entry warning) and the plan diff, with a stub client.

## Proposed issues (v0.5 milestone)

1. **Config:** `project` and per-environment `settings` in `plumb.config.ts`,
   typed and checked, with named errors.
2. **Plan and apply AccessPolicies,** found by tag, with `--dry-run`,
   `--prune` and `--adopt`, and the real-server server tests.
3. **Clients:** create through the admin endpoint, converge the membership.
4. **Project fields:** `setting`, secret names, `defaultProfile`,
   `defaultAccessPolicies`; report `strictMode` and `features`.
5. **`push --check`** for drift, and a nightly example in the README.
6. **Docs:** the README's project section and the lockdown recipe; design 05
   becomes implemented.

## Later (not in this design)

- **A super-admin credential** for `strictMode` and `features`, planned as its
  own section and applied only when that credential is configured.
- **Bot registrations** (the Bot and its membership, not its code).
- **Installing through `PackageRelease/$install`** once the marketplace's
  manifest and idempotency land.
- **Secret values** from a secrets store.

## Open questions

- **Settings types:** `ProjectSetting` holds a string, boolean, decimal or
  integer; whether the config infers the value type from the JavaScript value
  or asks for it.
- **The tag system URL** is Plumb's repository URL, as the checker's identifier
  is; whether to move both to a URL that survives a repository move before
  either is widely deployed.
- **Linked projects:** policies and profiles can come from a linked project;
  whether `push` should see them when planning.
