# Test fixtures

Inputs to Plumb's tests, and the results each one should produce. Expected
results come from the profile's rules and from `@medplum/core`'s
`validateResource`, never from Plumb's output (design 01, Testing). All
resources here are HL7's published examples or made up; none is real patient
data.

## `packages/hl7.fhir.us.core#9.0.0`

US Core 9.0.0, copied unmodified from the FHIR package registry, laid out as
the shared FHIR package cache (`~/.fhir/packages`) lays it out.

- **Source:** `https://packages.fhir.org/hl7.fhir.us.core/9.0.0`, tarball
  SHA-256 `d7b54d2ec2a48cea94ffea5d939ad67a681f80b94d69594a08cebac36da9e059`.
- **License:** CC0-1.0 (the package's `package.json`), so it may be committed.
- **Kept:** `package.json`, every StructureDefinition (70), ValueSet (21) and
  CodeSystem (4), and all 230 examples under `example/`.
- **Left out:** the CapabilityStatements, SearchParameters, OperationDefinition,
  ImplementationGuide, Basic and Parameters resources, `.index.json`,
  `.index.db`, and the `xml/`, `openapi/` and `other/` folders. Plumb reads none
  of them. `.index.json` is left out because it lists the omitted files.
- The files are HL7's published examples, so the agnostic check applies only
  its denylist to them: their example hosts, emails and identifiers are HL7's,
  not an organization's.

To refresh it, download the tarball, check its hash, and copy the same files:

```bash
curl -sSL https://packages.fhir.org/hl7.fhir.us.core/9.0.0 -o us-core.tgz
```

## Trimmed dependency packages

`hl7.fhir.uv.extensions.r4#5.3.0`, `hl7.fhir.uv.sdc#4.0.0`,
`hl7.fhir.uv.xver-r5.r4#0.1.0` and `hl7.terminology.r4#7.1.0` hold only the
28 definitions US Core 9.0.0's resource profiles reach through the loader, plus
each package's `package.json`, copied unmodified from the registry (all
CC0-1.0). The full packages are about 250 MB; these are about 1 MB. To refresh
them, fetch US Core into a cache with `fetchPackages`, load every US Core
resource profile with `loadProfiles`, and copy the files for each definition
whose source is one of these packages.

`hl7.fhir.uv.ips#2.0.1` holds the 19 definitions IPS Patient and IPS
Composition reach, plus its `package.json`, copied unmodified from the
registry (CC0-1.0), for the golden tests; the extensions package above also
holds the four IPS needs.

## `us-core-examples.json`

What each US Core example should do: compile against the type for its
`meta.profile` and validate against that profile. The file lists the only
exceptions: examples with no US Core profile, Bundles (whose entries are
checked one by one), and the profile Medplum cannot parse.

## `profiles`

Plumb's own synthetic test profiles, one or two per row of design 01's
coverage matrix, under the canonical `http://example.org/fhir/plumb-test`. The
FSH in `input/fsh` is the source; `fsh-generated/resources` is SUSHI's output,
with snapshots, and is committed. After editing the FSH, regenerate it:

```bash
npm run fixtures:profiles
```

SUSHI fetches `hl7.fhir.r4.core` into `~/.fhir/packages` the first time. It is
needed only to edit these profiles; the tests read the committed JSON.

The snapshots repeat base FHIR definition text, with HL7's example hosts, so
the agnostic check applies only its denylist to `fsh-generated`; the FSH
itself gets the full check.

## `contracts`

One contract table per test profile, and one each for four US Core profiles
with synthetic records. Each file names its `profile`, the coverage-matrix
rows it covers, and its fixtures. A fixture has:

| Field | Meaning |
|---|---|
| `name`, `rule` | What the row tests, and the profile rule it comes from |
| `conforms` | Whether the resource meets the profile's rules, by a person reading them |
| `compiles` | Whether it should compile against the generated type |
| `validates` | Whether `validateResource` reports no `error` issue, checked against Medplum's validator |
| `typeGap` | Why `compiles` differs from `conforms`, when it does |
| `validatorGap` | Why `validates` differs from `conforms`, when it does |
| `resource` | The resource |

`assignableTo` lists parent profiles the generated type must be assignable to.
The gap names, and what each means, are defined in design 01's Testing
section; a new one needs a reviewed edit there.

## Goldens (`../golden`)

`test/golden/generated` is Plumb's output for four US Core and two IPS
profiles, generated from these fixtures and committed. The golden test
regenerates it and compares byte for byte. Goldens detect change, not
correctness, so each file is read against its profile before it is committed.
To regenerate after an intended change:

```bash
GOLDEN_UPDATE=1 npx vitest run test/golden
```

CI type-checks them under TypeScript 5.0 and the project's TypeScript, with
`NodeNext` and `bundler` resolution (`test/golden/tsconfig.*.json`).

