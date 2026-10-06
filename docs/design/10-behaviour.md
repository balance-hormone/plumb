# Design 10: Behaviour as Code

**Status: accepted** on 2026-10-06; v0.12 is #167 to #173 and v0.13 #174 to
#177. The first item on the
[spec's roadmap](../spec.md#roadmap). It supersedes the
[operation contracts](../future/operation-contracts.md) sketch.

Builds on [design 06](06-project-config.md)'s project config, whose
AccessPolicies, secrets and tags it reuses, on
[design 08](08-test-environments.md)'s test projects, and on Plumb's own
checker bot, which `push` already installs, finds by identifier and redeploys
only when its bundle changes. Read design 06 first.

## Job

A Medplum project's behaviour is its bots and what triggers them: a
Subscription, a schedule, a custom FHIR operation, a vendor's webhook. Today
each piece is set up by hand or by a project's own scripts, per environment,
and found again by server id:

- **Ids are kept by hand.** A bot's id differs in every environment, so
  config files, OperationDefinitions (`Bot/<id>` in their implementation
  extension), Subscription endpoints and the AccessPolicies that let people
  run a bot all carry ids someone copies between environments. A dev id in a
  prod Subscription fails without a word.
- **One bot is configured in many places:** its registration, its code, its
  membership's policy, the policies allowed to run it, its Subscriptions, its
  schedule, its OperationDefinition and the types its callers cast to.
- **The failures are silent.** A bot created with a plain `POST /Bot` has no
  membership, so its Subscriptions and schedule throw and it can never be a
  webhook. A schedule written without the `cron` feature is never registered.
  Criteria the server cannot match never fire. A public webhook without a
  policy is a bare 403. An environment missing its OperationDefinitions turns
  every custom operation into a 404.
- **Callers and handlers disagree.** An operation is called by string name and
  its response cast; its OperationDefinition is hand-written JSON that nothing
  checks against the handler.

The same four steps as every layer: **declare** bots, Subscriptions and
operations in the repository, **generate** typed handlers and callers,
**converge** each environment with `push`, and **verify** with `push --check`.

```text
plumb push --env prod
✔ profiles       1 loaded
✔ project        plan: 0 to create, 1 to update, 0 to remove
✔ bots           plan: 1 to create, 1 to deploy, 0 to disconnect
    + Bot  send-reminder   awslambda, every day at 14:00, policy reminder-sender
    ~ Bot  intake-webhook  code changed (a91f… → 3c07…)
    webhook  intake-webhook  https://api.example.org/webhook/7d1e…
✔ subscriptions  plan: 1 to create, 1 to update, 0 to turn off
    + Subscription  new-appointment  Appointment?status=booked → Bot send-reminder
    ~ Subscription  lab-result       criteria changed
✔ operations     plan: 0 to create, 0 to update, 0 to delete
Done in 9.8s
```

```ts
// src/operations/send-message.ts
import { defineOperation } from '../fhir/generated/index.js';
import { draftSchema, sentSchema } from './schemas.js'; // any Standard Schema library

export const sendMessage = defineOperation({
  code: 'send-message',
  resource: 'Communication',
  level: 'type',
  bot: 'messenger',
  input: draftSchema,     // plain JSON, checked by the schema
  output: 'Communication' // a FHIR type or a selected profile
});

// a caller
const sent = await callOperation(medplum, sendMessage, { to: 'Patient/1', text: 'Hi' });
//    ^? Communication

// the bot
export const handler = handleOperation(sendMessage, async (medplum, input) => {
  // input is the schema's output type; the return must be a Communication
});
```

## Checked first

Each claim below was read from Medplum's source (`main` at `a245d5016`, 5.2.1)
and is recorded in the
[research notes](../research/medplum-server-behaviour.md#behaviour). Each
shapes a rule in this design.

- **Only the admin endpoint makes a bot that works.**
  `POST admin/projects/:id/bot` (and `Bot/$init`) create the Bot and its
  ProjectMembership, with an AccessPolicy if given. A plain `POST /Bot` makes
  none: its Subscriptions and schedule throw, it cannot be a webhook, and an
  operation silently runs it as the caller. A project admin cannot add a
  missing membership afterwards, since `project` and `user` are read-only to
  them. `$init` ignores `runtimeVersion`; the admin endpoint passes it on.
- **`$deploy` is never a no-op.** Each call with `code` writes a new Binary
  and Bot version and, on Lambda, publishes a new function version, even for
  identical code. On Lambda it also writes `timeout` when the Bot has none.
  The deployed file's extension (`.cjs`, `.mjs`) picks the Lambda module
  format; vmcontext needs CommonJS that assigns `exports.handler`.
- **Reads rewrite attachments.** `executableCode.url` reads back as a
  presigned URL, never the `Binary/<id>` written, so a deployed bundle is
  compared by a hash Plumb records, as the checker's is.
- **Schedules need the `cron` feature,** which only a super admin can turn
  on; without it a schedule is skipped at debug level. An invalid
  `cronString` on a Bot is ignored, silently. Rewriting an unchanged one is a
  no-op. The `Cron` resource (Medplum 5.1.38 and later) validates on write,
  but Plumb supports 5.1.0.
- **A webhook is addressed by the bot's ProjectMembership id,** needs
  `publicWebhook` and a policy on that membership, and is otherwise a 403
  before the handler runs. Deleting a Bot loses the membership id every vendor
  points at; it also deletes the Bot's Lambda.
- **Subscriptions** have no `identifier`; fire only when `status` is
  `active`; are not validated on write; and match criteria with
  `matchesSearchRequest`, which returns false for chained parameters, `_has`,
  any parameter not in Medplum's base set (a project's SearchParameters
  included), and number, quantity and composite parameters, and reads most
  modifiers as plain equality. A `channel.header` without `:` throws, one
  whose value holds a `:` is cut short. A bot-backed Subscription to a bot
  that fails counts as delivered: it is never retried or auto-disabled. The
  server sets a failing URL Subscription to `off` with an `error`.
- **Custom operations** are found by `code` alone, in the project and its
  linked projects, ignoring `status`, `resource` and level, and run only when
  no built-in operation has that code. The bot gets the raw POST body (or the
  stored resource, for an instance operation). A bot's `Parameters` return
  passes through; otherwise the OperationDefinition's `out` parameters map it,
  and an object with no matching `out` parameter comes back as empty
  `Parameters`. The parameter helpers live in the server, not in
  `@medplum/core`.
- **AccessPolicy criteria match with `matchesSearchRequest`,** so an entry
  `Bot?identifier=<system>|<key>` grants a bot by key, with no id.
- **Nothing upstream declares this.** `medplum.config.json` lists bots by id
  and deploys one file at a time; Medplum's examples upsert Subscriptions by
  endpoint, which collides when a bot has two. The marketplace manifest
  (`medplum/medplum#10557`, unmerged) declares bots and operations by
  identifier and has no Subscriptions.

## What is declared

| Declared | Found again by | Removed with `--prune` by |
| --- | --- | --- |
| Bot, with its membership and schedule | `identifier`, Plumb's system and the key | schedule cleared, Bot kept and reported |
| Subscription | Plumb's tag, the key as code | `status: off` |
| OperationDefinition | Plumb's tag, the operation's code | deleted |

A removed bot keeps its Bot, membership and Lambda: deleting them breaks every
webhook pointing at the membership, for good. Its Subscriptions are turned
off and its OperationDefinitions deleted, since Medplum ignores an
OperationDefinition's `status`, so retiring one would not stop it.

Not declared, and why:

- **The bot's code build.** The project builds its bots as it does today;
  `push` deploys the file a bot names.
- **The `bots` and `cron` features,** which only a super admin can set:
  `push` reports a missing one, as it reports strict mode.
- **Pre-commit bots, CDS Hooks services and WebSocket Subscriptions;** the
  first two need server settings, the last live only in Redis.
- **Linked bots** hosted in another project.

## Config

```ts
export default defineConfig({
  // …igs, profiles, out, project, content as today
  bots: {
    'send-reminder': {
      file: './dist/bots/send-reminder.cjs', // built by the project
      runtime: 'awslambda',                  // the default, Medplum's own
      timeout: 30,                           // seconds; default 10, always written
      policy: 'reminder-sender',             // a key in project.accessPolicies
      secrets: ['SMS_API_KEY'],              // keys in project.secrets it reads
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
      fhirPath: "%previous.status != 'final'",
      url: 'https://hooks.example.org/lab',
      secret: { env: 'LAB_HOOK_SECRET' },     // sent as X-Signature's key
      maxAttempts: 5,
    },
  },
  operations: ['./src/operations/*.ts'],      // modules exporting defineOperation contracts
});
```

- **A bot's key is its identity:** its `identifier`, its `name` unless one is
  given, and the name its webhook URL, Subscriptions, operations and policies
  use. Server ids never appear in the repository.
- **`runtime`, `timeout`, `runAsUser`, `admin`, `publicWebhook`, `rawBody`
  and `audit`** (`auditEventTrigger` and `auditEventDestination`) are the
  Bot's own fields, written as declared, so `$deploy` never fills in a
  `timeout` that then reads as drift.
- **`policy` names one of `project.accessPolicies`.** A bot without one runs
  with the project's full access, and `push` warns, as design 06 warns for an
  admin client without one. `publicWebhook` without a `policy` is a named
  error: the server would answer every call with a 403.
- **Who may run a bot** is a policy entry, by key:

  ```ts
  accessPolicies: {
    'front-desk': { resource: [{ resourceType: 'Bot', bots: ['send-reminder'] }] },
  }
  ```

  `bots` becomes the criteria `Bot?identifier=<system>|send-reminder`, so a
  policy is the same in every environment.
- **`secrets`** must be keys of `project.secrets`, so a bot never deploys
  reading a secret the environment does not set.
- **A Subscription names `bot` or `url`,** never both. A `url` must be
  `https`. `headers` take `{ env }` values, as secrets do, since they usually
  carry a token.
- **`operations` lists contract modules,** loaded as the config is, with the
  project's tsx when installed. Each export made by `defineOperation` is an
  operation; its `bot` must be a key of `bots`.

### Checked offline, before anything is written

Named errors, each naming the key:

- `invalid-bot`: a `file` that does not exist, a vmcontext bundle that is not
  CommonJS, an unknown `policy` or secret, `publicWebhook` without `policy`,
  an invalid `cron` (Medplum's own `isValidCron`).
- `invalid-subscription`: criteria Medplum's matcher cannot fire on, checked
  with `@medplum/core`'s own parser and the base search parameters: an
  unknown resource type, a chained or `_has` parameter, a parameter that is
  not in Medplum's base set, a number, quantity or composite parameter, a
  modifier the matcher ignores; a FHIRPath that does not parse; a header
  without `:` or with one in its value; `maxAttempts` over 18; `bot` and
  `url` both or neither; a `bot` not in `bots`.
- `invalid-operation`: a code used twice, a code an OperationDefinition in
  `@medplum/definitions` already has (base R4's, and the few Medplum ships
  there; Medplum's other server operations are not listed anywhere offline,
  so the README lists them), a `bot` not in `bots`, a FHIR side naming a
  profile that is not selected.

## The plan

`push` gains three steps after `project` (so the policies and secrets bots
need exist first): `bots`, `operations`, then `subscriptions`, last, so
nothing fires at a bot before its code is deployed.

**Bots.** Each declared bot is found by identifier in the target project.

- **Missing:** created through the admin endpoint with its runtime and
  policy, so it gets its membership, then given its identifier and fields.
- **Held:** its fields, membership policy and `admin` are converged; a held
  bot with no membership is reported, since only a super admin can fix it.
- **Deployed** only when the file's SHA-256 differs from the one recorded in
  `executableCode.title` (`<key>-<hash>.cjs`, keeping the file's extension),
  so an unchanged bundle never publishes a Lambda version.
- **`--adopt`** takes over an untagged bot with the same name: it gains the
  identifier and keeps its id, membership and webhook URL. Without it, the
  plan names the bot and leaves it alone.
- **Reported:** each public webhook's URL in this environment; a missing
  `bots` feature, or `cron` when any bot has a schedule.

**Subscriptions.** Each is found by Plumb's tag with its key, so changing the
criteria updates it in place rather than leaving the old one running. A held
Subscription the server turned `off` with an `error` is reported, and
`push` sets it back to `active`. Only the fields Plumb declares are compared;
the server's own `meta` and `error` are not drift.

**Operations.** Each contract becomes an OperationDefinition, found by its
tag and code: the implementation extension names this environment's
`Bot/<id>`, resolved from the bot's key, so the file never holds an id. A
held OperationDefinition with that code that Plumb did not tag, here or in a
linked project, stops the push (`shadowed-operation`): Medplum would pick one
of the two at random.

`--dry-run` stops after the plans; `--check` exits 1 when any plan is not
empty, so a bot redeployed by hand, a Subscription edited in the console or a
missing OperationDefinition turns the nightly check red.

`planBots`, `planSubscriptions` and `planOperations` return plans and their
`apply` functions write them; `push` composes them and the CLI only prints.

## Operation contracts

`defineOperation`, `callOperation` and `handleOperation` are written into
`_plumb.ts` when the config lists `operations`, so an app and its bots take
no runtime dependency on Plumb.

- **Each side is a FHIR type or a Standard Schema.** A FHIR side names a
  resource type or a selected profile and takes the type `generate` writes.
  A JSON side is any [Standard Schema](https://standardschema.dev) value
  (Zod, Valibot, ArkType and others implement it), so Plumb adds no schema
  library and a project keeps the one it has.
- **Both ends check at run time.** `handleOperation` parses the input before
  the handler runs and checks the output before returning it; `callOperation`
  checks the input before sending and the output it gets back. A JSON side is
  checked by its schema. A FHIR side's resource type is checked, and a
  profile side with the generated `asProfiled`
  ([design 04](04-typed-reads.md)): the profile's stamp and the elements its
  type requires. Full validation stays Medplum's, on write; a bot bundle does
  not carry the profiles' definitions.
- **The wire is what Medplum passes through.** Input is the POST body as is:
  the resource, or the JSON. Output goes back as `Parameters`, which Medplum
  passes through untouched: a resource as the `return` parameter, JSON as a
  `result` string, which `callOperation` unwraps. Nothing depends on how
  Medplum would map an unwrapped return.
- **The OperationDefinition is generated from the contract:** its code,
  level, resource, the `return` or `result` out parameter, and the
  implementation extension. It describes the operation; Medplum does not check
  input against it.
- **A failed check is an `OperationOutcome`** with the schema's issues, which
  `handleOperation` returns as a 400 and `callOperation` throws as an
  `OperationError` carrying them.

## Typed bots

`generate` writes `_bots.ts` when the config declares `bots`:
`defineBot('<key>', handler)`, whose `event.input` is the union of what the
bot's triggers send it, and whose `event.secrets` has the bot's declared
secret keys:

| Trigger | `event.input` |
| --- | --- |
| A Subscription on `Appointment?…` | `Appointment`, or `{ deletedResource: Appointment }` when it includes `delete` |
| A schedule | `Bot` |
| An operation | the contract's input type (through `handleOperation`) |
| A webhook | `unknown`, or `string` with `rawBody` |

A bot with one trigger gets that type; one with several narrows on it. The
types say what Medplum sends; a webhook's body is still the bot's to check.

## Test projects

A test project ([design 08](08-test-environments.md)) is pushed with the
config, so its bots, Subscriptions and operations exist and its tests can call
them. The test server runs every bot on vmcontext, whatever its `runtime`;
vmcontext's `require` reaches the server's own packages, so a bundle that
leaves only `@medplum/*` external runs there. A bot built for a Lambda layer
names a test build with `test.bots: { '<key>': { file } }`.

## Errors

Named, as config and push errors are: `invalid-bot`, `invalid-subscription`,
`invalid-operation` (above); `bot-without-membership`, a held bot only a super
admin can repair; `shadowed-bot`, two bots with one identifier;
`shadowed-operation` (above); `bots-disabled` and `cron-disabled`, reported
from `GET /auth/me` before anything is written.

## Testing

Against the Docker Medplum server, in a test project per file:

- **Bots converge:** a push creates a bot with its membership and policy; a
  second push plans nothing and deploys nothing (its Bot version is
  unchanged); a changed file deploys once; `--adopt` keeps the bot's id and
  membership id.
- **Triggers fire:** a write matching a pushed Subscription runs its bot,
  seen in the bot's AuditEvent; a criteria change updates the Subscription in
  place; a webhook URL `push` reports runs the bot without a token and a
  policy-less one is refused at the config.
- **Access by key:** a client whose policy grants `bots: ['x']` can run `x`
  and not `y`.
- **Operations:** `callOperation` reaches the bot by code with JSON and FHIR
  sides; a schema failure is a 400 with the schema's issues; an
  OperationDefinition another tool wrote for the code stops the push.
- **Prune:** a removed bot's Subscriptions go `off`, its OperationDefinitions
  are deleted, and the Bot, membership and webhook URL remain.
- **Drift:** a Subscription edited in the console turns `--check` red.

Offline: the config checks and each named error, with a criteria table built
from Medplum's matcher (each row records whether `matchesSearchRequest` can
fire on it, checked against the function itself); generated handler and
contract types compile against fixture bots and reject a wrong input, in the
harness's `tsc` run. Schedules are checked by `push`'s plan, not by waiting
for one to run.

## Proposed issues

**v0.12: bots and triggers** (#167 to #173)

1. **Research and spec:** the behaviour findings in the research notes, and
   this design on the roadmap. (Lands with this note.)
2. **Config:** `bots` and `subscriptions`, typed and checked offline, with the
   criteria table.
3. **Push:** the `bots` step: create through the admin endpoint, converge,
   deploy by hash, schedules, `--adopt`, webhook URLs, features reported.
4. **Access by key:** `bots` in policy entries.
5. **Push:** the `subscriptions` step, by tag, with `--prune` and `--check`.
6. **Test projects** run the declared bots on vmcontext, with `test.bots`.
7. **Docs:** a README section, the changelog, and Medplum issues for a failing
   bot counted as delivered and for a `GET` operation with a query string.

**v0.13: operations and typed handlers** (#174 to #177)

8. **Contracts:** `defineOperation`, `callOperation` and `handleOperation` in
   `_plumb.ts`, with Standard Schema and FHIR sides.
9. **Push:** the `operations` step, generating OperationDefinitions, with
   `shadowed-operation`, `--prune` and `--check`.
10. **Generate:** `_bots.ts` and `defineBot`, typed by trigger.
11. **Docs:** the README's operations section, the changelog, and this design
    marked implemented.

## Later (not in this design)

- **The `Cron` resource** for schedules with parameters, once Plumb's oldest
  supported Medplum has it.
- **Pre-commit bots and CDS Hooks services,** which need server settings.
- **Marketplace manifests** emitted from bots and contracts, once
  `@medplum/package-types` merges.
- **Secrets per bot,** if Medplum gains them; today every bot reads the whole
  `Project.secret`.
