// Coverage matrix: Choice types.
Profile: ChoiceObservation
Parent: Observation
Id: choice-observation
Title: "Choice Observation"
Description: "value[x] narrowed to one type; effective[x] narrowed to two types, optional."
* value[x] only Quantity
* effective[x] only dateTime or Period

Profile: RequiredChoiceObservation
Parent: Observation
Id: required-choice-observation
Title: "Required Choice Observation"
Description: "value[x] required, with two types: exactly one of valueQuantity or valueString."
* value[x] 1..1
* value[x] only Quantity or string
