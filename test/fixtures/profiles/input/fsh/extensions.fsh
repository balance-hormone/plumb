// Coverage matrix: Extensions, simple and complex, required and optional.
Extension: FavoriteColor
Id: favorite-color
Description: "Simple extension with a required code."
* value[x] 1..1
* value[x] only code
* valueCode from PlumbTestColorsVS (required)

Extension: Nickname
Id: nickname
Description: "Simple extension with a string."
* value[x] only string

Extension: CareNote
Id: care-note
Description: "Complex extension: instruction required, author optional."
* extension contains instruction 1..1 and author 0..1
* extension[instruction].value[x] 1..1
* extension[instruction].value[x] only string
* extension[author].value[x] only Reference(RelatedPerson)
* value[x] 0..0

Extension: ContactWindow
Id: contact-window
Description: "Complex extension: start required, end optional."
* extension contains start 1..1 and end 0..1
* extension[start].value[x] 1..1
* extension[start].value[x] only time
* extension[end].value[x] only time
* value[x] 0..0

Profile: ExtensionsPatient
Parent: Patient
Id: extensions-patient
Title: "Extensions Patient"
Description: "Simple required (favoriteColor), simple optional (nickname), complex required (careNote), complex optional (contactWindow)."
* extension contains
    FavoriteColor named favoriteColor 1..1 and
    Nickname named nickname 0..1 and
    CareNote named careNote 1..1 and
    ContactWindow named contactWindow 0..1

Profile: OptionalExtensionsPatient
Parent: Patient
Id: optional-extensions-patient
Title: "Optional Extensions Patient"
Description: "The same four extensions, each 0..1, so each extension's contents can be tested on its own."
* extension contains
    FavoriteColor named favoriteColor 0..1 and
    Nickname named nickname 0..1 and
    CareNote named careNote 0..1 and
    ContactWindow named contactWindow 0..1
