// Coverage matrix: Bindings, the six cases of design 01's decision 3.
CodeSystem: PlumbTestColors
Id: plumb-test-colors
Title: "Plumb test colors"
* ^caseSensitive = true
* #red "Red"
* #green "Green"
* #blue "Blue"

ValueSet: PlumbTestColorsVS
Id: plumb-test-colors-vs
Title: "Plumb test colors"
* include codes from system PlumbTestColors

ValueSet: PlumbTestGenderSubset
Id: plumb-test-gender-subset
Title: "Female or male"
* $gender#female
* $gender#male

ValueSet: PlumbTestFindings
Id: plumb-test-findings
Title: "Clinical findings (rule-based, cannot be listed offline)"
* include codes from system $sct where concept is-a #404684003

CodeSystem: PlumbTestUnits
Id: plumb-test-units
Title: "Plumb test units"
* ^caseSensitive = true
* #g "gram"
* #kg "kilogram"

ValueSet: PlumbTestUnitsVS
Id: plumb-test-units-vs
Title: "Plumb test units"
* include codes from system PlumbTestUnits

ValueSet: PlumbTestLargeVS
Id: plumb-test-large-vs
Title: "101 codes, over the size limit"
* include codes from system PlumbTestLarge

CodeSystem: PlumbTestLarge
Id: plumb-test-large
Title: "101 codes"
* ^caseSensitive = true
* #c001 "Code 001"
* #c002 "Code 002"
* #c003 "Code 003"
* #c004 "Code 004"
* #c005 "Code 005"
* #c006 "Code 006"
* #c007 "Code 007"
* #c008 "Code 008"
* #c009 "Code 009"
* #c010 "Code 010"
* #c011 "Code 011"
* #c012 "Code 012"
* #c013 "Code 013"
* #c014 "Code 014"
* #c015 "Code 015"
* #c016 "Code 016"
* #c017 "Code 017"
* #c018 "Code 018"
* #c019 "Code 019"
* #c020 "Code 020"
* #c021 "Code 021"
* #c022 "Code 022"
* #c023 "Code 023"
* #c024 "Code 024"
* #c025 "Code 025"
* #c026 "Code 026"
* #c027 "Code 027"
* #c028 "Code 028"
* #c029 "Code 029"
* #c030 "Code 030"
* #c031 "Code 031"
* #c032 "Code 032"
* #c033 "Code 033"
* #c034 "Code 034"
* #c035 "Code 035"
* #c036 "Code 036"
* #c037 "Code 037"
* #c038 "Code 038"
* #c039 "Code 039"
* #c040 "Code 040"
* #c041 "Code 041"
* #c042 "Code 042"
* #c043 "Code 043"
* #c044 "Code 044"
* #c045 "Code 045"
* #c046 "Code 046"
* #c047 "Code 047"
* #c048 "Code 048"
* #c049 "Code 049"
* #c050 "Code 050"
* #c051 "Code 051"
* #c052 "Code 052"
* #c053 "Code 053"
* #c054 "Code 054"
* #c055 "Code 055"
* #c056 "Code 056"
* #c057 "Code 057"
* #c058 "Code 058"
* #c059 "Code 059"
* #c060 "Code 060"
* #c061 "Code 061"
* #c062 "Code 062"
* #c063 "Code 063"
* #c064 "Code 064"
* #c065 "Code 065"
* #c066 "Code 066"
* #c067 "Code 067"
* #c068 "Code 068"
* #c069 "Code 069"
* #c070 "Code 070"
* #c071 "Code 071"
* #c072 "Code 072"
* #c073 "Code 073"
* #c074 "Code 074"
* #c075 "Code 075"
* #c076 "Code 076"
* #c077 "Code 077"
* #c078 "Code 078"
* #c079 "Code 079"
* #c080 "Code 080"
* #c081 "Code 081"
* #c082 "Code 082"
* #c083 "Code 083"
* #c084 "Code 084"
* #c085 "Code 085"
* #c086 "Code 086"
* #c087 "Code 087"
* #c088 "Code 088"
* #c089 "Code 089"
* #c090 "Code 090"
* #c091 "Code 091"
* #c092 "Code 092"
* #c093 "Code 093"
* #c094 "Code 094"
* #c095 "Code 095"
* #c096 "Code 096"
* #c097 "Code 097"
* #c098 "Code 098"
* #c099 "Code 099"
* #c100 "Code 100"
* #c101 "Code 101"

Profile: BindingsPatient
Parent: Patient
Id: bindings-patient
Title: "Bindings Patient"
Description: "Required on a code, listable (gender); required on a CodeableConcept (maritalStatus); required on a Coding, listable (meta.tag); required on a Coding, not listable offline (meta.security); preferred (communication.language)."
* gender from PlumbTestGenderSubset (required)
* maritalStatus from PlumbTestColorsVS (required)
* meta.tag from PlumbTestColorsVS (required)
* meta.security from PlumbTestFindings (required)
* communication.language from PlumbTestColorsVS (preferred)

Profile: BindingsObservation
Parent: Observation
Id: bindings-observation
Title: "Bindings Observation"
Description: "Required on a code, over the size limit (valueQuantity.code); extensible on a code (component.valueQuantity.code)."
* value[x] only Quantity
* valueQuantity.code from PlumbTestLargeVS (required)
* component.value[x] only Quantity
* component.valueQuantity.code from PlumbTestUnitsVS (extensible)
