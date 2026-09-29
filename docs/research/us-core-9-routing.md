# US Core 9.0.0: What Routing Can Generate

Read from the published package (`hl7.fhir.us.core` 9.0.0,
`https://hl7.org/fhir/us/core/STU9/package.tgz`) on 2026-09-28, snapshots only.
This is the evidence behind the spec's split between generated routing rows and
config rows.

## Resource types with more than one profile, or content-dependent rules

A routing row can be **generated** when the profile pins a fixed or pattern
value on its key. It has to be a **config row** when the profile keys on
value-set membership instead.

| Type | Profile | Parent | Pinned `code` | Pinned `category` | Keyed on a value set |
|---|---|---|---|---|---|
| Condition | `us-core-condition-encounter-diagnosis` | Condition | | `encounter-diagnosis` | |
| Condition | `us-core-condition-problems-health-concerns` | Condition | | | category ∈ `us-core-problem-or-health-concern` |
| DiagnosticReport | `us-core-diagnosticreport-lab` | DiagnosticReport | | `LAB` | |
| DiagnosticReport | `us-core-diagnosticreport-note` | DiagnosticReport | | | category ∈ `us-core-diagnosticreport-category` (0..*) |
| DocumentReference | `us-core-documentreference` | DocumentReference | | | type ∈ `us-core-documentreference-type` (required) |
| DocumentReference | `us-core-adi-documentreference` | DocumentReference | | | |
| Observation | `us-core-vital-signs` | vitalsigns | | `vital-signs` | |
| Observation | `us-core-blood-pressure` | us-core-vital-signs | 85354-9 | `vital-signs` | |
| Observation | `us-core-average-blood-pressure` | Observation | 96607-7 | `vital-signs` | |
| Observation | `us-core-bmi` | us-core-vital-signs | 39156-5 | `vital-signs` | |
| Observation | `us-core-body-height` | us-core-vital-signs | 8302-2 | `vital-signs` | |
| Observation | `us-core-body-temperature` | us-core-vital-signs | 8310-5 | `vital-signs` | |
| Observation | `us-core-body-weight` | us-core-vital-signs | 29463-7 | `vital-signs` | |
| Observation | `us-core-head-circumference` | us-core-vital-signs | 9843-4 | `vital-signs` | |
| Observation | `us-core-heart-rate` | us-core-vital-signs | 8867-4 | `vital-signs` | |
| Observation | `us-core-respiratory-rate` | us-core-vital-signs | 9279-1 | `vital-signs` | |
| Observation | `us-core-pulse-oximetry` | us-core-vital-signs | (coding slices, extensible) | `vital-signs` | |
| Observation | `us-core-observation-clinical-result` | Observation | | | category ∈ `us-core-clinical-result-observation-category` |
| Observation | `us-core-observation-lab` | us-core-observation-clinical-result | | `laboratory` | |
| Observation | `us-core-observation-occupation` | Observation | 11341-5 | `social-history` | |
| Observation | `us-core-observation-pregnancyintent` | Observation | 86645-9 | `social-history` | |
| Observation | `us-core-observation-pregnancystatus` | Observation | 82810-3 | `social-history` | |
| Observation | `us-core-observation-sexual-orientation` | Observation | 76690-7 | | |
| Observation | `us-core-smokingstatus` | Observation | (value set, extensible) | `social-history` | code ∈ a VSAC value set |
| Observation | `us-core-observation-screening-assessment` | Observation | | `survey` | |
| Observation | `us-core-observation-adi-documentation` | Observation | 45473-6 | `observation-adi-documentation` | |
| Observation | `us-core-care-experience-preference` | Observation | 95541-9 | `care-experience-preference` | |
| Observation | `us-core-treatment-intervention-preference` | Observation | 75773-2 | `treatment-intervention-preference` | |
| Observation | `us-core-simple-observation` | Observation | | | category ∈ `us-core-simple-observation-category` |

**Takeaways**

- About two-thirds of the Observation profiles pin a LOINC code, and most also
  pin a category, so those rows generate cleanly.
- **Overlap is real.** Every vital sign is also a `us-core-vital-signs`, and a
  lab result is also a clinical result, so routing needs most-specific-wins.
- **Value-set keys need either an expansion or a config row.** VSAC value sets
  (smoking status) cannot be expanded offline from the package, so they are
  config rows.
- **Several profiles share a key.** `social-history` alone selects nothing;
  the code decides between occupation, pregnancy status, pregnancy intent and
  smoking status.

## Surprises that change routing

- **`us-core-careplan` 9.0.0 does not require a category.** Only `status`,
  `intent` and `subject` are required (`category` is 0..*, `text` 0..1). CarePlan
  is therefore a single-profile type in 9.0.0, not a routed one. Earlier US Core
  versions required the `assess-plan` category, and much existing guidance
  still assumes it.
- **`us-core-coverage` has one content rule:** `us-core-15`, "Member Id in
  `Coverage.identifier` or `Coverage.subscriberId` SHALL be present". A
  self-pay Coverage has no member id and cannot conform. The routing key there
  is the absence of an element, which is why the spec allows absence as a key.
- **US Core profiles Specimen and Device** (`us-core-device` requires `type`),
  and FamilyMemberHistory (`relationship` 1..1). Easy to miss when listing
  which types have a US Core profile from memory.

## Required elements that commonly surprise imports

Checked against the snapshots:

| Profile | Element | Cardinality or rule |
|---|---|---|
| `us-core-encounter` | `type` | 1..* |
| `us-core-immunization` | `occurrence[x]` | 1..1 (`primarySource` is 0..1) |
| `us-core-careteam` | `participant.role` | 1..1 |
| `us-core-practitioner` | `name.family` | 1..1; `identifier` 1..* |
| `us-core-vital-signs` | `effective[x]` | 1..1 (`vs-1`, `vs-2`, `vs-3`) |
| `us-core-smokingstatus` | `effective[x]` | 1..1 |
| `us-core-observation-lab` | `effective[x]` | 0..1; `us-core-2`: a value, a component or a data-absent-reason |
| `us-core-diagnosticreport-lab` | `effective[x]` | 0..1 |
| `us-core-questionnaireresponse` | `questionnaire` | 1..1 |
| `us-core-procedure` | `code` | 1..1; `us-core-7`: performed when completed or in progress |
| `us-core-documentreference` | `type` | 1..1, required binding |
| `us-core-provenance` | `provenance-1` | `onBehalfOf` when `agent.who` is a Practitioner or Device |
| `us-core-medicationrequest` | `us-core-21` | `requester` SHALL be present if `intent` is `order` |
| `us-core-coverage` | `relationship`, `payor` | 1..1 each; `us-core-15` as above |

These are good fixtures for Plumb's contract tables, because they are the rules
most likely to fail real data.
