// Coverage matrix: Primitive types. One extension per FHIR primitive, each
// narrowing value[x] to that type, so each primitive appears as a required field.
Profile: PrimitivesBasic
Parent: Basic
Id: primitives-basic
Title: "Primitives Basic"
Description: "One optional extension per FHIR primitive type."
* extension contains
    PrimitiveString named string 0..1 and
    PrimitiveBoolean named boolean 0..1 and
    PrimitiveInteger named integer 0..1 and
    PrimitiveDecimal named decimal 0..1 and
    PrimitiveDate named date 0..1 and
    PrimitiveDateTime named dateTime 0..1 and
    PrimitiveInstant named instant 0..1 and
    PrimitiveTime named time 0..1 and
    PrimitiveCode named code 0..1 and
    PrimitiveUri named uri 0..1 and
    PrimitiveUrl named url 0..1 and
    PrimitiveCanonical named canonical 0..1 and
    PrimitiveId named id 0..1 and
    PrimitiveOid named oid 0..1 and
    PrimitiveUuid named uuid 0..1 and
    PrimitiveMarkdown named markdown 0..1 and
    PrimitiveBase64Binary named base64Binary 0..1 and
    PrimitivePositiveInt named positiveInt 0..1 and
    PrimitiveUnsignedInt named unsignedInt 0..1

Extension: PrimitiveString
Id: primitive-string
Description: "One string value."
* value[x] 1..1
* value[x] only string

Extension: PrimitiveBoolean
Id: primitive-boolean
Description: "One boolean value."
* value[x] 1..1
* value[x] only boolean

Extension: PrimitiveInteger
Id: primitive-integer
Description: "One integer value."
* value[x] 1..1
* value[x] only integer

Extension: PrimitiveDecimal
Id: primitive-decimal
Description: "One decimal value."
* value[x] 1..1
* value[x] only decimal

Extension: PrimitiveDate
Id: primitive-date
Description: "One date value."
* value[x] 1..1
* value[x] only date

Extension: PrimitiveDateTime
Id: primitive-date-time
Description: "One dateTime value."
* value[x] 1..1
* value[x] only dateTime

Extension: PrimitiveInstant
Id: primitive-instant
Description: "One instant value."
* value[x] 1..1
* value[x] only instant

Extension: PrimitiveTime
Id: primitive-time
Description: "One time value."
* value[x] 1..1
* value[x] only time

Extension: PrimitiveCode
Id: primitive-code
Description: "One code value."
* value[x] 1..1
* value[x] only code

Extension: PrimitiveUri
Id: primitive-uri
Description: "One uri value."
* value[x] 1..1
* value[x] only uri

Extension: PrimitiveUrl
Id: primitive-url
Description: "One url value."
* value[x] 1..1
* value[x] only url

Extension: PrimitiveCanonical
Id: primitive-canonical
Description: "One canonical value."
* value[x] 1..1
* value[x] only canonical

Extension: PrimitiveId
Id: primitive-id
Description: "One id value."
* value[x] 1..1
* value[x] only id

Extension: PrimitiveOid
Id: primitive-oid
Description: "One oid value."
* value[x] 1..1
* value[x] only oid

Extension: PrimitiveUuid
Id: primitive-uuid
Description: "One uuid value."
* value[x] 1..1
* value[x] only uuid

Extension: PrimitiveMarkdown
Id: primitive-markdown
Description: "One markdown value."
* value[x] 1..1
* value[x] only markdown

Extension: PrimitiveBase64Binary
Id: primitive-base64-binary
Description: "One base64Binary value."
* value[x] 1..1
* value[x] only base64Binary

Extension: PrimitivePositiveInt
Id: primitive-positive-int
Description: "One positiveInt value."
* value[x] 1..1
* value[x] only positiveInt

Extension: PrimitiveUnsignedInt
Id: primitive-unsigned-int
Description: "One unsignedInt value."
* value[x] 1..1
* value[x] only unsignedInt
