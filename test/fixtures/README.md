# Test fixtures

Inputs to Plumb's tests, and the results each one should produce. Expected
results come from the profile's rules and from `@medplum/core`'s
`validateResource`, never from Plumb's output (design 01, Testing).

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

## `us-core-examples.json`

What each US Core example should do: compile against the type for its
`meta.profile` and validate against that profile. The file lists the only
exceptions: examples with no US Core profile, Bundles (whose entries are
checked one by one), and the profile Medplum cannot parse.
