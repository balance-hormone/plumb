# Prototype: FSH to Types to Validator

A proof of concept of the core chain (FSH → SUSHI → generator → `tsc` →
Medplum's validator), run for real on 2026-09-25 against US Core 9.0.0,
SUSHI 3, TypeScript 5.9, `@medplum/core` 5.1.26 and Zod 4. It is the starting
point for the generator, not an implementation of it. The run used an
adopter's Patient profile; it is shown here renamed to a generic example with
the same shape (a required-identifier invariant, required names, birth date,
gender, and telecom slices on top of US Core Patient).

## What it proved

- SUSHI compiles a profile on `us-core-patient` with a full snapshot and zero
  errors.
- The generated types produce the intended compile errors: a missing family
  name, a missing birth date, a phone entry with the wrong `system`.
- Medplum's validator, run offline against the committed StructureDefinition,
  enforces both an invariant and a required slice.

## The example profile

```fsh
Invariant: example-mrn-1
Description: "At least one identifier uses the example MRN system."
Expression: "identifier.where(system = 'https://example.org/mrn').exists()"
Severity: #error

Profile: ExamplePatient
Parent: http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient
Id: example-patient
* ^version = "1.0.0"
* obeys example-mrn-1
* name.given 1..*
* name.family 1..1
* birthDate 1..1
* gender 1..1
* telecom ^slicing.discriminator.type = #value
* telecom ^slicing.discriminator.path = "system"
* telecom ^slicing.rules = #open
* telecom contains phone 1..* and email 0..*
* telecom[phone].system = #phone (exactly)
* telecom[phone].value 1..1
* telecom[email].system = #email (exactly)
* telecom[email].value 1..1
```

## SUSHI config

```yaml
canonical: https://example.org/fhir
status: active
version: 1.0.0
fhirVersion: 4.0.1
FSHOnly: true
dependencies:
  hl7.fhir.us.core: 9.0.0
```

SUSHI warns that `id` and `name` are unused when `FSHOnly: true`, so they are
left out.

```bash
npx fsh-sushi@3 profiles --snapshot
node generate.mjs profiles/fsh-generated/resources/StructureDefinition-example-patient.json ExamplePatient patient.generated.ts
# ✓ ExamplePatient ← https://example.org/fhir/StructureDefinition/example-patient|1.0.0  (7 fields narrowed, 3 invariants documented)
```

## The generated type

```ts
export type ExamplePatientTelecomPhone = Require<ContactPoint, 'system' | 'value'> & { system: 'phone' };

/** Invariants (enforced by the server and `validateProfiled`): example-mrn-1, us-core-23, us-core-6 */
export type ExamplePatient = Omit<Patient, 'identifier' | 'name' | 'telecom' | 'gender' | 'birthDate'> & {
  identifier: Require<Identifier, 'system' | 'value'>[];
  name: Require<HumanName, 'family' | 'given'>[];
  telecom: [ExamplePatientTelecomPhone, ...Require<ContactPoint, 'system' | 'value'>[]];
  gender: NonNullable<Patient['gender']>;
  birthDate: string;
};
```

## The prototype generator

It handles one profile at a time from CLI arguments, inlines its own
`Require<>` helper, and covers required top-level elements, one level of
required nested elements, fixed-value discriminator slices and invariants. It
does not do choice types, required bindings as literal unions, multiple
profiles or config; those are the generator's real scope.

```js
// StructureDefinition snapshot → TypeScript. Proof of concept.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , sdPath, typeName, outPath] = process.argv;
const sd = JSON.parse(readFileSync(sdPath, 'utf8'));
const R = sd.type;
const els = sd.snapshot.element;
const depth = (e) => e.path.split('.').length;
const field = (e) => e.path.split('.')[1];
const plain = (e) => !e.id.includes(':');

const perms = (xs) =>
  xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
const req = (base, keys) => (keys.length ? `Require<${base}, ${keys.map((k) => `"${k}"`).join(' | ')}>` : base);

const lines = [];
const members = [];
const overridden = [];

for (const top of els.filter((e) => depth(e) === 2 && plain(e) && !field(e).endsWith('[x]'))) {
  const f = field(top);
  const isArray = top.max === '*' || Number(top.max) > 1;
  const item = isArray ? `NonNullable<${R}["${f}"]>[number]` : `NonNullable<${R}["${f}"]>`;
  const kids = els.filter((e) => e.id.startsWith(`${top.id}.`) && depth(e) === 3 && plain(e) && e.min >= 1).map(field3);
  const slices = els.filter((e) => e.id.startsWith(`${top.id}:`) && !e.id.slice(top.id.length + 1).includes('.') && e.min >= 1);
  if (top.min < 1 && !kids.length && !slices.length) continue;

  let t = req(item, kids);
  if (slices.length) {
    const disc = top.slicing.discriminator[0].path;
    const names = [];
    for (const s of slices) {
      const sk = els.filter((e) => e.id.startsWith(`${s.id}.`) && depth(e) === 3 && e.min >= 1).map(field3);
      const fixed = els.find((e) => e.id === `${s.id}.${disc}`);
      const v = fixed.fixedCode ?? fixed.patternCode;
      const n = `${typeName}${cap(f)}${cap(s.sliceName)}`;
      lines.push(
        `/** \`${f}:${s.sliceName}\` — ${s.min}..${s.max}, discriminated by \`${disc} = "${v}"\`. */`,
        `export type ${n} = ${req(item, sk)} & { ${disc}: "${v}" };`,
        '',
      );
      names.push(n);
    }
    lines.push(
      `/** Must contain ${names.join(' and ')} (any order among the first ${names.length}), then anything else. */`,
      `export type ${typeName}${cap(f)} = ${perms(names).map((p) => `[${p.join(', ')}, ...${t}[]]`).join('\n  | ')};`,
      '',
    );
    t = `${typeName}${cap(f)}`;
  } else if (isArray) t = `${t}[]`;
  members.push(`  ${f}${top.min >= 1 ? '' : '?'}: ${t};`);
  overridden.push(f);
}
function field3(e) {
  return e.path.split('.')[2];
}
function cap(s) {
  return s[0].toUpperCase() + s.slice(1);
}

const invariants = [
  ...new Map(
    els.flatMap((e) => e.constraint ?? []).filter((c) => !/^(ele|dom)-/.test(c.key)).map((c) => [c.key, c]),
  ).values(),
];
const out = [
  `// GENERATED from ${sd.url}|${sd.version}. Do not edit.`,
  `import type { ${R} } from "@medplum/fhirtypes";`,
  '',
  'type Require<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };',
  '',
  `export const ${typeName}Profile = "${sd.url}" as const;`,
  '',
  ...lines,
  '/**',
  ` * ${sd.title} ${sd.version} — ${sd.description}`,
  ...(invariants.length
    ? [' *', ' * Invariants (enforced by the server and `validateProfiled`):', ...invariants.map((c) => ` *   - ${c.key}: ${c.human}`)]
    : []),
  ' */',
  `export type ${typeName} = Omit<${R}, ${overridden.map((f) => `"${f}"`).join(' | ')}> & {`,
  ...members,
  '};',
  '',
];
writeFileSync(outPath, out.join('\n'));
console.log(`✓ ${typeName} ← ${sd.url}|${sd.version}  (${overridden.length} fields narrowed, ${invariants.length} invariants documented)`);
```

## What `validateProfiled` does underneath

```js
import { indexStructureDefinitionBundle, validateResource } from '@medplum/core';
import { readJson } from '@medplum/definitions';

// Index the base R4 definitions once, then validate against the committed profile.
for (const f of ['fhir/r4/profiles-types.json', 'fhir/r4/profiles-resources.json']) {
  indexStructureDefinitionBundle(readJson(f));
}
const issues = validateResource(resource, { profile: examplePatientStructureDefinition });
```

On 5.1.26 this threw an `OperationOutcomeError` on error-severity issues; on
5.1.41 `validateResource` returns the issues instead. Offline it reported
the invariant as "Constraint <key> not met", and a missing required slice as
"Incorrect number of values provided for slice '<name>': expected 1..*, but
found 0".

## Known gaps found in the prototype

- Required slices must be the leading telecom entries, in either order. A
  telecom array built with `.map()` or `.filter()` does not satisfy the tuple.
- `identifier: []` compiles; only the validator catches it.
- Element types come out as indexed types (`NonNullable<Patient["telecom"]>[number]`)
  rather than named ones (`ContactPoint`). Correct, but named types give better
  hover text; the real generator should map element types to their FHIR type
  names.
- The generator must read snapshots, never differentials, and must extend
  `@medplum/fhirtypes` rather than emit a parallel base tree.
