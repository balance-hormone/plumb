// Coverage matrix: Cardinality, and Primitive extensions (birthDate as _birthDate).
Profile: CardinalityPatient
Parent: Patient
Id: cardinality-patient
Title: "Cardinality Patient"
Description: "0..1 (gender), 1..1 (birthDate), 0..* (identifier), 1..* (name), max 0 (photo), and 0..* tightened to 0..1 (address)."
* birthDate 1..1
* name 1..*
* photo 0..0
* address 0..1
