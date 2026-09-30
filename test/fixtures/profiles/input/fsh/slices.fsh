// Coverage matrix: Slices.
Profile: SlicedObservation
Parent: Observation
Id: sliced-observation
Title: "Sliced Observation"
Description: "Unordered open slicing on component by code: systolic and diastolic required, pulse optional; systolic has a nested required value."
* component ^slicing.discriminator.type = #pattern
* component ^slicing.discriminator.path = "code"
* component ^slicing.rules = #open
* component ^slicing.ordered = false
* component contains systolic 1..1 and diastolic 1..1 and pulse 0..1
* component[systolic].code = $loinc#8480-6
* component[systolic].value[x] only Quantity
* component[systolic].valueQuantity 1..1
* component[systolic].valueQuantity.value 1..1
* component[diastolic].code = $loinc#8462-4
* component[diastolic].value[x] only Quantity
* component[pulse].code = $loinc#8867-4

Profile: SlicedPatient
Parent: Patient
Id: sliced-patient
Title: "Sliced Patient"
Description: "Closed slicing on identifier by system (mrn required, member optional); ordered open slicing on name by use (official required, then nickname optional)."
* identifier ^slicing.discriminator.type = #value
* identifier ^slicing.discriminator.path = "system"
* identifier ^slicing.rules = #closed
* identifier contains mrn 1..1 and member 0..1
* identifier[mrn].system = "http://example.org/fhir/sid/mrn" (exactly)
* identifier[mrn].value 1..1
* identifier[member].system = "http://example.org/fhir/sid/member" (exactly)
* name ^slicing.discriminator.type = #value
* name ^slicing.discriminator.path = "use"
* name ^slicing.rules = #open
* name ^slicing.ordered = true
* name contains official 1..1 and nickname 0..1
* name[official].use = #official (exactly)
* name[official].family 1..1
* name[nickname].use = #nickname (exactly)
