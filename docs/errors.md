# Error codes

Every code Plumb reports, by the command that reports it, with its exit code
and the fix. A code is API: `--json` prints it, and `plumb-fhir` exports
`ConfigErrorCode`. The exit code is the code's own, whichever command or step
reports it, from one table in `src/commands.ts`; a test compares this page
with that table and with the codes in `src/`.

- **0:** success.
- **1:** a problem found. The command ran, and what it met needs fixing: a
  profile that does not load, stale output, a failed write, a blocked plan.
- **2:** the command could not run as asked: usage, config, set-up or
  connection. Fix it, then run the command again.

A code a migration throws is passed through, and exits 1.

## Config

Reported by every command that loads `plumb.config.ts`, or once the profiles
load, by the step that checks them.

| Code | Command | Exit | Fix |
| --- | --- | --- | --- |
| `config-not-found` | all | 2 | Create `plumb.config.ts`, or pass `--config <path>`. |
| `unsupported-syntax` | all | 2 | Use syntax Node's type stripping runs, or install `tsx`. |
| `unresolved-import` | all | 2 | Install the package the config imports, or fix its path. |
| `no-default-export` | all | 2 | `export default defineConfig({ … })`. |
| `unknown-key` | all | 2 | Remove or correct the key the message names. |
| `missing-out` | all | 2 | Set `out`, the folder for the generated types. |
| `invalid-type` | all | 2 | Give the key the type the message names. |
| `invalid-ig` | all | 2 | Name each IG as `name@version`, an exact version. |
| `unlisted-ig` | all | 2 | Add the package to `igs`, or drop the `name/*` that names it. |
| `invalid-profile` | all | 2 | Name a profile by its canonical URL without `\|version`, or `name/*`. |
| `invalid-max-codes` | all | 2 | Make `bindings.maxCodes` a positive whole number. |
| `invalid-base-url` | all | 2 | Give the environment an absolute `baseUrl`. |
| `unknown-environment` | validate, push, migrate | 2 | Pass an `--env` the config's `environments` declares. |
| `missing-variable` | validate, push, migrate | 2 | Set the variable, or pass `--env-file`. |
| `invalid-route` | generate | 2 | Fix the routing row the message names. |
| `unselected-route` | generate | 2 | Add the profile to `profiles`, or remove its routing row. |
| `invalid-route-element` | generate | 2 | Route on a first-level element of the type. |
| `invalid-default-profile` | all | 2 | Name a selected profile of that type. |
| `versioned-url` | all | 2 | Drop the `\|version`: Medplum matches bare URLs only. |
| `fsh-and-local` | all | 2 | Keep one: `fsh` sets `local` to SUSHI's output. |
| `no-sushi-config` | all | 2 | Point `fsh` at the folder holding `sushi-config.yaml`. |
| `invalid-setting` | all | 2 | Make the setting a string, boolean or number. |
| `super-admin-field` | all | 2 | Remove it from `project`: only a super admin can set it. |
| `unknown-access-policy` | all | 2 | Name a key of `project.accessPolicies`. |
| `duplicate-key` | all | 2 | Give each policy, client or bot its own name. |
| `invalid-check` | all | 2 | Fix the `check` key the message names. |
| `invalid-server-version` | all | 2 | Set `test.server` to a Medplum release, as `5.1.42`. |
| `invalid-bot` | all, push | 2 | Fix the bot, or build its `file` before `push`. |
| `invalid-subscription` | all | 2 | Fix the Subscription the message names. |
| `unknown-bot` | all | 2 | Name a key of `bots`. |
| `invalid-operation` | push | 2 | Fix the operation contract the message names. |
| `invalid-migration` | migrate, migrate new | 2 | Fix the migration module, or `migrations.modules`. |
| `invalid-restamp-exclude` | all, migrate | 2 | Point `migrations.restamp.exclude` at a module that default-exports a function from a record to a reason or `undefined`. |
| `invalid-content` | generate, push | 2 | Make the file one Questionnaire, CodeSystem, ValueSet or Organization, with its URL or id. |
| `duplicate-content` | generate, push | 2 | Keep one file per canonical URL or Organization id. |
| `unknown-migration` | migrate | 2 | Name a migration id the modules declare. |
| `no-migrations` | migrate, migrate status | 2 | Add `migrations` to the config. |
| `no-check-config` | check | 2 | Add `check` to the config. |

