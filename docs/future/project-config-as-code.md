# Idea: Project Config as Code

**Status: picked up** by [design 06](../design/06-project-config.md)
(implemented in v0.6). This note keeps the original sketch and research.

## Problem

A Medplum project's configuration (`strictMode`, features, default profiles,
access policies, client applications) is usually set by hand in the console.
It cannot be reviewed, and it cannot be reproduced in a second environment.

## Sketch

- **`push --env <env>`** shows a plan and applies it (design 06 settled on
  applying by default, with `--dry-run`, rather than a `--write` flag), in
  dependency order: StructureDefinitions, defaults, settings, clients,
  policies. A second run with no config change is an empty plan (Terraform's
  plan and apply).
- **Declared:** `strictMode`, `features`, `setting`, `defaultProfile`,
  `defaultAccessPolicies`, client applications, access policies, and bot
  registrations (the Bot resource and its membership, not its code, which
  Medplum's CLI already deploys).
- **Converged on every run,** matched by name or identifier, never by a
  hard-coded id. Created clients and bots have their ids written to an output
  file the project wires into its own secrets; secrets stores are out of scope.
- **Refuses to create a project** the config does not already match, unless
  `--create` is passed.
- **Drift:** live defaults, settings or policies that differ from the config
  fail a check.
- **One StructureDefinition per canonical URL,** loaded by updating it in
  place, because Medplum resolves a bare URL by a text sort on `version`.

## Two credentials

`strictMode`, `features`, `link` and `systemSetting` are writable only by a
super admin; a project admin's writes to them are silently discarded. `push`
routes those fields to a separately configured break-glass credential and plans
them as their own section, so they are never applied by accident.

## The lockdown recipe

From Medplum's source:

- project admin does **not** bypass an AccessPolicy, but can create clients
  through the system repository, edit any ProjectMembership, and act on behalf
  of another membership;
- policy entries are a **union** (any entry that allows an interaction allows
  it), and field rules come from the **first** matching entry;
- so people get `admin: false` and a policy with **no writable `*` entry**: the
  clinical types they may write are listed explicitly, configuration types
  (ClientApplication, Bot, Subscription, OperationDefinition,
  StructureDefinition, SearchParameter, AccessPolicy) are read-only or absent,
  and any `*` entry is `readonly: true`;
- the CI client gets `admin: true` **and** an explicit policy, because an admin
  with no policy falls back to full access;
- super admin is the break-glass.

## Overlap with Medplum's marketplace

Medplum's in-progress marketplace (`medplum/medplum#9406`) has a
`defineManifest()` format with idempotent, re-runnable installs, migrations and
a configuration Questionnaire: the same idea as `push`, applied to installable
packages. If this tool is picked up, first check whether the marketplace has
merged and whether `push` should load through `PackageRelease/$install` rather
than plain FHIR writes. Plumb should not build a rival.

## User stories carried over

1. Declare and converge strict mode, features, settings, default profiles and
   default access policies.
2. Declare client applications and access policies, so a second environment
   can be built from the repo.
3. Plan, then apply only with `--write`; a second run changes nothing.
4. Refuse to create a project the config does not already match.
5. A documented lockdown recipe.
6. Fail when live configuration drifts from the config.

## Ties to other pieces

- Supplies the writer for the [conformance check](conformance-check.md)'s load
  gate.
- Would load the generated OperationDefinitions of
  [operation contracts](operation-contracts.md).

## Research

- [Medplum server behaviour](../research/medplum-server-behaviour.md): project
  fields and who can write them, AccessPolicy and project admin, bots, the
  marketplace.
