// Coverage matrix: Fixed and pattern values, on a primitive, a Coding and a CodeableConcept.
Profile: FixedPatternObservation
Parent: Observation
Id: fixed-pattern-observation
Title: "Fixed Pattern Observation"
Description: "Fixed primitive (status), pattern CodeableConcept (code)."
* status = #final (exactly)
* code = $loinc#8302-2

Profile: FixedPatternEncounter
Parent: Encounter
Id: fixed-pattern-encounter
Title: "Fixed Pattern Encounter"
Description: "Pattern primitive (status), fixed Coding (class), pattern Coding (classHistory.class), fixed CodeableConcept (priority)."
* status = #finished
* class = $v3-ActCode#AMB (exactly)
* classHistory.class = $v3-ActCode#IMP
* priority = $sct#394848005 (exactly)
