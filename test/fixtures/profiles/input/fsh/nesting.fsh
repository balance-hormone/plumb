// Coverage matrix: Nesting, plus an invariant.
Profile: NestingPatient
Parent: Patient
Id: nesting-patient
Title: "Nesting Patient"
Description: "Required fields inside a complex type (identifier), a backbone element (contact) and a complex type inside a backbone element (contact.name, contact.telecom)."
* obeys plumb-name-part
* identifier 1..*
* identifier.system 1..1
* identifier.value 1..1
* contact.name 1..1
* contact.name.family 1..1
* contact.telecom.system 1..1
* contact.telecom.value 1..1

Invariant: plumb-name-part
Description: "Every name has a family name or a given name."
Expression: "name.all(family.exists() or given.exists())"
Severity: #error
