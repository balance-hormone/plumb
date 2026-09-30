// Coverage matrix: Inheritance. Several profiles on one base type are covered by
// the Patient and Observation profiles in the other files.
Profile: ParentObservation
Parent: Observation
Id: parent-observation
Title: "Parent Observation"
Description: "subject and a dateTime effective[x] required."
* subject 1..1
* effective[x] 1..1
* effective[x] only dateTime

Profile: ChildObservation
Parent: ParentObservation
Id: child-observation
Title: "Child Observation"
Description: "ParentObservation, plus a BMI code pattern and a required valueQuantity.value."
* code = $loinc#39156-5
* value[x] 1..1
* value[x] only Quantity
* valueQuantity.value 1..1
