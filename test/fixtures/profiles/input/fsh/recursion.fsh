// Coverage matrix: Recursion. Questionnaire.item.item is a contentReference to
// Questionnaire.item.
Profile: RecursiveQuestionnaire
Parent: Questionnaire
Id: recursive-questionnaire
Title: "Recursive Questionnaire"
Description: "item required, and item.text required on every item."
* item 1..*
* item.text 1..1