## Set-up and connection

| Code | Command | Exit | Fix |
| --- | --- | --- | --- |
| `sushi-not-installed` | generate | 2 | `npm install --save-dev fsh-sushi`. |
| `sushi-too-old` | generate | 2 | Install the SUSHI release the message names. |
| `no-compiler-api` | check | 2 | Install TypeScript 5 or 6 in the project. |
| `checker-missing` | validate, migrate | 2 | Run `plumb push` to install the checker. |
| `checker-outdated` | validate, migrate | 2 | Run `plumb push` to update the checker. |
| `migrator-missing` | migrate | 2 | Run `plumb push` to deploy the migration bot. |
| `migrator-not-current` | migrate | 2 | Run `plumb generate`, build the bot, then `plumb push`. |
| `not-synthetic` | migrate | 2 | Run `--local` only on an environment marked `synthetic: true`. |
| `bots-disabled` | push | 2 | Ask a super admin to turn on the project's `bots` feature. |
| `cron-disabled` | push | 2 | Ask a super admin to turn on the project's `cron` feature. |
| `connect-failed` | validate, push, migrate, migrate status | 2 | Check `baseUrl` and the client's credentials. |
| `registry-error` | generate, validate, push | 2 | Check the network, and the IG's name and version. |

## Packages and profiles

| Code | Command | Exit | Fix |
| --- | --- | --- | --- |
| `download-mismatch` | generate | 1 | Fetch again; the registry sent another package than it lists. |
| `invalid-package` | generate | 1 | Report the package to its publisher; Plumb will not unpack it. |
| `inexact-dependency` | generate | 1 | Pin the dependency in `igs` at an exact version. |
| `integrity-mismatch` | generate | 1 | Delete the cached copy, then run `plumb generate`. |
| `lock-missing` | generate, validate, push, migrate | 1 | Run `plumb generate` and commit `plumb.lock`. |
| `lock-disagrees` | generate, validate, push, migrate | 1 | Run `plumb generate` and commit `plumb.lock`. |
| `no-lock` | check | 1 | Run `plumb generate`, which writes the lock and fills the cache. |
| `invalid-lock` | generate, check, validate, push, migrate | 2 | Resolve the merge conflict or hand edit in `plumb.lock`, or delete it and run `plumb generate`. |
| `local-not-found` | generate, validate, push, migrate | 2 | Create the folder `local` names, or fix the path. |
| `invalid-local-json` | generate, validate, push, migrate | 2 | Fix the named file in `local` so it is valid JSON. |
| `profile-not-found` | generate, validate, push, migrate | 1 | Fix the URL, or add the IG or local file that defines it. |
| `no-snapshot` | generate, validate, push, migrate | 1 | Build the profile with a snapshot (`sushi build --snapshot`). |
| `not-r4` | generate, validate, push, migrate | 1 | Select an R4 package or profile. |
| `unresolved-reference` | generate, validate, push, migrate | 1 | Add the IG or file that defines what the profile references. |
| `duplicate-definition` | generate, validate, push, migrate | 1 | Keep one definition of the URL across `local` and `igs`. |
| `unparseable` | generate, validate, push, migrate | 1 | Fix the profile Medplum cannot parse, or deselect it. |
| `load-failed` | check | 1 | Fix what keeps the profiles from loading, as `plumb generate` reports it. |
| `content-refused` | generate, push | 1 | Fix the content file where Medplum's validator says. |
| `sushi-error` | generate | 1 | Fix the FSH where SUSHI says. |
| `sushi-failed` | generate | 1 | Run `sushi build` to see why SUSHI stopped. |
| `type-name-clash` | generate | 1 | Rename one of the two profiles whose names give one type. |
| `foreign-file` | generate | 1 | Move the file Plumb did not write out of `out`. |
| `baseline-growth` | check | 1 | Fix the new findings, or pass `--allow-growth`. |

## Writes and runs

