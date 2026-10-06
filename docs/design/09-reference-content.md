# Design 09: Reference Content as Code

**Status: accepted** on 2026-10-06, for v0.11. The second item on the
[spec's roadmap](../spec.md#roadmap). Builds on
[design 02](02-conformance-check.md)'s `push`, which loads profiles by
canonical URL, and [design 06](06-project-config.md)'s project config, which
finds what it manages by a tag. Read design 06 first: this extends its plan,
its tags, `--adopt`, `--prune` and `--check`.

## Job

A Medplum project holds content its code depends on that is neither a profile
nor patient data: the Questionnaires its forms render, the CodeSystems and
ValueSets its codes come from, the Organizations its resources point at. Today
that content is made in the console or by a one-off script, so a second
environment drifts from the first, and code reads it untyped:
`getQuestionnaireAnswers(response)` returns
`Record<string, QuestionnaireResponseItemAnswer>`, so a misspelled `linkId` or
a code no answer option allows compiles, and reads `undefined` at run time.

The same four steps as every layer: **declare** the content as FHIR files in
the repository, **generate** types from it, **converge** each environment on
it with `push`, and **verify** with `push --check`.

```text
plumb push --env prod
✔ profiles   1 loaded
✔ content    plan: 3 to create, 1 to update, 0 to retire
    + CodeSystem     http://example.org/fhir/CodeSystem/visit-reason 1.0.0
    + ValueSet       http://example.org/fhir/ValueSet/visit-reason 1.0.0
    + Questionnaire  http://example.org/fhir/Questionnaire/intake 2.1.0
    ~ Organization   main-clinic (address)
✔ content    applied 4 changes   380ms
✔ project    plan: 0 to create, 0 to update, 0 to remove
Done in 4.2s
```

```ts
import { intakeAnswers } from './fhir/generated/index.js';

const answers = intakeAnswers(response);
answers['visit-reason']; // Coding with code 'new' | 'follow-up' | 'urgent', or undefined
answers['weight-kg'];    // number | undefined
answers['wieght-kg'];    // compile error
```

## Checked first

Each claim below was read from Medplum's source (`main` at `398038d`, 5.2.1)
and is recorded in the
[research notes](../research/medplum-server-behaviour.md#reference-content).
Two of them take items off the roadmap's list.

- **A project's SearchParameters do nothing.** The search index is built once
  at server start from `@medplum/definitions`; no code reads a stored
  SearchParameter back, each parameter maps to columns a schema migration
  adds, and an unknown code is a 400. A custom search parameter is a Medplum
  change, not something `push` can write, so this design leaves it out and
  the spec's roadmap drops it.
- **Terminology resolves the project's own first.** `$expand`,
  `$validate-code`, `$lookup` and the `validate-terminology` feature resolve a
  ValueSet or CodeSystem by URL in the caller's own project, then linked
  projects in `Project.link` order, then base R4, skipping retired ones. So a
  pushed ValueSet takes effect, and a retired one stops.
- **A CodeSystem's inline concepts are indexed on write** when its `content`
  is `complete`, `example` or `fragment`; an update re-indexes from the inline
  concepts alone. A `not-present` CodeSystem needs `CodeSystem/$import`.
- **No canonical URL is unique.** The server accepts two Questionnaires for
  one URL, and `QuestionnaireResponse/$extract` then picks whichever the
  database returns first. Push keeps one per URL, as it does for profiles.
- **A QuestionnaireResponse is never checked against its Questionnaire,** on
  write or anywhere else. Generated answer types are the only check a
  response's shape gets.
- **Nothing blocks a delete** of content other resources point at. Retiring,
  not deleting, is the safe removal.
- **Subscriptions** need `status: active`, are not validated on write, and a
  criteria string the server cannot match never fires, silently. Their main
  use is triggering bots, and their channel headers carry secrets: they move
  to the behaviour layer, declared with the bots they trigger.

## What is declared

| Content | Found again by | Removed with `--prune` by |
| --- | --- | --- |
| Questionnaire | canonical `url` | `status: retired` |
| CodeSystem | canonical `url` | `status: retired` |
| ValueSet | canonical `url` | `status: retired` |
| Organization | a key, its file's `id` | `active: false` |

Not declared, and why:

- **SearchParameters:** a project's own are ignored (above).
- **Subscriptions:** with the bots they trigger, in the behaviour layer.
- **Anything per environment.** Content is the same in every environment, as
  policies are; two environments that need different content are two configs.
- **Patient data,** and any resource a person creates in the app. Seed data
  for tests is `test.seed` ([design 08](08-test-environments.md)), loaded
  into test projects only.
- **`not-present` CodeSystems** (SNOMED CT, LOINC, RxNorm): their codes are
  licensed, large and loaded by `$import` or by Medplum itself.

## Config

```ts
export default defineConfig({
  // …igs, profiles, out, project as today
  content: ['./fhir/content/*.json', './fsh/fsh-generated/resources/Questionnaire-*.json'],
});
```

- **`content` lists files,** as paths or globs against the config's folder,
  each one FHIR resource as JSON. A FSH project points at the instances SUSHI
  writes; `content` is never the whole SUSHI output, which holds examples
  that are not content.
- **The file is the content.** It is written as it stands, less `id` and
  `meta`, so what is reviewed in the diff is what the server holds.
- **An Organization's file `id` is its key** (a FSH `Instance` name), never
  sent as its server id. Two files with one key, or one canonical URL, are a
  named error.
- **Checked before anything is written:** each file must parse, be one of the
  four types, carry a `url` (canonical types) or `id` (Organization), and pass
  Medplum's validator offline against base R4 and any selected profile it
  claims in `meta.profile`. A file that fails names itself, and nothing is
  pushed.

## Terminology travels with profiles

`push` loads a profile's StructureDefinitions and never the ValueSets and
CodeSystems its bindings name. On a project with `validate-terminology`, a
write that carries a value for such a binding is refused with `ValueSet <url>
not found` (`repository/validation.ts`, `validateTerminology`).

Profiles' terminology joins the profile plan, by the same rules: each
required and extensible binding of a selected profile, and the CodeSystems
those ValueSets include, from the IG packages and `local`, except base R4's,
which the server holds. They load with the profiles, before the gate, so the
gate checks what the server will check. A `not-present` CodeSystem is not
loaded, and a binding to one is reported once (`hl7.fhir.us.core: 3 ValueSets
include SNOMED CT, which Medplum loads`).

## The plan

`push` gains a `content` step after `profiles` and before `project`, in
dependency order: CodeSystems, then the ValueSets that include them, then
Questionnaires that name them in `answerValueSet`, then Organizations.

- **One per URL, updated in place.** A canonical resource is found by `url`
  in the target project; push updates the one it holds rather than adding a
  second, as it does for StructureDefinitions. Two held for one URL stop the
  push.
- **Tagged when written,** with Plumb's tag system and the URL or key as
  code, so `--prune` knows which ones Plumb wrote. An untagged one with the
  same URL or key is never touched: the plan names it, and `--adopt` tags and
  converges it, as design 06's policies do.
- **A changed resource without a version bump** is flagged, as an edited
  profile is: a Questionnaire whose items change under one `version` leaves
  stored responses pointing at a version that no longer says what they
  answered.
- **Removal retires, and needs `--prune`.** Content Plumb tagged whose file
  is gone is listed; with `--prune` a canonical resource becomes
  `status: retired` and an Organization `active: false`. Nothing is deleted:
  responses, codes and references keep pointing at something, and terminology
  lookup already skips retired content.
- **Only the target project's own,** as design 06: a linked project's content
  is neither planned nor counted as a second resource for a URL.
- **`--dry-run` stops after the plan,** and **`--check` exits 1** when the
  plan is not empty, so an edit made in the console turns the nightly check
  red.

`planContent(config, client)` returns the plan and `applyContent(plan,
client)` writes it; `push` composes them, and the CLI only prints.

## Generated types

`generate` reads `content` as well as profiles, and writes one file per
Questionnaire into `out`:

- **`<Name>Answers`:** each item's `linkId` mapped to its answer's type, from
  `item.type`: `string` and `text` to `string`, `integer` and `decimal` to
  `number`, `boolean`, `date` and `dateTime` to `string`, `quantity` to
  `Quantity`, `reference` to `Reference` of the targets it allows, and
  `choice` to a `Coding` whose `code` is a literal union when the answer
  options or the `answerValueSet` can be listed offline (by design 01's
  bindings rules). A repeating item is an array. Every answer can be
  `undefined`: a response is never checked against its Questionnaire, so a
  required item may still be missing.
- **`<name>Answers(response)`:** reads a QuestionnaireResponse into that
  type, as `getQuestionnaireAnswers` does, through nested groups. It throws
  when `response.questionnaire` names another Questionnaire.
- **`<Name>LinkId`,** the union of its `linkId`s, and its canonical URL as a
  constant, for code that builds a response.

ValueSets and CodeSystems in `content` already feed design 01's bindings:
they are listed offline like any local terminology, so a profile bound to
them gets its literal union.

## Errors

Named, as config and push errors are:

- `invalid-content`: a file that does not parse, or is not one of the four
  types; the message names SearchParameter and Subscription when that is
  what it is.
- `duplicate-content`: two files with one canonical URL or Organization key.
- `content-refused`: a file Medplum's validator rejects offline, with its
  path and the validator's issue.
- `shadowed-content`: the project holds two resources for one URL or key.

## Testing

Against the Docker Medplum server, in a test project per file
([design 08](08-test-environments.md)):

- **Converges:** a push creates the content, tagged; a second push plans
  nothing; an edit updates the one resource in place, keeping its id.
- **Terminology takes effect:** after a push, `$expand` of a pushed ValueSet
  lists the pushed CodeSystem's codes; in a test project with
  `validate-terminology`, a write coded outside a selected profile's required
  binding is refused, and one inside it accepted.
- **Retire, not delete:** a file removed is planned, kept without `--prune`,
  and retired with it; `$expand` of a retired ValueSet stops resolving it.
- **Untagged is untouched; `--adopt` takes it over.** A linked project's
  content is not planned.
- **Drift:** a Questionnaire edited in the console turns `--check` red.

Offline: the config checks and each named error; generated answer types
compile against fixture responses and reject a misspelled `linkId` and a code
outside the answer options, in the harness's `tsc` run; `<name>Answers`
reads nested and repeating items.

Fixtures are synthetic: Plumb's own FSH test project gains a Questionnaire,
a CodeSystem, a ValueSet and an Organization.

## Proposed issues (v0.11 milestone)

1. **Research and spec:** the reference-content findings in the research
   notes; the roadmap and the spec's layer table drop SearchParameters and
   move Subscriptions to behaviour. (Lands with this note.)
2. **Terminology with profiles:** the ValueSets and CodeSystems the selected
   profiles bind load with them, with the real-server `validate-terminology`
   test.
3. **Config:** `content`, typed and checked offline, with named errors.
4. **Push:** the `content` step, canonical resources by URL and
   Organizations by key, tagged, with `--adopt`, `--prune` retiring, and
   `--check`.
5. **Generate:** Questionnaire answer types, `<name>Answers` and the goldens.
6. **Docs:** a README section, the changelog, and this design marked
   implemented.

## Later (not in this design)

- **Subscriptions,** with the bots they trigger and checked criteria, in the
  behaviour layer.
- **Custom search parameters,** if Medplum gains project-scoped ones; an
  upstream issue first.
- **`not-present` CodeSystems** loaded by `$import` from a file the project
  holds a licence for.
- **ConceptMaps, PlanDefinitions and ActivityDefinitions,** found by URL like
  the rest, when a project needs them.
- **`QuestionnaireResponse/$extract` templates** typed against the resources
  they extract to.
