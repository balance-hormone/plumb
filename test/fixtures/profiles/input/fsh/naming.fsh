// Coverage matrix: Naming. Two profiles with the same name, so their generated
// type names would collide.
Profile: NamingPatientA
Parent: Patient
Id: naming-patient-a
Title: "Naming Patient A"
Description: "Shares its name with naming-patient-b."
* ^name = "NamingPatient"
* name 1..*

Profile: NamingPatientB
Parent: Patient
Id: naming-patient-b
Title: "Naming Patient B"
Description: "Shares its name with naming-patient-a."
* ^name = "NamingPatient"
* gender 1..1
