# Contributing to Plumb

Thank you for helping. Plumb makes Medplum's own types profile-aware; read
[`docs/README.md`](docs/README.md) for where the project stands and
[`docs/spec.md`](docs/spec.md) before changing behaviour.

## Sign your commits (DCO)

Like Medplum, Plumb uses the [Developer Certificate of Origin](https://developercertificate.org)
instead of a contributor licence agreement. By signing off a commit you certify
that you wrote it, or otherwise have the right to submit it under the
project's licence (Apache-2.0). Add the sign-off with `-s`:

```bash
git commit -s -m "fix(plumb): …"
```

which appends a line with your name and email:

```text
Signed-off-by: Your Name <you@example.com>
```

Every commit in a pull request needs one. A sign-off is your own statement, so
only you can add it: tools, bots and coding agents must not add one for you.

## Before you open a pull request

- **Agnostic, always.** No organization's profiles, data model, identifiers or
  migrations: not in code, tests, fixtures, docs or examples. Test profiles
  come from published implementation guides or Plumb's synthetic profiles.
- **Synthetic data only.** Never commit real patient data or anything that
  looks like it.
- Link the issue in the pull request (`Closes #N`), and use conventional commit
  titles (`feat(plumb): …`, `fix: …`, `docs: …`).
- A bug fix or new logic starts with a failing test.
- Run everything CI runs:

  ```bash
  npm ci
  npm run build
  npm run check
  ```

  The end-to-end quickstart test runs in CI, or locally with `PLUMB_E2E=1`; the
  real-registry test runs nightly, or locally with `PLUMB_REGISTRY=1`. The
  server tests in `test/server` start Medplum in Docker and run in CI, or
  locally with `PLUMB_SERVER=1`; `PLUMB_MEDPLUM_SERVER` picks the server
  release. They start it with `startServer`, as a project's own tests do, and
  remove it afterwards; one already running, as one an interrupted run left,
  is reused and left running, and `docker compose -p plumb-medplum down
  --volumes` removes it.

[`AGENTS.md`](AGENTS.md) holds the rest of the project's rules, for people and
coding agents alike.

## Releasing

For a maintainer with publish rights to `plumb-fhir` on npm:

1. Move the changelog's section from "unreleased" to the date, and set the
   `version` in `package.json` to match.
2. Remove `"private": true` from `package.json`. It is there so nothing is
   published by accident before the first release is signed off.
3. Publish from a clean checkout of `main`:

   ```bash
   npm ci
   npm publish
   ```

   `prepublishOnly` runs `npm run check` and `npm run build` first, so a
   failing check stops the publish.
4. Tag the release (`git tag v0.1.0 && git push --tags`) and create a GitHub
   release from the changelog.

## Licence

Plumb is licensed under [Apache-2.0](LICENSE.txt). Every source file carries
the SPDX header the lint checks for.
