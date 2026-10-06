# Design 08: Test Environments

**Status: accepted** on 2026-10-06, for v0.10. The first item on the [spec's roadmap](../spec.md#roadmap).
Builds on [design 02](02-conformance-check.md)'s `push` and
[design 06](06-project-config.md)'s project config: a test environment is a
project they converge, on a server Plumb starts.

## Job

A Medplum project's tests run against `MockClient`, which enforces no profile,
`defaultProfile`, strict mode or AccessPolicy. So the rules a project declares
in `plumb.config.ts` are exactly the rules its tests cannot see:

- a write the server will refuse for its profile passes;
- an unstamped write never gets the default profile the server would stamp;
- a policy that hides a field, or forbids a write, hides and forbids nothing;
- a bot's input, output and permissions are whatever the mock returns.

Plumb's own tests hit the same wall, and solved it in
[`test/server`](../../test/server/): Medplum, Postgres and Redis in Docker,
and a fresh strict project per run with an admin client and synthetic data.
Every server claim Plumb makes is tested that way. A project using Plumb gets
the same harness, with its own config pushed into the project:

```ts
// vitest.config.ts
export default defineConfig({
  test: { globalSetup: ['plumb-fhir/vitest'] },
});
```

```ts
// src/intake.server.test.ts
import { testProject, connectAs } from 'plumb-fhir/test';

test('a front-desk client cannot read observations', async () => {
  const medplum = await connectAs(testProject(), { accessPolicy: 'front-desk' });
  await expect(medplum.searchResources('Observation')).resolves.toHaveLength(0);
});

test('an intake without a birth date is refused', async () => {
  const medplum = await connectAs(testProject());
  await expect(createIntake(medplum, { name: 'Synthetic' })).rejects.toThrow(/birthDate/);
});
```

`MockClient` stays the right tool for unit tests. A test environment is for
the claims only a server can check: profiles, defaults, policies and bots.

## Checked first

Before building, confirm against Medplum's source and docs, as design 06 did
for the marketplace, that nothing upstream already turns a repository into a
configured test project: `@medplum/mock`, `@medplum/cli`, Medplum's own
compose files and its test utilities. If something does, this design builds
on it instead.

Checked on 2026-10-06 (#140): nothing does. `MockClient` enforces no profile
or policy, the CLI creates no project, the compose files and the server's test
helpers are Medplum's own, and `Project/$init` adds default policies `push`
does not manage. The details are in the
[research notes](../research/medplum-server-behaviour.md#test-projects-what-upstream-offers).
The design and its issues stand as written.

## What a test environment is

- **A server Plumb starts:** Medplum, Postgres and Redis from a compose file
  shipped in the package, the one `test/server` uses today. Its image is the
  installed `@medplum/core` version by default, so the server matches the
  client the project already pins
  ([the README's advice](../../README.md#keep-medplum-in-step-with-your-server)),
  or `test.server` when set.
- **A project per run, made as a super admin.** The server is Plumb's own, so
  it seeds a super-admin client on first boot and uses it only to create
  projects, set what a project admin cannot (`strictMode`, `features`) and
  link projects. Those credentials never leave the test server: a test
  environment is never pointed at a server Plumb did not start.
- **The project converged by `push`, unchanged.** The new project resolves to
  an environment like any other, with its admin client's credentials, and
  `push` runs on it exactly as it runs on production: profiles, then
  `project`. A test environment that differs from production by a code path
  would test the wrong thing.
- **Seed data loaded after the push,** through the admin client, from the
  files `test.seed` names. The project is strict, so a seed resource that
  breaks its profile or the default fails the setup and names its entry.
  Seed data is synthetic; Plumb's checks that keep patient data out of its
  own repository are the model for a project's.

## Config

```ts
export default defineConfig({
  // …
  test: {
    server: '5.1.42',              // optional; default: the installed @medplum/core
    strictMode: true,              // the default; false rehearses a loose project
    features: ['bots'],            // the default
    settings: { intakeEnabled: true }, // merged over project.settings, as an environment's are
    seed: ['./test/seed/*.json'],  // transaction or batch Bundles, loaded in order
  },
});
```

`test` can set `strictMode` and `features` because the test server's super
admin can; `project` still cannot. Secrets resolve as `push` resolves them,
from the environment's variables, so a `true` secret the test run does not
set fails the setup with the same named error.

## The API

Plain functions, as every Plumb command is; the Vitest entry is a thin
adapter over them.

- `startServer(config)` starts the compose project, or reuses one already
  running from the same file, and returns its base URL. `stopServer()`
  removes it with its volumes, unless it was already running.
- `createTestProject(config, options?)` makes a project, pushes into it, loads
  the seed, and returns `{ baseUrl, projectId, clientId, clientSecret }` plus
  the push result. `options` overrides `strictMode`, `features` and `seed`, for
  a test that needs a loose or empty project of its own.
- `connectAs(project, as?)` returns a `MedplumClient` logged in as the
  project's admin client, or, given `{ client: 'key' }`, as a client the
  config declares, or, given `{ accessPolicy: 'key', parameters? }`, as a
  throwaway client whose membership has that policy. AccessPolicies are tested
  by acting as them.
- `plumb-fhir/vitest`: a `globalSetup` that starts the server, creates one
  project per run, and provides it; `testProject()` reads it in a test. With
  no Docker it fails in CI and skips with a warning locally, as Plumb's own
  setup does.

Jest and other runners call the plain functions from their own global setup.

## Errors

Named, as `generate`'s and `push`'s are:

- `docker-unavailable`: Docker is not installed or not running.
- `server-unhealthy`: the server did not pass its health check in time.
- `push-failed`: the push into the test project failed; its own report
  follows.
- `seed-refused`: a seed entry was refused, naming the file, the entry and
  the server's issue.
- `unknown-policy` and `unknown-client`: `connectAs` named a key the config
  does not declare.

## Costs

- **Time.** The first boot pulls images and takes about a minute; a running
  server is reused. A project and a push of US Core's profiles take seconds.
  One project per run is the default; a test that needs its own pays for it.
- **Docker** is the one new requirement, and only for these tests.
- **No new dependency.** Docker is driven with `child_process`, as
  `test/server` drives it now, and the compose file ships in the package.
- **Bots run on the vmcontext runtime.** Hosted Medplum runs them on Lambda,
  so a test environment cannot show Lambda's differences, as the README's
  known limits already say for the checker.

## Plumb's own harness

`test/server/setup.ts` becomes a consumer of these functions, so Plumb's
server tests run on the code it ships, and the duplicate setup is deleted.

## Testing

Against the Docker server, as design 06's tests are:

- **Converged:** a test project holds the config's profiles, policies, clients
  and Project fields, and a second push into it plans nothing.
- **Strict by default:** a write that breaks a selected profile is refused; an
  unstamped write is stamped with the configured default.
- **Seed:** loaded in order; an entry that breaks its profile fails the setup
  with `seed-refused`, naming it.
- **`connectAs`:** a policy-scoped client reads what its policy allows and is
  refused what it does not; a declared client logs in with its policy; an
  unknown key is a named error.
- **Server version:** the default follows the installed `@medplum/core`;
  `test.server` overrides it.
- **Reuse and cleanup:** a running server is reused and left running; one
  Plumb started is removed.
- **No Docker:** `docker-unavailable` in CI, a skip with a warning locally.

## Proposed issues (v0.10 milestone)

1. **Checked first:** what Medplum already offers for a configured test
   project, recorded in the research notes.
2. **Server:** ship the compose file; `startServer` and `stopServer`; the
   version from `@medplum/core` or `test.server`; the `test` config, typed and
   checked, with named errors.
3. **Projects:** `createTestProject`, pushing through `push` and loading the
   seed, with the real-server tests.
4. **`connectAs`,** by admin, declared client and AccessPolicy.
5. **Vitest adapter** and `testProject()`; Plumb's own harness moved onto it.
6. **Docs:** a README section on testing against a real server, the
   changelog, and this design marked implemented.

## Later (not in this design)

- **`plumb local`:** the same server and a long-lived project for running an
  app in development, with its credentials in a gitignored file, as
  `supabase start` gives a local stack.
- **Medplum's web app** beside the server, for looking at a test project.
- **A per-test project pool,** if one project per run proves too coarse.
- **Rehearsing production's super-admin fields:** a warning when the test
  environment's `strictMode` or `features` differ from what `connect` reports
  for an environment.