| Code | Command | Exit | Fix |
| --- | --- | --- | --- |
| `checker-failed` | validate, push | 1 | Read the server's error; run again, `--resume` for `validate`. |
| `apply-failed` | push | 1 | Read the server's error, then push again. |
| `content-failed` | push | 1 | Read the server's error, then push again. |
| `project-failed` | push | 1 | Read the server's error, then push again. |
| `bots-failed` | push | 1 | Read the server's error, then push again. |
| `operations-failed` | push | 1 | Read the server's error, then push again. |
| `subscriptions-failed` | push | 1 | Read the server's error, then push again. |
| `migration-failed` | migrate | 1 | Fix the transform; `--write` resumes where it stopped. |
| `unmet-dependency` | migrate | 1 | Apply the migrations it `dependsOn` first. |
| `migration-edited` | migrate | 1 | Restore the module, or `--rerun <id>` to run it again. |
| `migration-running` | migrate | 1 | Wait for the other run, or ten minutes for its lease. |
| `migration-paused` | migrate | 1 | Run `--write` again to resume. |

## Blocked plans

A blocked plan is never an error: its `{ code, message }` is in the step's
plan (`content`, `project`, `bots`, `operations`, `subscriptions`) in
`--json`, and `push` exits 1.

| Code | Command | Exit | Fix |
| --- | --- | --- | --- |
| `shadowed-access-policy` | push | 1 | Delete all but one AccessPolicy with the tag. |
| `untagged-access-policy` | push | 1 | `--adopt`, or delete or rename the untagged AccessPolicy. |
| `shadowed-client-application` | push | 1 | Delete all but one ClientApplication with the tag. |
| `untagged-client-application` | push | 1 | `--adopt`, or delete or rename the untagged ClientApplication. |
| `client-without-membership` | push | 1 | Delete the client, then push again. |
| `missing-secret` | push | 1 | Set the secret in the console. |
| `unset-variable` | push | 1 | Set the variable that holds the secret or header. |
| `shadowed-content` | push | 1 | Delete all but one resource for the URL or key. |
| `untagged-content` | push | 1 | `--adopt`, or delete the untagged resource. |
| `shadowed-bot` | push | 1 | Delete all but one Bot with the identifier. |
| `untagged-bot` | push | 1 | `--adopt`, or rename the untagged Bot. |
| `bot-without-membership` | push | 1 | Ask a super admin to add the bot's membership, or delete it. |
| `shadowed-operation` | push | 1 | Delete the OperationDefinition Plumb did not write, or all but one tagged, or the linked project's with the same code; or change the contract's code. |
| `shadowed-subscription` | push | 1 | Delete all but one Subscription with the tag. |
| `untagged-subscription` | push | 1 | `--adopt`, or delete the untagged Subscription. |
| `unsendable-header` | push | 1 | Send the header without a `:`, which Medplum cuts at. |

## Warnings

Reported under a step, and never failing it.

| Code | Command | Exit | Fix |
| --- | --- | --- | --- |
| `version-conflict` | generate, validate, push | — | Pin the IGs so one version of the definition is loaded. |
| `unparseable-skipped` | generate, validate, push | — | None needed: a `name/*` profile Medplum cannot parse is skipped. |
| `base-version-mismatch` | generate, validate, push | — | Install the `@medplum/definitions` that matches the IG's base. |
| `writable-wildcard` | all | — | Name the writable types instead of `*`. |
| `writes-structure-definition` | all | — | Load profiles with `plumb push`, not through a policy. |
| `admin-without-policy` | all | — | Give the admin an `accessPolicy`, or drop `admin`. |

## `plumb-fhir/test`

Returned or thrown by the test helpers; no CLI command reports them.

| Code | Command | Exit | Fix |
| --- | --- | --- | --- |
| `docker-unavailable` | startServer | — | Start Docker. |
| `server-unhealthy` | startServer | — | Read the server's log the message holds. |
| `push-failed` | createTestProject | — | Fix the config, as `plumb push` reports. |
| `seed-refused` | createTestProject | — | Fix the seed entry the message names. |
| `unknown-client` | connectAs | — | Name a key of `project.clients`. |
| `unknown-policy` | connectAs | — | Name a key of `project.accessPolicies`. |
