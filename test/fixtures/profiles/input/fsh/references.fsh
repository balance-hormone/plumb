// Coverage matrix: References.
Profile: ReferencesObservation
Parent: Observation
Id: references-observation
Title: "References Observation"
Description: "subject narrowed to Patient (a base target); performer narrowed to CardinalityPatient (a profile target, which Medplum does not check)."
* subject 1..1
* subject only Reference(Patient)
* performer only Reference(CardinalityPatient)
